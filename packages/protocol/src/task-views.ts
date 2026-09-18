/**
 * Task 消息读模型（`task_message` 的团队可见投影）。
 *
 * 这是 **Hub 与 Web 共用的唯一真源**（#210）：`GET /tasks/:id` 的 `comments` 与
 * `instructions` 在服务端**本来就是同一种结构**（`apps/hub/src/modules/task/view.ts` 里
 * `instructions: CommentView[]`，同一份 `toCommentView`）。Web 曾手写第二份
 * `InstructionView`（子集副本：缺 `origin`/`editedAt`，`kind` 被收窄为指令两态），
 * 只因为 ③c 在展示层把两条流分开画——字段漂移后两边对不上就是 `#210` 这条 Issue。
 *
 * 收敛形状：
 *  - `TaskMessageView` = 完整 13 字段（`toCommentView` 实际发出的样子）；
 *  - Hub 的 `CommentView` = `TaskMessageView`（公开路径仍叫 Comment，改名属 #210 前半句
 *    "公开命名统一"、仍 OPEN——③c 已合入但改名没发生，户头不在 ③c；本片只收类型、不碰路径）；
 *  - Web 的 `InstructionView` = `TaskMessageView & { kind: 'instruction' | 'followup' }`
 *    （**派生**，不是第二份手写：服务端加字段时自动流过去）。
 *
 * **strictObject 是故意的**：服务端多发一个字段而这里不同步，`TaskRoomView` 的消费侧就该
 * 响——"静默多出字段"是另一种漂移。
 */
import { z } from 'zod'

export const TaskMessageViewSchema = z.strictObject({
  id: z.string(),
  taskId: z.string(),
  authorUserId: z.string(),
  body: z.string(),
  kind: z.enum(['discussion', 'instruction', 'followup']),
  origin: z.enum(['human', 'auto_assignment']),
  targetAgentId: z.string().nullable(),
  runId: z.string().nullable(),
  instructionState: z.enum(['pending', 'accepted', 'rejected']).nullable(),
  instructionErrorCode: z.string().nullable(),
  instructionErrorMessage: z.string().nullable(),
  createdAt: z.string(),
  editedAt: z.string().nullable(),
})

export type TaskMessageView = z.infer<typeof TaskMessageViewSchema>
