/**
 * ADR-0027 §6（PC-05b）：Node 侧上下文状态与清理重试队列的持久化。
 *
 * 状态按 `(runId, snapshotId)` 保存；delivered/read 集合跨重启保留，用于只删除
 * `readAt=0` 的未读副本。`context_cleanup_task` 保存删除/隔离失败的重试项，
 * 断线/重启后仍能继续清理（每项按 due_at 退避）。
 */
import type { RunContextState, RunContextStateEntry } from '@whalepod/protocol'
import { openStateDatabase } from '../state/db.js'

export type ContextPauseReason = 'cleanup' | 'generation_regression'

export interface StoredContextState {
  readonly runId: string
  readonly snapshotId: string
  readonly stateVersion: number
  readonly stateDigest: string
  readonly entries: readonly RunContextStateEntry[]
  readonly syncedAt: string
  readonly paused: boolean
  /** pause 的原因；drain 只能解除它自己拥有的 cleanup pause。 */
  readonly pauseReason: ContextPauseReason | null
  readonly delivered: readonly string[]
  readonly read: readonly string[]
}

export interface DueCleanupTask {
  readonly runId: string
  readonly entryId: string
  readonly attempts: number
}

export interface ContextStateStore {
  get(runId: string): StoredContextState | undefined
  putInitial(
    runId: string,
    snapshotId: string,
    entries: readonly RunContextStateEntry[],
    stateDigest: string,
    syncedAt: string,
  ): void
  upsert(state: RunContextState, syncedAt: string): boolean
  touchSync(runId: string, snapshotId: string, syncedAt: string): void
  setPaused(runId: string, paused: boolean, reason?: ContextPauseReason | null): void
  markDelivered(runId: string, snapshotId: string, entryIds: readonly string[]): void
  markRead(runId: string, snapshotId: string, entryId: string): void
  delete(runId: string): void
  enqueueCleanup(runId: string, entryId: string, dueAt: string, lastError: string): void
  clearCleanup(runId: string, entryId: string): void
  dueCleanup(now: Date): readonly DueCleanupTask[]
  recordCleanupFailure(runId: string, entryId: string, dueAt: string, lastError: string): void
  pendingCleanupCount(runId: string): number
  pendingCleanupEntryIds(runId: string): readonly string[]
}

function merge(existing: readonly string[], incoming: readonly string[]): string[] {
  return [...new Set([...existing, ...incoming])].sort()
}

function parseArray(raw: string | null | undefined): string[] {
  if (raw === null || raw === undefined) return []
  try {
    const parsed = JSON.parse(raw) as unknown
    return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === 'string') : []
  } catch {
    return []
  }
}

interface StateRow {
  run_id: string
  snapshot_id: string
  state_version: number
  state_digest: string
  entries: string
  synced_at: string
  paused: number
  pause_reason: string | null
  delivered: string
  read_items: string
}

function rowToState(row: StateRow): StoredContextState {
  return {
    runId: row.run_id,
    snapshotId: row.snapshot_id,
    stateVersion: row.state_version,
    stateDigest: row.state_digest,
    entries: JSON.parse(row.entries) as RunContextStateEntry[],
    syncedAt: row.synced_at,
    paused: row.paused === 1,
    pauseReason:
      row.pause_reason === 'cleanup' || row.pause_reason === 'generation_regression'
        ? row.pause_reason
        : null,
    delivered: parseArray(row.delivered),
    read: parseArray(row.read_items),
  }
}

export class SqliteContextStateStore implements ContextStateStore {
  private readonly db: ReturnType<typeof openStateDatabase>

  constructor(path: string) {
    this.db = openStateDatabase(path)
    this.db.exec(`
      create table if not exists run_context_state (
        run_id text primary key,
        snapshot_id text not null,
        state_version integer not null,
        state_digest text not null,
        entries text not null,
        synced_at text not null,
        paused integer not null default 0,
        pause_reason text,
        delivered text not null default '[]',
        read_items text not null default '[]'
      );
      create table if not exists context_cleanup_task (
        run_id text not null,
        entry_id text not null,
        kind text not null default 'entry',
        due_at text not null,
        attempts integer not null default 0,
        last_error text,
        primary key (run_id, entry_id, kind)
      );
      create index if not exists context_cleanup_due_idx on context_cleanup_task (due_at);
    `)
    // 旧库升级：paused 之前没有原因，drain 按 cleanup 处理。
    const columns = this.db.prepare('pragma table_info(run_context_state)').all() as {
      name: string
    }[]
    if (!columns.some((column) => column.name === 'pause_reason')) {
      this.db.exec('alter table run_context_state add column pause_reason text')
    }
  }

  get(runId: string): StoredContextState | undefined {
    const row = this.db.prepare('select * from run_context_state where run_id = ?').get(runId) as
      | StateRow
      | undefined
    return row === undefined ? undefined : rowToState(row)
  }

  putInitial(
    runId: string,
    snapshotId: string,
    entries: readonly RunContextStateEntry[],
    stateDigest: string,
    syncedAt: string,
  ): void {
    const existing = this.get(runId)
    // 初始状态只能建立一次；已有同快照的已应用状态不得被 v0 覆盖。不同快照
    // 意味着同一 runId 的全新上下文，delivered/read 不得沿用旧集合。
    if (existing !== undefined && existing.snapshotId === snapshotId) return
    this.db
      .prepare(
        `insert into run_context_state
           (run_id, snapshot_id, state_version, state_digest, entries, synced_at, delivered, read_items)
         values (?, ?, 0, ?, ?, ?, ?, ?)
         on conflict (run_id) do update set
           snapshot_id = excluded.snapshot_id,
           state_version = excluded.state_version,
           state_digest = excluded.state_digest,
           entries = excluded.entries,
           synced_at = excluded.synced_at,
           paused = 0,
           pause_reason = null,
           delivered = excluded.delivered,
           read_items = excluded.read_items`,
      )
      .run(
        runId,
        snapshotId,
        stateDigest,
        JSON.stringify(entries),
        syncedAt,
        JSON.stringify([]),
        JSON.stringify([]),
      )
  }

  upsert(state: RunContextState, syncedAt: string): boolean {
    const existing = this.get(state.runId)
    // 同一 runId 的 snapshot 身份不可变；异快照帧不得覆盖本地状态。
    if (existing !== undefined && existing.snapshotId !== state.snapshotId) return false
    // 旧版本/旧快照的迟到状态不得覆盖更新的状态；同版本同摘要幂等。
    if (existing !== undefined) {
      if (existing.stateVersion > state.stateVersion) return false
      if (
        existing.stateVersion === state.stateVersion &&
        existing.stateDigest !== state.stateDigest
      ) {
        return false
      }
    }
    this.db
      .prepare(
        `insert into run_context_state
           (run_id, snapshot_id, state_version, state_digest, entries, synced_at, delivered, read_items)
         values (?, ?, ?, ?, ?, ?, ?, ?)
         on conflict (run_id) do update set
           snapshot_id = excluded.snapshot_id,
           state_version = excluded.state_version,
           state_digest = excluded.state_digest,
           entries = excluded.entries,
           synced_at = excluded.synced_at,
           delivered = excluded.delivered,
           read_items = excluded.read_items`,
      )
      .run(
        state.runId,
        state.snapshotId,
        state.stateVersion,
        state.stateDigest,
        JSON.stringify(state.entries),
        syncedAt,
        JSON.stringify(existing?.delivered ?? []),
        JSON.stringify(existing?.read ?? []),
      )
    return true
  }

  touchSync(runId: string, snapshotId: string, syncedAt: string): void {
    this.db
      .prepare('update run_context_state set synced_at = ? where run_id = ? and snapshot_id = ?')
      .run(syncedAt, runId, snapshotId)
  }

  setPaused(runId: string, paused: boolean, reason?: ContextPauseReason | null): void {
    this.db
      .prepare('update run_context_state set paused = ?, pause_reason = ? where run_id = ?')
      .run(paused ? 1 : 0, paused ? (reason ?? null) : null, runId)
  }

  markDelivered(runId: string, snapshotId: string, entryIds: readonly string[]): void {
    const current = this.get(runId)
    if (current === undefined || current.snapshotId !== snapshotId) return
    this.db
      .prepare('update run_context_state set delivered = ? where run_id = ?')
      .run(JSON.stringify(merge(current.delivered, entryIds)), runId)
  }

  markRead(runId: string, snapshotId: string, entryId: string): void {
    const current = this.get(runId)
    if (current === undefined || current.snapshotId !== snapshotId) return
    this.db
      .prepare('update run_context_state set read_items = ? where run_id = ?')
      .run(JSON.stringify(merge(current.read, [entryId])), runId)
  }

  delete(runId: string): void {
    this.db.prepare('delete from run_context_state where run_id = ?').run(runId)
    this.db.prepare('delete from context_cleanup_task where run_id = ?').run(runId)
  }

  enqueueCleanup(runId: string, entryId: string, dueAt: string, lastError: string): void {
    this.db
      .prepare(
        `insert into context_cleanup_task (run_id, entry_id, due_at, last_error)
         values (?, ?, ?, ?)
         on conflict (run_id, entry_id, kind) do update set
           due_at = excluded.due_at,
           last_error = excluded.last_error`,
      )
      .run(runId, entryId, dueAt, lastError)
  }

  clearCleanup(runId: string, entryId: string): void {
    this.db
      .prepare('delete from context_cleanup_task where run_id = ? and entry_id = ?')
      .run(runId, entryId)
  }

  dueCleanup(now: Date): readonly DueCleanupTask[] {
    const rows = this.db
      .prepare(
        'select run_id, entry_id, attempts from context_cleanup_task where due_at <= ? order by due_at',
      )
      .all(now.toISOString()) as { run_id: string; entry_id: string; attempts: number }[]
    return rows.map((row) => ({
      runId: row.run_id,
      entryId: row.entry_id,
      attempts: row.attempts,
    }))
  }

  recordCleanupFailure(runId: string, entryId: string, dueAt: string, lastError: string): void {
    this.db
      .prepare(
        `update context_cleanup_task
         set attempts = attempts + 1, due_at = ?, last_error = ?
         where run_id = ? and entry_id = ?`,
      )
      .run(dueAt, lastError, runId, entryId)
  }

  pendingCleanupCount(runId: string): number {
    const row = this.db
      .prepare('select count(*) as count from context_cleanup_task where run_id = ?')
      .get(runId) as { count: number } | undefined
    return row?.count ?? 0
  }

  pendingCleanupEntryIds(runId: string): readonly string[] {
    const rows = this.db
      .prepare('select entry_id from context_cleanup_task where run_id = ? order by entry_id')
      .all(runId) as { entry_id: string }[]
    return rows.map((row) => row.entry_id)
  }

  close(): void {
    this.db.close()
  }
}

/** 测试/单测用的内存实现；语义与 SQLite 版一致。 */
export class MemoryContextStateStore implements ContextStateStore {
  private readonly states = new Map<string, StoredContextState>()
  private readonly cleanup = new Map<string, { dueAt: string; attempts: number; error: string }>()

  get(runId: string): StoredContextState | undefined {
    return this.states.get(runId)
  }

  putInitial(
    runId: string,
    snapshotId: string,
    entries: readonly RunContextStateEntry[],
    stateDigest: string,
    syncedAt: string,
  ): void {
    const existing = this.states.get(runId)
    if (existing !== undefined && existing.snapshotId === snapshotId) return
    this.states.set(runId, {
      runId,
      snapshotId,
      stateVersion: 0,
      stateDigest,
      entries,
      syncedAt,
      paused: false,
      pauseReason: null,
      delivered: [],
      read: [],
    })
  }

  upsert(state: RunContextState, syncedAt: string): boolean {
    const existing = this.states.get(state.runId)
    if (existing !== undefined && existing.snapshotId !== state.snapshotId) return false
    if (existing !== undefined) {
      if (existing.stateVersion > state.stateVersion) return false
      if (
        existing.stateVersion === state.stateVersion &&
        existing.stateDigest !== state.stateDigest
      ) {
        return false
      }
    }
    this.states.set(state.runId, {
      runId: state.runId,
      snapshotId: state.snapshotId,
      stateVersion: state.stateVersion,
      stateDigest: state.stateDigest,
      entries: state.entries,
      syncedAt,
      paused: existing?.paused ?? false,
      pauseReason: existing?.pauseReason ?? null,
      delivered: existing?.delivered ?? [],
      read: existing?.read ?? [],
    })
    return true
  }

  touchSync(runId: string, snapshotId: string, syncedAt: string): void {
    const current = this.states.get(runId)
    if (current === undefined || current.snapshotId !== snapshotId) return
    this.states.set(runId, { ...current, syncedAt })
  }

  setPaused(runId: string, paused: boolean, reason?: ContextPauseReason | null): void {
    const current = this.states.get(runId)
    if (current === undefined) return
    this.states.set(runId, {
      ...current,
      paused,
      pauseReason: paused ? (reason ?? null) : null,
    })
  }

  markDelivered(runId: string, snapshotId: string, entryIds: readonly string[]): void {
    const current = this.states.get(runId)
    if (current === undefined || current.snapshotId !== snapshotId) return
    this.states.set(runId, { ...current, delivered: merge(current.delivered, entryIds) })
  }

  markRead(runId: string, snapshotId: string, entryId: string): void {
    const current = this.states.get(runId)
    if (current === undefined || current.snapshotId !== snapshotId) return
    this.states.set(runId, { ...current, read: merge(current.read, [entryId]) })
  }

  delete(runId: string): void {
    this.states.delete(runId)
    for (const key of this.cleanup.keys()) {
      if (key.startsWith(`${runId}:`)) this.cleanup.delete(key)
    }
  }

  enqueueCleanup(runId: string, entryId: string, dueAt: string, lastError: string): void {
    const key = `${runId}:${entryId}`
    const current = this.cleanup.get(key)
    this.cleanup.set(key, {
      dueAt,
      attempts: current?.attempts ?? 0,
      error: lastError,
    })
  }

  clearCleanup(runId: string, entryId: string): void {
    this.cleanup.delete(`${runId}:${entryId}`)
  }

  dueCleanup(now: Date): readonly DueCleanupTask[] {
    return [...this.cleanup.entries()]
      .filter(([, value]) => value.dueAt <= now.toISOString())
      .map(([key, value]) => {
        const [runId, entryId] = key.split(':')
        return { runId: runId!, entryId: entryId!, attempts: value.attempts }
      })
  }

  recordCleanupFailure(runId: string, entryId: string, dueAt: string, lastError: string): void {
    const key = `${runId}:${entryId}`
    const current = this.cleanup.get(key)
    this.cleanup.set(key, {
      dueAt,
      attempts: (current?.attempts ?? 0) + 1,
      error: lastError,
    })
  }

  pendingCleanupCount(runId: string): number {
    let count = 0
    for (const key of this.cleanup.keys()) {
      if (key.startsWith(`${runId}:`)) count += 1
    }
    return count
  }

  pendingCleanupEntryIds(runId: string): readonly string[] {
    return [...this.cleanup.keys()]
      .filter((key) => key.startsWith(`${runId}:`))
      .map((key) => key.slice(runId.length + 1))
      .sort()
  }
}
