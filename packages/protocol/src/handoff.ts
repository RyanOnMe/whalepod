/**
 * 交接包与交接草稿的形状真源（#379；ADR-0017 §3-4）。
 *
 * 三层：
 * - **叙述（narrative）**：Runtime 收尾时模型产出的结构化内容（完成项/接口约定/
 *   未完成项/关键决定/验证证据/下游行动 + PR·commit 引用）。模型陈述默认
 *   `verified=false`（待核实）；owner 逐项核对后可改标。
 * - **系统块（system）**：Hub 在落库/发布时从权威事实填入（来源 Run、约定版本、
 *   Artifact 身份与摘要）——模型与 owner 都不能伪造。
 * - **草稿/版本（draft/revision）**：草稿仅 owner 可见可编辑（draft_version 并发
 *   令牌）；发布产生 Task 级单调递增的不可变 `HandoffRevision`。
 *
 * 体积预算：交接内容随 `run.event` 上行（Hub 侧 run_event payload 上限 32 KiB），
 * 叙述整体（JSON 字节）硬上限 `HANDOFF_NARRATIVE_MAX_BYTES`，超限在 Runtime 侧
 * 即按生成失败处理，不给 Hub 制造毒帧。
 */
import { z } from 'zod'

/** 叙述整体（JSON.stringify 后的 UTF-8 字节）上限；留足 envelope 头空间。 */
export const HANDOFF_NARRATIVE_MAX_BYTES = 24_576

/** 单条引用的身份上限。 */
export const HANDOFF_REFS_PER_ITEM_MAX = 16

/**
 * 系统块材料条数上限（与运行时输入清单同值）：超限时 **Hub 侧必须转「未生成/明确拒绝」**，
 * 不许把 ZodError 抛穿 ingest 事务（评审 M1：那会让 Node 以 4003 反复重连并卡死 Run）。
 */
export const HANDOFF_ARTIFACTS_MAX = 64

/**
 * 引用（refs）：结构化、可核查的指向。
 * - artifact：本 Task 的**已发布**交付物才允许出现在发布版的引用里（发布时复验）；
 * - run：本 Task 的 Run；
 * - url：外部材料（PR、文档）；
 * - commit：git 提交 sha（前缀即可）。
 */
export const HandoffRefSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('artifact'), artifactId: z.uuid() }),
  z.strictObject({ kind: z.literal('run'), runId: z.uuid() }),
  z.strictObject({ kind: z.literal('url'), url: z.string().min(1).max(2048) }),
  z.strictObject({ kind: z.literal('commit'), sha: z.string().min(4).max(128) }),
])
export type HandoffRef = z.infer<typeof HandoffRefSchema>

/**
 * 叙述条目：`verified` 默认 false（模型产出的默认标「待核实」）；
 * `refs` 是该条目可核查的引用面。**验证证据类条目发布时必须有至少一条引用**
 * （「测试通过必须附证据引用」——发布校验在 Hub 命令层，形状只约束结构）。
 */
export const HandoffItemSchema = z.strictObject({
  text: z.string().min(1).max(2000),
  verified: z.boolean(),
  refs: z.array(HandoffRefSchema).max(HANDOFF_REFS_PER_ITEM_MAX),
})
export type HandoffItem = z.infer<typeof HandoffItemSchema>

/** 一段叙述（六段 + 两类引用清单）。 */
/**
 * 未配对代理项（lone surrogate）防线（评审 F-残余）：JSON 线上可以携带 `"\ud800"`
 * 这类码位——结构与字节上限都会放行，但 PostgreSQL 的 jsonb 编码会以 22P02 拒行，
 * 抛穿 ingest 事务就是毒帧路径回归（与 M1 容量毒帧同一类）。schema 层直接拒绝：
 * 孤立代理项在任何真实文本（模型输出/UTF-8 往返）里都不该出现，放行它只会把
 * 不可编码的内容放进系统。合法代理对（emoji）不受影响。
 */
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/

function containsLoneSurrogate(value: unknown): boolean {
  if (typeof value === 'string') return LONE_SURROGATE.test(value)
  if (Array.isArray(value)) return value.some(containsLoneSurrogate)
  if (value !== null && typeof value === 'object') {
    return Object.values(value).some(containsLoneSurrogate)
  }
  return false
}

export const HandoffNarrativeSchema = z
  .strictObject({
    completed: z.array(HandoffItemSchema).max(64),
    interfaces: z.array(HandoffItemSchema).max(64),
    unfinished: z.array(HandoffItemSchema).max(64),
    decisions: z.array(HandoffItemSchema).max(64),
    evidence: z.array(HandoffItemSchema).max(64),
    downstream: z.array(HandoffItemSchema).max(64),
    commits: z.array(z.string().min(4).max(128)).max(64),
    prs: z.array(z.string().min(1).max(2048)).max(64),
  })
  .refine(
    (value) =>
      new TextEncoder().encode(JSON.stringify(value)).length <= HANDOFF_NARRATIVE_MAX_BYTES,
    { message: `handoff narrative exceeds ${HANDOFF_NARRATIVE_MAX_BYTES} bytes` },
  )
  .refine((value) => !containsLoneSurrogate(value), {
    message: 'handoff narrative contains a lone surrogate (invalid unicode)',
  })

export type HandoffNarrative = z.infer<typeof HandoffNarrativeSchema>

export function emptyHandoffNarrative(): HandoffNarrative {
  return {
    completed: [],
    interfaces: [],
    unfinished: [],
    decisions: [],
    evidence: [],
    downstream: [],
    commits: [],
    prs: [],
  }
}

/** 自动叙述不具有真人核实权；人工编辑接口不调用此函数。 */
export function unverifiedHandoffNarrative(content: HandoffNarrative): HandoffNarrative {
  const result = { ...content }
  for (const key of [
    'completed',
    'interfaces',
    'unfinished',
    'decisions',
    'evidence',
    'downstream',
  ] as const) {
    result[key] = content[key].map((item) => ({ ...item, verified: false }))
  }
  return result
}

/** 来源 Run 的 Artifact 清单条目（系统块用；身份 + 摘要，不含本机路径）。 */
export const HandoffArtifactEntrySchema = z.strictObject({
  artifactId: z.uuid(),
  title: z.string().min(1).max(200),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  byteSize: z.number().int().min(0),
  status: z.enum(['candidate', 'published', 'rejected']),
})
export type HandoffArtifactEntry = z.infer<typeof HandoffArtifactEntrySchema>

/**
 * 系统块（Hub 权威填入）：来源 Run、绑定约定版本、Artifact 身份与摘要。
 * **发布版只含已发布 Artifact**（候选不进可交付交接包——发布时重算过滤）。
 */
export const HandoffSystemSchema = z.strictObject({
  sourceRunId: z.uuid(),
  specRevision: z
    .strictObject({ id: z.uuid(), revisionNumber: z.number().int().positive() })
    .nullable(),
  artifacts: z.array(HandoffArtifactEntrySchema).max(HANDOFF_ARTIFACTS_MAX),
})
export type HandoffSystem = z.infer<typeof HandoffSystemSchema>

/** 完整交接内容 = 系统块 + 叙述。 */
export const HandoffContentSchema = z.strictObject({
  system: HandoffSystemSchema,
  narrative: HandoffNarrativeSchema,
})
export type HandoffContent = z.infer<typeof HandoffContentSchema>

export const HandoffDraftStatusSchema = z.enum(['ready', 'failed', 'published'])
export type HandoffDraftStatus = z.infer<typeof HandoffDraftStatusSchema>

/**
 * 交接草稿读模型（owner 作用域；别的成员与管理员连存在性都不可见——404 收口）。
 * `status='failed'` 时 content 为 null，failureReason 说明原因（「交接草稿未生成」）。
 */
export const HandoffDraftViewSchema = z.strictObject({
  id: z.uuid(),
  taskId: z.uuid(),
  sourceRunId: z.uuid(),
  specRevisionId: z.uuid().nullable(),
  status: HandoffDraftStatusSchema,
  failureReason: z.string().nullable(),
  content: HandoffContentSchema.nullable(),
  draftVersion: z.number().int().positive(),
  origin: z.enum(['auto', 'manual']),
  createdByUserId: z.uuid(),
  createdAt: z.string(),
  updatedAt: z.string(),
  publishedRevisionId: z.uuid().nullable(),
})
export type HandoffDraftView = z.infer<typeof HandoffDraftViewSchema>

/** 已发布交接版本读模型（团队可见；发布后不可变，修改产生新版本）。 */
export const HandoffRevisionViewSchema = z.strictObject({
  id: z.uuid(),
  taskId: z.uuid(),
  revisionNumber: z.number().int().positive(),
  sourceRunId: z.uuid(),
  specRevisionId: z.uuid().nullable(),
  content: HandoffContentSchema,
  publishedByUserId: z.uuid(),
  publishedAt: z.string(),
})
export type HandoffRevisionView = z.infer<typeof HandoffRevisionViewSchema>

/**
 * run.start 里固化的「本次执行是否生成交接草稿」快照（#379；ADR-0017 §3）：
 * 建 Run 时 Task 已启用约定流程才携带（因此业务 Run 必然已绑定版本）；`agreement`
 * 是绑定版本的正文快照，作为 Runtime 收尾整理「约定验收条件」的锚点。
 */
export const HandoffRunSpecSchema = z.strictObject({
  agreement: z
    .strictObject({
      revisionNumber: z.number().int().positive(),
      goal: z.string().max(10000),
      constraints: z.string().max(10000),
      acceptance: z.string().max(10000),
      openQuestions: z.string().max(10000),
    })
    .nullable(),
})
export type HandoffRunSpec = z.infer<typeof HandoffRunSpecSchema>

/**
 * 接收确认（#380；ADR-0017 §5）：已发布交接版本 × 同项目下游 Task 的接收关系。
 * pending = 已交付待接收方确认；confirmed = 接收方已填「本次准备做什么」。
 * 确认**不等于**接受 Task、不自动启动 Run；旧 receipt 永远保留其版本（上游出新版本
 * 后由接收方 adopt 产生新的 confirmed receipt）。
 */
export const HandoffReceiptStatusSchema = z.enum(['pending', 'confirmed'])
export type HandoffReceiptStatus = z.infer<typeof HandoffReceiptStatusSchema>

/**
 * HandoffReceiptViewSchema（团队可见：交接是正式记录，不是私有面）。
 * `latestRevisionNumber` = 该 receipt 上游 Task 的当前最新已发布版本号；
 * `latestRevisionNumber > revisionNumber` 即下游显示「有新版本」的判据。
 */
export const HandoffReceiptViewSchema = z.strictObject({
  id: z.uuid(),
  revisionId: z.uuid(),
  revisionNumber: z.number().int().positive(),
  latestRevisionNumber: z.number().int().positive(),
  upstreamTaskId: z.uuid(),
  upstreamTaskTitle: z.string(),
  downstreamTaskId: z.uuid(),
  downstreamTaskTitle: z.string(),
  receiverUserId: z.uuid(),
  deliveredByUserId: z.uuid(),
  status: HandoffReceiptStatusSchema,
  /** 接收方确认时填写的「本次准备做什么」（pending 时为 null）。 */
  understanding: z.string().nullable(),
  /** 可选差异原文（确认/采用时同时作为一条讨论消息落在上游 Task）。 */
  differences: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
  confirmedAt: z.string().nullable(),
})
export type HandoffReceiptView = z.infer<typeof HandoffReceiptViewSchema>

/** POST /handoff-revisions/:revisionId/deliver（#380）：交付给成员并建/联下游 Task。 */
export const DeliverHandoffRequestSchema = z
  .strictObject({
    receiverUserId: z.uuid(),
    /** 关联既有下游 Task（必须同项目、且责任人就是被选成员）。 */
    downstreamTaskId: z.uuid().optional(),
    /** 或新建下游 Task（同项目、责任人 = 被选成员、待接受）。 */
    newTask: z
      .strictObject({
        title: z.string().min(1).max(200),
        description: z.string().max(20000).optional(),
      })
      .optional(),
  })
  .superRefine((value, ctx) => {
    if ((value.downstreamTaskId === undefined) === (value.newTask === undefined)) {
      ctx.addIssue({
        code: 'custom',
        message: 'deliver requires exactly one of downstreamTaskId or newTask',
      })
    }
  })
export type DeliverHandoffRequest = z.infer<typeof DeliverHandoffRequestSchema>

/**
 * POST /handoff-receipts/:receiptId/confirm 与 /adopt 共用（#380）：
 * `understanding`（本次准备做什么）必填；`differences` 可选——非空时作为一条讨论
 * 消息落在**上游 Task**（差异复用讨论，不另造通道）。
 */
export const ConfirmHandoffReceiptRequestSchema = z.strictObject({
  understanding: z.string().min(1).max(10000),
  differences: z.string().min(1).max(10000).optional(),
  expectedRevisionId: z.uuid().optional(),
})
export type ConfirmHandoffReceiptRequest = z.infer<typeof ConfirmHandoffReceiptRequestSchema>

/** 差异消息的固定前缀：讨论流里一眼可辨来源（内容仍是接收方原文）。 */
export const HANDOFF_DIFFERENCE_PREFIX = '【交接差异】'
