/**
 * ADR-0027 §4（PC-05b-2）：上下文回执发件箱的持久、排序与 seq 分配语义。
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { RunContextReceipt } from '@whalepod/protocol'
import {
  MemoryContextReceiptOutbox,
  SqliteContextReceiptOutbox,
} from '../src/context/receipt-outbox.js'
import type { RunContextReceiptDraft } from '../src/context/receipt-outbox.js'

const RUN_ID = '01905f7c-0000-7000-8000-000000000301'
const RUN_B = '01905f7c-0000-7000-8000-000000000302'
const SNAPSHOT_ID = '01905f7c-0000-7000-8000-000000000961'
const SNAPSHOT_B = '01905f7c-0000-7000-8000-000000000962'
const ENTRY_ID = '01905f7c-0000-7000-8000-000000000951'
const DIGEST = 'a'.repeat(64)

function receipt(seq: number, runId = RUN_ID, snapshotId = SNAPSHOT_ID): RunContextReceipt {
  return {
    runId,
    snapshotId,
    receiptSeq: seq,
    headerDigest: DIGEST,
    nonceMatched: true,
    entriesDelivered: [ENTRY_ID],
    entriesRead: [],
    readEvents: [],
    missing: [],
    digestVerified: true,
    at: '2026-11-03T00:00:00.000Z',
  }
}

function draft(runId = RUN_ID, snapshotId = SNAPSHOT_ID): RunContextReceiptDraft {
  const { receiptSeq: _receiptSeq, ...rest } = receipt(1, runId, snapshotId)
  return rest
}

describe('context receipt outbox', () => {
  let root: string
  let path: string

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'wp-context-receipt-outbox-'))
    path = join(root, 'outbox.sqlite')
  })

  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

  it('persists across reopen, replays in seq order and deletes only acked seqs', () => {
    const first = new SqliteContextReceiptOutbox(path)
    first.enqueue(receipt(2), '2026-11-03T00:00:02.000Z')
    first.enqueue(receipt(1), '2026-11-03T00:00:01.000Z')
    first.enqueue(receipt(3), '2026-11-03T00:00:03.000Z')
    first.closeForTest()

    const second = new SqliteContextReceiptOutbox(path)
    expect(second.pending().map((item) => item.receipt.receiptSeq)).toEqual([1, 2, 3])
    // 高 seq 的 ack 不能连带删除更低的未 ack 项。
    second.ack(RUN_ID, SNAPSHOT_ID, 2)
    expect(second.pending().map((item) => item.receipt.receiptSeq)).toEqual([1, 3])
    second.ack(RUN_ID, SNAPSHOT_ID, 1)
    second.ack(RUN_ID, SNAPSHOT_ID, 3)
    expect(second.pending()).toHaveLength(0)
    expect(second.size()).toBe(0)
  })

  it('assigns receiptSeq atomically and persists the counter across reopen', () => {
    const first = new SqliteContextReceiptOutbox(path)
    const one = first.enqueueNext(draft(), '2026-11-03T00:00:01.000Z')
    const two = first.enqueueNext(draft(), '2026-11-03T00:00:02.000Z')
    expect([one.receiptSeq, two.receiptSeq]).toEqual([1, 2])
    first.closeForTest()

    const second = new SqliteContextReceiptOutbox(path)
    expect(second.pending().map((item) => item.receipt.receiptSeq)).toEqual([1, 2])
    expect(second.enqueueNext(draft(), '2026-11-03T00:00:03.000Z').receiptSeq).toBe(3)
    expect(second.pending(RUN_ID).map((item) => item.receipt.receiptSeq)).toEqual([1, 2, 3])
  })

  it('rolls back the seq allocation when the outbox insert fails', () => {
    const outbox = new SqliteContextReceiptOutbox(path)
    const inspect = new DatabaseSync(path)
    inspect.exec(`
      create trigger refuse_first_receipt
      before insert on context_receipt_outbox
      when new.receipt_seq = 1
      begin
        select raise(abort, 'boom');
      end
    `)
    expect(() => outbox.enqueueNext(draft(), '2026-11-03T00:00:01.000Z')).toThrow()
    expect(outbox.pending()).toHaveLength(0)
    expect(
      inspect
        .prepare('select value from context_receipt_seq where run_id = ? and snapshot_id = ?')
        .get(RUN_ID, SNAPSHOT_ID),
    ).toBeUndefined()
    // 失败不消耗 seq：下一次仍从 1 开始。
    inspect.exec('drop trigger refuse_first_receipt')
    expect(outbox.enqueueNext(draft(), '2026-11-03T00:00:01.000Z').receiptSeq).toBe(1)
    inspect.close()
  })

  it('seeds the counter from the PC-05a legacy seq file', () => {
    const legacyPath = join(root, 'legacy-receipts.sqlite')
    const legacy = new DatabaseSync(legacyPath)
    legacy.exec(`
      create table context_receipt_seq (
        run_id text not null,
        snapshot_id text not null,
        next_seq integer not null,
        primary key (run_id, snapshot_id)
      )
    `)
    legacy
      .prepare('insert into context_receipt_seq (run_id, snapshot_id, next_seq) values (?, ?, ?)')
      .run(RUN_ID, SNAPSHOT_ID, 7)
    legacy.close()

    const outbox = new SqliteContextReceiptOutbox(path)
    outbox.seedFromLegacy(legacyPath)
    expect(outbox.enqueueNext(draft(), '2026-11-03T00:00:08.000Z').receiptSeq).toBe(8)
  })

  it('orders multiple runs and snapshots globally and filters per run', () => {
    const outbox = new SqliteContextReceiptOutbox(path)
    outbox.enqueue(receipt(2, RUN_B, SNAPSHOT_B), '2026-11-03T00:00:02.000Z')
    outbox.enqueue(receipt(1, RUN_ID, SNAPSHOT_ID), '2026-11-03T00:00:01.000Z')
    outbox.enqueue(receipt(1, RUN_B, SNAPSHOT_B), '2026-11-03T00:00:01.000Z')
    expect(
      outbox
        .pending()
        .map(
          (item) => `${item.receipt.runId}:${item.receipt.snapshotId}:${item.receipt.receiptSeq}`,
        ),
    ).toEqual([
      `${RUN_ID}:${SNAPSHOT_ID}:1`,
      `${RUN_B}:${SNAPSHOT_B}:1`,
      `${RUN_B}:${SNAPSHOT_B}:2`,
    ])
    expect(outbox.pending(RUN_B).map((item) => item.receipt.receiptSeq)).toEqual([1, 2])
  })

  it('memory implementation mirrors ordering, seq assignment and ack semantics', () => {
    const outbox = new MemoryContextReceiptOutbox()
    outbox.enqueue(receipt(3), '2026-11-03T00:00:03.000Z')
    outbox.enqueue(receipt(1), '2026-11-03T00:00:01.000Z')
    outbox.enqueue(receipt(2), '2026-11-03T00:00:02.000Z')
    expect(outbox.pending().map((item) => item.receipt.receiptSeq)).toEqual([1, 2, 3])
    expect(outbox.enqueueNext(draft(), '2026-11-03T00:00:04.000Z').receiptSeq).toBe(4)
    outbox.ack(RUN_ID, SNAPSHOT_ID, 2)
    expect(outbox.pending().map((item) => item.receipt.receiptSeq)).toEqual([1, 3, 4])
    outbox.ack(RUN_ID, SNAPSHOT_ID, 1)
    outbox.ack(RUN_ID, SNAPSHOT_ID, 3)
    outbox.ack(RUN_ID, SNAPSHOT_ID, 4)
    expect(outbox.size()).toBe(0)
  })
})
