/**
 * Command spool（P1-12；02 Task 12 Step 4）。
 *
 * Node 在 ack run.start 之前先把 command（含 runtime intent）写入本地 SQLite；
 * Hub 确认（ack）后标记完成。重复 commandId 幂等：重复投递得到确定性结果
 * （'duplicate'），不产生第二行。
 *
 * ## 恢复语义（#181 评审 O1 纠正：别把它当"自动重放"）
 *
 * `run.start` 的恢复是**读最新一条**（`latestForRun(runId, 'run.start')`，重建 Run
 * 投影）；其余 command（含 `run.followup`）本 Node **不主动重放**——ack 丢失时的唯一
 * 恢复路径是 Hub 按同一 commandId 重投。`pending()` 目前只有测试消费者。
 *
 * 表**只进不出**：没有删除与保留期，payload 全文入库（`run.followup` 会把增长率从
 * 「每 Run 一行」变成「每条消息一行、每行最多 20 000 字」）。这是已登记的已知项，
 * 清理策略与 §9 的日志保留期一起定。
 */
import { openStateDatabase } from '../state/db.js'

export type CommandType = 'run.start' | 'run.cancel' | 'run.followup'

export interface SpooledCommand {
  readonly commandId: string
  readonly runId: string
  readonly type: CommandType
  readonly payload: unknown
  readonly receivedAt: string
}

export type RecordOutcome = 'recorded' | 'duplicate'

/**
 * 首次处理该 command 的结果（#181 阻断 B1）。
 *
 * 为什么必须持久化：只记「见过这个 commandId」不足以在重复投递时回放正确的 ack——
 * 首次可能是**拒绝**（未 ready / 终态 / 未知），那时如果重投一律回 `accepted=true`，
 * 就造出「已受理、零痕迹、未执行」的假受理：那句话从未进 Runtime stdin，而 Hub
 * outbox 会因这条 ack 落 `acked_at`、**永不重投**。所以结果本身要落库，重复投递
 * 按当初的真实结果回放。
 */
export type HandlingOutcome = 'accepted' | 'rejected'

export class CommandStore {
  private readonly db: ReturnType<typeof openStateDatabase>

  constructor(path: string) {
    this.db = openStateDatabase(path)
    this.db.exec(`
      create table if not exists spooled_command (
        seq_id integer primary key autoincrement,
        command_id text not null unique,
        run_id text not null,
        type text not null,
        payload text not null,
        received_at text not null,
        acked_at text,
        outcome text,
        error_code text,
        error_message text
      )
    `)
    // 老库补列（#181 B1）：sqlite 没有 add column if not exists，按 pragma 结果判断。
    this.ensureColumn('outcome', 'outcome text')
    this.ensureColumn('error_code', 'error_code text')
    this.ensureColumn('error_message', 'error_message text')
  }

  private ensureColumn(name: string, ddl: string): void {
    const columns = this.db
      .prepare('pragma table_info(spooled_command)')
      .all() as unknown as Array<{
      name: string
    }>
    if (!columns.some((column) => column.name === name)) {
      this.db.exec(`alter table spooled_command add column ${ddl}`)
    }
  }

  record(command: Omit<SpooledCommand, 'receivedAt'> & { receivedAt?: string }): RecordOutcome {
    const receivedAt = command.receivedAt ?? new Date().toISOString()
    const result = this.db
      .prepare(
        'insert or ignore into spooled_command (command_id, run_id, type, payload, received_at) values (?, ?, ?, ?, ?)',
      )
      .run(
        command.commandId,
        command.runId,
        command.type,
        JSON.stringify(command.payload ?? {}),
        receivedAt,
      )
    return result.changes === 0 ? 'duplicate' : 'recorded'
  }

  /** 未 ack 的 command，按接收序稳定排列（重放顺序确定）。 */
  pending(): SpooledCommand[] {
    const rows = this.db
      .prepare(
        'select command_id, run_id, type, payload, received_at from spooled_command where acked_at is null order by seq_id asc',
      )
      .all() as unknown as Array<{
      command_id: string
      run_id: string
      type: string
      payload: string
      received_at: string
    }>
    return rows.map((row) => ({
      commandId: row.command_id,
      runId: row.run_id,
      type: row.type as CommandType,
      payload: JSON.parse(row.payload) as unknown,
      receivedAt: row.received_at,
    }))
  }

  markAcked(commandId: string): void {
    this.db
      .prepare('update spooled_command set acked_at = ? where command_id = ?')
      .run(new Date().toISOString(), commandId)
  }

  /**
   * 记录首次处理结果并同时标记 ack（两者是同一时刻的事实：只在该 command 被
   * 受理或拒绝时才回 ack）。重复投递靠 {@link outcomeOf} 回放这一结果。
   */
  recordOutcome(
    commandId: string,
    outcome: HandlingOutcome,
    error?: { code: string; message: string },
  ): void {
    this.db
      .prepare(
        'update spooled_command set outcome = ?, error_code = ?, error_message = ?, acked_at = ? where command_id = ?',
      )
      .run(
        outcome,
        error?.code ?? null,
        error?.message ?? null,
        new Date().toISOString(),
        commandId,
      )
  }

  /** 首次处理结果；从未处理完（崩溃在 record 与处理之间）→ undefined。 */
  outcomeOf(
    commandId: string,
  ): { outcome: HandlingOutcome; error?: { code: string; message: string } } | undefined {
    const row = this.db
      .prepare(
        'select outcome, error_code, error_message from spooled_command where command_id = ?',
      )
      .get(commandId) as
      | { outcome: string | null; error_code: string | null; error_message: string | null }
      | undefined
    if (row === undefined || row.outcome === null) return undefined
    return {
      outcome: row.outcome as HandlingOutcome,
      ...(row.error_code !== null && row.error_message !== null
        ? { error: { code: row.error_code, message: row.error_message } }
        : {}),
    }
  }

  /** P1-16：该 command 是否已完成过一次完整处理（spawn 成功或拒绝后 ack）。 */
  isAcked(commandId: string): boolean {
    const row = this.db
      .prepare('select acked_at from spooled_command where command_id = ?')
      .get(commandId) as { acked_at: string | null } | undefined
    return row !== undefined && row.acked_at !== null
  }

  /**
   * P1-16：某 run 最近一条指定类型 command（含已 ack）。
   * Node 重启后重建 Run 投影（run.snapshot 的字段事实源）。
   */
  latestForRun(runId: string, type: CommandType): SpooledCommand | undefined {
    const row = this.db
      .prepare(
        'select command_id, run_id, type, payload, received_at from spooled_command where run_id = ? and type = ? order by seq_id desc limit 1',
      )
      .get(runId, type) as
      | { command_id: string; run_id: string; type: string; payload: string; received_at: string }
      | undefined
    if (row === undefined) return undefined
    return {
      commandId: row.command_id,
      runId: row.run_id,
      type: row.type as CommandType,
      payload: JSON.parse(row.payload) as unknown,
      receivedAt: row.received_at,
    }
  }

  close(): void {
    this.db.close()
  }
}
