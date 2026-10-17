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
 *  - Hub 的 `CommentView` = `TaskMessageView`（公开路径仍叫 Comment：#210 前半句
 *    "公开命名统一"按 C 方案关闭——内外一致（类型/事件/路径全叫 comment），改名是审美
 *    不是正确性；公开路径改名是破坏性变更，留待不得不 bump 协议的大版本时顺手做）；
 *  - Web 的 `InstructionView` = `TaskMessageView & { kind: 'instruction' | 'followup' }`
 *    （**派生**，不是第二份手写：服务端加字段时自动流过去）。
 *
 * **strictObject 是故意的**：服务端多发一个字段而这里不同步，`TaskRoomView` 的消费侧就该
 * 响——"静默多出字段"是另一种漂移。
 */
import { z } from 'zod'
import { PreparationFactsSchema } from './node-wire.js'

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

/** #319：服务端生成的提交验收条件；缺失/未知不能被客户端视作可提交。 */
export const TaskReviewEligibilitySchema = z
  .strictObject({
    allowed: z.boolean(),
    reason: z
      .enum([
        'not_assignee',
        'not_accepted',
        'task_not_in_progress',
        'active_run',
        'no_published_artifact',
      ])
      .nullable(),
  })
  .refine((value) => value.allowed === (value.reason === null), 'allowed and reason must agree')
export type TaskReviewEligibility = z.infer<typeof TaskReviewEligibilitySchema>

export const ExecutionPreparationRequestSchema = z
  .strictObject({
    agentId: z.uuid(),
    profileRevisionId: z.uuid(),
    deviceId: z.uuid().optional(),
    workspaceId: z.uuid().optional(),
  })
  .refine(
    (value) => value.workspaceId === undefined || value.deviceId !== undefined,
    'workspace requires device',
  )
export const ExecutionPreparationViewSchema = z.strictObject({
  checkedAt: z.iso.datetime(),
  profileRevisionId: z.uuid(),
  deviceId: z.uuid(),
  workspaceId: z.uuid(),
  deviceName: z.string(),
  workspaceName: z.string(),
  modelCall: z.literal('not_tested'),
  ...PreparationFactsSchema.shape,
})
export type ExecutionPreparationRequest = z.infer<typeof ExecutionPreparationRequestSchema>
export type ExecutionPreparationView = z.infer<typeof ExecutionPreparationViewSchema>

/**
 * 任务约定内容四段（#378；ADR-0017 §1）：目标、约束、验收条件、待确认问题。
 * 空串合法（新草稿从空开始）；确认时要求目标非空（命令层校验，属业务规则不是形状规则）。
 * 每段 10000 字符与消息正文同口径。
 */
export const TaskSpecContentSchema = z.strictObject({
  goal: z.string().max(10000),
  constraints: z.string().max(10000),
  acceptance: z.string().max(10000),
  openQuestions: z.string().max(10000),
})
export type TaskSpecContent = z.infer<typeof TaskSpecContentSchema>

export const TaskSpecRevisionStatusSchema = z.enum(['draft', 'confirmed'])
export const TaskSpecRevisionOriginSchema = z.enum(['manual', 'agent'])

/** 单条约定版本（draft 或 confirmed）的读模型：Hub 出网前 parse，多一列少一列都是红。 */
export const TaskSpecRevisionViewSchema = z.strictObject({
  id: z.uuid(),
  taskId: z.uuid(),
  revisionNumber: z.number().int().positive().nullable(),
  status: TaskSpecRevisionStatusSchema,
  content: TaskSpecContentSchema,
  draftVersion: z.number().int().positive(),
  origin: TaskSpecRevisionOriginSchema,
  createdByUserId: z.uuid(),
  createdAt: z.string(),
  updatedAt: z.string(),
  confirmedByUserId: z.uuid().nullable(),
  confirmedAt: z.string().nullable(),
})
export type TaskSpecRevisionView = z.infer<typeof TaskSpecRevisionViewSchema>

/** 已确认历史返回上限（读模型硬 cap）：超出部分以 confirmedCount 如实计数。 */
export const TASK_AGREEMENT_HISTORY_LIMIT = 50

/**
 * GET /tasks/:taskId/agreement 的读模型（#378）：
 * - `draft` = 当前开放草稿（每 Task 至多一个）；`confirmed` = 最新已确认版本；
 * - `history` = 已确认版本倒序（≤ TASK_AGREEMENT_HISTORY_LIMIT），ConfirmedCount 是真实总数。
 */
export const TaskAgreementViewSchema = z.strictObject({
  enabled: z.boolean(),
  draft: TaskSpecRevisionViewSchema.nullable(),
  confirmed: TaskSpecRevisionViewSchema.nullable(),
  history: z.array(TaskSpecRevisionViewSchema),
  confirmedCount: z.number().int().min(0),
})
export type TaskAgreementView = z.infer<typeof TaskAgreementViewSchema>
