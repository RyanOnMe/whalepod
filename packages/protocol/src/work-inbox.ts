/**
 * ADR-0028（RD-02a-1）：工作收件箱条目的 HTTP 视图/请求契约。
 *
 * 条目保存来源正文的私有快照（仅 Task 当前 assignee 可读）；`sourceDigest` 与
 * `bodyDigest` 用于后续交付清单与重复判定。delivered/unconfirmed/consumed 属于
 * RD-02a-2，不在此处出现。
 */
import { z } from 'zod'
import { WorkSourceTypeSchema } from './work.js'

export const WorkInboxItemStatusSchema = z.enum([
  'pending',
  'returned',
  'superseded',
  'retracted',
  'expired',
])
export type WorkInboxItemStatus = z.infer<typeof WorkInboxItemStatusSchema>

export const WorkInboxReturnReasonSchema = z.enum([
  'irrelevant',
  'new_gap',
  'conflict',
  'permission_invalid',
  'incomplete',
])
export type WorkInboxReturnReason = z.infer<typeof WorkInboxReturnReasonSchema>

export const WorkInboxItemViewSchema = z.strictObject({
  id: z.uuid(),
  workKey: z.uuid(),
  sourceType: WorkSourceTypeSchema,
  sourceId: z.uuid(),
  sourceVersion: z.string().min(1).max(200),
  sourceDigest: z.string().regex(/^[a-f0-9]{64}$/),
  authorizationGeneration: z.string().min(1).max(64),
  title: z.string().min(1).max(200),
  body: z.string().max(65536),
  bodyDigest: z.string().regex(/^[a-f0-9]{64}$/),
  refs: z.record(z.string(), z.unknown()),
  supersedesId: z.uuid().nullable(),
  status: WorkInboxItemStatusSchema,
  statusReason: z.string().max(500).nullable(),
  returnReason: WorkInboxReturnReasonSchema.nullable(),
  returnNote: z.string().max(1000).nullable(),
  statusAt: z.iso.datetime({ offset: true }),
  createdAt: z.iso.datetime({ offset: true }),
  updatedAt: z.iso.datetime({ offset: true }),
})
export type WorkInboxItemView = z.infer<typeof WorkInboxItemViewSchema>

export const WorkInboxViewSchema = z.strictObject({
  items: z.array(WorkInboxItemViewSchema).max(100),
  watermarks: z.strictObject({
    lastItemAt: z.iso.datetime({ offset: true }).nullable(),
    pendingCount: z.number().int().nonnegative(),
  }),
})
export type WorkInboxView = z.infer<typeof WorkInboxViewSchema>

export const AssociateWorkInboxItemRequestSchema = z.strictObject({
  sourceType: WorkSourceTypeSchema,
  sourceId: z.uuid(),
})
export type AssociateWorkInboxItemRequest = z.infer<typeof AssociateWorkInboxItemRequestSchema>

export const WorkInboxItemReturnRequestSchema = z.strictObject({
  reason: WorkInboxReturnReasonSchema,
  note: z.string().trim().min(1).max(1000).optional(),
})
export type WorkInboxItemReturnRequest = z.infer<typeof WorkInboxItemReturnRequestSchema>

export const WorkInboxItemActionRequestSchema = z.strictObject({
  reason: z.string().trim().min(1).max(500).optional(),
})
export type WorkInboxItemActionRequest = z.infer<typeof WorkInboxItemActionRequestSchema>

export const WorkInboxListQuerySchema = z.strictObject({
  status: WorkInboxItemStatusSchema.optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
})
export type WorkInboxListQuery = z.infer<typeof WorkInboxListQuerySchema>
