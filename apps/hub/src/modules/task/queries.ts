import type { TaskMessageRow, TaskRow } from '@whalepod/db'
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

/**
 * 线程消息的 JSON 视图（03 §2.2；按 (createdAt, id) 稳定排序由 listMessages 保证）。
 *
 * #185 起实体是 `task_message`：除讨论外还承载指令与追问，因此多出 kind / origin /
 * targetAgentId / runId / instructionState 五个字段（既有讨论消息按默认值
 * `discussion` / `human` 读出，老客户端不受影响）。
 *
 * 命名说明：**视图与 HTTP 路径暂时仍叫 Comment**（`/tasks/:taskId/comments`）——把公开
 * API 与前端一起改名属于切片③c（线程读模型 + UI），本片只升级实体，避免同一 Issue 里
 * 同时动 DB、Hub、Web 三处。**不新增 TODO**：改名点就是 ③c 的 Issue。
 */
export interface CommentView {
  id: string
  taskId: string
  authorUserId: string
  body: string
  kind: 'discussion' | 'instruction' | 'followup'
  origin: 'human' | 'auto_assignment'
  targetAgentId: string | null
  runId: string | null
  instructionState: 'pending' | 'accepted' | 'rejected' | null
  createdAt: string
  editedAt: string | null
}

export function toCommentView(row: TaskMessageRow): CommentView {
  return {
    id: row.id,
    taskId: row.taskId,
    authorUserId: row.authorUserId,
    body: row.body,
    kind: row.kind as CommentView['kind'],
    origin: row.origin as CommentView['origin'],
    targetAgentId: row.targetAgentId,
    runId: row.runId,
    instructionState: row.instructionState as CommentView['instructionState'],
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
