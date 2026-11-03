/**
 * ADR-0027 §6（PC-05b）：Run 项目上下文撤权状态机与状态同步。
 *
 * 状态只在 Hub 派生：每条快照入口按「context_entry 当前有效性 + project_source
 * 状态/权限代次」得到 frozen / retracted / source_tombstoned / permission_* /
 * unavailable。派生结果写回入口行并递增快照 stateVersion；Node 只应用、不自行
 * 判断授权。正文不进入状态帧。
 */
import { createHash } from 'node:crypto'
import { and, eq, inArray, isNull, sql } from 'drizzle-orm'
import type {
  Database,
  RunProjectContextEntryRow,
  RunProjectContextRow,
  RunRow,
  Tx,
} from '@whalepod/db'
import {
  ACTIVE_RUN_CONTEXT_STATUSES,
  getRunProjectContextByRun,
  upsertRunContextStateAck,
  listActiveRunContextSnapshots,
  listActiveRunContextSnapshotsForEntry,
  listRunProjectContextEntries,
  Outbox,
  schema,
  updateRunProjectContext,
  updateRunProjectContextEntryState,
} from '@whalepod/db'
import {
  contextStateDigestInput,
  RUN_CONTEXT_STATE_SYNC_INTERVAL_MS,
  type ContextStateAck,
  type RunContextState,
  type RunContextStateEntry,
  type RunProjectContextEntryStatus,
} from '@whalepod/protocol'
import { uuidv7 } from '../shared/uuid.js'

export interface RunContextStateDeps {
  readonly database: Database
  readonly outbox: Outbox
  readonly now: () => Date
  /** 单 Run 状态刷新失败时的告警（只含不透明 id/错误名）；缺失 = 静默跳过。 */
  readonly log?: (message: string, context: Record<string, unknown>) => void
}

export interface DerivedRunContextState {
  readonly snapshot: RunProjectContextRow
  readonly entries: readonly RunContextStateEntry[]
  /** 入口状态或快照状态发生了变化（需要下发完整状态）。 */
  readonly changed: boolean
  readonly state: RunContextState
}

function sha256Hex(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

export function snapshotStatusOf(
  entries: readonly RunContextStateEntry[],
): RunProjectContextRow['status'] {
  if (entries.length === 0) return 'frozen'
  const frozen = entries.filter((entry) => entry.state === 'frozen').length
  if (frozen === entries.length) return 'frozen'
  return frozen === 0 ? 'invalidated' : 'partially_unavailable'
}

export interface DerivationInput {
  readonly entry: RunProjectContextEntryRow
  readonly contextEntry: typeof schema.contextEntries.$inferSelect | undefined
  readonly source: typeof schema.projectSources.$inferSelect | undefined
  readonly now: Date
}

/** 单条入口的派生规则（导出供规则级单测；运行时只经 refreshRunContextState 写入）。 */
export function deriveEntryState(input: DerivationInput): {
  readonly state: RunProjectContextEntryStatus
  readonly reason: string | null
} {
  const { entry, contextEntry, source, now } = input

  // 快照入口引用的业务事实已不存在/被纠正/被替换：这是条目级撤回，不是权限问题。
  if (entry.sourceId === null) {
    if (contextEntry === undefined) {
      return { state: 'unavailable', reason: 'entry_missing' }
    }
    if (contextEntry.status !== 'active') {
      return { state: 'retracted', reason: `entry_${contextEntry.status}` }
    }
    if (contextEntry.correctedAt !== null) {
      return { state: 'retracted', reason: 'entry_corrected' }
    }
    if (entry.identityUnverified) {
      // Decision 不参与 source_tombstoned/permission_*（schema 禁止），身份未核实
      // 仍必须不可读，因此落到 schema 允许的 unavailable。
      return { state: 'unavailable', reason: 'identity_unverified' }
    }
    if (entry.permissionStateAtSelection !== 'authorized') {
      return { state: 'unavailable', reason: 'permission_not_authorized' }
    }
    return { state: 'frozen', reason: null }
  }

  // 来源条目同样先看条目事实：来源 Observation 被纠正/撤回后不因来源恢复而复活。
  if (contextEntry === undefined) {
    return { state: 'unavailable', reason: 'entry_missing' }
  }
  if (contextEntry.status !== 'active') {
    return { state: 'retracted', reason: `entry_${contextEntry.status}` }
  }
  if (contextEntry.correctedAt !== null) {
    return { state: 'retracted', reason: 'entry_corrected' }
  }
  // 来源撤销/暂停/权限未知不可读；代次只拦倒退（重新核验可恢复）。
  if (source === undefined) {
    return { state: 'unavailable', reason: 'source_missing' }
  }
  if (source.status === 'revoked') {
    return { state: 'source_tombstoned', reason: 'source_revoked' }
  }
  if (source.status === 'paused') {
    return { state: 'unavailable', reason: 'source_paused' }
  }
  if (source.status === 'unavailable') {
    return { state: 'unavailable', reason: 'source_unavailable' }
  }
  if (source.permissionState === 'denied') {
    return { state: 'permission_denied', reason: 'permission_denied' }
  }
  if (source.permissionState === 'unknown') {
    return { state: 'permission_unknown', reason: 'permission_unknown' }
  }
  if (
    source.permissionExpiresAt !== null &&
    source.permissionExpiresAt.getTime() <= now.getTime()
  ) {
    return { state: 'permission_unknown', reason: 'permission_expired' }
  }
  // 代次只拦「倒退」：来源重新核验后 generation 会递增，仍可恢复读取；但旧代次
  // 即使 stateVersion 更高也不得恢复（ADR-0027 §6）。
  const snapshotGeneration = entry.authorizationGeneration
  if (snapshotGeneration !== null) {
    const snapshotNumber = Number(snapshotGeneration)
    const currentNumber = Number(source.authorizationGeneration)
    if (Number.isFinite(snapshotNumber) && Number.isFinite(currentNumber)) {
      if (currentNumber < snapshotNumber) {
        return { state: 'permission_unknown', reason: 'authorization_generation_regressed' }
      }
    } else if (snapshotGeneration !== String(source.authorizationGeneration)) {
      return { state: 'permission_unknown', reason: 'authorization_generation_mismatch' }
    }
  }
  return { state: 'frozen', reason: null }
}

/**
 * 重算一个快照的状态。调用方必须已持有快照行锁（本函数默认在事务内调用）。
 * 只在入口状态或快照聚合状态变化时递增 stateVersion；否则保持原版本，避免
 * 周期同步把水位推成噪音。
 */
export async function refreshRunContextState(
  tx: Tx,
  snapshotId: string,
  now: Date,
): Promise<DerivedRunContextState> {
  const [snapshot] = await tx
    .select()
    .from(schema.runProjectContexts)
    .where(eq(schema.runProjectContexts.id, snapshotId))
    .for('update')
  if (snapshot === undefined) throw new Error('run project context not found')
  return refreshLockedSnapshot(tx, snapshot, now)
}

interface DerivedSnapshot {
  readonly entries: readonly RunContextStateEntry[]
  readonly status: RunProjectContextRow['status']
  readonly changedEntries: readonly {
    readonly entryId: string
    readonly state: RunProjectContextEntryStatus
    readonly reason: string | null
  }[]
}

/** 只读派生：不写库；派发前复核与周期刷新共用同一套规则。 */
async function deriveSnapshot(
  tx: Tx,
  snapshot: RunProjectContextRow,
  now: Date,
): Promise<DerivedSnapshot> {
  const entries = await listRunProjectContextEntries(tx, snapshot.id)
  const contextEntryIds = entries.map((entry) => entry.entryId)
  const sourceIds = entries
    .map((entry) => entry.sourceId)
    .filter((value): value is string => value !== null)

  const [contextRows, sourceRows] = await Promise.all([
    contextEntryIds.length === 0
      ? Promise.resolve([])
      : tx
          .select()
          .from(schema.contextEntries)
          .where(inArray(schema.contextEntries.id, contextEntryIds)),
    sourceIds.length === 0
      ? Promise.resolve([])
      : tx.select().from(schema.projectSources).where(inArray(schema.projectSources.id, sourceIds)),
  ])
  const contextById = new Map(contextRows.map((row) => [row.id, row]))
  const sourceById = new Map(sourceRows.map((row) => [row.id, row]))

  const derived: RunContextStateEntry[] = []
  const changedEntries: {
    entryId: string
    state: RunProjectContextEntryStatus
    reason: string | null
  }[] = []
  for (const entry of entries) {
    const result = deriveEntryState({
      entry,
      contextEntry: contextById.get(entry.entryId),
      source: entry.sourceId === null ? undefined : sourceById.get(entry.sourceId),
      now,
    })
    if (entry.entryStatus !== result.state || entry.statusReason !== result.reason) {
      changedEntries.push({ entryId: entry.entryId, ...result })
    }
    const generation = entry.sourceId === null ? undefined : sourceById.get(entry.sourceId)
    derived.push({
      entryId: entry.entryId,
      kind: entry.kind,
      state: result.state,
      currentAuthorizationGeneration:
        generation === undefined ? null : String(generation.authorizationGeneration),
      reason: result.reason,
    })
  }
  return { entries: derived, status: snapshotStatusOf(derived), changedEntries }
}

async function refreshLockedSnapshot(
  tx: Tx,
  snapshot: RunProjectContextRow,
  now: Date,
): Promise<DerivedRunContextState> {
  const derived = await deriveSnapshot(tx, snapshot, now)
  for (const entry of derived.changedEntries) {
    await updateRunProjectContextEntryState(
      tx,
      snapshot.id,
      entry.entryId,
      entry.state,
      entry.reason,
    )
  }

  const statusChanged = snapshot.status !== derived.status
  const entriesChanged = derived.changedEntries.length > 0
  const mustInitialize = snapshot.stateVersion === 0
  // 摘要按现有版本重算：generation-only 变化（state 仍 frozen）也必须推进版本，
  // 否则帧里的 entries 与 stateDigest 会自相矛盾，Node 会拒收并把 outbox 卡住。
  const currentVersion = mustInitialize ? 1 : snapshot.stateVersion
  const currentDigest = sha256Hex(contextStateDigestInput(currentVersion, derived.entries))
  const digestChanged = snapshot.stateDigest !== currentDigest
  if (!entriesChanged && !statusChanged && !mustInitialize && !digestChanged) {
    return {
      snapshot,
      entries: derived.entries,
      changed: false,
      state: toRunContextState(snapshot, derived.entries, now),
    }
  }

  const nextVersion = mustInitialize ? 1 : snapshot.stateVersion + 1
  const digest = sha256Hex(contextStateDigestInput(nextVersion, derived.entries))
  const updated = await updateRunProjectContext(tx, snapshot.id, {
    stateVersion: nextVersion,
    stateDigest: digest,
    stateUpdatedAt: now,
    status: derived.status,
  })
  if (updated === undefined) throw new Error('run project context update returned no row')
  return {
    snapshot: updated,
    entries: derived.entries,
    changed: true,
    state: toRunContextState(updated, derived.entries, now),
  }
}

/** 只读派生当前快照状态（下载/读面用；不写库、不推进版本）。 */
export async function deriveRunContextStateReadOnly(
  tx: Tx,
  snapshotId: string,
  now: Date,
): Promise<
  | {
      readonly status: RunProjectContextRow['status']
      readonly entries: readonly RunContextStateEntry[]
    }
  | undefined
> {
  const [snapshot] = await tx
    .select()
    .from(schema.runProjectContexts)
    .where(eq(schema.runProjectContexts.id, snapshotId))
  if (snapshot === undefined) return undefined
  const derived = await deriveSnapshot(tx, snapshot, now)
  return { status: derived.status, entries: derived.entries }
}

export function toRunContextState(
  snapshot: RunProjectContextRow,
  entries: readonly RunContextStateEntry[],
  now: Date,
): RunContextState {
  // state_version=0 只可能出现在升级前且尚未刷新的行；对外状态帧必须带正版本。
  const stateVersion = snapshot.stateVersion === 0 ? 1 : snapshot.stateVersion
  const stateDigest =
    snapshot.stateDigest ?? sha256Hex(contextStateDigestInput(stateVersion, entries))
  return {
    runId: snapshot.runId,
    snapshotId: snapshot.id,
    stateVersion,
    stateDigest,
    entries: [...entries],
    generatedAt: now.toISOString(),
  }
}

async function hasPendingCommand(tx: Tx, type: string, runId: string): Promise<boolean> {
  const [row] = await tx
    .select({ id: schema.dispatchOutbox.id })
    .from(schema.dispatchOutbox)
    .where(
      and(
        eq(schema.dispatchOutbox.type, type),
        isNull(schema.dispatchOutbox.ackedAt),
        isNull(schema.dispatchOutbox.failedAt),
        sql`${schema.dispatchOutbox.payload}->>'runId' = ${runId}`,
      ),
    )
    .limit(1)
  return row !== undefined
}

async function activeRunForSnapshot(
  tx: Tx,
  runId: string,
): Promise<Pick<RunRow, 'id' | 'deviceId' | 'status'> | undefined> {
  const [run] = await tx
    .select({ id: schema.runs.id, deviceId: schema.runs.deviceId, status: schema.runs.status })
    .from(schema.runs)
    .where(eq(schema.runs.id, runId))
  if (run === undefined) return undefined
  return (ACTIVE_RUN_CONTEXT_STATUSES as readonly string[]).includes(run.status) ? run : undefined
}

/**
 * 入队完整状态。不做 pending 去重：状态变化必须尽快下发；旧帧先到也会被 Node
 * 按 stateVersion 拒绝覆盖，重复帧幂等。心跳帧仍做 pending 去重（见下）。
 */
export async function enqueueRunContextState(
  tx: Tx,
  deps: RunContextStateDeps,
  state: RunContextState,
): Promise<boolean> {
  const run = await activeRunForSnapshot(tx, state.runId)
  if (run === undefined) return false
  const commandId = uuidv7(deps.now().getTime())
  await deps.outbox.enqueue(tx, {
    id: commandId,
    deviceId: run.deviceId,
    type: 'run.context_state',
    payload: { ...state, commandId },
  })
  return true
}

async function enqueueContextStateSync(
  tx: Tx,
  deps: RunContextStateDeps,
  state: RunContextState,
  notBefore: Date,
): Promise<boolean> {
  const run = await activeRunForSnapshot(tx, state.runId)
  if (run === undefined) return false
  if (await hasPendingCommand(tx, 'context.state_sync', state.runId)) return false
  const commandId = uuidv7(deps.now().getTime())
  await deps.outbox.enqueue(tx, {
    id: commandId,
    deviceId: run.deviceId,
    type: 'context.state_sync',
    payload: {
      commandId,
      runId: state.runId,
      snapshotId: state.snapshotId,
      stateVersion: state.stateVersion,
      stateDigest: state.stateDigest,
      at: state.generatedAt,
    },
    notBefore,
  })
  return true
}

export interface RunContextStateRefreshSummary {
  readonly refreshed: number
  readonly changed: number
  readonly heartbeats: number
}

/** 周期 tick：重算所有活跃快照；变化发完整状态，无变化发水位帧（20 秒节流）。 */
export async function syncActiveRunContextStates(
  deps: RunContextStateDeps,
): Promise<RunContextStateRefreshSummary> {
  const now = deps.now()
  const snapshots = await listActiveRunContextSnapshots(deps.database.db)
  let refreshed = 0
  let changed = 0
  let heartbeats = 0
  for (const item of snapshots) {
    if (item.entryCount === 0) continue
    try {
      await deps.database.transaction(async (tx) => {
        const result = await refreshRunContextState(tx, item.snapshotId, now)
        refreshed += 1
        if (result.changed) {
          if (await enqueueRunContextState(tx, deps, result.state)) changed += 1
          return
        }
        const notBefore = new Date(now.getTime() + RUN_CONTEXT_STATE_SYNC_INTERVAL_MS)
        if (await enqueueContextStateSync(tx, deps, result.state, notBefore)) heartbeats += 1
      })
    } catch (error) {
      // 单个快照被并发删除/迁移不应拖垮整轮；留归因后继续其他 Run。
      deps.log?.('context state sync skipped', {
        component: 'hub.context',
        runId: item.runId,
        snapshotId: item.snapshotId,
        errorName: error instanceof Error ? error.name : 'unknown',
      })
    }
  }
  return { refreshed, changed, heartbeats }
}

/** Node 重连/hello：把该设备所有活跃 Run 的完整当前状态立即下发（不只增量）。 */
export async function enqueueRunContextStatesForDevice(
  deps: RunContextStateDeps,
  deviceId: string,
): Promise<number> {
  const now = deps.now()
  const snapshots = await listActiveRunContextSnapshots(deps.database.db)
  let enqueued = 0
  for (const item of snapshots) {
    if (item.entryCount === 0) continue
    try {
      await deps.database.transaction(async (tx) => {
        const [run] = await tx
          .select({ deviceId: schema.runs.deviceId })
          .from(schema.runs)
          .where(eq(schema.runs.id, item.runId))
        if (run?.deviceId !== deviceId) return
        const result = await refreshRunContextState(tx, item.snapshotId, now)
        if (await enqueueRunContextState(tx, deps, result.state)) enqueued += 1
      })
    } catch (error) {
      deps.log?.('context state hello sync skipped', {
        component: 'hub.context',
        deviceId,
        runId: item.runId,
        errorName: error instanceof Error ? error.name : 'unknown',
      })
    }
  }
  return enqueued
}

/** 纠正/撤回后：刷新所有包含该 context_entry 的活跃快照。 */
export async function refreshRunContextStateForEntry(
  tx: Tx,
  deps: RunContextStateDeps,
  entryId: string,
  now: Date,
): Promise<number> {
  const snapshots = await listActiveRunContextSnapshotsForEntry(tx, entryId)
  let refreshed = 0
  for (const item of snapshots) {
    const result = await refreshRunContextState(tx, item.snapshotId, now)
    refreshed += 1
    if (result.changed) await enqueueRunContextState(tx, deps, result.state)
  }
  return refreshed
}

/** Hub 收到 `context.state_pull`：校验归属并回完整当前状态（至少一次；Node 按 stateVersion 幂等）。 */
export async function handleRunContextStatePull(
  deps: RunContextStateDeps,
  deviceId: string,
  pull: { readonly runId: string; readonly snapshotId: string },
): Promise<boolean> {
  const now = deps.now()
  return deps.database.transaction(async (tx) => {
    const [run] = await tx
      .select({ deviceId: schema.runs.deviceId, status: schema.runs.status })
      .from(schema.runs)
      .where(eq(schema.runs.id, pull.runId))
    if (run === undefined || run.deviceId !== deviceId) return false
    if (!(ACTIVE_RUN_CONTEXT_STATUSES as readonly string[]).includes(run.status)) return false
    const snapshot = await getRunProjectContextByRun(tx, pull.runId)
    if (snapshot === undefined || snapshot.id !== pull.snapshotId) return false
    const result = await refreshRunContextState(tx, snapshot.id, now)
    return enqueueRunContextState(tx, deps, result.state)
  })
}

/** Hub 收到 `context.state_ack`：落应用回执（重复版本幂等），不改变状态机。 */
export async function recordRunContextStateAck(
  deps: RunContextStateDeps,
  deviceId: string,
  ack: ContextStateAck,
): Promise<boolean> {
  return deps.database.transaction(async (tx) => {
    const [run] = await tx
      .select({
        id: schema.runs.id,
        deviceId: schema.runs.deviceId,
      })
      .from(schema.runs)
      .where(eq(schema.runs.id, ack.runId))
    if (run === undefined || run.deviceId !== deviceId) return false
    const snapshot = await getRunProjectContextByRun(tx, ack.runId)
    if (snapshot === undefined || snapshot.id !== ack.snapshotId) return false
    // 只接受当前或更早版本的应用回执；未来版本或当前版本摘要不符视为畸形。
    if (ack.stateVersion > snapshot.stateVersion) return false
    if (ack.stateVersion === snapshot.stateVersion && ack.stateDigest !== snapshot.stateDigest) {
      return false
    }
    await upsertRunContextStateAck(tx, {
      id: uuidv7(deps.now().getTime()),
      runId: ack.runId,
      snapshotId: ack.snapshotId,
      deviceId,
      stateVersion: ack.stateVersion,
      stateDigest: ack.stateDigest,
      appliedAt: new Date(ack.appliedAt),
      failedEntryIds: [...ack.failedEntryIds],
      receivedAt: deps.now(),
    })
    // 重复 ack 是幂等成功，不是非法回执。
    return true
  })
}

/**
 * 派发前复核：按当前来源/条目状态重新派生（只读），任一非 frozen → 不得派发。
 * 不在这里写状态行：周期 tick 或纠正事务会落库并下发；派发窗口只做拒绝判断。
 */
export async function verifyRunContextStateFrozen(
  tx: Tx,
  runId: string,
  now: Date = new Date(),
): Promise<{ readonly ok: true } | { readonly ok: false; readonly reason: string }> {
  const snapshot = await getRunProjectContextByRun(tx, runId)
  if (snapshot === undefined) return { ok: true }
  const derived = await deriveSnapshot(tx, snapshot, now)
  const unavailable = derived.entries.find((entry) => entry.state !== 'frozen')
  if (unavailable !== undefined) {
    return { ok: false, reason: `entry_${unavailable.state}` }
  }
  if (derived.status !== 'frozen') {
    return { ok: false, reason: `snapshot_${derived.status}` }
  }
  return { ok: true }
}
