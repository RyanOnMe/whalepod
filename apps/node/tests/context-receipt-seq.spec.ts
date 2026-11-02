/**
 * ADR-0027 §4：receiptSeq 必须跨 Node 进程重启继续单调，否则重连后的首批回执
 * 会被 Hub 判重复并静默丢弃。这里验证 SQLite 实现确实持久（重开同一文件继续计数）。
 */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { SqliteContextReceiptSeqStore } from '../src/context/receipt-seq-store.js'

let root: string

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'wp-receipt-seq-'))
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

describe('SqliteContextReceiptSeqStore', () => {
  it('continues seq after reopening the state file', () => {
    const path = join(root, 'context-receipts.sqlite')
    const runId = '11111111-1111-4111-8111-111111111111'
    const snapshotId = '22222222-2222-4222-8222-222222222222'
    const first = new SqliteContextReceiptSeqStore(path)
    expect(first.next(runId, snapshotId)).toBe(1)
    expect(first.next(runId, snapshotId)).toBe(2)

    const reopened = new SqliteContextReceiptSeqStore(path)
    expect(reopened.next(runId, snapshotId)).toBe(3)
    // 计数按 (run, snapshot) 隔离，不同 Run 从头开始。
    expect(reopened.next('33333333-3333-4333-8333-333333333333', snapshotId)).toBe(1)
  })
})
