import type { TaskCommentRow, TaskRow } from '@whalepod/db'
import { getTask, listTasksByProject } from '@whalepod/db'
import type { DbHandle } from '@whalepod/db'

/** Task 的 JSON 视图（03 §2.2；时间为 ISO 字符串）。 */
export interface TaskView {
  id: string
  projectId: string
  title: string
  description: string
  status: TaskRow['status']
  assigneeUserId: string
  assignmentStatus: TaskRow['assignmentStatus']
  createdBy: string
  acceptedAt: string | null
  completedAt: string | null
  createdAt: string
  updatedAt: string
}

export function toTaskView(row: TaskRow): TaskView {
  return {
    id: row.id,
    projectId: row.projectId,
    title: row.title,
    description: row.description,
    status: row.status,
    assigneeUserId: row.assigneeUserId,
    assignmentStatus: row.assignmentStatus,
    createdBy: row.createdBy,
    acceptedAt: row.acceptedAt?.toISOString() ?? null,
    completedAt: row.completedAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  }
}

/** Comment 的 JSON 视图（03 §2.2；按 (createdAt, id) 稳定排序由 listComments 保证）。 */
export interface CommentView {
  id: string
  taskId: string
  authorUserId: string
  body: string
  createdAt: string
  editedAt: string | null
}

export function toCommentView(row: TaskCommentRow): CommentView {
  return {
    id: row.id,
    taskId: row.taskId,
    authorUserId: row.authorUserId,
    body: row.body,
    createdAt: row.createdAt.toISOString(),
    editedAt: row.editedAt?.toISOString() ?? null,
  }
}

export async function getTaskView(handle: DbHandle, id: string): Promise<TaskView | undefined> {
  const row = await getTask(handle, id)
  return row === undefined ? undefined : toTaskView(row)
}

export async function listTaskViewsByProject(
  handle: DbHandle,
  projectId: string,
): Promise<TaskView[]> {
  return (await listTasksByProject(handle, projectId)).map(toTaskView)
}
