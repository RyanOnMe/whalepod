/**
 * ADR-0027（PC-05a）：Run 项目上下文快照的线上形状。
 *
 * 只含不透明 id、内容地址与计数；正文只在 Node 受控下载与成员读面出现，绝不带
 * 本地路径。快照是创建事务里冻结的历史事实：后续新版本/纠正不修改它。
 */
import { z } from 'zod'

/** Node 在 `node.hello` 声明支持项目上下文快照；缺省 = 旧 Node，不派发非空快照。 */
export const PROJECT_CONTEXT_CAPABILITY = 'project-context.v1' as const
export const ProjectContextCapabilitySchema = z.enum([PROJECT_CONTEXT_CAPABILITY])

export const PROJECT_CONTEXT_MAX_ENTRIES = 32
export const PROJECT_CONTEXT_MAX_ENTRY_BYTES = 64 * 1024
export const PROJECT_CONTEXT_MAX_TOTAL_BYTES = 256 * 1024
export const PROJECT_CONTEXT_HEADER_MAX_CHARS = 4000
export const RUN_CONTEXT_RECEIPT_MAX_READ_EVENTS = 32

const Sha256DigestSchema = z.string().regex(/^[a-f0-9]{64}$/)
const IsoDateTimeSchema = z.iso.datetime({ offset: true })

export const ProjectContextEntryKindSchema = z.enum(['observation', 'decision'])
export type ProjectContextEntryKind = z.infer<typeof ProjectContextEntryKindSchema>

export const ProjectContextUnselectedReasonSchema = z.enum([
  'entry_too_large',
  'capacity_exceeded',
  'permission_denied',
  'identity_unverified',
  'inference_not_selectable',
  'conflict',
])
export type ProjectContextUnselectedReason = z.infer<typeof ProjectContextUnselectedReasonSchema>

export const ProjectContextUnselectedSchema = z.strictObject({
  entryId: z.uuid(),
  reason: ProjectContextUnselectedReasonSchema,
})
export type ProjectContextUnselected = z.infer<typeof ProjectContextUnselectedSchema>

/**
 * 快照逐条列出的未纳入项上限。超出部分**不静默丢弃**：按原因聚合成计数
 * （`unselectedOmitted`）随快照持久化并在读面返回，总数也写进 headerText。
 * 明细上限与 16KiB 列约束留出余量（128 × 约 86B ≈ 11KiB）。
 */
export const PROJECT_CONTEXT_MAX_UNSELECTED_DETAIL = 128

export const ProjectContextUnselectedOmittedSchema = z
  .object({
    entry_too_large: z.number().int().min(1),
    capacity_exceeded: z.number().int().min(1),
    permission_denied: z.number().int().min(1),
    identity_unverified: z.number().int().min(1),
    inference_not_selectable: z.number().int().min(1),
    conflict: z.number().int().min(1),
  })
  .partial()
  .strict()
export type ProjectContextUnselectedOmitted = z.infer<typeof ProjectContextUnselectedOmittedSchema>

/**
 * `run.start.projectContext.manifest` 与 `runtime.initialize.projectContext.entries`
 * 的共用条目。`snapshotAuthorizationGeneration` 只对来源 Observation 有意义；
 * Decision 与内部业务 Observation 都为 null（不参与来源撤销状态机）。
 */
export const RunProjectContextManifestEntrySchema = z
  .strictObject({
    entryId: z.uuid(),
    kind: ProjectContextEntryKindSchema,
    title: z.string().min(1).max(200),
    revisionId: z.uuid().nullable(),
    businessRef: z.string().min(1).max(300).nullable(),
    digest: Sha256DigestSchema,
    byteSize: z.number().int().min(0).max(PROJECT_CONTEXT_MAX_ENTRY_BYTES),
    snapshotAuthorizationGeneration: z.string().min(1).max(128).nullable(),
  })
  .superRefine((value, ctx) => {
    if (value.kind === 'decision' && value.snapshotAuthorizationGeneration !== null) {
      ctx.addIssue({
        code: 'custom',
        message: 'decision entries must not carry a source authorization generation',
      })
    }
    if (value.kind === 'observation' && value.businessRef === null && value.revisionId === null) {
      ctx.addIssue({
        code: 'custom',
        message: 'observation entries require either a business ref or a source revision',
      })
    }
    if (
      value.kind === 'observation' &&
      value.businessRef === null &&
      value.snapshotAuthorizationGeneration === null
    ) {
      ctx.addIssue({
        code: 'custom',
        message: 'source observation entries require a snapshot authorization generation',
      })
    }
  })
export type RunProjectContextManifestEntry = z.infer<typeof RunProjectContextManifestEntrySchema>

/** Hub → Node：Run 创建事务里冻结的快照头 + 清单（正文由受控下载接口提供）。 */
export const RunStartProjectContextSchema = z.strictObject({
  snapshotId: z.uuid(),
  digest: Sha256DigestSchema,
  headerText: z.string().min(1).max(PROJECT_CONTEXT_HEADER_MAX_CHARS),
  headerDigest: Sha256DigestSchema,
  manifest: z.array(RunProjectContextManifestEntrySchema).min(1).max(PROJECT_CONTEXT_MAX_ENTRIES),
})
export type RunStartProjectContext = z.infer<typeof RunStartProjectContextSchema>

/** Node → Hub：受控下载接口的应答（正文 base64，Node 逐条核对 digest/byteSize）。 */
export const RunProjectContextBundleEntrySchema = z.strictObject({
  entryId: z.uuid(),
  kind: ProjectContextEntryKindSchema,
  title: z.string().min(1).max(200),
  digest: Sha256DigestSchema,
  byteSize: z.number().int().min(0).max(PROJECT_CONTEXT_MAX_ENTRY_BYTES),
  bodyBase64: z.string().regex(/^[A-Za-z0-9+/]*={0,2}$/),
})
export type RunProjectContextBundleEntry = z.infer<typeof RunProjectContextBundleEntrySchema>

export const RunProjectContextBundleSchema = z.strictObject({
  snapshotId: z.uuid(),
  digest: Sha256DigestSchema,
  headerText: z.string().min(1).max(PROJECT_CONTEXT_HEADER_MAX_CHARS),
  headerDigest: Sha256DigestSchema,
  entries: z.array(RunProjectContextBundleEntrySchema).max(PROJECT_CONTEXT_MAX_ENTRIES),
})
export type RunProjectContextBundle = z.infer<typeof RunProjectContextBundleSchema>

/** Runtime → Node：首条交付与每次工具读取的回执（本地 wire）。 */
export const RuntimeContextReceiptPayloadSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('delivered'),
    runId: z.uuid(),
    snapshotId: z.uuid(),
    headerDigest: Sha256DigestSchema,
    nonceMatched: z.boolean(),
    entriesDelivered: z.array(z.uuid()).max(PROJECT_CONTEXT_MAX_ENTRIES),
    at: IsoDateTimeSchema,
  }),
  z.strictObject({
    kind: z.literal('read'),
    runId: z.uuid(),
    snapshotId: z.uuid(),
    entryId: z.uuid(),
    digestVerified: z.boolean(),
    byteSize: z.number().int().min(0).max(PROJECT_CONTEXT_MAX_ENTRY_BYTES),
    at: IsoDateTimeSchema,
  }),
])
export type RuntimeContextReceiptPayload = z.infer<typeof RuntimeContextReceiptPayloadSchema>

export const RunContextReadEventSchema = z.strictObject({
  entryId: z.uuid(),
  digestVerified: z.boolean(),
  byteSize: z.number().int().min(0).max(PROJECT_CONTEXT_MAX_ENTRY_BYTES),
  at: IsoDateTimeSchema,
})
export type RunContextReadEvent = z.infer<typeof RunContextReadEventSchema>

/** Node → Hub：专用上行回执（append-only，receiptSeq 单调）。 */
export const RunContextReceiptSchema = z.strictObject({
  runId: z.uuid(),
  snapshotId: z.uuid(),
  receiptSeq: z.number().int().positive(),
  headerDigest: Sha256DigestSchema,
  nonceMatched: z.boolean(),
  entriesDelivered: z.array(z.uuid()).max(PROJECT_CONTEXT_MAX_ENTRIES),
  entriesRead: z.array(z.uuid()).max(PROJECT_CONTEXT_MAX_ENTRIES),
  readEvents: z.array(RunContextReadEventSchema).max(RUN_CONTEXT_RECEIPT_MAX_READ_EVENTS),
  missing: z.array(z.uuid()).max(PROJECT_CONTEXT_MAX_ENTRIES),
  digestVerified: z.boolean(),
  at: IsoDateTimeSchema,
})
export type RunContextReceipt = z.infer<typeof RunContextReceiptSchema>

/** 成员读面：条目正文只在 frozen 且读时权限通过时返回。 */
export const RunProjectContextEntryViewSchema = z.strictObject({
  entryId: z.uuid(),
  kind: ProjectContextEntryKindSchema,
  entryVersion: z.string().min(1).max(200),
  title: z.string().min(1).max(200),
  body: z.string().nullable(),
  digest: Sha256DigestSchema,
  byteSize: z.number().int().min(0).max(PROJECT_CONTEXT_MAX_ENTRY_BYTES),
  businessRef: z.string().min(1).max(300).nullable(),
  revisionId: z.uuid().nullable(),
  threadId: z.uuid().nullable(),
  entryStatus: z.enum(['frozen', 'retracted', 'source_tombstoned']),
  statusReason: z.string().max(500).nullable(),
  identityUnverified: z.boolean(),
  deliveredAt: IsoDateTimeSchema.nullable(),
  readAt: IsoDateTimeSchema.nullable(),
})
export type RunProjectContextEntryView = z.infer<typeof RunProjectContextEntryViewSchema>

export const RunProjectContextViewSchema = z.strictObject({
  snapshotId: z.uuid(),
  selectionRuleVersion: z.string().min(1).max(64),
  snapshotDigest: Sha256DigestSchema,
  headerDigest: Sha256DigestSchema,
  entryCount: z.number().int().min(0).max(PROJECT_CONTEXT_MAX_ENTRIES),
  totalBytes: z.number().int().min(0).max(PROJECT_CONTEXT_MAX_TOTAL_BYTES),
  unselected: z.array(ProjectContextUnselectedSchema).max(PROJECT_CONTEXT_MAX_UNSELECTED_DETAIL),
  /**
   * 超出逐条明细上限的未纳入项，按原因聚合。空对象 = 没有遗漏明细。
   * 若只读 `unselected` 会少算，UI/审计须把这里也计入。
   */
  unselectedOmitted: ProjectContextUnselectedOmittedSchema,
  status: z.enum(['frozen', 'partially_unavailable', 'invalidated']),
  deliveredAt: IsoDateTimeSchema.nullable(),
  consumedAt: IsoDateTimeSchema.nullable(),
  consumedAllAt: IsoDateTimeSchema.nullable(),
  unavailable: z.boolean(),
  entries: z.array(RunProjectContextEntryViewSchema),
})
export type RunProjectContextView = z.infer<typeof RunProjectContextViewSchema>
