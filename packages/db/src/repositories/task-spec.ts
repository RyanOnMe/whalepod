/**
 * 任务约定版本仓储（#378；ADR-0017 §1）：draft 可编辑（draft_version CAS）、
 * confirmed 不可变且 (task_id, revision_number) 唯一。
 *
 * 并发语义由调用方 + 库共同保证：命令层先锁 Task 行串行化「编号分配 / 编辑 / 确认」，
 * 这里再对草稿编辑用 `draft_version` 做条件更新（CAS）兜底——即使将来有旁路调用，
 * 不匹配的编辑也写不进去（不覆盖他人版本）。
 */
import type { TaskSpecContent } from '@whalepod/protocol'
import { and, desc, eq, max, sql } from 'drizzle-orm'
import type { DbHandle } from '../client.js'
import { taskSpecRevisions } from '../schema/project.js'

export type TaskSpecRevisionRow = typeof taskSpecRevisions.$inferSelect

export interface NewTaskSpecDraft {
  id: string
  taskId: string
  content: TaskSpecContent
  origin: 'manual' | 'agent'
  createdBy: string
  createdAt: Date
}

export async function insertSpecDraft(
  handle: DbHandle,
  draft: NewTaskSpecDraft,
): Promise<TaskSpecRevisionRow> {
  const [row] = await handle
    .insert(taskSpecRevisions)
    .values({
      id: draft.id,
      taskId: draft.taskId,
      status: 'draft',
      content: draft.content,
      draftVersion: 1,
      origin: draft.origin,
      createdBy: draft.createdBy,
      createdAt: draft.createdAt,
      updatedAt: draft.createdAt,
    })
    .returning()
  if (row === undefined) throw new Error('insert task spec draft returned no row')
  return row
}

/** 当前开放草稿（每 Task 至多一个，部分唯一索引兜底）。 */
export async function getOpenSpecDraft(
  handle: DbHandle,
  taskId: string,
): Promise<TaskSpecRevisionRow | undefined> {
  const [row] = await handle
    .select()
    .from(taskSpecRevisions)
    .where(and(eq(taskSpecRevisions.taskId, taskId), eq(taskSpecRevisions.status, 'draft')))
    .limit(1)
  return row
}

export async function getSpecRevision(
  handle: DbHandle,
  id: string,
): Promise<TaskSpecRevisionRow | undefined> {
  const [row] = await handle
    .select()
    .from(taskSpecRevisions)
    .where(eq(taskSpecRevisions.id, id))
    .limit(1)
  return row
}

/** 最新已确认版本（缺省绑定的解析对象）。 */
export async function getLatestConfirmedSpec(
  handle: DbHandle,
  taskId: string,
): Promise<TaskSpecRevisionRow | undefined> {
  const [row] = await handle
    .select()
    .from(taskSpecRevisions)
    .where(and(eq(taskSpecRevisions.taskId, taskId), eq(taskSpecRevisions.status, 'confirmed')))
    .orderBy(desc(taskSpecRevisions.revisionNumber))
    .limit(1)
  return row
}

/** 已确认历史（倒序、含内容）；limit 为读模型硬 cap，真实总数用 count 单独取。 */
export async function listConfirmedSpecRevisions(
  handle: DbHandle,
  taskId: string,
  limit: number,
): Promise<TaskSpecRevisionRow[]> {
  return handle
    .select()
    .from(taskSpecRevisions)
    .where(and(eq(taskSpecRevisions.taskId, taskId), eq(taskSpecRevisions.status, 'confirmed')))
    .orderBy(desc(taskSpecRevisions.revisionNumber))
    .limit(limit)
}

export async function countConfirmedSpecRevisions(
  handle: DbHandle,
  taskId: string,
): Promise<number> {
  const [row] = await handle
    .select({ value: sql<number>`count(*)::int` })
    .from(taskSpecRevisions)
    .where(and(eq(taskSpecRevisions.taskId, taskId), eq(taskSpecRevisions.status, 'confirmed')))
  return row?.value ?? 0
}

/** 绑定展示用（#378）：id → revision_number；仅已确认行有编号（绑定只能指向已确认版本）。 */
export async function mapSpecRevisionNumbers(
  handle: DbHandle,
  taskId: string,
): Promise<Map<string, number>> {
  const rows = await handle
    .select({ id: taskSpecRevisions.id, revisionNumber: taskSpecRevisions.revisionNumber })
    .from(taskSpecRevisions)
    .where(and(eq(taskSpecRevisions.taskId, taskId), eq(taskSpecRevisions.status, 'confirmed')))
  return new Map(
    rows
      .filter((row): row is { id: string; revisionNumber: number } => row.revisionNumber !== null)
      .map((row) => [row.id, row.revisionNumber]),
  )
}

/** 下一个版本号 = 当前 max + 1（调用方持 Task 行锁；部分唯一索引是并发兜底）。 */
export async function nextSpecRevisionNumber(handle: DbHandle, taskId: string): Promise<number> {
  const [row] = await handle
    .select({ value: max(taskSpecRevisions.revisionNumber) })
    .from(taskSpecRevisions)
    .where(eq(taskSpecRevisions.taskId, taskId))
  return (row?.value ?? 0) + 1
}

/**
 * 草稿编辑（CAS）：仅当行仍是 draft 且 `draft_version` 等于 expected 时落盘，
 * 版本 +1。返回 undefined = 并发修改/状态已变（调用方回 409 让用户重取）。
 */
export async function updateSpecDraftContentCas(
  handle: DbHandle,
  id: string,
  content: TaskSpecContent,
  expectedDraftVersion: number,
  now: Date,
): Promise<TaskSpecRevisionRow | undefined> {
  const [row] = await handle
    .update(taskSpecRevisions)
    .set({ content, draftVersion: expectedDraftVersion + 1, updatedAt: now })
    .where(
      and(
        eq(taskSpecRevisions.id, id),
        eq(taskSpecRevisions.status, 'draft'),
        eq(taskSpecRevisions.draftVersion, expectedDraftVersion),
      ),
    )
    .returning()
  return row
}

/** 草稿确认：仅 draft 行可确认（CAS 语义，重复确认返回 undefined）。 */
export async function confirmSpecDraftCas(
  handle: DbHandle,
  id: string,
  revisionNumber: number,
  confirmedBy: string,
  now: Date,
): Promise<TaskSpecRevisionRow | undefined> {
  const [row] = await handle
    .update(taskSpecRevisions)
    .set({
      status: 'confirmed',
      revisionNumber,
      confirmedBy,
      confirmedAt: now,
      updatedAt: now,
    })
    .where(and(eq(taskSpecRevisions.id, id), eq(taskSpecRevisions.status, 'draft')))
    .returning()
  return row
}

/** 丢弃草稿（仅 draft 行；confirmed 不可删）。 */
export async function deleteSpecDraft(
  handle: DbHandle,
  id: string,
): Promise<TaskSpecRevisionRow | undefined> {
  const [row] = await handle
    .delete(taskSpecRevisions)
    .where(and(eq(taskSpecRevisions.id, id), eq(taskSpecRevisions.status, 'draft')))
    .returning()
  return row
}
