import { and, eq, inArray, sql } from 'drizzle-orm'
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

export async function maxRunWorkInputReceiptSeq(
  handle: DbHandle,
  runId: string,
  manifestDigest: string,
): Promise<number> {
  const [row] = await handle
    .select({ max: sql<number | null>`max(${runWorkInputReceipts.receiptSeq})::int` })
    .from(runWorkInputReceipts)
    .where(
      and(
        eq(runWorkInputReceipts.runId, runId),
        eq(runWorkInputReceipts.manifestDigest, manifestDigest),
      ),
    )
  return row?.max ?? 0
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
      ),
    )
}
