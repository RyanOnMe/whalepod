import { and, eq, inArray } from 'drizzle-orm'
import type { DbHandle } from '../client.js'
import {
  runWorkInputReceipts,
  workInboxDeliveries,
  workInputConsumptions,
  type NewRunWorkInputReceiptRow,
  type NewWorkInputConsumptionRow,
  type RunWorkInputReceiptRow,
  type WorkInputConsumptionRow,
} from '../schema/work-delivery.js'
import { workInboxItems, type WorkInboxItemRow } from '../schema/work-inbox.js'

// ADR-0028（RD-02a-2b）：工作输入回执与消费事实。回执 append-only；消费按
// (run_id, inbox_item_id) 唯一，重复读取不新增第二条。

export async function insertRunWorkInputReceiptIfAbsent(
  handle: DbHandle,
  values: NewRunWorkInputReceiptRow,
): Promise<RunWorkInputReceiptRow | undefined> {
  const [row] = await handle
    .insert(runWorkInputReceipts)
    .values(values)
    .onConflictDoNothing({
      target: [
        runWorkInputReceipts.runId,
        runWorkInputReceipts.manifestDigest,
        runWorkInputReceipts.receiptSeq,
      ],
    })
    .returning()
  return row
}

export async function getRunWorkInputReceipt(
  handle: DbHandle,
  runId: string,
  manifestDigest: string,
  receiptSeq: number,
): Promise<RunWorkInputReceiptRow | undefined> {
  const [row] = await handle
    .select()
    .from(runWorkInputReceipts)
    .where(
      and(
        eq(runWorkInputReceipts.runId, runId),
        eq(runWorkInputReceipts.manifestDigest, manifestDigest),
        eq(runWorkInputReceipts.receiptSeq, receiptSeq),
      ),
    )
    .limit(1)
  return row
}

export async function getWorkInputConsumption(
  handle: DbHandle,
  runId: string,
  inboxItemId: string,
): Promise<WorkInputConsumptionRow | undefined> {
  const [row] = await handle
    .select()
    .from(workInputConsumptions)
    .where(
      and(
        eq(workInputConsumptions.runId, runId),
        eq(workInputConsumptions.inboxItemId, inboxItemId),
      ),
    )
    .limit(1)
  return row
}

export async function insertWorkInputConsumptionIfAbsent(
  handle: DbHandle,
  values: NewWorkInputConsumptionRow,
): Promise<WorkInputConsumptionRow | undefined> {
  const [row] = await handle
    .insert(workInputConsumptions)
    .values(values)
    .onConflictDoNothing({
      target: [workInputConsumptions.runId, workInputConsumptions.inboxItemId],
    })
    .returning()
  return row
}

/** 首次读取：item 仍属于本 Run 时置 consumed；已被对账收回则不动。 */
export async function markWorkInboxItemConsumed(
  handle: DbHandle,
  input: { readonly itemId: string; readonly runId: string; readonly now: Date },
): Promise<WorkInboxItemRow | undefined> {
  const [row] = await handle
    .update(workInboxItems)
    .set({
      status: 'consumed',
      statusReason: 'consumed_by_run',
      consumedAt: input.now,
      // 窗口内读取的条目仍带 unconfirmed_at；consumed 状态要求它为空。
      unconfirmedAt: null,
      statusAt: input.now,
      updatedAt: input.now,
    })
    .where(
      and(
        eq(workInboxItems.id, input.itemId),
        eq(workInboxItems.deliveryRunId, input.runId),
        inArray(workInboxItems.status, ['delivered', 'unconfirmed']),
      ),
    )
    .returning()
  return row
}

/**
 * 迟到的旧 Run 回执：下一 Run 已领取但未读取 → 撤回该交付。
 * item 回到不可再投的 `superseded`（`status_reason=late_receipt_withdrawn`），
 * 交付指针清空；不是 pending，后续关联/派工不会产生第三次投递。
 * 返回 undefined 表示条目已不再处于可撤回状态。
 */
export async function withdrawWorkInboxItemForLateReceipt(
  handle: DbHandle,
  input: { readonly itemId: string; readonly now: Date },
): Promise<WorkInboxItemRow | undefined> {
  const [row] = await handle
    .update(workInboxItems)
    .set({
      status: 'superseded',
      statusReason: 'late_receipt_withdrawn',
      returnReason: null,
      returnNote: null,
      deliveryRunId: null,
      deliveredAt: null,
      unconfirmedAt: null,
      consumedAt: null,
      statusAt: input.now,
      updatedAt: input.now,
    })
    .where(
      and(
        eq(workInboxItems.id, input.itemId),
        inArray(workInboxItems.status, ['delivered', 'unconfirmed']),
      ),
    )
    .returning()
  return row
}

export async function markWorkInboxDeliveriesAcked(
  handle: DbHandle,
  input: { readonly runId: string; readonly itemIds: readonly string[]; readonly at: Date },
): Promise<void> {
  if (input.itemIds.length === 0) return
  await handle
    .update(workInboxDeliveries)
    .set({ ackedAt: input.at, updatedAt: input.at })
    .where(
      and(
        eq(workInboxDeliveries.runId, input.runId),
        inArray(workInboxDeliveries.inboxItemId, [...input.itemIds]),
      ),
    )
}

export async function markWorkInboxDeliveryStatus(
  handle: DbHandle,
  input: {
    readonly itemId: string
    readonly runId: string
    readonly status: 'consumed' | 'duplicate' | 'duplicate_consumption'
    readonly at: Date
    readonly failureReason?: string | null
  },
): Promise<void> {
  await handle
    .update(workInboxDeliveries)
    .set({
      status: input.status,
      ackedAt: input.status === 'consumed' ? input.at : undefined,
      settledAt: input.at,
      failureReason: input.failureReason ?? null,
      updatedAt: input.at,
    })
    .where(
      and(
        eq(workInboxDeliveries.inboxItemId, input.itemId),
        eq(workInboxDeliveries.runId, input.runId),
        // 迟到的重复回执不得改写 already-consumed/returned/withdrawn 的尝试历史。
        inArray(workInboxDeliveries.status, ['sent', 'unconfirmed']),
      ),
    )
}
