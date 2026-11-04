/**
 * ADR-0028 §8（RD-03d2a）：`ask` 的问题与回答契约。
 *
 * 问题只暴露协调元数据（摘要、候选文本、不透明引用）；不暴露来源正文。
 * `decisionId` 是确定性哈希，客户端只当作不透明标识。
 */
import { z } from 'zod'

export const WorkQuestionTypeSchema = z.enum(['choose_option', 'authorize_scope'])
export type WorkQuestionType = z.infer<typeof WorkQuestionTypeSchema>

export const WorkQuestionStatusSchema = z.enum([
  'open',
  'answered',
  'superseded',
  'expired',
  'cancelled',
])
export type WorkQuestionStatus = z.infer<typeof WorkQuestionStatusSchema>

export const WorkAnswerTypeSchema = z.enum(['choose_option', 'deny', 'defer', 'authorize_scope'])
export type WorkAnswerType = z.infer<typeof WorkAnswerTypeSchema>

export const WorkQuestionOptionSchema = z.strictObject({
  id: z.string().min(1).max(64),
  label: z.string().min(1).max(200),
})
export type WorkQuestionOption = z.infer<typeof WorkQuestionOptionSchema>

export const WorkQuestionViewSchema = z.strictObject({
  id: z.uuid(),
  workKey: z.uuid(),
  decisionId: z.string().regex(/^[a-f0-9]{64}$/),
  questionType: WorkQuestionTypeSchema,
  blockedDecision: z.string().min(1).max(64),
  summary: z.string().min(1).max(500),
  options: z.array(WorkQuestionOptionSchema).min(1).max(8),
  recommendedOptionId: z.string().min(1).max(64).nullable(),
  refs: z.record(z.string(), z.unknown()),
  inputDigest: z.string().regex(/^[a-f0-9]{64}$/),
  mandateId: z.uuid(),
  mandateVersion: z.number().int().positive(),
  principalUserId: z.uuid(),
  dispatchIntentId: z.uuid().nullable(),
  status: WorkQuestionStatusSchema,
  createdAt: z.iso.datetime({ offset: true }),
  answeredAt: z.iso.datetime({ offset: true }).nullable(),
  closedAt: z.iso.datetime({ offset: true }).nullable(),
})
export type WorkQuestionView = z.infer<typeof WorkQuestionViewSchema>

export const WorkQuestionAnswerRequestSchema = z.strictObject({
  answerType: WorkAnswerTypeSchema,
  optionId: z.string().min(1).max(64).optional(),
  reason: z.string().trim().min(1).max(500).optional(),
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
})
export type WorkQuestionAnswerView = z.infer<typeof WorkQuestionAnswerViewSchema>
