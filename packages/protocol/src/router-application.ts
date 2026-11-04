/** ADR-0028 §17（RD-03r2）：Router 提案应用、wait 与显式重评的 HTTP 视图。 */
import { z } from 'zod'

const Id = z.uuid()
const Digest = z.string().regex(/^[a-f0-9]{64}$/)
const Time = z.iso.datetime({ offset: true })

export const RouterApplicationViewSchema = z.strictObject({
  evaluationId: Id,
  workKey: Id,
  decision: z.enum(['dispatch', 'wait', 'ask', 'ignore']),
  status: z.enum(['applied', 'rejected', 'stale']),
  reason: z.string().min(1).max(500).nullable(),
  evaluationDigest: Digest,
  mandateId: Id,
  mandateVersion: z.number().int().positive(),
  decisionId: Id.nullable(),
  intentId: Id.nullable(),
  questionId: Id.nullable(),
  waitId: Id.nullable(),
  runId: Id.nullable(),
  appliedAt: Time,
})
export type RouterApplicationView = z.infer<typeof RouterApplicationViewSchema>

export const WorkWaitViewSchema = z.strictObject({
  id: Id,
  evaluationId: Id,
  workKey: Id,
  status: z.enum(['open', 'resumed', 'expired', 'superseded', 'cancelled']),
  reason: z.string().min(1).max(64),
  summary: z.string().min(1).max(500),
  resumeCondition: z.string().min(1).max(500),
  generation: z.number().int().positive(),
  deadlineAt: Time,
  mandateId: Id,
  mandateVersion: z.number().int().positive(),
  createdAt: Time,
  updatedAt: Time,
})
export type WorkWaitView = z.infer<typeof WorkWaitViewSchema>

/**
 * 显式重评入口：`waitId` 表示从 open wait 的当前代次重评；`evaluationId` 表示对
 * 已结束（failed/stale/skipped）的评估明确重试。二者取一，不接受客户端自造
 * triggerKey。
 */
export const RouterReevaluateRequestSchema = z
  .strictObject({
    waitId: Id.optional(),
    evaluationId: Id.optional(),
  })
  .refine((value) => (value.waitId === undefined) !== (value.evaluationId === undefined), {
    message: 'exactly one of waitId or evaluationId is required',
  })
export type RouterReevaluateRequest = z.infer<typeof RouterReevaluateRequestSchema>
