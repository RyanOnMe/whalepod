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
    // P1-13：seq 分配器与 spool 同库同事务——崩溃不会产生「已分配未写入」的
    // 缺口（缺口会让 Hub 连续水位 ack 永远越过不了）。
    this.db.exec(`
      create table if not exists run_event_seq (
        run_id text primary key,
        next_seq integer not null
      )
    `)
  }

  /**
   * 原子分配 seq 并写入（BEGIN IMMEDIATE 单事务；调用方用 build(seq) 把真实
   * seq 嵌进 payload 再序列化）。返回分配的 seq。重复调用 seq 单调递增。
   */
  appendAlloc(runId: string, build: (seq: number) => string): number {
    this.db.exec('begin immediate')
    try {
      const row = this.db
        .prepare('select next_seq from run_event_seq where run_id = ?')
        .get(runId) as { next_seq: number } | undefined
      const seq = row?.next_seq ?? 1
      if (row === undefined) {
        this.db.prepare('insert into run_event_seq (run_id, next_seq) values (?, 2)').run(runId)
      } else {
        this.db
          .prepare('update run_event_seq set next_seq = ? where run_id = ?')
          .run(seq + 1, runId)
      }
      this.db
        .prepare('insert into spooled_event (run_id, seq, payload, created_at) values (?, ?, ?, ?)')
        .run(runId, seq, build(seq), new Date().toISOString())
      this.db.exec('commit')
      return seq
    } catch (error) {
      this.db.exec('rollback')
      throw error
    }
  }

  /** 心跳上报用（03 §6.2 lastEventSeqByRun）：每 run 已分配的最高 seq（含已 ack）。 */
  seqWatermarkByRun(): Record<string, number> {
    const rows = this.db
      .prepare('select run_id, next_seq from run_event_seq')
      .all() as unknown as Array<{ run_id: string; next_seq: number }>
    const out: Record<string, number> = {}
    for (const row of rows) out[row.run_id] = row.next_seq - 1
    return out
  }

  /** 有待发事件的 run 列表（重连后全量 drain 的驱动源，R1）。 */
  runIdsWithPending(): string[] {
    const rows = this.db
      .prepare('select distinct run_id from spooled_event order by run_id asc')
      .all() as unknown as Array<{ run_id: string }>
    return rows.map((row) => row.run_id)
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
      .all(runId) as unknown as Array<{ run_id: string; seq: number; payload: string }>
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
