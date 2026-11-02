/**
 * ADR-0027 §4：Node 侧 `run.context_receipt.receiptSeq` 的持久计数。
 *
 * Hub 要求同一 `(runId,snapshotId)` 的 receiptSeq 单调且不重复；进程重启后若从 1
 * 重新计数，后续所有回执都会被 Hub 判为重复而静默失效。因此计数落在 Node 本地
 * SQLite（与 command/event spool 同一状态目录纪律），`next()` 先读后写，同一
 * 进程内由同步调用串行化。
 */
import { openStateDatabase } from '../state/db.js'

export interface ContextReceiptSeqStore {
  next(runId: string, snapshotId: string): number
}

export class SqliteContextReceiptSeqStore implements ContextReceiptSeqStore {
  private readonly db: ReturnType<typeof openStateDatabase>

  constructor(path: string) {
    this.db = openStateDatabase(path)
    this.db.exec(`
      create table if not exists context_receipt_seq (
        run_id text not null,
        snapshot_id text not null,
        next_seq integer not null,
        primary key (run_id, snapshot_id)
      )
    `)
  }

  next(runId: string, snapshotId: string): number {
    const row = this.db
      .prepare('select next_seq from context_receipt_seq where run_id = ? and snapshot_id = ?')
      .get(runId, snapshotId) as { next_seq: number } | undefined
    const next = (row?.next_seq ?? 0) + 1
    this.db
      .prepare(
        `insert into context_receipt_seq (run_id, snapshot_id, next_seq)
         values (?, ?, ?)
         on conflict (run_id, snapshot_id) do update set next_seq = excluded.next_seq`,
      )
      .run(runId, snapshotId, next)
    return next
  }
}

/** 单测/无状态装配用内存计数（生产用 SQLite 持久实现）。 */
export class MemoryContextReceiptSeqStore implements ContextReceiptSeqStore {
  private readonly counters = new Map<string, number>()

  next(runId: string, snapshotId: string): number {
    const key = `${runId}|${snapshotId}`
    const next = (this.counters.get(key) ?? 0) + 1
    this.counters.set(key, next)
    return next
  }
}
