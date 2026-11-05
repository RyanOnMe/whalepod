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
