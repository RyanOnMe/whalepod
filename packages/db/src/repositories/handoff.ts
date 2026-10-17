/**
 * 交接草稿/版本仓储（#379；ADR-0017 §3-4）。
 *
 * 幂等与并发：
 * - 自动落库（事件上行）用 `onConflictDoNothing` 让「同一次上行的重放」不产生第二行
 *   （部分唯一索引 handoff_draft_one_open_per_run 兜底）；
 * - 草稿编辑用 `draft_version` 条件更新（CAS）；
 * - 版本编号用「Task 当前上限 + 1」在命令层的 Task 行锁内分配，唯一约束是并发兜底。
 */
import type { HandoffContent } from '@whalepod/protocol'
import { and, desc, eq, max, sql } from 'drizzle-orm'
import type { DbHandle } from '../client.js'
import { handoffDrafts, handoffReceipts, handoffRevisions } from '../schema/handoff.js'
import { tasks } from '../schema/project.js'
import { runs } from '../schema/run.js'

export type HandoffDraftRow = typeof handoffDrafts.$inferSelect
export type HandoffRevisionRow = typeof handoffRevisions.$inferSelect

export interface NewHandoffDraft {
  id: string
  taskId: string
  sourceRunId: string
  specRevisionId: string | null
  status: 'ready' | 'failed'
  failureReason?: string
  content?: HandoffContent
  origin: 'auto' | 'manual'
  createdBy: string
  createdAt: Date
}

/** 自动落库（事件上行）：冲突（同源 Run 已有未发布草稿）→ 跳过，不覆盖既有事实。 */
export async function insertHandoffDraftIfAbsent(
  handle: DbHandle,
  draft: NewHandoffDraft,
): Promise<{ inserted: boolean }> {
  const rows = await handle
    .insert(handoffDrafts)
    .values({
      id: draft.id,
      taskId: draft.taskId,
      sourceRunId: draft.sourceRunId,
      specRevisionId: draft.specRevisionId,
      status: draft.status,
      failureReason: draft.failureReason ?? null,
      content: draft.content ?? null,
      origin: draft.origin,
      createdBy: draft.createdBy,
      createdAt: draft.createdAt,
      updatedAt: draft.createdAt,
    })
    .onConflictDoNothing()
    .returning({ id: handoffDrafts.id })
  return { inserted: rows.length > 0 }
}

/** 该来源 Run 的未发布草稿（ready 或 failed；部分唯一索引保证至多一条）。 */
export async function getOpenHandoffDraft(
  handle: DbHandle,
  sourceRunId: string,
): Promise<HandoffDraftRow | undefined> {
  const [row] = await handle
    .select()
    .from(handoffDrafts)
    .where(
      and(
        eq(handoffDrafts.sourceRunId, sourceRunId),
        sql`${handoffDrafts.status} in ('ready', 'failed')`,
      ),
    )
    .limit(1)
  return row
}

/** 该来源 Run 最近一条草稿行（含 published 审计行）；读模型优先取未发布草稿。 */
export async function getLatestHandoffDraft(
  handle: DbHandle,
  sourceRunId: string,
): Promise<HandoffDraftRow | undefined> {
  const [row] = await handle
    .select()
    .from(handoffDrafts)
    .where(eq(handoffDrafts.sourceRunId, sourceRunId))
    .orderBy(desc(handoffDrafts.createdAt), desc(handoffDrafts.id))
    .limit(1)
  return row
}

export async function getHandoffDraftById(
  handle: DbHandle,
  id: string,
): Promise<HandoffDraftRow | undefined> {
  const [row] = await handle.select().from(handoffDrafts).where(eq(handoffDrafts.id, id)).limit(1)
  return row
}

/** 手工草稿替换失败草稿：只允许替换 failed 行（ready 行走编辑而非重建）。 */
export async function replaceFailedDraft(
  handle: DbHandle,
  failedDraftId: string,
  draft: Omit<NewHandoffDraft, 'status' | 'failureReason'>,
): Promise<{ inserted: boolean }> {
  const deleted = await handle
    .delete(handoffDrafts)
    .where(and(eq(handoffDrafts.id, failedDraftId), eq(handoffDrafts.status, 'failed')))
    .returning({ id: handoffDrafts.id })
  if (deleted.length === 0) return { inserted: false }
  await handle.insert(handoffDrafts).values({
    id: draft.id,
    taskId: draft.taskId,
    sourceRunId: draft.sourceRunId,
    specRevisionId: draft.specRevisionId,
    status: 'ready',
    content: draft.content ?? null,
    origin: draft.origin,
    createdBy: draft.createdBy,
    createdAt: draft.createdAt,
    updatedAt: draft.createdAt,
  })
  return { inserted: true }
}

/** 草稿编辑（CAS）：仅 ready 且版本匹配才落盘，版本 +1。 */
export async function updateHandoffDraftContentCas(
  handle: DbHandle,
  id: string,
  content: HandoffContent,
  expectedDraftVersion: number,
  now: Date,
): Promise<HandoffDraftRow | undefined> {
  const [row] = await handle
    .update(handoffDrafts)
    .set({ content, draftVersion: expectedDraftVersion + 1, updatedAt: now })
    .where(
      and(
        eq(handoffDrafts.id, id),
        eq(handoffDrafts.status, 'ready'),
        eq(handoffDrafts.draftVersion, expectedDraftVersion),
      ),
    )
    .returning()
  return row
}

/** 发布收敛：ready → published + 版本指针（CAS：仅 ready 行可发布）。 */
export async function markHandoffDraftPublished(
  handle: DbHandle,
  id: string,
  revisionId: string,
  now: Date,
): Promise<HandoffDraftRow | undefined> {
  const [row] = await handle
    .update(handoffDrafts)
    .set({ status: 'published', publishedRevisionId: revisionId, updatedAt: now })
    .where(and(eq(handoffDrafts.id, id), eq(handoffDrafts.status, 'ready')))
    .returning()
  return row
}

/** 下一个交接版本号（调用方持 Task 行锁；唯一约束兜底）。 */
export async function nextHandoffRevisionNumber(handle: DbHandle, taskId: string): Promise<number> {
  const [row] = await handle
    .select({ value: max(handoffRevisions.revisionNumber) })
    .from(handoffRevisions)
    .where(eq(handoffRevisions.taskId, taskId))
  return (row?.value ?? 0) + 1
}

export interface NewHandoffRevision {
  id: string
  taskId: string
  revisionNumber: number
  sourceRunId: string
  specRevisionId: string | null
  content: HandoffContent
  createdFromDraftId: string
  publishedBy: string
  publishedAt: Date
}

export async function insertHandoffRevision(
  handle: DbHandle,
  revision: NewHandoffRevision,
): Promise<HandoffRevisionRow> {
  const [row] = await handle.insert(handoffRevisions).values(revision).returning()
  if (row === undefined) throw new Error('insert handoff revision returned no row')
  return row
}

export async function getHandoffRevision(
  handle: DbHandle,
  id: string,
): Promise<HandoffRevisionRow | undefined> {
  const [row] = await handle
    .select()
    .from(handoffRevisions)
    .where(eq(handoffRevisions.id, id))
    .limit(1)
  return row
}

/** 某 Task 的已发布交接版本（倒序；团队可见读模型）。 */
export async function listHandoffRevisionsByTask(
  handle: DbHandle,
  taskId: string,
): Promise<HandoffRevisionRow[]> {
  return handle
    .select()
    .from(handoffRevisions)
    .where(eq(handoffRevisions.taskId, taskId))
    .orderBy(desc(handoffRevisions.revisionNumber))
}

/** 该上游 Task 的最新已发布版本号（「有新版本」判据；无版本 → 0）。 */
export async function latestHandoffRevisionNumber(
  handle: DbHandle,
  taskId: string,
): Promise<number> {
  const [row] = await handle
    .select({ value: max(handoffRevisions.revisionNumber) })
    .from(handoffRevisions)
    .where(eq(handoffRevisions.taskId, taskId))
  return row?.value ?? 0
}

export type HandoffReceiptRow = typeof handoffReceipts.$inferSelect

export interface NewHandoffReceipt {
  id: string
  revisionId: string
  upstreamTaskId: string
  downstreamTaskId: string
  receiverUserId: string
  deliveredBy: string
  /** 直接确认（adopt 路径）：状态与理解一次写入；缺省 = pending 待确认。 */
  confirmed?: { understanding: string; differences?: string; confirmedAt: Date }
  createdAt: Date
}

/**
 * 落一条接收关系。重复确认/采用（同 downstream_task_id + revision_id）由唯一约束
 * 兜底：`onConflictDoNothing` 后回读既有行——**重复点击不重复创建**。
 */
export async function insertHandoffReceiptIfAbsent(
  handle: DbHandle,
  receipt: NewHandoffReceipt,
): Promise<{ row: HandoffReceiptRow; inserted: boolean }> {
  const inserted = await handle
    .insert(handoffReceipts)
    .values({
      id: receipt.id,
      revisionId: receipt.revisionId,
      upstreamTaskId: receipt.upstreamTaskId,
      downstreamTaskId: receipt.downstreamTaskId,
      receiverUserId: receipt.receiverUserId,
      deliveredBy: receipt.deliveredBy,
      status: receipt.confirmed === undefined ? 'pending' : 'confirmed',
      understanding: receipt.confirmed?.understanding ?? null,
      differences: receipt.confirmed?.differences ?? null,
      createdAt: receipt.createdAt,
      updatedAt: receipt.createdAt,
      confirmedAt: receipt.confirmed?.confirmedAt ?? null,
    })
    .onConflictDoNothing()
    .returning()
  const row =
    inserted[0] ??
    (await getHandoffReceiptByVersion(handle, receipt.downstreamTaskId, receipt.revisionId))
  if (row === undefined) throw new Error('handoff receipt insert lost without conflict row')
  return { row, inserted: inserted.length > 0 }
}

export async function getHandoffReceipt(
  handle: DbHandle,
  id: string,
): Promise<HandoffReceiptRow | undefined> {
  const [row] = await handle
    .select()
    .from(handoffReceipts)
    .where(eq(handoffReceipts.id, id))
    .limit(1)
  return row
}

export async function getHandoffReceiptByVersion(
  handle: DbHandle,
  downstreamTaskId: string,
  revisionId: string,
): Promise<HandoffReceiptRow | undefined> {
  const [row] = await handle
    .select()
    .from(handoffReceipts)
    .where(
      and(
        eq(handoffReceipts.downstreamTaskId, downstreamTaskId),
        eq(handoffReceipts.revisionId, revisionId),
      ),
    )
    .limit(1)
  return row
}

/** 确认（CAS：仅 pending 行可确认；重复确认由状态早返回兜底，不覆盖首次理解）。 */
export async function confirmHandoffReceipt(
  handle: DbHandle,
  id: string,
  understanding: string,
  differences: string | undefined,
  now: Date,
): Promise<HandoffReceiptRow | undefined> {
  const [row] = await handle
    .update(handoffReceipts)
    .set({
      status: 'confirmed',
      understanding,
      differences: differences ?? null,
      confirmedAt: now,
      updatedAt: now,
    })
    .where(and(eq(handoffReceipts.id, id), eq(handoffReceipts.status, 'pending')))
    .returning()
  return row
}

/** 下游 Task 的接收关系（含其上游 Task 标题；确认/版本展示的数据源）。 */
export async function listReceiptsByDownstreamTask(
  handle: DbHandle,
  downstreamTaskId: string,
): Promise<
  Array<{ receipt: HandoffReceiptRow; revision: HandoffRevisionRow; upstreamTaskTitle: string }>
> {
  const rows = await handle
    .select({ receipt: handoffReceipts, revision: handoffRevisions, upstreamTitle: tasks.title })
    .from(handoffReceipts)
    .innerJoin(handoffRevisions, eq(handoffReceipts.revisionId, handoffRevisions.id))
    .innerJoin(tasks, eq(handoffReceipts.upstreamTaskId, tasks.id))
    .where(eq(handoffReceipts.downstreamTaskId, downstreamTaskId))
    .orderBy(desc(handoffRevisions.revisionNumber), desc(handoffReceipts.createdAt))
  return rows.map((row) => ({
    receipt: row.receipt,
    revision: row.revision,
    upstreamTaskTitle: row.upstreamTitle,
  }))
}

/** 上游 Task 发出的全部交接（「已交接」视图；含下游 Task 标题）。 */
export async function listReceiptsByUpstreamTask(
  handle: DbHandle,
  upstreamTaskId: string,
): Promise<
  Array<{ receipt: HandoffReceiptRow; revision: HandoffRevisionRow; downstreamTaskTitle: string }>
> {
  const rows = await handle
    .select({ receipt: handoffReceipts, revision: handoffRevisions, downstreamTitle: tasks.title })
    .from(handoffReceipts)
    .innerJoin(handoffRevisions, eq(handoffReceipts.revisionId, handoffRevisions.id))
    .innerJoin(tasks, eq(handoffReceipts.downstreamTaskId, tasks.id))
    .where(eq(handoffReceipts.upstreamTaskId, upstreamTaskId))
    .orderBy(desc(handoffReceipts.createdAt))
  return rows.map((row) => ({
    receipt: row.receipt,
    revision: row.revision,
    downstreamTaskTitle: row.downstreamTitle,
  }))
}

/**
 * Node 下载授权的最小扩展（#380；ADR-0017 §5）：该设备自己的 Run 的交接输入快照
 * 引用了该 Artifact 才可下载——不开放上游其他材料、候选与私有现场。
 */
export async function deviceHandoffInputReferences(
  handle: DbHandle,
  deviceId: string,
  artifactId: string,
): Promise<boolean> {
  const rows = await handle
    .select({ id: runs.id })
    .from(runs)
    .where(
      and(
        eq(runs.deviceId, deviceId),
        sql`${runs.handoffInput} is not null`,
        sql`exists (
          select 1 from jsonb_array_elements(${runs.handoffInput} -> 'artifacts') as entry
          where entry ->> 'artifactId' = ${artifactId}
        )`,
      ),
    )
    .limit(1)
  return rows.length > 0
}
