import type { RunRow, Tx } from '@whalepod/db'
import {
  getRunWorkInputReceipt,
  getWorkByKey,
  getWorkByKeyForUpdate,
  getWorkInboxItemForUpdate,
  insertRunWorkInputReceiptIfAbsent,
  insertWorkInputConsumptionIfAbsent,
  markWorkInboxDeliveriesAcked,
  markWorkInboxDeliveryStatus,
  markWorkInboxItemConsumed,
  withdrawWorkInboxItemForLateReceipt,
} from '@whalepod/db'
import {
  WorkInputManifestSchema,
  type RunWorkInputReceipt,
  type WorkInputManifest,
} from '@whalepod/protocol'
import { RunCommandError } from '../run/errors.js'
import { canonicalJson, sha256Hex } from '../coordination/digest.js'
import { uuidv7 } from '../shared/uuid.js'
import { WORK_INPUT_RECONCILE_WINDOW_MS } from './run-inputs.js'

// ADR-0028（RD-02a-2b）：工作输入回执的 Hub 侧状态机。与 run.context_receipt 不同：
// Run 终态后仍接受；窗口内置 consumed，窗口后只记迟到对账（duplicate），不复活 Run。

export interface WorkInputReceiptOutcome {
  readonly consumed: number
  readonly duplicate: number
  readonly duplicateConsumption: number
  readonly late: number
  readonly idempotent: boolean
}

function emptyOutcome(idempotent = false): WorkInputReceiptOutcome {
  return { consumed: 0, duplicate: 0, duplicateConsumption: 0, late: 0, idempotent }
}

function parseManifest(run: RunRow): WorkInputManifest {
  if (run.workInputManifest === null || run.workInputManifestDigest === null) {
    throw new RunCommandError('CONFLICT', 'run has no work input manifest')
  }
  const parsed = WorkInputManifestSchema.safeParse(run.workInputManifest)
  if (!parsed.success) throw new RunCommandError('CONFLICT', 'run work input manifest is invalid')
  if (sha256Hex(canonicalJson(parsed.data)) !== run.workInputManifestDigest) {
    throw new RunCommandError('CONFLICT', 'run work input manifest digest mismatch')
  }
  return parsed.data
}

function assertKnownIds(receipt: RunWorkInputReceipt, manifest: WorkInputManifest): void {
  const known = new Set(manifest.entries.map((entry) => entry.inboxItemId))
  for (const id of [
    ...receipt.entriesDelivered,
    ...receipt.entriesRead,
    ...receipt.missing,
    ...receipt.readEvents.map((event) => event.inboxItemId),
  ]) {
    if (!known.has(id)) {
      throw new RunCommandError('CONFLICT', 'receipt references an item outside the manifest')
    }
  }
}

function withinWindow(unconfirmedAt: Date, now: Date): boolean {
  return now.getTime() <= unconfirmedAt.getTime() + WORK_INPUT_RECONCILE_WINDOW_MS
}

export async function recordRunWorkInputReceipt(
  tx: Tx,
  run: RunRow,
  receipt: RunWorkInputReceipt,
  now: Date,
): Promise<WorkInputReceiptOutcome> {
  const manifest = parseManifest(run)
  if (receipt.workKey !== run.workKey || receipt.manifestDigest !== run.workInputManifestDigest) {
    throw new RunCommandError('CONFLICT', 'receipt does not match the run work input manifest')
  }
  assertKnownIds(receipt, manifest)

  // 同一 (run, manifest, seq) 只落一行。**低于最大 seq 的未见序号也接受**：
  // Node 重连时可能先发出新回执、再补发旧 outbox；条目/消费唯一键已经保证
  // 重复读取不会二次消费，拒收旧序号只会永久丢掉已发生的读取事实。
  const existing = await getRunWorkInputReceipt(
    tx,
    run.id,
    receipt.manifestDigest,
    receipt.receiptSeq,
  )
  if (existing !== undefined) return emptyOutcome(true)

  // 读回执要改条目状态：先取 Work 行锁再插回执。反过来（插回执的 Work FK 先取
  // KEY SHARE，再升级 FOR UPDATE）会被另一条并发读回执卡成环——两条都持 KEY SHARE、
  // 又都等对方释放。纯 delivered 回执不改条目，只做无锁读取。
  const work =
    receipt.readEvents.length > 0
      ? await getWorkByKeyForUpdate(tx, receipt.workKey)
      : await getWorkByKey(tx, receipt.workKey)
  if (work === undefined) throw new RunCommandError('CONFLICT', 'work not found')
  const receiptRow = await insertRunWorkInputReceiptIfAbsent(tx, {
    id: uuidv7(now.getTime()),
    runId: run.id,
    workId: work.id,
    workKey: receipt.workKey,
    manifestDigest: receipt.manifestDigest,
    receiptSeq: receipt.receiptSeq,
    entriesDelivered: [...receipt.entriesDelivered],
    entriesRead: [...receipt.entriesRead],
    readEvents: receipt.readEvents.map((event) => ({ ...event })),
    missing: [...receipt.missing],
    digestVerified: receipt.digestVerified,
    receivedAt: now,
  })
  // 并发同 seq：另一事务已落同一回执，按幂等处理。
  if (receiptRow === undefined) return emptyOutcome(true)
  await markWorkInboxDeliveriesAcked(tx, {
    runId: run.id,
    itemIds: receipt.entriesDelivered,
    at: now,
  })
  if (!receipt.digestVerified) return emptyOutcome()

  const counts = { consumed: 0, duplicate: 0, duplicateConsumption: 0, late: 0 }
  const receiptId = receiptRow.id
  const manifestById = new Map(manifest.entries.map((entry) => [entry.inboxItemId, entry]))
  const reads = [...receipt.readEvents].sort((left, right) =>
    left.inboxItemId < right.inboxItemId ? -1 : left.inboxItemId > right.inboxItemId ? 1 : 0,
  )
  for (const event of reads) {
    if (!event.digestVerified) {
      throw new RunCommandError('CONFLICT', 'work input receipt is not digest-verified')
    }
    const pinned = manifestById.get(event.inboxItemId)
    if (pinned === undefined || pinned.byteSize !== event.byteSize) {
      throw new RunCommandError('CONFLICT', 'receipt byte size does not match the manifest')
    }
    const item = await getWorkInboxItemForUpdate(tx, event.inboxItemId)
    if (item === undefined || item.workId !== work.id) {
      throw new RunCommandError('CONFLICT', 'receipt item does not belong to this work')
    }
    const readAt = new Date(event.at)
    const recordConsumption = (kind: 'consumed' | 'duplicate' | 'duplicate_consumption') =>
      insertWorkInputConsumptionIfAbsent(tx, {
        id: uuidv7(now.getTime()),
        inboxItemId: item.id,
        workId: work.id,
        workKey: work.workKey,
        runId: run.id,
        manifestDigest: receipt.manifestDigest,
        kind,
        receiptId,
        readAt,
        createdAt: now,
      })
    // 同一 Run 再次读取：首次消费事实已存在，不新增第二行，也不改写交付尝试。
    if (item.status === 'consumed' && item.deliveryRunId === run.id) {
      counts.duplicate += 1
      continue
    }
    if (item.deliveryRunId !== run.id) {
      // 条目已被后续 Run 消费 → duplicate_consumption；两边的交付尝试都是历史事实，
      // 迟到回执只追加对账记录，不改写 consumed 的尝试。
      if (item.status === 'consumed') {
        counts.duplicateConsumption += 1
        await recordConsumption('duplicate_consumption')
        continue
      }
      // 下一 Run 已领取但尚未消费：记录旧 Run 的迟到读取，并撤回下一交付。
      // 条目转 superseded（只有 pending 能再次被关联/派发），因此不会出现第三次投递。
      // 旧 Run 自己的 delivery 已是 returned/withdrawn，保持原状。
      counts.duplicate += 1
      await recordConsumption('duplicate')
      if (
        item.deliveryRunId !== null &&
        (item.status === 'delivered' || item.status === 'unconfirmed')
      ) {
        await markWorkInboxDeliveryStatus(tx, {
          itemId: item.id,
          runId: item.deliveryRunId,
          status: 'duplicate',
          at: now,
          failureReason: 'late_receipt_previous_run',
        })
        await withdrawWorkInboxItemForLateReceipt(tx, { itemId: item.id, now })
      }
      continue
    }
    if (
      item.status === 'delivered' ||
      (item.status === 'unconfirmed' && withinWindow(item.unconfirmedAt ?? now, now))
    ) {
      const consumed = await markWorkInboxItemConsumed(tx, {
        itemId: item.id,
        runId: run.id,
        now,
      })
      if (consumed === undefined) {
        counts.duplicate += 1
        continue
      }
      const inserted = await recordConsumption('consumed')
      if (inserted === undefined) counts.duplicate += 1
      else counts.consumed += 1
      await markWorkInboxDeliveryStatus(tx, {
        itemId: item.id,
        runId: run.id,
        status: 'consumed',
        at: now,
      })
      continue
    }
    if (item.status === 'unconfirmed') {
      counts.late += 1
      await recordConsumption('duplicate')
      await markWorkInboxDeliveryStatus(tx, {
        itemId: item.id,
        runId: run.id,
        status: 'duplicate',
        at: now,
        failureReason: 'receipt_after_window',
      })
      continue
    }
    counts.duplicate += 1
    await recordConsumption('duplicate')
  }
  return { ...counts, idempotent: false }
}
