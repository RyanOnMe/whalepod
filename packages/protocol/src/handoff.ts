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
  artifacts: z.array(HandoffArtifactEntrySchema).max(64),
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
 * 建 Run 时 Task 已启用约定流程才携带；`agreement` 是绑定版本的正文快照
 * （Runtime 收尾整理时作为「约定验收条件」的锚点；未绑定则为 null）。
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
