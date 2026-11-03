import { and, desc, eq, inArray, sql } from 'drizzle-orm'
import type { DbHandle } from '../client.js'
import { workInboxDeliveries } from '../schema/work-delivery.js'
import { workInboxItems } from '../schema/work-inbox.js'
import {
  workEntryAdmissions,
  workEntryRouterCalls,
  type NewWorkEntryAdmissionRow,
  type NewWorkEntryRouterCallRow,
  type WorkEntryAdmissionRow,
  type WorkEntryRouterCallRow,
} from '../schema/work-entry.js'
import {
  workSubscriptions,
  type NewWorkSubscriptionRow,
  type WorkSubscriptionRow,
} from '../schema/work-subscription.js'

export type {
  NewWorkEntryAdmissionRow,
  NewWorkEntryRouterCallRow,
  WorkEntryAdmissionRow,
  WorkEntryRouterCallRow,
} from '../schema/work-entry.js'
export type { NewWorkSubscriptionRow, WorkSubscriptionRow } from '../schema/work-subscription.js'

// ADR-0028（RD-02b）：订阅与入口准入的持久化原语。状态迁移与来源校验由 Hub 命令层裁决。

export type WorkSubscriptionTarget = WorkSubscriptionRow['targetType']

/** 同一 active 订阅身份并发插入时返回 undefined，由调用方回读既有行。 */
export async function insertWorkSubscription(
  handle: DbHandle,
  values: NewWorkSubscriptionRow,
): Promise<WorkSubscriptionRow | undefined> {
  const [row] = await handle
    .insert(workSubscriptions)
    .values(values)
    .onConflictDoNothing()
    .returning()
  return row
}

export async function getWorkSubscription(
  handle: DbHandle,
  id: string,
): Promise<WorkSubscriptionRow | undefined> {
  const [row] = await handle
    .select()
    .from(workSubscriptions)
    .where(eq(workSubscriptions.id, id))
    .limit(1)
  return row
}

export async function getWorkSubscriptionForUpdate(
  handle: DbHandle,
  id: string,
): Promise<WorkSubscriptionRow | undefined> {
  const [row] = await handle
    .select()
    .from(workSubscriptions)
    .where(eq(workSubscriptions.id, id))
    .limit(1)
    .for('update')
  return row
}

export async function findActiveWorkSubscription(
  handle: DbHandle,
  workId: string,
  targetType: WorkSubscriptionTarget,
  targetRef: string,
): Promise<WorkSubscriptionRow | undefined> {
  const [row] = await handle
    .select()
    .from(workSubscriptions)
    .where(
      and(
        eq(workSubscriptions.workId, workId),
        eq(workSubscriptions.targetType, targetType),
        eq(workSubscriptions.targetRef, targetRef),
        eq(workSubscriptions.status, 'active'),
      ),
    )
    .limit(1)
  return row
}

export async function listWorkSubscriptions(
  handle: DbHandle,
  workId: string,
): Promise<WorkSubscriptionRow[]> {
  return handle
    .select()
    .from(workSubscriptions)
    .where(eq(workSubscriptions.workId, workId))
    .orderBy(desc(workSubscriptions.createdAt), desc(workSubscriptions.id))
}

export interface WorkSubscriptionPatch {
  readonly status?: WorkSubscriptionRow['status']
  readonly endedByUserId?: string | null
  readonly statusReason?: string | null
  readonly endedAt?: Date | null
  readonly updatedAt?: Date
}

export async function updateWorkSubscription(
  handle: DbHandle,
  id: string,
  patch: WorkSubscriptionPatch,
): Promise<WorkSubscriptionRow | undefined> {
  const [row] = await handle
    .update(workSubscriptions)
    .set({ ...patch, updatedAt: patch.updatedAt ?? new Date() })
    .where(eq(workSubscriptions.id, id))
    .returning()
  return row
}

/**
 * 订阅失效/撤权时清理该订阅交付的未读副本。已消费条目保持原状（ADR-0024/0027：
 * 已交给模型的内容不承诺清除），delivered/unconfirmed 只撤回投递记录、不复活 Run。
 */
export async function retractInboxItemsForSubscription(
  handle: DbHandle,
  subscriptionId: string,
  statusReason: string,
  now: Date,
): Promise<WorkInboxRetractRow[]> {
  const rows = await handle
    .update(workInboxItems)
    .set({
      status: 'retracted',
      statusReason,
      retractionScope: 'subscription',
      returnReason: null,
      returnNote: null,
      deliveryRunId: null,
      deliveredAt: null,
      unconfirmedAt: null,
      consumedAt: null,
      statusAt: now,
      updatedAt: now,
    })
    .where(
      and(
        eq(workInboxItems.subscriptionId, subscriptionId),
        inArray(workInboxItems.status, ['pending', 'returned', 'delivered', 'unconfirmed']),
      ),
    )
    .returning()
  if (rows.length > 0) {
    await handle
      .update(workInboxDeliveries)
      .set({
        status: 'withdrawn',
        failureReason: 'subscription_ended',
        settledAt: now,
        updatedAt: now,
      })
      .where(
        and(
          inArray(
            workInboxDeliveries.inboxItemId,
            rows.map((row) => row.id),
          ),
          inArray(workInboxDeliveries.status, ['sent', 'unconfirmed']),
        ),
      )
  }
  return rows
}

export type WorkInboxRetractRow = typeof workInboxItems.$inferSelect

/**
 * Mandate 新版本/暂停/撤销、Task 改派与工作退休统一走这里：旧订阅转 stale，
 * 并清理其未读副本。返回被收口的订阅，供调用方写观测。
 */
export async function expireWorkSubscriptionsAndRetract(
  handle: DbHandle,
  values: {
    readonly workId: string
    readonly statusReason: string
    readonly now: Date
  },
): Promise<WorkSubscriptionRow[]> {
  const ended = await handle
    .update(workSubscriptions)
    .set({
      status: 'stale',
      endedByUserId: null,
      statusReason: values.statusReason,
      endedAt: values.now,
      updatedAt: values.now,
    })
    .where(and(eq(workSubscriptions.workId, values.workId), eq(workSubscriptions.status, 'active')))
    .returning()
  for (const subscription of ended) {
    await retractInboxItemsForSubscription(handle, subscription.id, values.statusReason, values.now)
  }
  return ended
}

export async function insertWorkEntryRouterCall(
  handle: DbHandle,
  values: NewWorkEntryRouterCallRow,
): Promise<WorkEntryRouterCallRow | undefined> {
  const [row] = await handle
    .insert(workEntryRouterCalls)
    .values(values)
    .onConflictDoNothing({ target: workEntryRouterCalls.dedupeKey })
    .returning()
  return row
}

export async function getWorkEntryRouterCallByKey(
  handle: DbHandle,
  dedupeKey: string,
): Promise<WorkEntryRouterCallRow | undefined> {
  const [row] = await handle
    .select()
    .from(workEntryRouterCalls)
    .where(eq(workEntryRouterCalls.dedupeKey, dedupeKey))
    .limit(1)
  return row
}

export async function insertWorkEntryAdmission(
  handle: DbHandle,
  values: NewWorkEntryAdmissionRow,
): Promise<WorkEntryAdmissionRow | undefined> {
  const [row] = await handle
    .insert(workEntryAdmissions)
    .values(values)
    .onConflictDoNothing({ target: workEntryAdmissions.dedupeKey })
    .returning()
  return row
}

export async function getWorkEntryAdmissionByKey(
  handle: DbHandle,
  dedupeKey: string,
): Promise<WorkEntryAdmissionRow | undefined> {
  const [row] = await handle
    .select()
    .from(workEntryAdmissions)
    .where(eq(workEntryAdmissions.dedupeKey, dedupeKey))
    .limit(1)
  return row
}

export async function listWorkEntryAdmissions(
  handle: DbHandle,
  workId: string,
  limit: number,
): Promise<WorkEntryAdmissionRow[]> {
  return handle
    .select()
    .from(workEntryAdmissions)
    .where(eq(workEntryAdmissions.workId, workId))
    .orderBy(desc(workEntryAdmissions.createdAt), desc(workEntryAdmissions.id))
    .limit(limit)
}

/** 测试与对账用的轻量计数；路由读面仍走 listWorkEntryAdmissions。 */
export async function countWorkEntryAdmissions(
  handle: DbHandle,
  workId: string,
  outcome?: WorkEntryAdmissionRow['outcome'],
): Promise<number> {
  const where =
    outcome === undefined
      ? eq(workEntryAdmissions.workId, workId)
      : and(eq(workEntryAdmissions.workId, workId), eq(workEntryAdmissions.outcome, outcome))
  const [row] = await handle
    .select({ count: sql<number>`count(*)::int` })
    .from(workEntryAdmissions)
    .where(where)
  return row?.count ?? 0
}
