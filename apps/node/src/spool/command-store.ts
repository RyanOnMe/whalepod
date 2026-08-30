/**
 * Command spool（P1-12；02 Task 12 Step 4）。
 *
 * Node 在 ack run.start 之前先把 command（含 runtime intent）写入本地 SQLite；
 * Hub 确认（ack）后标记完成。崩溃/重启后 pending 仍在，恢复流程据此重放。
 * 重复 commandId 幂等：重复投递得到确定性结果（'duplicate'），不产生第二行。
 */
import { openStateDatabase } from '../state/db.js'

export type CommandType = 'run.start' | 'run.cancel'

export interface SpooledCommand {
  readonly commandId: string
  readonly runId: string
  readonly type: CommandType
  readonly payload: unknown
  readonly receivedAt: string
}

export type RecordOutcome = 'recorded' | 'duplicate'

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
        acked_at text
      )
    `)
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
