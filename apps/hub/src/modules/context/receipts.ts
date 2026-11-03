/**
 * ADR-0027 §4：`run.context_receipt` 的 Hub 接受谓词与落库。
 *
 * 回执是 Node 的**自报证据**（本次 Run 的受信执行代理），用于防「只存快照 ID」、
 * 漏读与部分交付；不防恶意 Node。全部谓词成立才更新 delivered/read 状态；
 * 终态后到达记 receipt_late，不复活 Run。
 */
import type { RunRow, Tx } from '@whalepod/db'
import {
  getRunProjectContextForUpdate,
  insertRunContextConsumptionIfAbsent,
  insertRunContextReceipt,
  lastRunContextReceiptSeq,
  listRunProjectContextEntries,
  markRunProjectContextEntriesDelivered,
  markRunProjectContextEntryRead,
  updateRunProjectContext,
} from '@whalepod/db'
import type { RunContextReceipt } from '@whalepod/protocol'
import { sha256Hex } from '../coordination/digest.js'
import { uuidv7 } from '../shared/uuid.js'

const ACTIVE_RUN_STATUSES = ['dispatching', 'running', 'waiting_approval'] as const

export type RunContextReceiptOutcome =
  | {
      readonly status: 'accepted'
      readonly snapshotId: string
      readonly delivered: number
      readonly read: number
    }
  | { readonly status: 'late' }
  | { readonly status: 'rejected'; readonly reason: string }

function uniqueUuids(values: readonly string[]): string[] | undefined {
  const set = new Set(values)
  return set.size === values.length ? [...set].sort() : undefined
}

function sameSet(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false
  const sortedA = [...a].sort()
  const sortedB = [...b].sort()
  return sortedA.every((value, index) => value === sortedB[index])
}

export async function recordRunContextReceipt(
  tx: Tx,
  run: RunRow,
  receipt: RunContextReceipt,
  now: Date,
  onConsumptionGap: (message: string, context: Record<string, unknown>) => void,
): Promise<RunContextReceiptOutcome> {
  if (!(ACTIVE_RUN_STATUSES as readonly string[]).includes(run.status)) {
    return { status: 'late' }
  }
  // 锁序：先锁快照行，再写快照条目行。状态机（tick/纠正/下载）也按
  // snapshot → entry 加锁；若这里保持 entry → snapshot，会与其形成 ABBA 死锁。
  const snapshot = await getRunProjectContextForUpdate(tx, run.id)
  if (snapshot === undefined || snapshot.id !== receipt.snapshotId) {
    return { status: 'rejected', reason: 'snapshot_mismatch' }
  }
  if (!receipt.nonceMatched) return { status: 'rejected', reason: 'nonce_mismatch' }
  if (receipt.headerDigest !== snapshot.headerDigest) {
    return { status: 'rejected', reason: 'header_digest_mismatch' }
  }
  if (sha256Hex(snapshot.headerText) !== snapshot.headerDigest) {
    return { status: 'rejected', reason: 'stored_header_digest_mismatch' }
  }
  if (!receipt.digestVerified) return { status: 'rejected', reason: 'digest_not_verified' }
  const delivered = uniqueUuids(receipt.entriesDelivered)
  const read = uniqueUuids(receipt.entriesRead)
  const missing = uniqueUuids(receipt.missing)
  if (delivered === undefined || read === undefined || missing === undefined) {
    return { status: 'rejected', reason: 'duplicate_entry_ids' }
  }
  const entries = await listRunProjectContextEntries(tx, snapshot.id)
  const byId = new Map(entries.map((entry) => [entry.entryId, entry]))
  const known = new Set(byId.keys())
  if (delivered.some((entryId) => !known.has(entryId))) {
    return { status: 'rejected', reason: 'delivered_outside_snapshot' }
  }
  if (missing.some((entryId) => !known.has(entryId))) {
    return { status: 'rejected', reason: 'missing_outside_snapshot' }
  }
  // 同一条目不能一边「已交付」一边「未交付」——自报矛盾的回执不可信。
  if (delivered.some((entryId) => missing.includes(entryId))) {
    return { status: 'rejected', reason: 'missing_overlaps_delivered' }
  }
  // Node 自报的未交付集合必须与已交付集合互斥且覆盖整个快照：允许部分交付，
  // 不允许漏项或把同一条目同时算进两边。
  if (new Set([...delivered, ...missing]).size !== known.size) {
    return { status: 'rejected', reason: 'missing_set_mismatch' }
  }
  if (read.some((entryId) => !delivered.includes(entryId))) {
    return { status: 'rejected', reason: 'read_not_delivered' }
  }
  // ADR-0027 §4 要求的是**集合**一致：同一条目在一批里读两次仍算一次已读，
  // 逐事件的事实由下面的 digest/byteSize 校验保留。
  if (!sameSet(read, [...new Set(receipt.readEvents.map((event) => event.entryId))])) {
    return { status: 'rejected', reason: 'read_events_mismatch' }
  }
  for (const event of receipt.readEvents) {
    const entry = byId.get(event.entryId)
    if (entry === undefined || !event.digestVerified || event.byteSize !== entry.byteSize) {
      return { status: 'rejected', reason: 'read_event_invalid' }
    }
  }
  const lastSeq = await lastRunContextReceiptSeq(tx, run.id, snapshot.id)
  if (receipt.receiptSeq <= lastSeq) {
    return { status: 'rejected', reason: 'receipt_seq_not_monotonic' }
  }

  await insertRunContextReceipt(tx, {
    id: uuidv7(),
    runId: run.id,
    snapshotId: snapshot.id,
    receiptSeq: receipt.receiptSeq,
    headerDigest: receipt.headerDigest,
    nonceMatched: receipt.nonceMatched,
    entriesDelivered: delivered,
    entriesRead: read,
    readEvents: receipt.readEvents,
    missing,
    digestVerified: receipt.digestVerified,
    at: new Date(receipt.at),
    receivedAt: now,
  })
  await markRunProjectContextEntriesDelivered(tx, snapshot.id, delivered, now)
  for (const event of receipt.readEvents) {
    await markRunProjectContextEntryRead(tx, snapshot.id, event.entryId, new Date(event.at))
    // ADR-0027 §4：消费行由同一事务的 savepoint 写入；失败只记 consumption_gap，
    // 不回滚已经成立的读取事实。
    try {
      await tx.transaction(async (savepoint) => {
        await insertRunContextConsumptionIfAbsent(savepoint, {
          snapshotId: snapshot.id,
          entryId: event.entryId,
          threadId: byId.get(event.entryId)?.threadId ?? null,
          runId: run.id,
          readAt: new Date(event.at),
        })
      })
    } catch (error) {
      onConsumptionGap('run context consumption write failed', {
        component: 'hub.context',
        action: 'context.consumption_gap',
        runId: run.id,
        snapshotId: snapshot.id,
        entryId: event.entryId,
        errorName: error instanceof Error ? error.name : typeof error,
      })
    }
  }

  const refreshed = await listRunProjectContextEntries(tx, snapshot.id)
  const readCount = refreshed.filter((entry) => entry.readAt !== null).length
  const allRead = refreshed.length > 0 && readCount === refreshed.length
  const patch = {
    ...(delivered.length > 0 && snapshot.deliveredAt === null ? { deliveredAt: now } : {}),
    ...(readCount > 0 && snapshot.consumedAt === null ? { consumedAt: now } : {}),
    ...(allRead && snapshot.consumedAllAt === null ? { consumedAllAt: now } : {}),
  }
  // Drizzle 的 .set({}) 会抛 "No values to set"；增量回执在全字段已写后是常态
  // （Node 一次读一条，第二次读时 deliveredAt/consumedAt 都已存在）。
  if (Object.keys(patch).length > 0) {
    await updateRunProjectContext(tx, snapshot.id, patch)
  }

  return {
    status: 'accepted',
    snapshotId: snapshot.id,
    delivered: delivered.length,
    read: read.length,
  }
}
