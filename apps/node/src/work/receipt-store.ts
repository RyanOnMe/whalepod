/**
 * ADR-0028 §3（RD-02a-2b）：Node 侧工作输入回执的持久状态与待发队列。
 *
 * receiptSeq 必须跨进程重启单调；delivered/read 累计集合用于重建累计回执；
 * 断线时 `send` 失败的回执留在本地队列，重连后重放（60s 迟到回执依赖这一点）。
 */
import type { RunWorkInputReceipt } from '@whalepod/protocol'
import { openStateDatabase } from '../state/db.js'

export interface WorkInputReceiptSnapshot {
  readonly delivered: readonly string[]
  readonly read: readonly string[]
}

export interface WorkInputReceiptStore {
  snapshot(runId: string, manifestDigest: string): WorkInputReceiptSnapshot
  nextSeq(runId: string, manifestDigest: string): number
  addDelivered(runId: string, manifestDigest: string, itemIds: readonly string[]): void
  addRead(runId: string, manifestDigest: string, itemId: string): void
  enqueue(receipt: RunWorkInputReceipt): void
  pending(): readonly RunWorkInputReceipt[]
  removePending(runId: string, manifestDigest: string, receiptSeq: number): void
}

function merge(existing: readonly string[], incoming: readonly string[]): string[] {
  return [...new Set([...existing, ...incoming])].sort()
}

export class SqliteWorkInputReceiptStore implements WorkInputReceiptStore {
  private readonly db: ReturnType<typeof openStateDatabase>

  constructor(path: string) {
    this.db = openStateDatabase(path)
    this.db.exec(`
      create table if not exists work_input_receipt_state (
        run_id text not null,
        manifest_digest text not null,
        delivered text not null default '[]',
        read_items text not null default '[]',
        next_seq integer not null default 1,
        primary key (run_id, manifest_digest)
      );
      create table if not exists work_input_receipt_outbox (
        run_id text not null,
        manifest_digest text not null,
        receipt_seq integer not null,
        frame text not null,
        created_at text not null,
        primary key (run_id, manifest_digest, receipt_seq)
      );
    `)
  }

  snapshot(runId: string, manifestDigest: string): WorkInputReceiptSnapshot {
    const row = this.db
      .prepare(
        'select delivered, read_items from work_input_receipt_state where run_id = ? and manifest_digest = ?',
      )
      .get(runId, manifestDigest) as { delivered: string; read_items: string } | undefined
    return {
      delivered: parseArray(row?.delivered),
      read: parseArray(row?.read_items),
    }
  }

  nextSeq(runId: string, manifestDigest: string): number {
    const row = this.db
      .prepare(
        'select next_seq from work_input_receipt_state where run_id = ? and manifest_digest = ?',
      )
      .get(runId, manifestDigest) as { next_seq: number } | undefined
    const seq = row?.next_seq ?? 1
    this.db
      .prepare(
        `insert into work_input_receipt_state (run_id, manifest_digest, next_seq)
         values (?, ?, ?)
         on conflict (run_id, manifest_digest) do update set next_seq = excluded.next_seq`,
      )
      .run(runId, manifestDigest, seq + 1)
    return seq
  }

  addDelivered(runId: string, manifestDigest: string, itemIds: readonly string[]): void {
    const current = this.snapshot(runId, manifestDigest)
    this.writeSets(runId, manifestDigest, merge(current.delivered, itemIds), current.read)
  }

  addRead(runId: string, manifestDigest: string, itemId: string): void {
    const current = this.snapshot(runId, manifestDigest)
    this.writeSets(runId, manifestDigest, current.delivered, merge(current.read, [itemId]))
  }

  enqueue(receipt: RunWorkInputReceipt): void {
    this.db
      .prepare(
        `insert or replace into work_input_receipt_outbox
         (run_id, manifest_digest, receipt_seq, frame, created_at)
         values (?, ?, ?, ?, ?)`,
      )
      .run(
        receipt.runId,
        receipt.manifestDigest,
        receipt.receiptSeq,
        JSON.stringify(receipt),
        receipt.at,
      )
  }

  pending(): readonly RunWorkInputReceipt[] {
    const rows = this.db
      .prepare('select frame from work_input_receipt_outbox order by created_at asc')
      .all() as { frame: string }[]
    return rows.map((row) => JSON.parse(row.frame) as RunWorkInputReceipt)
  }

  removePending(runId: string, manifestDigest: string, receiptSeq: number): void {
    this.db
      .prepare(
        'delete from work_input_receipt_outbox where run_id = ? and manifest_digest = ? and receipt_seq = ?',
      )
      .run(runId, manifestDigest, receiptSeq)
  }

  private writeSets(
    runId: string,
    manifestDigest: string,
    delivered: readonly string[],
    read: readonly string[],
  ): void {
    this.db
      .prepare(
        `insert into work_input_receipt_state (run_id, manifest_digest, delivered, read_items, next_seq)
         values (?, ?, ?, ?, 1)
         on conflict (run_id, manifest_digest) do update set
           delivered = excluded.delivered,
           read_items = excluded.read_items`,
      )
      .run(runId, manifestDigest, JSON.stringify(delivered), JSON.stringify(read))
  }
}

export class MemoryWorkInputReceiptStore implements WorkInputReceiptStore {
  private readonly states = new Map<
    string,
    { delivered: string[]; read: string[]; nextSeq: number }
  >()
  private readonly outbox = new Map<string, RunWorkInputReceipt>()

  private state(runId: string, manifestDigest: string) {
    const key = `${runId}|${manifestDigest}`
    const existing = this.states.get(key)
    if (existing !== undefined) return existing
    const created = { delivered: [] as string[], read: [] as string[], nextSeq: 1 }
    this.states.set(key, created)
    return created
  }

  snapshot(runId: string, manifestDigest: string): WorkInputReceiptSnapshot {
    const state = this.state(runId, manifestDigest)
    return { delivered: [...state.delivered], read: [...state.read] }
  }

  nextSeq(runId: string, manifestDigest: string): number {
    const state = this.state(runId, manifestDigest)
    const seq = state.nextSeq
    state.nextSeq += 1
    return seq
  }

  addDelivered(runId: string, manifestDigest: string, itemIds: readonly string[]): void {
    const state = this.state(runId, manifestDigest)
    state.delivered = merge(state.delivered, itemIds)
  }

  addRead(runId: string, manifestDigest: string, itemId: string): void {
    const state = this.state(runId, manifestDigest)
    state.read = merge(state.read, [itemId])
  }

  enqueue(receipt: RunWorkInputReceipt): void {
    this.outbox.set(`${receipt.runId}|${receipt.manifestDigest}|${receipt.receiptSeq}`, receipt)
  }

  pending(): readonly RunWorkInputReceipt[] {
    return [...this.outbox.values()]
  }

  removePending(runId: string, manifestDigest: string, receiptSeq: number): void {
    this.outbox.delete(`${runId}|${manifestDigest}|${receiptSeq}`)
  }
}

function parseArray(raw: string | undefined): string[] {
  if (raw === undefined) return []
  try {
    const parsed = JSON.parse(raw) as unknown
    return Array.isArray(parsed)
      ? parsed.filter((value): value is string => typeof value === 'string')
      : []
  } catch {
    return []
  }
}
