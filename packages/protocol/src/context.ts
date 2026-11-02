/**
 * 项目事实账本（ADR-0025；PC-03a）。
 *
 * 先覆盖平台内事件产生的 Observation/Decision/Correction 与业务引用；来源修订、
 * 线程与 WorkLink 的字段由后续切片增加。视图不含凭据、绝对路径或平台私密正文。
 */
import { z } from 'zod'

export const ContextEntryKindSchema = z.enum(['observation', 'inference', 'decision', 'correction'])
export type ContextEntryKind = z.infer<typeof ContextEntryKindSchema>

export const ContextEntryStatusSchema = z.enum(['active', 'superseded', 'conflict', 'retracted'])
export type ContextEntryStatus = z.infer<typeof ContextEntryStatusSchema>

export const ContextActorKindSchema = z.enum(['member', 'system', 'coordinator'])
export type ContextActorKind = z.infer<typeof ContextActorKindSchema>

/** 业务引用：指向既有业务事实；source 引用在后续切片启用。 */
export const BusinessCitationViewSchema = z.strictObject({
  kind: z.literal('business'),
  businessRef: z.string().min(1).max(300),
  businessVersion: z.string().min(1).max(200),
  occurredAt: z.iso.datetime({ offset: true }),
})
export type BusinessCitationView = z.infer<typeof BusinessCitationViewSchema>

/** 来源引用：PC-03b/03c 启用；当前只保留形状，不在内部事件中使用。 */
export const SourceCitationViewSchema = z.strictObject({
  kind: z.literal('source'),
  sourceId: z.uuid(),
  revisionId: z.uuid(),
  resourceKey: z.string().min(1).max(500),
  threadKey: z.string().min(1).max(300).optional(),
  locator: z.string().min(1).max(2000),
  authorizationGeneration: z.number().int().positive(),
  observedAt: z.iso.datetime({ offset: true }),
  digest: z.string().regex(/^[a-f0-9]{64}$/),
})
export type SourceCitationView = z.infer<typeof SourceCitationViewSchema>

export const ContextCitationViewSchema = z.discriminatedUnion('kind', [
  BusinessCitationViewSchema,
  SourceCitationViewSchema,
])
export type ContextCitationView = z.infer<typeof ContextCitationViewSchema>

/** 成员视图：正文只在团队可读的当前有效集返回；推断与决定类型始终可见。 */
export const ProjectContextEntryViewSchema = z
  .strictObject({
    id: z.uuid(),
    projectId: z.uuid(),
    kind: ContextEntryKindSchema,
    status: ContextEntryStatusSchema,
    correctedAt: z.iso.datetime({ offset: true }).nullable(),
    title: z.string().min(1).max(200),
    body: z.string().max(65536),
    payload: z.record(z.string(), z.unknown()),
    businessRef: z.string().min(1).max(300).nullable(),
    businessVersion: z.string().min(1).max(200).nullable(),
    targetEntryId: z.uuid().nullable(),
    evaluationId: z.uuid().nullable(),
    actorKind: ContextActorKindSchema,
    createdBy: z.uuid().nullable(),
    processorVersion: z.string().max(100).nullable(),
    createdAt: z.iso.datetime({ offset: true }),
    citations: z.array(ContextCitationViewSchema).max(16),
  })
  .superRefine((value, ctx) => {
    // Correction 指向目标条目而不是引用事实；其余类型至少一条引用（ADR-0025 §1）。
    if (value.kind !== 'correction' && value.citations.length === 0) {
      ctx.addIssue({ code: 'custom', message: 'non-correction entries require a citation' })
    }
  })
export type ProjectContextEntryView = z.infer<typeof ProjectContextEntryViewSchema>

export const ProjectContextViewSchema = z.strictObject({
  projectId: z.uuid(),
  entries: z.array(ProjectContextEntryViewSchema),
  /**
   * 非 null 表示还有下一页（按 entry 身份键集分页）；读面不得静默截断——
   * 调用方必须把 null 当作「已到末尾」。
   */
  nextCursor: z.string().max(1000).nullable(),
})
export type ProjectContextView = z.infer<typeof ProjectContextViewSchema>

/** POST /projects/:projectId/context/:entryId/correction */
export const CorrectContextEntryRequestSchema = z.strictObject({
  correctionKind: z.enum(['negate', 'amend', 'unrelated']),
  note: z.string().trim().min(1).max(2000),
})
export type CorrectContextEntryRequest = z.infer<typeof CorrectContextEntryRequestSchema>
