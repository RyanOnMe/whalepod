/**
 * Event spool（P1-12；02 Task 12 Step 4）。
 *
 * Runtime 产出先按 (runId, seq) 落本地 SQLite，再发 Hub；Hub ack 后删除。
 * 崩溃恢复：未 ack 的事件重开仍在（Hub 未确认不丢）。重复 (runId, seq) 幂等。
 */
import { openStateDatabase } from '../state/db.js'

export interface SpooledEvent {
  readonly runId: string
  readonly seq: number
  readonly payload: string
}

export class EventStore {
  private readonly db: ReturnType<typeof openStateDatabase>

  constructor(path: string) {
    this.db = openStateDatabase(path)
    this.db.exec(`
      create table if not exists spooled_event (
        run_id text not null,
        seq integer not null,
        payload text not null,
        created_at text not null,
        primary key (run_id, seq)
      )
    `)
  }

  append(runId: string, seq: number, payload: string): 'recorded' | 'duplicate' {
    const result = this.db
      .prepare(
        'insert or ignore into spooled_event (run_id, seq, payload, created_at) values (?, ?, ?, ?)',
      )
      .run(runId, seq, payload, new Date().toISOString())
    return result.changes === 0 ? 'duplicate' : 'recorded'
  }

  pending(runId: string): SpooledEvent[] {
    const rows = this.db
      .prepare('select run_id, seq, payload from spooled_event where run_id = ? order by seq asc')
      .all(runId) as Array<{ run_id: string; seq: number; payload: string }>
    return rows.map((row) => ({ runId: row.run_id, seq: row.seq, payload: row.payload }))
  }

  /** Hub 确认后删除单条。 */
  ack(runId: string, seq: number): void {
    this.db.prepare('delete from spooled_event where run_id = ? and seq = ?').run(runId, seq)
  }

  /** Hub 按游标确认（ack 到某 seq 为止）——批量删除 ≤ untilSeq 的事件。 */
  ackUntil(runId: string, untilSeq: number): void {
    this.db.prepare('delete from spooled_event where run_id = ? and seq <= ?').run(runId, untilSeq)
  }

  close(): void {
    this.db.close()
  }
}
