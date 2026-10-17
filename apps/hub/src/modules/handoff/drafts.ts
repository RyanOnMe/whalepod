/**
 * 交接草稿与版本（#379；ADR-0017 §3-4）。
 *
 * 生命周期：
 * - 正常完成的 Run 在收尾生成草稿 → owner 受众 run.event 上行 → 这里落库（幂等）；
 * - 失败/取消的 Run 不自动生成；owner 可手工新建/编辑（失败恢复路径）；
 * - 发布 = owner 显式动作：校验（证据引用 / 材料已发布 / 流程启用）→ 不可变版本，
 *   Task 级编号单调递增；发布后不原地覆盖，修改产生新草稿、新版本。
 *
 * 私有边界（不泄露名称、数量、内容）：
 * - 草稿的一切读/写都要求 actor === run.ownerUserId；其他成员与**团队管理员**一律
 *   404（不可枚举）。发布后的版本才是团队可见的。
 */
import type {
  HandoffContent,
  HandoffDraftView,
  HandoffNarrative,
  HandoffRevisionView,
} from '@whalepod/protocol'
import {
  HANDOFF_ARTIFACTS_MAX,
  HandoffContentSchema,
  HandoffDraftViewSchema,
  HandoffRevisionViewSchema,
  HandoffSystemSchema,
  emptyHandoffNarrative,
} from '@whalepod/protocol'
import { and, asc, desc, eq, inArray } from 'drizzle-orm'
import type { Actor } from '@whalepod/domain'
import type {
  Database,
  DbHandle,
  HandoffDraftRow,
  HandoffRevisionRow,
  RunRow,
  Tx,
} from '@whalepod/db'
import {
  appendTeamEvent,
  getHandoffRevision,
  getLatestHandoffDraft,
  getOpenHandoffDraft,
  getRun,
  getSpecRevision,
  getTask,
  insertHandoffDraftIfAbsent,
  insertHandoffRevision,
  listHandoffRevisionsByTask,
  markHandoffDraftPublished,
  nextHandoffRevisionNumber,
  replaceFailedDraft,
  schema,
  transactCommand,
  updateHandoffDraftContentCas,
} from '@whalepod/db'
import type { ProjectedRunEvent } from '@whalepod/protocol'
import { ApiError } from '../shared/http-error.js'
import { taskChangedPayload } from '../task/commands.js'
import { uuidv7 } from '../shared/uuid.js'

export function toHandoffDraftView(row: HandoffDraftRow): HandoffDraftView {
  return HandoffDraftViewSchema.parse({
    id: row.id,
    taskId: row.taskId,
    sourceRunId: row.sourceRunId,
    specRevisionId: row.specRevisionId,
    status: row.status,
    failureReason: row.failureReason,
    content: row.content,
    draftVersion: row.draftVersion,
    origin: row.origin,
    createdByUserId: row.createdBy,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    publishedRevisionId: row.publishedRevisionId,
  })
}

export function toHandoffRevisionView(row: HandoffRevisionRow): HandoffRevisionView {
  return HandoffRevisionViewSchema.parse({
    id: row.id,
    taskId: row.taskId,
    revisionNumber: row.revisionNumber,
    sourceRunId: row.sourceRunId,
    specRevisionId: row.specRevisionId,
    content: row.content,
    publishedByUserId: row.publishedBy,
    publishedAt: row.publishedAt.toISOString(),
  })
}

/**
 * 系统块（Hub 权威填入）：来源 Run、约定版本号、Artifact 身份与摘要。
 * `filter`：'all' = 草稿形态（含候选，供 owner 核实）；'published' = 发布形态
 * （候选不进可交付交接包）。绝不包含本机路径。
 */
export async function buildHandoffSystemBlock(
  handle: DbHandle,
  run: RunRow,
  filter: 'all' | 'published',
): Promise<HandoffContent['system']> {
  let specRevision: { id: string; revisionNumber: number } | null = null
  if (run.specRevisionId !== null) {
    const revision = await getSpecRevision(handle, run.specRevisionId)
    if (revision !== undefined && revision.revisionNumber !== null) {
      specRevision = { id: revision.id, revisionNumber: revision.revisionNumber }
    }
  }
  const artifactRows = await handle
    .select({
      artifactId: schema.artifacts.id,
      title: schema.artifacts.title,
      sha256: schema.artifacts.sha256,
      byteSize: schema.artifacts.byteSize,
      status: schema.artifacts.status,
    })
    .from(schema.artifacts)
    .where(eq(schema.artifacts.runId, run.id))
    .orderBy(asc(schema.artifacts.createdAt), asc(schema.artifacts.id))
  // 评审 M1（2026-10-18）：系统块超协议上限（64 条）时**不许抛 ZodError**——自动落库在
  // ingest 事务里抛会让 WS 以 4003 反复重连，且重发帧永远排不到 run.completed 之前成功，
  // Run 卡死。容量不足一律转「生成失败（自动路径）/ 显式 409（手工与发布路径）」；
  // 同一守卫也提前挡住 DB 的 32 KiB content 约束（否则是同类毒帧的另一条路径）。
  const included = artifactRows.filter((row) => filter === 'all' || row.status === 'published')
  if (included.length > HANDOFF_ARTIFACTS_MAX) {
    throw new HandoffCapacityError(
      `这条执行登记的 Artifact 超过交接包上限（${HANDOFF_ARTIFACTS_MAX} 项）`,
    )
  }
  return HandoffSystemSchema.parse({ sourceRunId: run.id, specRevision, artifacts: included })
}

/** 交接包容量不足（>64 条材料或内容超 32 KiB）：自动路径转失败草稿，显式路径转 409。 */
export class HandoffCapacityError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'HandoffCapacityError'
  }
}

/** 系统块 + 叙述的内容上限（与 DB 的 content 列约束同值；按 JSON 字节计）。 */
export const HANDOFF_CONTENT_MAX_BYTES = 32_768

/** 显式路径（手工新建/编辑/发布）在落库前先失败，给出可读冲突而不是 23514。 */
export function assertHandoffContentFits(content: HandoffContent): void {
  if (new TextEncoder().encode(JSON.stringify(content)).length > HANDOFF_CONTENT_MAX_BYTES) {
    throw new HandoffCapacityError('交接内容超过 32 KiB 上限，请精简叙述后重试')
  }
}

/** 显式路径统一：容量超限转 409（自动路径不走这里——它落 failed 草稿）。 */
function assertHandoffContentFitsGuard(content: HandoffContent): void {
  try {
    assertHandoffContentFits(content)
  } catch (error) {
    capacityConflict(error)
  }
}

/**
 * run.event 上行落库（owner 受众的 handoff.draft）。
 * - 幂等：同源 Run 的未发布草稿已存在（重放/重发）→ 跳过，不覆盖既有事实；
 *   **已发布过的征执行**同样跳过（迟到的再造帧不产生第二份草稿）；
 * - **不动 Run 状态**：迟到/终态场景只更新草稿侧事实（不复活终态）；
 * - 容量不足（材料 >64 / 内容 >32 KiB）→ 落「未生成」失败草稿，**绝不抛穿 ingest 事务**。
 */
export async function persistHandoffDraftEvent(
  tx: Tx,
  run: RunRow,
  event: Extract<ProjectedRunEvent['event'], { type: 'handoff.draft' }>,
  now: Date,
): Promise<{ inserted: boolean }> {
  const specRevisionId = run.specRevisionId
  const alreadyPublished =
    (
      await tx
        .select({ id: schema.handoffDrafts.id })
        .from(schema.handoffDrafts)
        .where(
          and(
            eq(schema.handoffDrafts.sourceRunId, run.id),
            eq(schema.handoffDrafts.status, 'published'),
          ),
        )
        .limit(1)
    ).length > 0
  if (alreadyPublished) return { inserted: false }
  if (event.status === 'failed') {
    return insertHandoffDraftIfAbsent(tx, {
      id: uuidv7(),
      taskId: run.taskId,
      sourceRunId: run.id,
      specRevisionId,
      status: 'failed',
      failureReason: event.reason ?? 'unknown',
      origin: 'auto',
      createdBy: run.ownerUserId,
      createdAt: now,
    })
  }
  let content: HandoffContent
  try {
    const system = await buildHandoffSystemBlock(tx, run, 'all')
    content = HandoffContentSchema.parse({
      system,
      narrative: event.content ?? emptyHandoffNarrative(),
    })
    assertHandoffContentFits(content)
  } catch (error) {
    if (!(error instanceof HandoffCapacityError)) throw error
    // 生成侧容量问题 = 「交接草稿未生成」，业务结果不受影响（评审 M1）。
    return insertHandoffDraftIfAbsent(tx, {
      id: uuidv7(),
      taskId: run.taskId,
      sourceRunId: run.id,
      specRevisionId,
      status: 'failed',
      failureReason: 'capacity-exceeded',
      origin: 'auto',
      createdBy: run.ownerUserId,
      createdAt: now,
    })
  }
  return insertHandoffDraftIfAbsent(tx, {
    id: uuidv7(),
    taskId: run.taskId,
    sourceRunId: run.id,
    specRevisionId,
    status: 'ready',
    content,
    origin: 'auto',
    createdBy: run.ownerUserId,
    createdAt: now,
  })
}

/** 显式路径的统一容量守卫：HandoffCapacityError → 409 CONFLICT（不泄露内部形态）。 */
function capacityConflict(error: unknown): never {
  if (error instanceof HandoffCapacityError) {
    throw new ApiError(409, 'CONFLICT', error.message)
  }
  throw error
}

/** 日志里可复用的终态集合（与 db 的 TERMINAL_RUN_STATUSES 同口径，避免跨包引入循环）。 */
const TERMINAL: ReadonlySet<RunRow['status']> = new Set([
  'completed',
  'failed',
  'cancelled',
  'lost',
])

async function requireOwnedRun(
  handle: DbHandle,
  runId: string,
  actorUserId: string,
): Promise<RunRow> {
  const run = await getRun(handle, runId)
  // 不可见与不存在同作 404（管理员也不可见——草稿私有的口径）。
  if (run === undefined || run.ownerUserId !== actorUserId) {
    throw new ApiError(404, 'NOT_FOUND', 'run not found')
  }
  return run
}

/** GET 读模型：优先未发布草稿；否则最近一条草稿行（含 published 审计行）；无 → null。 */
export async function getRunHandoffDraft(
  handle: DbHandle,
  runId: string,
  actorUserId: string,
): Promise<HandoffDraftView | null> {
  const run = await requireOwnedRun(handle, runId, actorUserId)
  const row =
    (await getOpenHandoffDraft(handle, run.id)) ?? (await getLatestHandoffDraft(handle, run.id))
  return row === undefined ? null : toHandoffDraftView(row)
}

/**
 * 手工新建草稿（失败恢复路径）：仅终态的、本次运行 owner 的 Run；
 * 已有 ready 草稿 → 409（应编辑而不是重建）；failed 草稿 → 以手工草稿替换。
 */
export async function createManualHandoffDraft(
  database: Database,
  actor: Actor,
  runId: string,
  idempotencyKey: string,
): Promise<HandoffDraftView> {
  return transactCommand(database, `handoff.manual:${idempotencyKey}`, async (tx) => {
    const run = await requireOwnedRun(tx, runId.toLowerCase(), actor.userId)
    if (!TERMINAL.has(run.status)) {
      throw new ApiError(409, 'CONFLICT', '执行尚未结束，无法创建交接草稿')
    }
    const now = new Date()
    const existing = await getOpenHandoffDraft(tx, run.id)
    if (existing !== undefined && existing.status === 'ready') {
      throw new ApiError(409, 'CONFLICT', '已有待发布的交接草稿，请直接编辑它')
    }
    const system = await buildHandoffSystemBlock(tx, run, 'all').catch(capacityConflict)
    // 「修改产生新版本」：同一来源 Run 已发布过交接包时，新草稿以上一版叙述为起点
    // （owner 在此基础上改，而不是从零重写）。
    const publishedRows = await tx
      .select()
      .from(schema.handoffDrafts)
      .where(
        and(
          eq(schema.handoffDrafts.sourceRunId, run.id),
          eq(schema.handoffDrafts.status, 'published'),
        ),
      )
      .orderBy(desc(schema.handoffDrafts.updatedAt))
      .limit(1)
    const seededNarrative = publishedRows[0]?.content?.narrative ?? emptyHandoffNarrative()
    const content = HandoffContentSchema.parse({ system, narrative: seededNarrative })
    assertHandoffContentFitsGuard(content)
    if (existing !== undefined) {
      const { inserted } = await replaceFailedDraft(tx, existing.id, {
        id: uuidv7(),
        taskId: run.taskId,
        sourceRunId: run.id,
        specRevisionId: run.specRevisionId,
        content,
        origin: 'manual',
        createdBy: actor.userId,
        createdAt: now,
      })
      if (!inserted) {
        throw new ApiError(409, 'CONFLICT', '交接草稿状态已变化，请刷新后重试')
      }
    } else {
      await insertHandoffDraftIfAbsent(tx, {
        id: uuidv7(),
        taskId: run.taskId,
        sourceRunId: run.id,
        specRevisionId: run.specRevisionId,
        status: 'ready',
        content,
        origin: 'manual',
        createdBy: actor.userId,
        createdAt: now,
      })
    }
    const row = await getOpenHandoffDraft(tx, run.id)
    if (row === undefined) throw new Error('handoff draft vanished in its own transaction')
    return toHandoffDraftView(row)
  })
}

export interface UpdateHandoffDraftInput {
  narrative: HandoffNarrative
  expectedDraftVersion: number
}

/** 编辑草稿叙述（系统块保持权威、发布时重算）；CAS 并发令牌不匹配 → 409。 */
export async function updateManualHandoffDraft(
  database: Database,
  actor: Actor,
  runId: string,
  input: UpdateHandoffDraftInput,
  idempotencyKey: string,
): Promise<HandoffDraftView> {
  return transactCommand(database, `handoff.update:${idempotencyKey}`, async (tx) => {
    const run = await requireOwnedRun(tx, runId.toLowerCase(), actor.userId)
    const draft = await getOpenHandoffDraft(tx, run.id)
    if (draft === undefined || draft.status !== 'ready' || draft.content === null) {
      throw new ApiError(409, 'CONFLICT', '没有可编辑的交接草稿（未生成或尚未手工创建）')
    }
    const content = HandoffContentSchema.parse({
      system: draft.content.system,
      narrative: input.narrative,
    })
    assertHandoffContentFitsGuard(content)
    const row = await updateHandoffDraftContentCas(
      tx,
      draft.id,
      content,
      input.expectedDraftVersion,
      new Date(),
    )
    if (row === undefined) {
      throw new ApiError(409, 'CONFLICT', '交接草稿已被更新，请刷新后重试')
    }
    return toHandoffDraftView(row)
  })
}

export interface PublishHandoffDraftResult {
  revision: HandoffRevisionView
}

/**
 * 发布（owner 显式动作）：校验 → 不可变版本。
 * 校验面（ADR-0017 §4）：
 * 1. Task 处于启用约定流程状态（流程关闭时不产生可交付交接包）；
 * 2. 「验证证据」条目必须至少一条引用；
 * 3. 材料引用只允许**本 Task 已发布**的 Artifact（候选不可进交接包）；
 * 4. run 引用必须是本 Task 的 Run；
 * 5. 系统块以发布时刻的权威事实重算（含 Artifact 摘要；候选被过滤）。
 */
export async function publishHandoffDraft(
  database: Database,
  actor: Actor,
  runId: string,
  idempotencyKey: string,
): Promise<PublishHandoffDraftResult> {
  return transactCommand(database, `handoff.publish:${idempotencyKey}`, async (tx) => {
    const run = await requireOwnedRun(tx, runId.toLowerCase(), actor.userId)
    const task = await getTask(tx, run.taskId)
    if (task === undefined) throw new ApiError(404, 'NOT_FOUND', 'task not found')
    if (!task.agreementEnabled) {
      throw new ApiError(409, 'CONFLICT', '任务未启用约定流程，不能发布交接包')
    }
    const draft = await getOpenHandoffDraft(tx, run.id)
    if (draft === undefined || draft.status !== 'ready' || draft.content === null) {
      throw new ApiError(409, 'CONFLICT', '没有可发布的交接草稿')
    }
    const narrative = draft.content.narrative
    const evidenceWithoutRefs = narrative.evidence.filter((item) => item.refs.length === 0)
    if (evidenceWithoutRefs.length > 0) {
      throw new ApiError(
        409,
        'CONFLICT',
        `验证证据必须附引用（${evidenceWithoutRefs.length} 条缺失）：材料/运行/链接/提交`,
      )
    }
    const artifactRefs = collectRefs(narrative).filter((ref) => ref.kind === 'artifact')
    if (artifactRefs.length > 0) {
      const rows = await tx
        .select({
          id: schema.artifacts.id,
          taskId: schema.artifacts.taskId,
          status: schema.artifacts.status,
        })
        .from(schema.artifacts)
        .where(
          inArray(
            schema.artifacts.id,
            artifactRefs.map((ref) => ref.artifactId),
          ),
        )
      const byId = new Map(rows.map((row) => [row.id, row]))
      for (const ref of artifactRefs) {
        const row = byId.get(ref.artifactId)
        if (row === undefined || row.taskId !== run.taskId || row.status !== 'published') {
          throw new ApiError(
            409,
            'CONFLICT',
            '交接包只能引用本任务已发布的交付物（候选或跨任务引用被拒绝）',
          )
        }
      }
    }
    const runRefs = collectRefs(narrative).filter((ref) => ref.kind === 'run')
    for (const ref of runRefs) {
      const referenced = await getRun(tx, ref.runId)
      if (referenced === undefined || referenced.taskId !== run.taskId) {
        throw new ApiError(409, 'CONFLICT', 'run 引用必须是本任务的执行')
      }
    }
    // 发布形态的系统块：以发布时刻事实重算，候选被过滤。
    const system = await buildHandoffSystemBlock(tx, run, 'published').catch(capacityConflict)
    const content = HandoffContentSchema.parse({ system, narrative })
    assertHandoffContentFitsGuard(content)
    // Task 行锁串行化编号分配（与任务约定版本同款；唯一约束兜底）。
    await tx
      .select({ id: schema.tasks.id })
      .from(schema.tasks)
      .where(eq(schema.tasks.id, run.taskId))
      .for('update')
    const revisionNumber = await nextHandoffRevisionNumber(tx, run.taskId)
    const now = new Date()
    const revision = await insertHandoffRevision(tx, {
      id: uuidv7(),
      taskId: run.taskId,
      revisionNumber,
      sourceRunId: run.id,
      specRevisionId: run.specRevisionId,
      content,
      createdFromDraftId: draft.id,
      publishedBy: actor.userId,
      publishedAt: now,
    })
    const marked = await markHandoffDraftPublished(tx, draft.id, revision.id, now)
    if (marked === undefined) {
      throw new ApiError(409, 'CONFLICT', '交接草稿状态已变化，请刷新后重试')
    }
    // 评审 B4/m2：发布是**团队可见事实**——不发事件，别人开着房间看不到新版本
    //（下游「有新版本」也就不出现）。与交付/确认同形：task.changed 双侧语义由
    // 订阅方按 taskId 失效（版本列表与服务端房间同键）。
    const sealedTask = await getTask(tx, run.taskId)
    if (sealedTask !== undefined) {
      await appendTeamEvent(tx, {
        type: 'task.changed',
        payload: taskChangedPayload(sealedTask),
      })
    }
    return { revision: toHandoffRevisionView(revision) }
  })
}

function collectRefs(narrative: HandoffNarrative) {
  const all = [
    ...narrative.completed,
    ...narrative.interfaces,
    ...narrative.unfinished,
    ...narrative.decisions,
    ...narrative.evidence,
    ...narrative.downstream,
  ]
  return all.flatMap((item) => item.refs)
}

/** 某 Task 的已发布交接版本（团队可见；倒序）。 */
export async function listTaskHandoffRevisions(
  handle: DbHandle,
  taskId: string,
): Promise<HandoffRevisionView[]> {
  return (await listHandoffRevisionsByTask(handle, taskId)).map(toHandoffRevisionView)
}

/** 单条已发布版本（团队可见；不存在 404）。 */
export async function getHandoffRevisionView(
  handle: DbHandle,
  revisionId: string,
): Promise<HandoffRevisionView | undefined> {
  const row = await getHandoffRevision(handle, revisionId)
  return row === undefined ? undefined : toHandoffRevisionView(row)
}
