import { and, desc, eq, inArray } from 'drizzle-orm'
import type { DbHandle } from '../client.js'
import { workInboxDeliveries } from '../schema/work-delivery.js'
import {
  workInboxItems,
  type NewWorkInboxItemRow,
  type WorkInboxItemRow,
} from '../schema/work-inbox.js'

export type { NewWorkInboxItemRow, WorkInboxItemRow } from '../schema/work-inbox.js'

// ADR-0028（RD-02a-1）：收件箱条目的持久化原语。状态迁移与来源校验由 Hub 命令层裁决；
// 同一身份/版本/摘要的唯一性由唯一索引兜底。

/** 同一身份/版本/摘要并发插入时返回 undefined，由调用方回读既有行。 */
export async function insertWorkInboxItem(
  handle: DbHandle,
  values: NewWorkInboxItemRow,
): Promise<WorkInboxItemRow | undefined> {
  const [row] = await handle
    .insert(workInboxItems)
    .values(values)
    // 只吞同一身份/版本/摘要的冲突；来源 pending 唯一索引冲突必须上抛成显式 409，
    // 不能被当成“并发同身份”后回读成 500。
    .onConflictDoNothing({
      target: [
        workInboxItems.workId,
        workInboxItems.sourceType,
        workInboxItems.sourceId,
        workInboxItems.sourceVersion,
        workInboxItems.sourceDigest,
      ],
    })
    .returning()
  return row
}

export async function getWorkInboxItem(
  handle: DbHandle,
  id: string,
): Promise<WorkInboxItemRow | undefined> {
  const [row] = await handle.select().from(workInboxItems).where(eq(workInboxItems.id, id)).limit(1)
  return row
}

export async function getWorkInboxItemForUpdate(
  handle: DbHandle,
  id: string,
): Promise<WorkInboxItemRow | undefined> {
  const [row] = await handle
    .select()
    .from(workInboxItems)
    .where(eq(workInboxItems.id, id))
    .limit(1)
    .for('update')
  return row
}

export async function getWorkInboxItemByIdentity(
  handle: DbHandle,
  values: {
    readonly workId: string
    readonly sourceType: WorkInboxItemRow['sourceType']
    readonly sourceId: string
    readonly sourceVersion: string
    readonly sourceDigest: string
  },
): Promise<WorkInboxItemRow | undefined> {
  const [row] = await handle
    .select()
    .from(workInboxItems)
    .where(
      and(
        eq(workInboxItems.workId, values.workId),
        eq(workInboxItems.sourceType, values.sourceType),
        eq(workInboxItems.sourceId, values.sourceId),
        eq(workInboxItems.sourceVersion, values.sourceVersion),
        eq(workInboxItems.sourceDigest, values.sourceDigest),
      ),
    )
    .limit(1)
  return row
}

export async function getRetractedInboxItemForSource(
  handle: DbHandle,
  workId: string,
  sourceType: WorkInboxItemRow['sourceType'],
  sourceId: string,
): Promise<WorkInboxItemRow | undefined> {
  const [row] = await handle
    .select()
    .from(workInboxItems)
    .where(
      and(
        eq(workInboxItems.workId, workId),
        eq(workInboxItems.sourceType, sourceType),
        eq(workInboxItems.sourceId, sourceId),
        eq(workInboxItems.status, 'retracted'),
        eq(workInboxItems.retractionScope, 'source'),
      ),
    )
    .limit(1)
  return row
}

/** 无锁读一批条目（用于先确定 workId，再按 Work→item 顺序加锁）。 */
export async function listWorkInboxItemsByIds(
  handle: DbHandle,
  ids: readonly string[],
): Promise<WorkInboxItemRow[]> {
  if (ids.length === 0) return []
  return handle
    .select()
    .from(workInboxItems)
    .where(inArray(workInboxItems.id, [...ids]))
    .orderBy(desc(workInboxItems.id))
}

export async function getLatestPendingInboxItemForSource(
  handle: DbHandle,
  workId: string,
  sourceType: WorkInboxItemRow['sourceType'],
  sourceId: string,
): Promise<WorkInboxItemRow | undefined> {
  const [row] = await handle
    .select()
    .from(workInboxItems)
    .where(
      and(
        eq(workInboxItems.workId, workId),
        eq(workInboxItems.sourceType, sourceType),
        eq(workInboxItems.sourceId, sourceId),
        eq(workInboxItems.status, 'pending'),
      ),
    )
    .orderBy(desc(workInboxItems.createdAt), desc(workInboxItems.id))
    .limit(1)
  return row
}

/** 业务引用订阅：同一 businessRef + sourceKind 的新版本替换旧 pending。 */
export async function getLatestPendingInboxItemForBusinessRef(
  handle: DbHandle,
  values: {
    readonly workId: string
    readonly businessRef: string
    readonly sourceKinds: readonly string[]
  },
): Promise<WorkInboxItemRow | undefined> {
  if (values.sourceKinds.length === 0) return undefined
  const [row] = await handle
    .select()
    .from(workInboxItems)
    .where(
      and(
        eq(workInboxItems.workId, values.workId),
        eq(workInboxItems.businessRef, values.businessRef),
        inArray(workInboxItems.sourceKind, [...values.sourceKinds]),
        eq(workInboxItems.status, 'pending'),
      ),
    )
    .orderBy(desc(workInboxItems.createdAt), desc(workInboxItems.id))
    .limit(1)
  return row
}

export async function supersedePendingInboxItemsForBusinessRef(
  handle: DbHandle,
  values: {
    readonly workId: string
    readonly businessRef: string
    readonly sourceKinds: readonly string[]
    readonly now: Date
  },
): Promise<WorkInboxItemRow[]> {
  if (values.sourceKinds.length === 0) return []
  return handle
    .update(workInboxItems)
    .set({
      status: 'superseded',
      statusReason: 'new_version',
      statusAt: values.now,
      updatedAt: values.now,
    })
    .where(
      and(
        eq(workInboxItems.workId, values.workId),
        eq(workInboxItems.businessRef, values.businessRef),
        inArray(workInboxItems.sourceKind, [...values.sourceKinds]),
        eq(workInboxItems.status, 'pending'),
      ),
    )
    .returning()
}

/** 同一来源的新版本替换旧 pending；返回被替换的行（保留历史）。 */
export async function supersedePendingInboxItems(
  handle: DbHandle,
  values: {
    readonly workId: string
    readonly sourceType: WorkInboxItemRow['sourceType']
    readonly sourceId: string
    readonly now: Date
  },
): Promise<WorkInboxItemRow[]> {
  return handle
    .update(workInboxItems)
    .set({
      status: 'superseded',
      statusReason: 'new_version',
      statusAt: values.now,
      updatedAt: values.now,
    })
    .where(
      and(
        eq(workInboxItems.workId, values.workId),
        eq(workInboxItems.sourceType, values.sourceType),
        eq(workInboxItems.sourceId, values.sourceId),
        eq(workInboxItems.status, 'pending'),
      ),
    )
    .returning()
}

export interface WorkInboxItemPatch {
  readonly status?: WorkInboxItemRow['status']
  readonly statusReason?: string | null
  readonly retractionScope?: string | null
  readonly autoAdmitted?: boolean
  readonly returnReason?: WorkInboxItemRow['returnReason']
  readonly returnNote?: string | null
  readonly statusAt?: Date
  readonly updatedAt?: Date
}

/** 来源级撤权：把该来源所有 pending/returned 条目一起收口，避免旧条目撤权后新版本继续投。 */
export async function retractInboxItemsForSource(
  handle: DbHandle,
  values: {
    readonly workId: string
    readonly sourceType: WorkInboxItemRow['sourceType']
    readonly sourceId: string
    readonly statusReason: string
    readonly now: Date
  },
): Promise<WorkInboxItemRow[]> {
  const rows = await handle
    .update(workInboxItems)
    .set({
      status: 'retracted',
      statusReason: values.statusReason,
      retractionScope: 'source',
      returnReason: null,
      returnNote: null,
      deliveryRunId: null,
      deliveredAt: null,
      unconfirmedAt: null,
      consumedAt: null,
      statusAt: values.now,
      updatedAt: values.now,
    })
    .where(
      and(
        eq(workInboxItems.workId, values.workId),
        eq(workInboxItems.sourceType, values.sourceType),
        eq(workInboxItems.sourceId, values.sourceId),
        inArray(workInboxItems.status, ['pending', 'returned', 'delivered', 'unconfirmed']),
      ),
    )
    .returning()
  if (rows.length > 0) {
    await handle
      .update(workInboxDeliveries)
      .set({
        status: 'withdrawn',
        failureReason: 'source_retracted',
        settledAt: values.now,
        updatedAt: values.now,
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

/**
 * wait 自动保留的副本随工作生命周期收口。RD-02a 的人工显式关联条目（auto_admitted=false）
 * 仍按原语义保留，避免把 assignee 明确关联的依据静默撤掉。
 */
export async function retractAutoAdmittedInboxItemsForWork(
  handle: DbHandle,
  values: {
    readonly workId: string
    readonly statusReason: string
    readonly now: Date
  },
): Promise<WorkInboxItemRow[]> {
  const rows = await handle
    .update(workInboxItems)
    .set({
      status: 'retracted',
      statusReason: values.statusReason,
      retractionScope: 'lifecycle',
      returnReason: null,
      returnNote: null,
      deliveryRunId: null,
      deliveredAt: null,
      unconfirmedAt: null,
      consumedAt: null,
      statusAt: values.now,
      updatedAt: values.now,
    })
    .where(
      and(
        eq(workInboxItems.workId, values.workId),
        eq(workInboxItems.autoAdmitted, true),
        inArray(workInboxItems.status, ['pending', 'returned', 'delivered', 'unconfirmed']),
      ),
    )
    .returning()
  if (rows.length > 0) {
    await handle
      .update(workInboxDeliveries)
      .set({
        status: 'withdrawn',
        failureReason: 'work_lifecycle',
        settledAt: values.now,
        updatedAt: values.now,
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

export async function updateWorkInboxItem(
  handle: DbHandle,
  id: string,
  patch: WorkInboxItemPatch,
): Promise<WorkInboxItemRow | undefined> {
  const [row] = await handle
    .update(workInboxItems)
    .set({ ...patch, updatedAt: patch.updatedAt ?? new Date() })
    .where(eq(workInboxItems.id, id))
    .returning()
  return row
}

export async function getLatestWorkInboxItem(
  handle: DbHandle,
  workId: string,
): Promise<WorkInboxItemRow | undefined> {
  const [row] = await handle
    .select()
    .from(workInboxItems)
    .where(eq(workInboxItems.workId, workId))
    .orderBy(desc(workInboxItems.createdAt), desc(workInboxItems.id))
    .limit(1)
  return row
}

export async function listWorkInboxItems(
  handle: DbHandle,
  workId: string,
  limit: number,
  status?: WorkInboxItemRow['status'] | undefined,
): Promise<WorkInboxItemRow[]> {
  const where =
    status === undefined
      ? eq(workInboxItems.workId, workId)
      : and(eq(workInboxItems.workId, workId), eq(workInboxItems.status, status))
  return handle
    .select()
    .from(workInboxItems)
    .where(where)
    .orderBy(desc(workInboxItems.createdAt), desc(workInboxItems.id))
    .limit(limit)
}
