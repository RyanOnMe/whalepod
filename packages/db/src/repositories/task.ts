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
