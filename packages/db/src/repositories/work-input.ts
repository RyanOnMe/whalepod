import { and, asc, eq, inArray, lte, sql } from 'drizzle-orm'
import type { DbHandle } from '../client.js'
import { workInboxItems, type WorkInboxItemRow } from '../schema/work-inbox.js'
import { getLatestInboxItemForSource } from './work-inbox.js'
import {
  workInboxDeliveries,
  type NewWorkInboxDeliveryRow,
  type WorkInboxDeliveryRow,
} from '../schema/work-delivery.js'

// ADR-0028（RD-02a-2a）：Run 工作输入的交付指针与 60s 对账。
// 每次尝试落 work_inbox_delivery；item 上的 delivery_* 是当前交付指针。

export async function listWorkInboxItemsForUpdate(
  handle: DbHandle,
  ids: readonly string[],
): Promise<WorkInboxItemRow[]> {
  if (ids.length === 0) return []
  return handle
    .select()
    .from(workInboxItems)
    .where(inArray(workInboxItems.id, [...ids]))
    .orderBy(asc(workInboxItems.id))
    .for('update')
}

export async function insertWorkInboxDelivery(
  handle: DbHandle,
  values: NewWorkInboxDeliveryRow,
): Promise<WorkInboxDeliveryRow> {
  const [row] = await handle.insert(workInboxDeliveries).values(values).returning()
  if (row === undefined) throw new Error('insert work inbox delivery returned no row')
  return row
}

export async function markWorkInboxItemDelivered(
  handle: DbHandle,
  values: {
    readonly itemId: string
    readonly runId: string
    readonly now: Date
  },
): Promise<WorkInboxItemRow | undefined> {
  const [row] = await handle
    .update(workInboxItems)
    .set({
      status: 'delivered',
      deliveryRunId: values.runId,
      deliveredAt: values.now,
      unconfirmedAt: null,
      consumedAt: null,
      statusReason: 'delivered_to_run',
      returnReason: null,
      returnNote: null,
      statusAt: values.now,
      updatedAt: values.now,
    })
    .where(and(eq(workInboxItems.id, values.itemId), eq(workInboxItems.status, 'pending')))
    .returning()
  return row
}

/** Run 终态：已交付未消费的条目标 unconfirmed；同一事务内与 Run 状态一起提交。 */
export async function markWorkInputsUnconfirmed(
  handle: DbHandle,
  runId: string,
  at: Date,
): Promise<number> {
  const updated = await handle
    .update(workInboxItems)
    .set({
      status: 'unconfirmed',
      unconfirmedAt: at,
      statusReason: 'run_ended_awaiting_receipt',
      statusAt: at,
      updatedAt: at,
    })
    .where(and(eq(workInboxItems.deliveryRunId, runId), eq(workInboxItems.status, 'delivered')))
    .returning({ id: workInboxItems.id })
  await handle
    .update(workInboxDeliveries)
    .set({ status: 'unconfirmed', updatedAt: at })
    .where(and(eq(workInboxDeliveries.runId, runId), eq(workInboxDeliveries.status, 'sent')))
  return updated.length
}

/**
 * 60s 窗口到期仍无消费回执：回到 pending 并保留 delivery 尝试历史。
 * 返回本轮实际收口的条目数；调用方按 tick 周期反复执行，幂等。
 */
export async function returnUnconfirmedWorkInputs(
  handle: DbHandle,
  cutoff: Date,
  now: Date,
): Promise<number> {
  const due = await handle
    .select()
    .from(workInboxItems)
    .where(and(eq(workInboxItems.status, 'unconfirmed'), lte(workInboxItems.unconfirmedAt, cutoff)))
    .orderBy(asc(workInboxItems.id))
  let settled = 0
  for (const item of due) {
    // 若同来源已有更新的条目，旧版本不能回到 pending（会撞来源 pending 唯一索引，
    // 也会让 #493 再交付一个已被新版本取代的输入）；直接收口为 superseded。
    const latest = await getLatestInboxItemForSource(
      handle,
      item.workId,
      item.sourceType,
      item.sourceId,
    )
    const supersededByNewer = latest !== undefined && latest.id !== item.id
    const [updated] = await handle
      .update(workInboxItems)
      .set({
        status: supersededByNewer ? 'superseded' : 'pending',
        statusReason: supersededByNewer ? 'new_version' : 'run_ended_unconsumed',
        deliveryRunId: null,
        deliveredAt: null,
        unconfirmedAt: null,
        consumedAt: null,
        statusAt: now,
        updatedAt: now,
      })
      .where(and(eq(workInboxItems.id, item.id), eq(workInboxItems.status, 'unconfirmed')))
      .returning({ id: workInboxItems.id })
    if (updated === undefined) continue
    await handle
      .update(workInboxDeliveries)
      .set({
        status: 'returned',
        settledAt: now,
        failureReason: supersededByNewer ? 'superseded_by_new_version' : 'run_ended_unconsumed',
        updatedAt: now,
      })
      .where(
        and(
          eq(workInboxDeliveries.inboxItemId, item.id),
          eq(workInboxDeliveries.status, 'unconfirmed'),
        ),
      )
    settled += 1
  }
  return settled
}

export async function listWorkInboxDeliveriesByRun(
  handle: DbHandle,
  runId: string,
): Promise<WorkInboxDeliveryRow[]> {
  return handle
    .select()
    .from(workInboxDeliveries)
    .where(eq(workInboxDeliveries.runId, runId))
    .orderBy(asc(workInboxDeliveries.inboxItemId))
}

export async function countWorkInboxItemsByStatus(
  handle: DbHandle,
  workId: string,
): Promise<Record<string, number>> {
  const rows = await handle
    .select({ status: workInboxItems.status, count: sql<number>`count(*)::int` })
    .from(workInboxItems)
    .where(eq(workInboxItems.workId, workId))
    .groupBy(workInboxItems.status)
  return Object.fromEntries(rows.map((row) => [row.status, row.count]))
}
