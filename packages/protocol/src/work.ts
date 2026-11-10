/**
 * ADR-0028（RD-01）：持续工作、Mandate 与影子准入的 HTTP 视图/请求契约。
 *
 * 视图只含协调元数据与引用，不含来源正文；`dispatch_intent` 由 RD-03a/b 推进
 * `proposed/approved/dispatched` 与终态。
 */
import { z } from 'zod'
import { WorkAnswerTypeSchema, WorkQuestionViewSchema } from './work-question.js'

export const WorkStateSchema = z.enum(['active', 'waiting', 'retired'])
export type WorkState = z.infer<typeof WorkStateSchema>

export const WorkResumeModeSchema = z.enum(['auto', 'owner_confirmation'])
export type WorkResumeMode = z.infer<typeof WorkResumeModeSchema>

export const WorkMandateStatusSchema = z.enum([
  'draft',
  'active',
  'paused',
  'revoked',
  'expired',
  'superseded',
])
export type WorkMandateStatus = z.infer<typeof WorkMandateStatusSchema>

export const WorkAutoDispatchSchema = z.enum(['off', 'existing_task'])
export type WorkAutoDispatch = z.infer<typeof WorkAutoDispatchSchema>

export const WorkActionClassSchema = z.enum(['research', 'analysis', 'draft', 'revise'])
export type WorkActionClass = z.infer<typeof WorkActionClassSchema>

export const WorkSourceTypeSchema = z.enum(['task_message', 'context_entry'])
export type WorkSourceType = z.infer<typeof WorkSourceTypeSchema>

export const RouterDecisionKindSchema = z.enum(['ignore', 'wait', 'ask', 'propose'])
export type RouterDecisionKind = z.infer<typeof RouterDecisionKindSchema>

export const DispatchIntentStatusSchema = z.enum([
  'proposed',
  'approved',
  'dispatched',
  'rejected',
  'expired',
  'cancelled',
  'superseded',
])
export type DispatchIntentStatus = z.infer<typeof DispatchIntentStatusSchema>

export const DispatchApprovalBasisSchema = z.enum(['human', 'mandate'])
export type DispatchApprovalBasis = z.infer<typeof DispatchApprovalBasisSchema>

// ADR-0028 §7 固定草稿工具面在 RD-01 的保守子集：只接受这些工具名。面外工具
//（bash/run_code/workflow/subagent*/job*/skill/web/message/发布/业务写入）不是「走审批」，
// 而是根本不能写进 Mandate。
export const WORK_DRAFT_TOOL_NAMES = ['read', 'write', 'edit', 'glob', 'grep'] as const
export const WorkDraftToolNameSchema = z.enum(WORK_DRAFT_TOOL_NAMES)
export type WorkDraftToolName = z.infer<typeof WorkDraftToolNameSchema>

export const WorkViewSchema = z.strictObject({
  workKey: z.uuid(),
  taskId: z.uuid(),
  projectId: z.uuid(),
  humanOwnerUserId: z.uuid(),
  goal: z.string().min(1).max(1000),
  state: WorkStateSchema,
  resumeMode: WorkResumeModeSchema.nullable(),
  resumeCondition: z.string().max(500).nullable(),
  mandateId: z.uuid().nullable(),
  retiredAt: z.iso.datetime({ offset: true }).nullable(),
  createdAt: z.iso.datetime({ offset: true }),
  updatedAt: z.iso.datetime({ offset: true }),
})
export type WorkView = z.infer<typeof WorkViewSchema>

export const WorkMandateViewSchema = z.strictObject({
  id: z.uuid(),
  workKey: z.uuid(),
  version: z.number().int().positive(),
  current: z.boolean(),
  status: WorkMandateStatusSchema,
  principalUserId: z.uuid(),
  onBehalfOfUserId: z.uuid(),
  humanOwnerUserId: z.uuid(),
  draftRecipientUserId: z.uuid(),
  autoDispatch: WorkAutoDispatchSchema,
  allowedActionClasses: z.array(WorkActionClassSchema).min(1).max(4),
  allowedSourceTypes: z.array(WorkSourceTypeSchema).min(1).max(2),
  allowedAgentIds: z.array(z.uuid()).max(32),
  allowedToolNames: z.array(WorkDraftToolNameSchema).max(16),
  maxRunsPerWork: z.number().int().nonnegative(),
  maxCostMicros: z.number().int().nonnegative(),
  maxTokens: z.number().int().nonnegative(),
  maxAttempts: z.number().int().nonnegative(),
  waitDeadlineSeconds: z.number().int().positive().max(86400),
  expiresAt: z.iso.datetime({ offset: true }),
  statusReason: z.string().max(500).nullable(),
  pausedAt: z.iso.datetime({ offset: true }).nullable(),
  revokedAt: z.iso.datetime({ offset: true }).nullable(),
  createdAt: z.iso.datetime({ offset: true }),
})
export type WorkMandateView = z.infer<typeof WorkMandateViewSchema>

export const WorkDecisionViewSchema = z.strictObject({
  id: z.uuid(),
  decision: RouterDecisionKindSchema,
  reason: z.string().min(1).max(64),
  summary: z.string().min(1).max(500),
  sourceType: WorkSourceTypeSchema,
  sourceId: z.uuid(),
  sourceVersion: z.string().min(1).max(200),
  sourceDigest: z.string().regex(/^[a-f0-9]{64}$/),
  inputDigest: z.string().regex(/^[a-f0-9]{64}$/),
  mandateId: z.uuid().nullable(),
  mandateVersion: z.number().int().positive().nullable(),
  rulesVersion: z.string().min(1).max(64),
  refs: z.record(z.string(), z.unknown()),
  createdAt: z.iso.datetime({ offset: true }),
})
export type WorkDecisionView = z.infer<typeof WorkDecisionViewSchema>

export const DispatchIntentViewSchema = z.strictObject({
  id: z.uuid(),
  workKey: z.uuid(),
  status: DispatchIntentStatusSchema,
  approvalBasis: DispatchApprovalBasisSchema.nullable(),
  decisionId: z.uuid().nullable(),
  mandateId: z.uuid(),
  mandateVersion: z.number().int().positive(),
  authorizedByUserId: z.uuid(),
  onBehalfOfUserId: z.uuid(),
  inputDigest: z.string().regex(/^[a-f0-9]{64}$/),
  triggerRefs: z.array(z.unknown()).min(1).max(16),
  candidates: z.array(z.unknown()),
  exclusionReasons: z.array(z.unknown()),
  reason: z.string().min(1).max(500),
  resolutionReason: z.string().min(1).max(500).nullable(),
  agentId: z.uuid().nullable(),
  profileRevisionId: z.uuid().nullable(),
  deviceId: z.uuid().nullable(),
  workspaceId: z.uuid().nullable(),
  actionClass: WorkActionClassSchema.nullable(),
  runId: z.uuid().nullable(),
  expiresAt: z.iso.datetime({ offset: true }),
  approvedAt: z.iso.datetime({ offset: true }).nullable(),
  dispatchedAt: z.iso.datetime({ offset: true }).nullable(),
  cancelledAt: z.iso.datetime({ offset: true }).nullable(),
  rejectedAt: z.iso.datetime({ offset: true }).nullable(),
  createdAt: z.iso.datetime({ offset: true }),
})
export type DispatchIntentView = z.infer<typeof DispatchIntentViewSchema>

export const WorkWatermarksSchema = z.strictObject({
  lastDecisionAt: z.iso.datetime({ offset: true }).nullable(),
  lastSourceVersion: z.string().max(200).nullable(),
  proposedIntentCount: z.number().int().nonnegative(),
})
export type WorkWatermarks = z.infer<typeof WorkWatermarksSchema>

export const CreateWorkMandateRequestSchema = z.strictObject({
  autoDispatch: WorkAutoDispatchSchema.default('off'),
  allowedActionClasses: z
    .array(WorkActionClassSchema)
    .min(1)
    .max(4)
    .default(['research', 'analysis', 'draft', 'revise']),
  allowedSourceTypes: z
    .array(WorkSourceTypeSchema)
    .min(1)
    .max(2)
    .default(['task_message', 'context_entry']),
  allowedAgentIds: z.array(z.uuid()).max(32).default([]),
  allowedToolNames: z.array(WorkDraftToolNameSchema).max(16).default([]),
  maxRunsPerWork: z.number().int().nonnegative().default(20),
  maxCostMicros: z.number().int().nonnegative().default(10_000_000),
  maxTokens: z.number().int().nonnegative().default(2_000_000),
  maxAttempts: z.number().int().nonnegative().default(3),
  waitDeadlineSeconds: z.number().int().min(1).max(86400).default(900),
  expiresAt: z.iso.datetime({ offset: true }),
  draftRecipientUserId: z.uuid().optional(),
})
export type CreateWorkMandateRequest = z.infer<typeof CreateWorkMandateRequestSchema>

/**
 * RD-03d2b：`authorize_scope` 回答必须显式给出完整范围，不能靠创建 Mandate 的默认值
 * 静默补全成更宽的授权。字段与 `CreateWorkMandateRequest` 相同，但不带 default。
 */
export const WorkAuthorizeScopeRequestSchema = z.strictObject({
  autoDispatch: WorkAutoDispatchSchema,
  allowedActionClasses: z.array(WorkActionClassSchema).min(1).max(4),
  allowedSourceTypes: z.array(WorkSourceTypeSchema).min(1).max(2),
  allowedAgentIds: z.array(z.uuid()).max(32),
  allowedToolNames: z.array(WorkDraftToolNameSchema).max(16),
  maxRunsPerWork: z.number().int().nonnegative(),
  maxCostMicros: z.number().int().nonnegative(),
  maxTokens: z.number().int().nonnegative(),
  maxAttempts: z.number().int().nonnegative(),
  waitDeadlineSeconds: z.number().int().min(1).max(86400),
  expiresAt: z.iso.datetime({ offset: true }),
  draftRecipientUserId: z.uuid().optional(),
})
export type WorkAuthorizeScopeRequest = z.infer<typeof WorkAuthorizeScopeRequestSchema>

export const WorkMandateProposalStatusSchema = z.enum([
  'pending',
  'confirmed',
  'superseded',
  'expired',
  'cancelled',
])
export type WorkMandateProposalStatus = z.infer<typeof WorkMandateProposalStatusSchema>

/** RD-03d2b：authorize_scope 回答生成的待确认草案；确认前不扩大当前 Mandate。 */
export const WorkMandateProposalViewSchema = z.strictObject({
  id: z.uuid(),
  workKey: z.uuid(),
  questionId: z.uuid(),
  decisionId: z.string().regex(/^[a-f0-9]{64}$/),
  baseMandateId: z.uuid(),
  baseMandateVersion: z.number().int().positive(),
  principalUserId: z.uuid(),
  status: WorkMandateProposalStatusSchema,
  scope: CreateWorkMandateRequestSchema,
  resultMandateId: z.uuid().nullable(),
  createdAt: z.iso.datetime({ offset: true }),
  confirmedAt: z.iso.datetime({ offset: true }).nullable(),
})
export type WorkMandateProposalView = z.infer<typeof WorkMandateProposalViewSchema>

export const WorkDetailViewSchema = z.strictObject({
  work: WorkViewSchema,
  currentMandate: WorkMandateViewSchema.nullable(),
  recentDecisions: z.array(WorkDecisionViewSchema).max(50),
  proposedIntents: z.array(DispatchIntentViewSchema).max(50),
  /** RD-03b：最近派工意图全量（含 approved/dispatched/终态），供工作读面显示自动派工。 */
  dispatchIntents: z.array(DispatchIntentViewSchema).max(50).default([]),
  /** RD-03d2a：等待责任人回答的 ask（只含 open；回答历史按问题/回答表审计）。 */
  openQuestions: z.array(WorkQuestionViewSchema).max(50).default([]),
  /** RD-03d2b：已回答但尚未确认的新 Mandate 草案（只归当前责任人）。 */
  pendingMandateProposals: z.array(WorkMandateProposalViewSchema).max(50).default([]),
  watermarks: WorkWatermarksSchema,
})
export type WorkDetailView = z.infer<typeof WorkDetailViewSchema>

export const WorkQuestionAnswerRequestSchema = z.strictObject({
  answerType: WorkAnswerTypeSchema,
  optionId: z.string().min(1).max(64).optional(),
  reason: z.string().trim().min(1).max(500).optional(),
  /**
   * RD-03d2b：`authorize_scope` 回答必须携带完整范围，使用与创建 Mandate 相同的
   * 字段与语义校验；只生成 pending 草案，不直接扩大当前 Mandate。
   */
  scope: WorkAuthorizeScopeRequestSchema.optional(),
})
export type WorkQuestionAnswerRequest = z.infer<typeof WorkQuestionAnswerRequestSchema>

export const WorkQuestionAnswerViewSchema = z.strictObject({
  question: WorkQuestionViewSchema,
  answer: z.strictObject({
    id: z.uuid(),
    decisionId: z.string().regex(/^[a-f0-9]{64}$/),
    answerType: WorkAnswerTypeSchema,
    optionId: z.string().max(64).nullable(),
    binding: z.boolean(),
    rejectionReason: z.string().max(64).nullable(),
    createdAt: z.iso.datetime({ offset: true }),
  }),
  /** 绑定回答后是否需要重新准入/派工（本切片只返回提示，不自动建意图）。 */
  reevaluate: z.boolean(),
  /** defer 回答：不自动派发，等待期限/重评归 RD-03d3。 */
  deferred: z.boolean(),
  /** deny 或 choose_option 的 cancel/retry 是否取消了关联的 proposed/approved 意图。 */
  intentCancelled: z.boolean(),
  /** RD-03d2b：authorize_scope 绑定回答生成的 pending 草案；其它回答为 null。 */
  scopeProposal: WorkMandateProposalViewSchema.nullable(),
})
export type WorkQuestionAnswerView = z.infer<typeof WorkQuestionAnswerViewSchema>

export const WorkMandateProposalConfirmViewSchema = z.strictObject({
  proposal: WorkMandateProposalViewSchema,
  mandate: WorkMandateViewSchema,
  question: WorkQuestionViewSchema,
})
export type WorkMandateProposalConfirmView = z.infer<typeof WorkMandateProposalConfirmViewSchema>

export const WorkAdmissionCheckResultSchema = z.strictObject({
  decision: WorkDecisionViewSchema,
  proposedIntent: DispatchIntentViewSchema.nullable(),
  duplicate: z.boolean(),
})
export type WorkAdmissionCheckResult = z.infer<typeof WorkAdmissionCheckResultSchema>

export const CreateWorkRequestSchema = z.strictObject({
  goal: z.string().trim().min(1).max(1000),
})
export type CreateWorkRequest = z.infer<typeof CreateWorkRequestSchema>

export const WorkMandateStatusChangeRequestSchema = z.strictObject({
  reason: z.string().trim().min(1).max(500).optional(),
})
export type WorkMandateStatusChangeRequest = z.infer<typeof WorkMandateStatusChangeRequestSchema>

export const DispatchIntentApproveRequestSchema = z.strictObject({})
export type DispatchIntentApproveRequest = z.infer<typeof DispatchIntentApproveRequestSchema>

export const DispatchIntentRejectRequestSchema = z.strictObject({
  reason: z.string().trim().min(1).max(500).optional(),
})
export type DispatchIntentRejectRequest = z.infer<typeof DispatchIntentRejectRequestSchema>

export const DispatchIntentDispatchRequestSchema = z.strictObject({
  agentId: z.uuid(),
  profileRevisionId: z.uuid().optional(),
  deviceId: z.uuid(),
  workspaceId: z.uuid(),
  actionClass: WorkActionClassSchema.default('draft'),
  workInputItemIds: z.array(z.uuid()).max(32).optional(),
  executionProfile: z.enum(['managed_draft_source', 'managed_draft_source_preparation']).optional(),
  managedDraftSourceId: z.uuid().optional(),
})
export type DispatchIntentDispatchRequest = z.infer<typeof DispatchIntentDispatchRequestSchema>

export const WorkAdmissionCheckRequestSchema = z.strictObject({
  sourceType: WorkSourceTypeSchema,
  sourceId: z.uuid(),
})
export type WorkAdmissionCheckRequest = z.infer<typeof WorkAdmissionCheckRequestSchema>
