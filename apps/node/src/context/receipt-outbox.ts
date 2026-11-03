/**
 * ADR-0027 §4（PC-05b-2）：Node→Hub `run.context_receipt` 的持久发件箱。
 *
 * 回执先入队再发送；连接断开/进程重启后仍保留，按 `(runId, snapshotId,
 * receiptSeq)` 升序重放；只有收到 Hub 的 `run.context_receipt_ack` 才删除。
 */
import type { RunContextReceipt } from '@whalepod/protocol'
import { existsSync } from 'node:fs'
import { openStateDatabase } from '../state/db.js'

export interface PendingContextReceipt {
  readonly receipt: RunContextReceipt
  readonly enqueuedAt: string
}

/** 未分配 receiptSeq 的回执草稿；seq 由发件箱在同一事务里分配并入队。 */
export type RunContextReceiptDraft = Omit<RunContextReceipt, 'receiptSeq'>

export interface RunContextReceiptOutbox {
  enqueue(receipt: RunContextReceipt, enqueuedAt: string): void
  /**
   * 原子分配 `(runId, snapshotId)` 的下一个 receiptSeq 并写入发件箱。
   * 崩溃/写失败不会留下「seq 已消费但没有待发项」的空洞。
   */
  enqueueNext(draft: RunContextReceiptDraft, enqueuedAt: string): RunContextReceipt
  pending(runId?: string): readonly PendingContextReceipt[]
  /**
   * 删除一条已确认回执（无论 accepted/duplicate/late/rejected）。
   * 只删精确 seq：Hub 允许序号空洞，ack 的 highestSeq 不能证明更低的
   * 未 ack 项已经落库，按区间删会丢掉 Hub 从未收到的读取事实。
   */
  ack(runId: string, snapshotId: string, receiptSeq: number): void
  size(): number
}

export class SqliteContextReceiptOutbox implements RunContextReceiptOutbox {
  private readonly db: ReturnType<typeof openStateDatabase>

  constructor(path: string) {
    this.db = openStateDatabase(path)
    this.db.exec(`
      create table if not exists context_receipt_outbox (
        run_id text not null,
        snapshot_id text not null,
        receipt_seq integer not null,
        frame text not null,
        enqueued_at text not null,
        primary key (run_id, snapshot_id, receipt_seq)
      )
    `)
    this.db.exec(`
      create table if not exists context_receipt_seq (
        run_id text not null,
        snapshot_id text not null,
        value integer not null,
        primary key (run_id, snapshot_id)
      )
    `)
  }

  enqueue(receipt: RunContextReceipt, enqueuedAt: string): void {
    this.db.exec('begin immediate')
    try {
      this.insertRow(receipt, enqueuedAt)
      this.db
        .prepare(
          `insert into context_receipt_seq (run_id, snapshot_id, value)
           values (?, ?, ?)
           on conflict (run_id, snapshot_id) do update set
             value = max(context_receipt_seq.value, excluded.value)`,
        )
        .run(receipt.runId, receipt.snapshotId, receipt.receiptSeq)
      this.db.exec('commit')
    } catch (error) {
      this.db.exec('rollback')
      throw error
    }
  }

  enqueueNext(draft: RunContextReceiptDraft, enqueuedAt: string): RunContextReceipt {
    this.db.exec('begin immediate')
    try {
      const row = this.db
        .prepare('select value from context_receipt_seq where run_id = ? and snapshot_id = ?')
        .get(draft.runId, draft.snapshotId) as { value: number } | undefined
      const receiptSeq = (row?.value ?? 0) + 1
      this.db
        .prepare(
          `insert into context_receipt_seq (run_id, snapshot_id, value)
           values (?, ?, ?)
           on conflict (run_id, snapshot_id) do update set value = excluded.value`,
        )
        .run(draft.runId, draft.snapshotId, receiptSeq)
      const receipt: RunContextReceipt = { ...draft, receiptSeq }
      this.insertRow(receipt, enqueuedAt)
      this.db.exec('commit')
      return receipt
    } catch (error) {
      this.db.exec('rollback')
      throw error
    }
  }

  /**
   * PC-05a 的 `context-receipts.sqlite`（列名 `next_seq`）升级迁移：新发件箱接管
   * 计数后，旧文件里的高水位必须带过来；否则升级后会从 1 重新发，被 Hub 当成
   * duplicate 静默丢掉新读事件。只升不降，旧文件保持原样。
   */
  seedFromLegacy(path: string): void {
    if (!existsSync(path)) return
    const legacy = openStateDatabase(path)
    let rows: { run_id: string; snapshot_id: string; next_seq: number }[]
    try {
      rows = legacy
        .prepare('select run_id, snapshot_id, next_seq from context_receipt_seq')
        .all() as { run_id: string; snapshot_id: string; next_seq: number }[]
    } catch {
      // 旧文件存在但没有计数表：没有可迁移的状态。
      return
    } finally {
      legacy.close()
    }
    if (rows.length === 0) return
    this.db.exec('begin immediate')
    try {
      const upsert = this.db.prepare(
        `insert into context_receipt_seq (run_id, snapshot_id, value)
         values (?, ?, ?)
         on conflict (run_id, snapshot_id) do update set
           value = max(context_receipt_seq.value, excluded.value)`,
      )
      for (const row of rows) upsert.run(row.run_id, row.snapshot_id, row.next_seq)
      this.db.exec('commit')
    } catch (error) {
      this.db.exec('rollback')
      throw error
    }
  }

  private insertRow(receipt: RunContextReceipt, enqueuedAt: string): void {
    this.db
      .prepare(
        `insert into context_receipt_outbox
           (run_id, snapshot_id, receipt_seq, frame, enqueued_at)
         values (?, ?, ?, ?, ?)
         on conflict (run_id, snapshot_id, receipt_seq) do update set
           frame = excluded.frame,
           enqueued_at = excluded.enqueued_at`,
      )
      .run(
        receipt.runId,
        receipt.snapshotId,
        receipt.receiptSeq,
        JSON.stringify(receipt),
        enqueuedAt,
      )
  }

  pending(runId?: string): readonly PendingContextReceipt[] {
    const rows =
      runId === undefined
        ? (this.db
            .prepare(
              `select frame, enqueued_at from context_receipt_outbox
               order by run_id, snapshot_id, receipt_seq`,
            )
            .all() as { frame: string; enqueued_at: string }[])
        : (this.db
            .prepare(
              `select frame, enqueued_at from context_receipt_outbox
               where run_id = ? order by snapshot_id, receipt_seq`,
            )
            .all(runId) as { frame: string; enqueued_at: string }[])
    return rows.map((row) => ({
      receipt: JSON.parse(row.frame) as RunContextReceipt,
      enqueuedAt: row.enqueued_at,
    }))
  }

  ack(runId: string, snapshotId: string, receiptSeq: number): void {
    this.db
      .prepare(
        `delete from context_receipt_outbox
         where run_id = ? and snapshot_id = ? and receipt_seq = ?`,
      )
      .run(runId, snapshotId, receiptSeq)
  }

  size(): number {
    const row = this.db.prepare('select count(*) as count from context_receipt_outbox').get() as
      | { count: number }
      | undefined
    return row?.count ?? 0
  }

  /** 测试重开同一文件用；生产进程随 Node 退出。 */
  closeForTest(): void {
    this.db.close()
  }
}

/** 单测/无状态装配用内存实现；语义与 SQLite 版一致。 */
export class MemoryContextReceiptOutbox implements RunContextReceiptOutbox {
  private readonly items = new Map<string, PendingContextReceipt>()
  private readonly nextSeq = new Map<string, number>()

  enqueue(receipt: RunContextReceipt, enqueuedAt: string): void {
    const seqKey = `${receipt.runId}|${receipt.snapshotId}`
    this.nextSeq.set(seqKey, Math.max(this.nextSeq.get(seqKey) ?? 0, receipt.receiptSeq))
    this.items.set(`${seqKey}|${receipt.receiptSeq}`, {
      receipt,
      enqueuedAt,
    })
  }

  enqueueNext(draft: RunContextReceiptDraft, enqueuedAt: string): RunContextReceipt {
    const seqKey = `${draft.runId}|${draft.snapshotId}`
    const receiptSeq = (this.nextSeq.get(seqKey) ?? 0) + 1
    const receipt: RunContextReceipt = { ...draft, receiptSeq }
    this.enqueue(receipt, enqueuedAt)
    return receipt
  }

  pending(runId?: string): readonly PendingContextReceipt[] {
    return [...this.items.values()]
      .filter((item) => runId === undefined || item.receipt.runId === runId)
      .sort(
        (a, b) =>
          a.receipt.runId.localeCompare(b.receipt.runId) ||
          a.receipt.snapshotId.localeCompare(b.receipt.snapshotId) ||
          a.receipt.receiptSeq - b.receipt.receiptSeq,
      )
  }

  ack(runId: string, snapshotId: string, receiptSeq: number): void {
    this.items.delete(`${runId}|${snapshotId}|${receiptSeq}`)
  }

  size(): number {
    return this.items.size
  }
}
