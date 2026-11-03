/**
 * ADR-0027 §6（PC-05b-3）：Run 终态清理的持久队列与 Run home 事实。
 *
 * 终态帧到达时只登记任务；Runtime 子进程退出确认后才执行删除。任务落 Node
 * SQLite，Node 重启先清扫、运行期每小时重试；失败保留 `cleanup_pending`，
 * 不因进程退出丢失。
 */
import { openStateDatabase } from '../state/db.js'

export type TerminalCleanupState = 'pending' | 'deferred' | 'cleanup_pending' | 'done'

export interface RunRuntimeFacts {
  readonly runId: string
  /** 本 Run 实际使用的 DSH_HOME（resume Run 为来源 Run 的 home）。 */
  readonly homePath: string
  /** 非空项目上下文 Run = 快照条目数 > 0；0 = 空快照/无上下文。 */
  readonly entryCount: number
  /**
   * home 是否归本 Run 所有。resume Run 复用来源 Run 的 home，值为 false：
   * spawn 前失败只能清理本 Run 的 runtime-context，绝不能删来源 Run 的 session。
   */
  readonly ownsHome: boolean
  /** 是否已收到 runtime.ready（本 Run 的 session 可能已写入 home）。 */
  readonly sessionReady: boolean
  /** runtime.ready 回报的 DSH session id（重启后的 lost 快照也要能带上）。 */
  readonly dshSessionId: string | null
}

export interface TerminalCleanupTask extends Omit<RunRuntimeFacts, 'dshSessionId'> {
  readonly runTerminalAt: string
  readonly dueAt: string
  readonly attempts: number
  readonly lastError: string | null
  readonly state: TerminalCleanupState
}

export interface RunTerminalCleanupStore {
  putFacts(facts: RunRuntimeFacts, updatedAt: string): void
  getFacts(runId: string): RunRuntimeFacts | undefined
  /** 有 facts 但没有清理任务（prepare 后崩溃/队列写失败）——启动对账用。 */
  factsNotScheduled(): readonly RunRuntimeFacts[]
  /** runtime.ready 后补事实；facts 不存在时 no-op（旧库/异常路径不造新事实）。 */
  markSessionReady(runId: string, dshSessionId: string, updatedAt: string): void
  /**
   * 新一次 run.start 处理前清掉上一生命周期的 done 行：启动对账可能已把崩溃
   * 残留当孤儿清完，Hub 随后按同一 commandId 重投；若保留 done，终态登记会被
   * `on conflict do nothing` 吞掉，重跑后的 runtime-context/spill 永远不清理。
   * 只删 done；pending/deferred/cleanup_pending 仍由既有任务继续收敛。
   * 写失败向上抛出：本次 run.start 按 fail-closed 拒绝，不得吞错继续（否则
   * done 毒化会再次出现）。
   */
  reopen(runId: string): void
  /** 终态登记；重复终态不重置既有任务状态。 */
  schedule(input: {
    runId: string
    homePath: string
    entryCount: number
    ownsHome: boolean
    sessionReady: boolean
    runTerminalAt: string
    dueAt: string
  }): void
  get(runId: string): TerminalCleanupTask | undefined
  /** 到期待处理（state != done 且 due_at <= now）。 */
  due(now: Date): readonly TerminalCleanupTask[]
  /** 启动清扫：所有未完成任务，忽略 due_at。 */
  notDone(): readonly TerminalCleanupTask[]
  markDeferred(runId: string, dueAt: string, updatedAt: string): void
  markFailure(runId: string, lastError: string, dueAt: string, updatedAt: string): void
  markDone(runId: string, updatedAt: string): void
}

interface TaskRow {
  run_id: string
  home_path: string
  entry_count: number
  owns_home: number
  session_ready: number
  run_terminal_at: string
  due_at: string
  attempts: number
  last_error: string | null
  state: TerminalCleanupState
}

function rowToTask(row: TaskRow): TerminalCleanupTask {
  return {
    runId: row.run_id,
    homePath: row.home_path,
    entryCount: row.entry_count,
    ownsHome: row.owns_home !== 0,
    sessionReady: row.session_ready !== 0,
    runTerminalAt: row.run_terminal_at,
    dueAt: row.due_at,
    attempts: row.attempts,
    lastError: row.last_error,
    state: row.state,
  }
}

export class SqliteRunTerminalCleanupStore implements RunTerminalCleanupStore {
  private readonly db: ReturnType<typeof openStateDatabase>

  constructor(path: string) {
    this.db = openStateDatabase(path)
    this.db.exec(`
      create table if not exists run_runtime_facts (
        run_id text primary key,
        home_path text not null,
        entry_count integer not null default 0,
        owns_home integer not null default 1,
        session_ready integer not null default 0,
        dsh_session_id text,
        updated_at text not null
      )
    `)
    this.db.exec(`
      create table if not exists run_terminal_cleanup (
        run_id text primary key,
        home_path text not null,
        entry_count integer not null default 0,
        owns_home integer not null default 1,
        session_ready integer not null default 0,
        run_terminal_at text not null,
        due_at text not null,
        attempts integer not null default 0,
        last_error text,
        state text not null,
        updated_at text not null
      )
    `)
    // 本切片开发期建的库可能缺后加列；正式发布前不存在该表，但补列让本地升级
    // 不必删 state dir（sqlite 没有 add column if not exists）。
    this.ensureColumn('run_runtime_facts', 'owns_home', 'owns_home integer not null default 1')
    this.ensureColumn(
      'run_runtime_facts',
      'session_ready',
      'session_ready integer not null default 0',
    )
    this.ensureColumn('run_runtime_facts', 'dsh_session_id', 'dsh_session_id text')
    this.ensureColumn('run_terminal_cleanup', 'owns_home', 'owns_home integer not null default 1')
    this.ensureColumn(
      'run_terminal_cleanup',
      'session_ready',
      'session_ready integer not null default 0',
    )
    this.db.exec(
      'create index if not exists run_terminal_cleanup_due_idx on run_terminal_cleanup (due_at)',
    )
  }

  private ensureColumn(table: string, name: string, ddl: string): void {
    const columns = this.db.prepare(`pragma table_info(${table})`).all() as unknown as Array<{
      name: string
    }>
    if (!columns.some((column) => column.name === name)) {
      this.db.exec(`alter table ${table} add column ${ddl}`)
    }
  }

  putFacts(facts: RunRuntimeFacts, updatedAt: string): void {
    this.db
      .prepare(
        `insert into run_runtime_facts (run_id, home_path, entry_count, owns_home, session_ready, dsh_session_id, updated_at)
         values (?, ?, ?, ?, ?, ?, ?)
         on conflict (run_id) do update set
           home_path = excluded.home_path,
           entry_count = excluded.entry_count,
           owns_home = excluded.owns_home,
           -- 崩溃后重处理同一条未 ack 的 run.start 时，调用方会再次以
           -- sessionReady=false/dshSessionId=null 落 facts；已持久化的 ready
           -- 事实绝不能被降级，否则共享 home 会被误判为“未写过”。
           session_ready = max(run_runtime_facts.session_ready, excluded.session_ready),
           dsh_session_id = coalesce(excluded.dsh_session_id, run_runtime_facts.dsh_session_id),
           updated_at = excluded.updated_at`,
      )
      .run(
        facts.runId,
        facts.homePath,
        facts.entryCount,
        facts.ownsHome ? 1 : 0,
        facts.sessionReady ? 1 : 0,
        facts.dshSessionId,
        updatedAt,
      )
  }

  getFacts(runId: string): RunRuntimeFacts | undefined {
    const row = this.db
      .prepare(
        'select run_id, home_path, entry_count, owns_home, session_ready, dsh_session_id from run_runtime_facts where run_id = ?',
      )
      .get(runId) as
      | {
          run_id: string
          home_path: string
          entry_count: number
          owns_home: number
          session_ready: number
          dsh_session_id: string | null
        }
      | undefined
    return row === undefined
      ? undefined
      : {
          runId: row.run_id,
          homePath: row.home_path,
          entryCount: row.entry_count,
          ownsHome: row.owns_home !== 0,
          sessionReady: row.session_ready !== 0,
          dshSessionId: row.dsh_session_id,
        }
  }

  factsNotScheduled(): readonly RunRuntimeFacts[] {
    const rows = this.db
      .prepare(
        `select f.run_id, f.home_path, f.entry_count, f.owns_home, f.session_ready, f.dsh_session_id
         from run_runtime_facts f
         left join run_terminal_cleanup t on t.run_id = f.run_id
         where t.run_id is null
         order by f.run_id`,
      )
      .all() as unknown as Array<{
      run_id: string
      home_path: string
      entry_count: number
      owns_home: number
      session_ready: number
      dsh_session_id: string | null
    }>
    return rows.map((row) => ({
      runId: row.run_id,
      homePath: row.home_path,
      entryCount: row.entry_count,
      ownsHome: row.owns_home !== 0,
      sessionReady: row.session_ready !== 0,
      dshSessionId: row.dsh_session_id,
    }))
  }

  markSessionReady(runId: string, dshSessionId: string, updatedAt: string): void {
    this.db
      .prepare(
        'update run_runtime_facts set session_ready = 1, dsh_session_id = ?, updated_at = ? where run_id = ?',
      )
      .run(dshSessionId, updatedAt, runId)
    // 下发失败可能已经登记了任务（ready 之前）；任务行必须同步，否则 tick 仍按
    // sessionReady=false 早退，留下“blocked 但共享 home 没清”。
    this.db
      .prepare(
        "update run_terminal_cleanup set session_ready = 1, updated_at = ? where run_id = ? and state <> 'done'",
      )
      .run(updatedAt, runId)
  }

  reopen(runId: string): void {
    this.db
      .prepare("delete from run_terminal_cleanup where run_id = ? and state = 'done'")
      .run(runId)
  }

  schedule(input: {
    runId: string
    homePath: string
    entryCount: number
    ownsHome: boolean
    sessionReady: boolean
    runTerminalAt: string
    dueAt: string
  }): void {
    // 已有任务（含 failed/done）不被重复终态帧重置。
    this.db
      .prepare(
        `insert into run_terminal_cleanup
           (run_id, home_path, entry_count, owns_home, session_ready, run_terminal_at, due_at, attempts, last_error, state, updated_at)
         values (?, ?, ?, ?, ?, ?, ?, 0, null, 'pending', ?)
         on conflict (run_id) do nothing`,
      )
      .run(
        input.runId,
        input.homePath,
        input.entryCount,
        input.ownsHome ? 1 : 0,
        input.sessionReady ? 1 : 0,
        input.runTerminalAt,
        input.dueAt,
        input.runTerminalAt,
      )
  }

  get(runId: string): TerminalCleanupTask | undefined {
    const row = this.db
      .prepare('select * from run_terminal_cleanup where run_id = ?')
      .get(runId) as TaskRow | undefined
    return row === undefined ? undefined : rowToTask(row)
  }

  due(now: Date): readonly TerminalCleanupTask[] {
    const rows = this.db
      .prepare(
        `select * from run_terminal_cleanup
         where state <> 'done' and due_at <= ?
         order by run_terminal_at, run_id`,
      )
      .all(now.toISOString()) as unknown as TaskRow[]
    return rows.map(rowToTask)
  }

  notDone(): readonly TerminalCleanupTask[] {
    const rows = this.db
      .prepare(
        `select * from run_terminal_cleanup
         where state <> 'done'
         order by run_terminal_at, run_id`,
      )
      .all() as unknown as TaskRow[]
    return rows.map(rowToTask)
  }

  markDeferred(runId: string, dueAt: string, updatedAt: string): void {
    this.db
      .prepare(
        `update run_terminal_cleanup
         set state = 'deferred', due_at = ?, last_error = null, updated_at = ?
         where run_id = ? and state <> 'done'`,
      )
      .run(dueAt, updatedAt, runId)
  }

  markFailure(runId: string, lastError: string, dueAt: string, updatedAt: string): void {
    this.db
      .prepare(
        `update run_terminal_cleanup
         set state = 'cleanup_pending', attempts = attempts + 1, last_error = ?,
             due_at = ?, updated_at = ?
         where run_id = ? and state <> 'done'`,
      )
      .run(lastError, dueAt, updatedAt, runId)
  }

  markDone(runId: string, updatedAt: string): void {
    this.db
      .prepare(
        `update run_terminal_cleanup
         set state = 'done', last_error = null, updated_at = ?
         where run_id = ?`,
      )
      .run(updatedAt, runId)
  }
}

/** 单测/无状态装配用内存实现；语义与 SQLite 版一致。 */
export class MemoryRunTerminalCleanupStore implements RunTerminalCleanupStore {
  private readonly facts = new Map<string, RunRuntimeFacts>()
  private readonly tasks = new Map<string, TerminalCleanupTask>()

  putFacts(facts: RunRuntimeFacts, updatedAt?: string): void {
    void updatedAt
    const previous = this.facts.get(facts.runId)
    this.facts.set(
      facts.runId,
      previous === undefined
        ? facts
        : {
            ...facts,
            sessionReady: previous.sessionReady || facts.sessionReady,
            dshSessionId: facts.dshSessionId ?? previous.dshSessionId,
          },
    )
  }

  getFacts(runId: string): RunRuntimeFacts | undefined {
    return this.facts.get(runId)
  }

  factsNotScheduled(): readonly RunRuntimeFacts[] {
    return [...this.facts.values()].filter((facts) => !this.tasks.has(facts.runId))
  }

  markSessionReady(runId: string, dshSessionId: string, updatedAt: string): void {
    void updatedAt
    const facts = this.facts.get(runId)
    if (facts === undefined) return
    this.facts.set(runId, { ...facts, sessionReady: true, dshSessionId })
    const task = this.tasks.get(runId)
    if (task !== undefined && task.state !== 'done') {
      this.tasks.set(runId, { ...task, sessionReady: true })
    }
  }

  reopen(runId: string): void {
    if (this.tasks.get(runId)?.state === 'done') this.tasks.delete(runId)
  }

  schedule(input: {
    runId: string
    homePath: string
    entryCount: number
    ownsHome: boolean
    sessionReady: boolean
    runTerminalAt: string
    dueAt: string
  }): void {
    if (this.tasks.has(input.runId)) return
    this.tasks.set(input.runId, {
      ...input,
      attempts: 0,
      lastError: null,
      state: 'pending',
    })
  }

  get(runId: string): TerminalCleanupTask | undefined {
    return this.tasks.get(runId)
  }

  due(now: Date): readonly TerminalCleanupTask[] {
    return [...this.tasks.values()]
      .filter((task) => task.state !== 'done' && task.dueAt <= now.toISOString())
      .sort(
        (a, b) => a.runTerminalAt.localeCompare(b.runTerminalAt) || a.runId.localeCompare(b.runId),
      )
  }

  notDone(): readonly TerminalCleanupTask[] {
    return [...this.tasks.values()]
      .filter((task) => task.state !== 'done')
      .sort(
        (a, b) => a.runTerminalAt.localeCompare(b.runTerminalAt) || a.runId.localeCompare(b.runId),
      )
  }

  markDeferred(runId: string, dueAt: string, updatedAt: string): void {
    void updatedAt
    const task = this.tasks.get(runId)
    if (task === undefined || task.state === 'done') return
    this.tasks.set(runId, { ...task, state: 'deferred', dueAt, lastError: null })
  }

  markFailure(runId: string, lastError: string, dueAt: string, updatedAt: string): void {
    void updatedAt
    const task = this.tasks.get(runId)
    if (task === undefined || task.state === 'done') return
    this.tasks.set(runId, {
      ...task,
      state: 'cleanup_pending',
      attempts: task.attempts + 1,
      lastError,
      dueAt,
    })
  }

  markDone(runId: string, updatedAt: string): void {
    void updatedAt
    const task = this.tasks.get(runId)
    if (task === undefined) return
    this.tasks.set(runId, { ...task, state: 'done', lastError: null })
  }
}
