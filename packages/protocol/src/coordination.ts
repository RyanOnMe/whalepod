/**
 * ADR-0026（PC-04a）：确定性内部协调的读面与评估视图。
 *
 * 本切片不派发 Node/模型：评估状态只用 queued/completed/skipped/failed；
 * 视图不含正文副本，Inference 仍由 `context_entry` 的读面提供引用。
 */
import { z } from 'zod'
import { ProjectContextEntryViewSchema } from './context.js'

export const CoordinationEvaluationStatusSchema = z.enum([
  'queued',
  'dispatched',
  'running',
  'completed',
  'failed',
  'cancelled',
  'skipped',
  'stale',
])
export type CoordinationEvaluationStatus = z.infer<typeof CoordinationEvaluationStatusSchema>

export const CoordinationEvaluationViewSchema = z.strictObject({
  id: z.uuid(),
  projectId: z.uuid(),
  status: CoordinationEvaluationStatusSchema,
  attempt: z.number().int().positive(),
  inputDigest: z.string().regex(/^[a-f0-9]{64}$/),
  manifestVersion: z.number().int().positive(),
  rulesVersion: z.string().min(1).max(64),
  processorVersion: z.string().min(1).max(64),
  queuedAt: z.iso.datetime({ offset: true }),
  queueExpiresAt: z.iso.datetime({ offset: true }),
  coalescedAt: z.iso.datetime({ offset: true }).nullable(),
  finishedAt: z.iso.datetime({ offset: true }).nullable(),
  failureCode: z.string().max(64).nullable(),
  failureSummary: z.string().max(1000).nullable(),
  inferenceEntryId: z.uuid().nullable(),
  createdAt: z.iso.datetime({ offset: true }),
})
export type CoordinationEvaluationView = z.infer<typeof CoordinationEvaluationViewSchema>

export const ProjectCoordinatorStateViewSchema = z.strictObject({
  projectId: z.uuid(),
  enabled: z.boolean(),
  rulesVersion: z.string().min(1).max(64),
  processorVersion: z.string().min(1).max(64),
  lastSuccessfulEvaluationId: z.uuid().nullable(),
  pausedAt: z.iso.datetime({ offset: true }).nullable(),
  pauseReason: z.string().max(500).nullable(),
})
export type ProjectCoordinatorStateView = z.infer<typeof ProjectCoordinatorStateViewSchema>

export const CoordinationOpenQuestionViewSchema = z.strictObject({
  text: z.string().min(1).max(2000),
  entryId: z.uuid(),
  businessRef: z.string().min(1).max(300),
  businessVersion: z.string().min(1).max(200),
})
export type CoordinationOpenQuestionView = z.infer<typeof CoordinationOpenQuestionViewSchema>

export const ProjectCoordinationViewSchema = z.strictObject({
  projectId: z.uuid(),
  state: ProjectCoordinatorStateViewSchema,
  latestEvaluation: CoordinationEvaluationViewSchema.nullable(),
  latestInference: ProjectContextEntryViewSchema.nullable(),
  openQuestions: z.array(CoordinationOpenQuestionViewSchema),
})
export type ProjectCoordinationView = z.infer<typeof ProjectCoordinationViewSchema>
