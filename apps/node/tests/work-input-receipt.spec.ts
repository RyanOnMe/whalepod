/**
 * ADR-0028 §3（RD-02a-2b）：Node 工作输入回执持久状态与待发队列。
 *
 * 判定基线：receiptSeq 跨进程重启单调且按 (run, manifestDigest) 隔离；delivered/read
 * 累计集合重启后仍可重建；断线回执留在 outbox，重连补发成功后才删除。
 */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { RunWorkInputReceipt } from '@whalepod/protocol'
import { SqliteWorkInputReceiptStore } from '../src/work/receipt-store.js'

let root: string

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'wp-work-input-receipt-'))
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

const RUN_ID = '11111111-1111-4111-8111-111111111111'
const WORK_KEY = '22222222-2222-4222-8222-222222222222'
const DIGEST = 'a'.repeat(64)
const ITEM_1 = '33333333-3333-4333-8333-333333333333'
const ITEM_2 = '44444444-4444-4444-8444-444444444444'

function receipt(seq: number, overrides: Partial<RunWorkInputReceipt> = {}): RunWorkInputReceipt {
  return {
    runId: RUN_ID,
    workKey: WORK_KEY,
    manifestDigest: DIGEST,
    receiptSeq: seq,
    entriesDelivered: [ITEM_1],
    entriesRead: [],
    readEvents: [],
    missing: [],
    digestVerified: true,
    at: new Date(2026, 10, 2, 10, 0, seq).toISOString(),
    ...overrides,
  }
}

describe('SqliteWorkInputReceiptStore', () => {
  it('continues receiptSeq after reopening the state file', () => {
    const path = join(root, 'work-input-receipts.sqlite')
    const first = new SqliteWorkInputReceiptStore(path)
    expect(first.nextSeq(RUN_ID, DIGEST)).toBe(1)
    expect(first.nextSeq(RUN_ID, DIGEST)).toBe(2)

    const reopened = new SqliteWorkInputReceiptStore(path)
    expect(reopened.nextSeq(RUN_ID, DIGEST)).toBe(3)
    // 计数按 (run, manifestDigest) 隔离，不同清单副本从头开始。
    expect(reopened.nextSeq(RUN_ID, 'b'.repeat(64))).toBe(1)
    expect(reopened.nextSeq('55555555-5555-4555-8555-555555555555', DIGEST)).toBe(1)
  })

  it('persists cumulative delivered/read sets across reopen', () => {
    const path = join(root, 'work-input-receipts.sqlite')
    const first = new SqliteWorkInputReceiptStore(path)
    first.addDelivered(RUN_ID, DIGEST, [ITEM_2, ITEM_1, ITEM_1])
    first.addRead(RUN_ID, DIGEST, ITEM_1)
    expect(first.snapshot(RUN_ID, DIGEST)).toEqual({
      delivered: [ITEM_1, ITEM_2],
      read: [ITEM_1],
    })

    const reopened = new SqliteWorkInputReceiptStore(path)
    reopened.addRead(RUN_ID, DIGEST, ITEM_2)
    expect(reopened.snapshot(RUN_ID, DIGEST)).toEqual({
      delivered: [ITEM_1, ITEM_2],
      read: [ITEM_1, ITEM_2],
    })
  })

  it('keeps unacked receipts in the outbox until they are explicitly removed', () => {
    const path = join(root, 'work-input-receipts.sqlite')
    const first = new SqliteWorkInputReceiptStore(path)
    first.enqueue(receipt(1))
    first.enqueue(receipt(2, { entriesRead: [ITEM_1] }))

    const reopened = new SqliteWorkInputReceiptStore(path)
    expect(reopened.pending().map((item) => item.receiptSeq)).toEqual([1, 2])
    reopened.removePending(RUN_ID, DIGEST, 1)
    expect(reopened.pending().map((item) => item.receiptSeq)).toEqual([2])
  })

  it('replaces a queued receipt with the same sequence instead of duplicating it', () => {
    const store = new SqliteWorkInputReceiptStore(join(root, 'work-input-receipts.sqlite'))
    store.enqueue(receipt(1))
    store.enqueue(receipt(1, { entriesRead: [ITEM_1] }))
    expect(store.pending()).toHaveLength(1)
    expect(store.pending()[0]?.entriesRead).toEqual([ITEM_1])
  })
})
