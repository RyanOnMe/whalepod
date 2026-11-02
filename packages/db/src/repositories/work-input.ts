import { and, asc, desc, eq, inArray, lte, ne, sql } from 'drizzle-orm'
import type { DbHandle } from '../client.js'
import { workInboxItems, type WorkInboxItemRow } from '../schema/work-inbox.js'
import { works } from '../schema/work.js'
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
export async function listDueUnconfirmedWorkInputIds(
  handle: DbHandle,
  cutoff: Date,
): Promise<string[]> {
  const rows = await handle
    .select({ id: workInboxItems.id })
    .from(workInboxItems)
    .where(and(eq(workInboxItems.status, 'unconfirmed'), lte(workInboxItems.unconfirmedAt, cutoff)))
    .orderBy(asc(workInboxItems.id))
  return rows.map((row) => row.id)
}

/**
 * 收口一条到期的 unconfirmed 输入。先锁 Work 行，与关联/撤权的 Task→Work→item
 * 锁序串行化，避免“查无 pending、改 pending 时又撞唯一索引”。
 * 同来源以 (createdAt, sourceVersion, id) 判最新：只有最新条目能回 pending，
 * 旧版本一律 superseded(new_version)，不会因处理顺序让旧版本复活。
 */
export async function settleUnconfirmedWorkInput(
  handle: DbHandle,
  itemId: string,
  cutoff: Date,
  now: Date,
): Promise<number> {
  // 先无锁读 workId，再按 Work→item 加锁：与关联/撤权的 Task→Work→item 锁序一致。
  // 反过来（item→Work）会和撤权持 Work 等 item 形成死锁。
  const [snapshot] = await handle
    .select({ workId: workInboxItems.workId })
    .from(workInboxItems)
    .where(eq(workInboxItems.id, itemId))
    .limit(1)
  if (snapshot === undefined) return 0
  await handle
    .select({ id: works.id })
    .from(works)
    .where(eq(works.id, snapshot.workId))
    .for('update')
  const [item] = await handle
    .select()
    .from(workInboxItems)
    .where(eq(workInboxItems.id, itemId))
    .for('update')
  if (
    item === undefined ||
    item.workId !== snapshot.workId ||
    item.status !== 'unconfirmed' ||
    item.unconfirmedAt === null ||
    item.unconfirmedAt.getTime() > cutoff.getTime()
  ) {
    return 0
  }
  const sourceSiblings = and(
    eq(workInboxItems.workId, item.workId),
    eq(workInboxItems.sourceType, item.sourceType),
    eq(workInboxItems.sourceId, item.sourceId),
  )
  const [latest] = await handle
    .select({ id: workInboxItems.id })
    .from(workInboxItems)
    .where(sourceSiblings)
    .orderBy(
      desc(workInboxItems.createdAt),
      desc(workInboxItems.sourceVersion),
      desc(workInboxItems.id),
    )
    .limit(1)
  const supersededByNewer = latest !== undefined && latest.id !== item.id
  if (!supersededByNewer) {
    // 当前已是最新版本：把可能残留的旧 pending 收掉，避免撞来源 pending 唯一索引。
    await handle
      .update(workInboxItems)
      .set({
        status: 'superseded',
        statusReason: 'new_version',
        statusAt: now,
        updatedAt: now,
      })
      .where(
        and(sourceSiblings, eq(workInboxItems.status, 'pending'), ne(workInboxItems.id, item.id)),
      )
  }
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
  if (updated === undefined) return 0
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
  return 1
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
