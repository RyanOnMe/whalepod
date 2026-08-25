import { asc, eq } from 'drizzle-orm'
import type { DbHandle } from '../client.js'
import { projects, taskComments, tasks } from '../schema/project.js'

export type ProjectRow = typeof projects.$inferSelect
export type TaskRow = typeof tasks.$inferSelect
export type TaskCommentRow = typeof taskComments.$inferSelect

export interface NewProject {
  id: string
  name: string
  description?: string
  createdBy: string
}

export async function insertProject(handle: DbHandle, project: NewProject): Promise<ProjectRow> {
  const [row] = await handle.insert(projects).values(project).returning()
  if (row === undefined) throw new Error('insert project returned no row')
  return row
}

export async function getProject(handle: DbHandle, id: string): Promise<ProjectRow | undefined> {
  const [row] = await handle.select().from(projects).where(eq(projects.id, id)).limit(1)
  return row
}

export interface NewTask {
  id: string
  projectId: string
  title: string
  description?: string
  status?: TaskRow['status']
  assigneeUserId: string
  assignmentStatus?: TaskRow['assignmentStatus']
  createdBy: string
  acceptedAt?: Date
}

export async function insertTask(handle: DbHandle, task: NewTask): Promise<TaskRow> {
  const [row] = await handle.insert(tasks).values(task).returning()
  if (row === undefined) throw new Error('insert task returned no row')
  return row
}

export async function getTask(handle: DbHandle, id: string): Promise<TaskRow | undefined> {
  const [row] = await handle.select().from(tasks).where(eq(tasks.id, id)).limit(1)
  return row
}

export async function listTasksByProject(handle: DbHandle, projectId: string): Promise<TaskRow[]> {
  return handle
    .select()
    .from(tasks)
    .where(eq(tasks.projectId, projectId))
    .orderBy(asc(tasks.createdAt))
}

export async function setTaskStatus(
  handle: DbHandle,
  id: string,
  status: TaskRow['status'],
  completedAt?: Date,
): Promise<TaskRow | undefined> {
  const [row] = await handle
    .update(tasks)
    .set(completedAt !== undefined ? { status, completedAt } : { status })
    .where(eq(tasks.id, id))
    .returning()
  return row
}

export interface NewTaskComment {
  id: string
  taskId: string
  authorUserId: string
  body: string
}

export async function insertComment(
  handle: DbHandle,
  comment: NewTaskComment,
): Promise<TaskCommentRow> {
  const [row] = await handle.insert(taskComments).values(comment).returning()
  if (row === undefined) throw new Error('insert comment returned no row')
  return row
}

export async function listComments(handle: DbHandle, taskId: string): Promise<TaskCommentRow[]> {
  return handle
    .select()
    .from(taskComments)
    .where(eq(taskComments.taskId, taskId))
    .orderBy(asc(taskComments.createdAt))
}

/** 列出全部 Project（单 Team，所有未停用成员可见；03 §2.2）。 */
export async function listProjects(handle: DbHandle): Promise<ProjectRow[]> {
  return handle.select().from(projects).orderBy(asc(projects.createdAt))
}

/** PATCH /tasks/:taskId：只改非状态字段；updatedAt 由 task_set_updated_at 触发器写。 */
export async function updateTaskFields(
  handle: DbHandle,
  id: string,
  patch: { title?: string; description?: string },
): Promise<TaskRow | undefined> {
  const set: Record<string, unknown> = {}
  if (patch.title !== undefined) set.title = patch.title
  if (patch.description !== undefined) set.description = patch.description
  if (Object.keys(set).length === 0) return getTask(handle, id)
  const [row] = await handle.update(tasks).set(set).where(eq(tasks.id, id)).returning()
  return row
}

/** 迁移 Assignment 状态（accept→accepted、reject→rejected、reassign→pending）。 */
export async function setAssignment(
  handle: DbHandle,
  id: string,
  assignmentStatus: TaskRow['assignmentStatus'],
  acceptedAt: Date | null,
): Promise<TaskRow | undefined> {
  const [row] = await handle
    .update(tasks)
    .set({ assignmentStatus, acceptedAt })
    .where(eq(tasks.id, id))
    .returning()
  return row
}

/**
 * 重新指派：assignee 变化后 assignment_status 重置为 pending（03 §2.2/§3.1）。
 * 调用方负责「无活跃 Run」守卫（G2-05）与新 assignee 存在性校验。
 */
export async function reassignTask(
  handle: DbHandle,
  id: string,
  assigneeUserId: string,
): Promise<TaskRow | undefined> {
  const [row] = await handle
    .update(tasks)
    .set({ assigneeUserId, assignmentStatus: 'pending', acceptedAt: null })
    .where(eq(tasks.id, id))
    .returning()
  return row
}
