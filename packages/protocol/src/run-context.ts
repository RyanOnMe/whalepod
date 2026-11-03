/**
 * ADR-0027（PC-05a）：Run 项目上下文快照的线上形状。
 *
 * 只含不透明 id、内容地址与计数；正文只在 Node 受控下载与成员读面出现，绝不带
 * 本地路径。快照是创建事务里冻结的历史事实：后续新版本/纠正不修改它。
 */
import { z } from 'zod'

/** Node 在 `node.hello` 声明支持项目上下文快照；缺省 = 旧 Node，不派发非空快照。 */
export const PROJECT_CONTEXT_CAPABILITY = 'project-context.v1' as const
/**
 * ADR-0027 §6（PC-05b）：Node 能应用撤权状态帧（`run.context_state`/
 * `context.state_sync`）。只声明 `project-context.v1` 的旧 Node 会静默丢弃新帧，
 * 因此带上下文的 Run 必须同时要求本能力。升级顺序必须先 Hub 后 Node：旧 Hub
 * 的 hello schema 不认识本能力，会拒绝新 Node 连接；Hub 升级后旧 Node 仍可连接，
 * 但不会再收到新创建的带上下文 Run。升级前已存在的活跃上下文 Run 不受新状态机
 * 保护，需在升级前排空或接受该窗口。
 */
export const CONTEXT_STATE_CAPABILITY = 'context-state.v1' as const
export const ProjectContextCapabilitySchema = z.enum([
  PROJECT_CONTEXT_CAPABILITY,
  CONTEXT_STATE_CAPABILITY,
])

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

/**
 * ADR-0027 §6（PC-05b）：快照条目的撤权状态。`frozen` 之外一律不可经专用读工具
 * 交付正文；`source_tombstoned` 表示来源已撤销/墓碑，`retracted` 表示条目被纠正或
 * 撤回，权限相关三态保留原因。状态机在 Hub 派生，Node/Runtime 只应用。
 */
export const RunProjectContextEntryStatusSchema = z.enum([
  'frozen',
  'retracted',
  'source_tombstoned',
  'permission_unknown',
  'permission_denied',
  'unavailable',
])
export type RunProjectContextEntryStatus = z.infer<typeof RunProjectContextEntryStatusSchema>

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
  entryStatus: RunProjectContextEntryStatusSchema,
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

// ---------- ADR-0027 §6（PC-05b）：撤权状态与状态同步 ----------

/**
 * Node 本地状态文件名（与清单文件同目录）。Runtime 的 `read_project_context`
 * 每次读取都先读它：缺失、过期或条目非 frozen 一律 fail-closed，不回退旧缓存。
 */
export const RUN_CONTEXT_STATE_FILE = 'state.json'

/**
 * Node 判定状态同步过期的固定时限。ADR-0027 §6 允许实施固定 60 秒（最长 5 分钟）；
 * 超过后专用读工具不可用，直到下一次合格 state_sync。
 */
export const RUN_CONTEXT_STATE_SYNC_MAX_AGE_MS = 60_000
export const RUN_CONTEXT_STATE_SYNC_INTERVAL_MS = 20_000

/**
 * 注意：`superRefine` 只由 Zod 运行时执行；生成的 JSON Schema 只表达结构字段，
 * 不包含 Decision 的状态/代次约束。非 Zod 消费方必须以本文档与 Zod schema 为准，
 * 不能只信 generated/*.schema.json。
 */
export const RunContextStateEntrySchema = z
  .strictObject({
    entryId: z.uuid(),
    /**
     * ADR-0027 §6（PC-05b 修订）：状态帧覆盖快照内全部条目，但 Decision 只允许
     * frozen/retracted/unavailable 且代次必须为 null——来源撤销不得把 Decision
     * 误标成来源墓碑/权限不可用。
     */
    kind: ProjectContextEntryKindSchema,
    state: RunProjectContextEntryStatusSchema,
    /** 来源条目的当前授权代次；内部业务 Decision 必须为 null。 */
    currentAuthorizationGeneration: z.string().min(1).max(128).nullable(),
    reason: z.string().min(1).max(500).nullable(),
  })
  .superRefine((entry, ctx) => {
    if (entry.kind === 'decision' && entry.currentAuthorizationGeneration !== null) {
      ctx.addIssue({
        code: 'custom',
        path: ['currentAuthorizationGeneration'],
        message: 'decision state entries must not carry an authorization generation',
      })
    }
    if (
      entry.kind === 'decision' &&
      (entry.state === 'source_tombstoned' ||
        entry.state === 'permission_unknown' ||
        entry.state === 'permission_denied')
    ) {
      ctx.addIssue({
        code: 'custom',
        path: ['state'],
        message: 'source-derived state is not valid for a decision entry',
      })
    }
  })
export type RunContextStateEntry = z.infer<typeof RunContextStateEntrySchema>

/**
 * ADR-0027 §6：`stateDigest = sha256(规范化 JSON：stateVersion + 按 entryId 排序的
 * [{entryId, state, currentAuthorizationGeneration}])`。reason 不参与摘要——它只
 * 用于读面解释，避免同一撤销语义因文案变化触发无意义的状态版本推进。
 */
export function contextStateDigestInput(
  stateVersion: number,
  entries: readonly RunContextStateEntry[],
): string {
  const normalized = [...entries]
    .sort((a, b) => (a.entryId < b.entryId ? -1 : a.entryId > b.entryId ? 1 : 0))
    .map((entry) => [entry.entryId, entry.state, entry.currentAuthorizationGeneration])
  return JSON.stringify({ stateVersion, entries: normalized })
}

/** 完整状态载荷（Hub 内部与 Node 本地状态共用；wire 版本额外携带 commandId）。 */
export const RunContextStatePayloadSchema = z.strictObject({
  runId: z.uuid(),
  snapshotId: z.uuid(),
  stateVersion: z.number().int().positive(),
  stateDigest: Sha256DigestSchema,
  entries: z.array(RunContextStateEntrySchema).max(PROJECT_CONTEXT_MAX_ENTRIES),
  generatedAt: IsoDateTimeSchema,
})
export type RunContextState = z.infer<typeof RunContextStatePayloadSchema>

/** Hub → Node：完整当前状态（变化时与重连时发送）。 */
export const RunContextStateSchema = RunContextStatePayloadSchema.extend({
  /** Outbox commandId；Node 处理完必须 ack，否则 Hub 会按至少一次语义重发。 */
  commandId: z.uuid(),
})
export type RunContextStateWire = z.infer<typeof RunContextStateSchema>

/** 水位/摘要载荷；wire 版本额外携带 commandId。 */
export const ContextStateSyncPayloadSchema = z.strictObject({
  runId: z.uuid(),
  snapshotId: z.uuid(),
  stateVersion: z.number().int().positive(),
  stateDigest: Sha256DigestSchema,
  at: IsoDateTimeSchema,
})
export type ContextStateSync = z.infer<typeof ContextStateSyncPayloadSchema>

/** Hub → Node：水位/摘要帧，即使无变化也周期性发送；不直接应用 entries。 */
export const ContextStateSyncSchema = ContextStateSyncPayloadSchema.extend({
  commandId: z.uuid(),
})
export type ContextStateSyncWire = z.infer<typeof ContextStateSyncSchema>

/** Node → Hub：摘要不一致或本地缺失时拉取完整状态。 */
export const ContextStatePullSchema = z.strictObject({
  runId: z.uuid(),
  snapshotId: z.uuid(),
  knownStateVersion: z.number().int().min(0),
})
export type ContextStatePull = z.infer<typeof ContextStatePullSchema>

/** Node → Hub：状态文件写入与未读副本清理尝试完成后回报。 */
export const ContextStateAckSchema = z.strictObject({
  runId: z.uuid(),
  snapshotId: z.uuid(),
  stateVersion: z.number().int().positive(),
  stateDigest: Sha256DigestSchema,
  appliedAt: IsoDateTimeSchema,
  /** 删除/隔离失败的 entryId；非空表示 Node 仍在重试或已 fail-closed。 */
  failedEntryIds: z.array(z.uuid()).max(PROJECT_CONTEXT_MAX_ENTRIES),
})
export type ContextStateAck = z.infer<typeof ContextStateAckSchema>

/**
 * Node 本地状态文件的线上形状（Runtime 与 Node 共用同一 schema，防两侧漂移）。
 * `syncedAt` 是最近一次合格 state_sync/state 应用时间；`paused` 表示副本清理失败
 * 后的 fail-closed（所有读取不可用，但 Run 不取消）。
 */
export const RuntimeContextLocalStateSchema = z.strictObject({
  runId: z.uuid(),
  snapshotId: z.uuid(),
  stateVersion: z.number().int().min(0),
  stateDigest: Sha256DigestSchema,
  entries: z.array(RunContextStateEntrySchema).max(PROJECT_CONTEXT_MAX_ENTRIES),
  syncedAt: IsoDateTimeSchema,
  paused: z.boolean(),
})
export type RuntimeContextLocalState = z.infer<typeof RuntimeContextLocalStateSchema>
