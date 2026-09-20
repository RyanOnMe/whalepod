import type { TaskMessageRow, TaskRow } from '@whalepod/db'
import type { TaskMessageView } from '@whalepod/protocol'
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
 * 线程消息的 JSON 视图（03 §2.2）。
 *
 * #185 起实体是 `task_message`：除讨论外还承载指令与追问（既有讨论消息按默认值
 * `discussion` / `human` 读出，老客户端不受影响）。
 *
 * #210 收敛：唯一真源是 `@whalepod/protocol` 的 `TaskMessageView`，这里只做派生——
 * 此前是逐字段手写镜像，与 Web 的第二份副本互相漂移。
 *
 * 命名说明：**视图与 HTTP 路径叫 Comment**（`/tasks/:taskId/comments`）。
 * 实体是 `task_message`（讨论/指令/追问同表），"comment" 在这里就是"消息"的意思——
 * #210 前半句"公开命名统一"按 C 方案关闭：内外一致（类型/事件/路径全叫 comment），
 * 改名是审美不是正确性，不值得一次破坏性迁移。
 */
export type CommentView = TaskMessageView

/**
 * DB 行 → 团队可见投影（#210：返回类型就是协议的 `TaskMessageView`，改返回形状时
 * 类型与 `TaskMessageViewSchema` 会一起响）。
 *
 * 诚实记账（评审 S1）：下面三处 `as` 是类型断言、**不是运行时校验**——全 Hub 没有
 * 任何 `TaskMessageViewSchema.safeParse/parse` 输出路径（输出路径是 routes →
 * getTaskRoom → JSON 直出，Web 的 `client.ts` 又是 `as T`）。脏值今天进不来，
 * 靠的是 DB 侧：`task_message` 的 kind/origin/state 约束（`schema/project.ts` +
 * 迁移 `0003_task_message.sql`）与写入层只给合法值；集成测试的"真库过 schema"
 * 判据是这条链唯一的运行时钉子。
 */
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
    instructionErrorCode: row.instructionErrorCode,
    instructionErrorMessage: row.instructionErrorMessage,
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
