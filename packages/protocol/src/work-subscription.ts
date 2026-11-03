/**
 * ADR-0028（RD-02b）：显式工作订阅与入口准入观测面的 HTTP 契约。
 *
 * 订阅只表达「这类内部来源属于当前持续职责」，不授予执行权；创建/撤销均由
 * Task 当前 assignee 显式操作，并绑定创建时的 Mandate 版本与来源授权代次。
 * 入口准入记录快/慢路径决定，但只带不透明 id、摘要与计数，不带来源正文。
 */
import { z } from 'zod'
import { WorkSourceTypeSchema } from './work.js'

export const WorkSubscriptionTargetTypeSchema = z.enum(['task', 'business_ref'])
export type WorkSubscriptionTargetType = z.infer<typeof WorkSubscriptionTargetTypeSchema>

export const WorkSubscriptionStatusSchema = z.enum(['active', 'revoked', 'stale'])
export type WorkSubscriptionStatus = z.infer<typeof WorkSubscriptionStatusSchema>

export const WorkSubscriptionViewSchema = z.strictObject({
  id: z.uuid(),
  workKey: z.uuid(),
  targetType: WorkSubscriptionTargetTypeSchema,
  targetRef: z.string().min(1).max(200),
  status: WorkSubscriptionStatusSchema,
  authorizationGeneration: z.string().min(1).max(128),
  mandateId: z.uuid(),
  mandateVersion: z.number().int().positive(),
  createdByUserId: z.uuid(),
  endedByUserId: z.uuid().nullable(),
  statusReason: z.string().max(500).nullable(),
  endedAt: z.iso.datetime({ offset: true }).nullable(),
  createdAt: z.iso.datetime({ offset: true }),
  updatedAt: z.iso.datetime({ offset: true }),
})
export type WorkSubscriptionView = z.infer<typeof WorkSubscriptionViewSchema>

export const CreateWorkSubscriptionRequestSchema = z.strictObject({
  targetType: WorkSubscriptionTargetTypeSchema,
  targetRef: z.string().trim().min(1).max(200),
})
export type CreateWorkSubscriptionRequest = z.infer<typeof CreateWorkSubscriptionRequestSchema>

export const EndWorkSubscriptionRequestSchema = z.strictObject({
  reason: z.string().trim().min(1).max(500).optional(),
})
export type EndWorkSubscriptionRequest = z.infer<typeof EndWorkSubscriptionRequestSchema>

export const WorkEntryAdmissionOutcomeSchema = z.enum(['deliver', 'route_router', 'drop', 'wait'])
export type WorkEntryAdmissionOutcome = z.infer<typeof WorkEntryAdmissionOutcomeSchema>

export const WorkEntryAdmissionTriggerSchema = z.enum(['source', 'return'])
export type WorkEntryAdmissionTrigger = z.infer<typeof WorkEntryAdmissionTriggerSchema>

export const WorkEntryAdmissionViewSchema = z.strictObject({
  id: z.uuid(),
  workKey: z.uuid(),
  trigger: WorkEntryAdmissionTriggerSchema,
  outcome: WorkEntryAdmissionOutcomeSchema,
  reason: z.string().min(1).max(500),
  sourceType: WorkSourceTypeSchema,
  sourceId: z.uuid(),
  sourceVersion: z.string().min(1).max(200),
  sourceDigest: z.string().regex(/^[a-f0-9]{64}$/),
  authorizationGeneration: z.string().min(1).max(128),
  subscriptionId: z.uuid().nullable(),
  inboxItemId: z.uuid().nullable(),
  routerInvoked: z.boolean(),
  routerCallId: z.uuid().nullable(),
  deadlineAt: z.iso.datetime({ offset: true }).nullable(),
  createdAt: z.iso.datetime({ offset: true }),
})
export type WorkEntryAdmissionView = z.infer<typeof WorkEntryAdmissionViewSchema>

export const WorkEntryAdmissionListQuerySchema = z.strictObject({
  limit: z.coerce.number().int().min(1).max(100).default(50),
})
export type WorkEntryAdmissionListQuery = z.infer<typeof WorkEntryAdmissionListQuerySchema>
