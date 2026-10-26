/**
 * 交付物修订批次（#430；ADR-0021 §5）。
 *
 * - 创建时冻结原稿、选定批注线程（含回复）、参考材料与责任人方向；input 列之后
 *   不再回写，后来补充的批注属于下一轮。
 * - 启动复用既有 Run 创建入口（单活跃、审批、续跑守卫都不绕过），把本轮快照写入
 *   `run.review_input` 并经 `executionContext` 注入 Runtime。
 * - 新版关联必须由责任人显式完成，且候选必须由本轮 Run 产出；不按文件名猜。
 * - 复核只允许批注作者或当前责任人（代为收口必须写理由）；Agent 无权写复核表。
 */
import type { Actor } from '@whalepod/domain'
import type { ArtifactRow, Database, DbHandle, TaskRow } from '@whalepod/db'
import {
  appendTeamEvent,
  claimArtifactRevisionRoundStart,
  findRunByReviewRoundId,
  getArtifact,
  getArtifactComment,
  getArtifactRevisionLinkByRound,
  getArtifactRevisionRound,
  getTask,
  insertArtifactRevisionLinkIfAbsent,
  insertArtifactRevisionRound,
  insertArtifactRevisionRoundComments,
  listArtifactCommentResolutionsByRound,
  listArtifactComments,
  listArtifactRevisionRoundCommentIds,
  listArtifactRevisionRoundsByTask,
  markArtifactRevisionRoundStarted,
  transactCommand,
  schema,
  upsertArtifactCommentResolution,
} from '@whalepod/db'
import {
  ArtifactRevisionRoundViewSchema,
  ReviewInputManifestSchema,
  type ArtifactCommentResolutionView,
  type ArtifactRevisionRoundView,
  type CreateArtifactRevisionRoundRequest,
  type LinkArtifactRevisionCandidateRequest,
  type ResolveArtifactCommentRequest,
  type ReviewCommentSnapshot,
  type ReviewInputManifest,
  type ReviewRoundArtifact,
  type StartArtifactRevisionRoundRequest,
} from '@whalepod/protocol'
import { randomUUID } from 'node:crypto'
import { eq } from 'drizzle-orm'
import type { RunOrchestrator } from '../run/orchestrator.js'
import { ApiError } from '../shared/http-error.js'

function artifactSnapshot(row: ArtifactRow): ReviewRoundArtifact {
  if (row.status !== 'published' || row.publishedAt === null) {
    throw new ApiError(409, 'CONFLICT', '交付物尚未发布，不能作为修订依据')
  }
  return {
    artifactId: row.id,
    runId: row.runId,
    title: row.title,
    mediaType: row.mediaType,
    byteSize: Number(row.byteSize),
    sha256: row.sha256,
    publishedAt: row.publishedAt.toISOString(),
  }
}

function requireAssignee(task: TaskRow, actor: Actor): void {
  if (task.assigneeUserId !== actor.userId) {
    throw new ApiError(403, 'FORBIDDEN', 'only the task assignee can organize this revision')
  }
}

async function loadArtifactOr404(handle: DbHandle, id: string): Promise<ArtifactRow> {
  const row = await getArtifact(handle, id.toLowerCase())
  if (row === undefined) throw new ApiError(404, 'NOT_FOUND', 'artifact not found')
  return row
}

/** 选定线程快照：只接受顶层批注，回复随线程冻结（顺序稳定）。 */
async function snapshotComments(
  handle: DbHandle,
  artifactId: string,
  commentIds: readonly string[],
): Promise<ReviewCommentSnapshot[]> {
  const ids = [...new Set(commentIds.map((id) => id.toLowerCase()))]
  const rows = await listArtifactComments(handle, artifactId)
  const byId = new Map(rows.map((row) => [row.id, row]))
  const snapshots: ReviewCommentSnapshot[] = []
  for (const id of ids) {
    const row = byId.get(id)
    if (row === undefined) throw new ApiError(404, 'NOT_FOUND', 'comment not found in this version')
    if (row.parentCommentId !== null) {
      throw new ApiError(400, 'VALIDATION_FAILED', '请选择顶层批注；回复会随线程一起冻结')
    }
    const replies = rows
      .filter((candidate) => candidate.parentCommentId === row.id)
      .map((reply) => ({
        commentId: reply.id,
        authorUserId: reply.authorUserId,
        body: reply.body,
        createdAt: reply.createdAt.toISOString(),
      }))
    snapshots.push({
      commentId: row.id,
      authorUserId: row.authorUserId,
      kind: row.kind,
      anchor: row.anchor ?? null,
      body: row.body,
      createdAt: row.createdAt.toISOString(),
      replies,
    })
  }
  return snapshots.sort((a, b) => a.createdAt.localeCompare(b.createdAt))
}

async function loadRoundView(
  handle: DbHandle,
  roundId: string,
  actor?: Actor,
): Promise<ArtifactRevisionRoundView> {
  const round = await getArtifactRevisionRound(handle, roundId)
  if (round === undefined) throw new ApiError(404, 'NOT_FOUND', 'revision round not found')
  const input = ReviewInputManifestSchema.parse(round.input)
  const [link, resolutions] = await Promise.all([
    getArtifactRevisionLinkByRound(handle, round.id),
    listArtifactCommentResolutionsByRound(handle, round.id),
  ])
  const candidate =
    link === undefined ? undefined : await getArtifact(handle, link.candidateArtifactId)
  return ArtifactRevisionRoundViewSchema.parse({
    id: round.id,
    taskId: round.taskId,
    status: round.status,
    sourceArtifact: input.sourceArtifact,
    direction: round.direction,
    comments: input.comments,
    references: input.references,
    runId: round.runId,
    candidate:
      link === undefined ||
      candidate === undefined ||
      (candidate.status !== 'published' && candidate.ownerUserId !== actor?.userId)
        ? null
        : {
            artifactId: link.candidateArtifactId,
            linkedAt: link.createdAt.toISOString(),
            publishedAt: candidate?.publishedAt?.toISOString() ?? null,
          },
    resolutions: resolutions.map((row) => ({
      commentId: row.commentId,
      status: row.status,
      resolvedBy: row.resolvedBy,
      note: row.note,
      updatedAt: row.updatedAt.toISOString(),
    })),
    createdAt: round.createdAt.toISOString(),
    startedAt: round.startedAt?.toISOString() ?? null,
  })
}

export async function getRevisionRoundView(
  handle: DbHandle,
  roundId: string,
  actor?: Actor,
): Promise<ArtifactRevisionRoundView> {
  return loadRoundView(handle, roundId.toLowerCase(), actor)
}

export async function listRevisionRoundViews(
  handle: DbHandle,
  taskId: string,
  actor?: Actor,
): Promise<ArtifactRevisionRoundView[]> {
  const rounds = await listArtifactRevisionRoundsByTask(handle, taskId)
  return Promise.all(rounds.map((round) => loadRoundView(handle, round.id, actor)))
}

export async function createRevisionRound(
  database: Database,
  actor: Actor,
  taskId: string,
  request: CreateArtifactRevisionRoundRequest,
  idempotencyKey: string,
): Promise<ArtifactRevisionRoundView> {
  const task = await getTask(database.db, taskId.toLowerCase())
  if (task === undefined) throw new ApiError(404, 'NOT_FOUND', 'task not found')
  requireAssignee(task, actor)
  if (task.status === 'done' || task.status === 'cancelled') {
    throw new ApiError(409, 'CONFLICT', '已完成或取消的任务不能再组织修订')
  }
  const source = await loadArtifactOr404(database.db, request.sourceArtifactId)
  if (source.taskId !== task.id) {
    throw new ApiError(404, 'NOT_FOUND', 'artifact not found in this task')
  }
  const sourceSnapshot = artifactSnapshot(source)
  const comments = await snapshotComments(database.db, source.id, request.commentIds)
  const referenceIds = [
    ...new Set((request.referenceArtifactIds ?? []).map((id) => id.toLowerCase())),
  ].filter((id) => id !== source.id)
  const references: ReviewRoundArtifact[] = []
  for (const id of referenceIds) {
    const row = await loadArtifactOr404(database.db, id)
    if (row.taskId !== task.id) {
      throw new ApiError(404, 'NOT_FOUND', 'reference artifact not found in this task')
    }
    references.push(artifactSnapshot(row))
  }
  const direction = request.direction?.trim()
  const roundId = randomUUID()
  const input: ReviewInputManifest = ReviewInputManifestSchema.parse({
    roundId,
    sourceArtifact: sourceSnapshot,
    direction: direction === undefined || direction === '' ? null : direction,
    comments,
    references,
    frozenAt: new Date().toISOString(),
  })
  const outcome = await transactCommand(
    database,
    `artifact.review.round.create:${actor.userId}:${task.id}:${idempotencyKey}`,
    async (tx) => {
      const manifest = ReviewInputManifestSchema.parse({ ...input, roundId })
      await insertArtifactRevisionRound(tx, {
        id: roundId,
        taskId: task.id,
        sourceArtifactId: source.id,
        ownerUserId: actor.userId,
        ...(manifest.direction === null ? {} : { direction: manifest.direction }),
        input: manifest,
      })
      await insertArtifactRevisionRoundComments(
        tx,
        roundId,
        manifest.comments.map((comment) => comment.commentId),
      )
      await appendTeamEvent(tx, {
        type: 'artifact.changed',
        payload: {
          artifactId: source.id,
          taskId: task.id,
          runId: source.runId,
          status: source.status,
          change: 'review_round',
        },
      })
      return { id: roundId }
    },
  )
  return loadRoundView(database.db, outcome.id, actor)
}

function defaultPrompt(input: ReviewInputManifest): string {
  return `请根据本轮审阅意见修订交付物「${input.sourceArtifact.title}」。逐条处理执行上下文中冻结的意见；生成新的候选交付物，并在最终说明中逐条报告处理方式。不要修改或替代原交付物。`
}

export async function startRevisionRound(
  database: Database,
  orchestrator: RunOrchestrator,
  actor: Actor,
  roundId: string,
  request: StartArtifactRevisionRoundRequest,
  idempotencyKey: string,
  dshDistributionVersionFor: (deviceId: string) => Promise<string | undefined>,
): Promise<ArtifactRevisionRoundView> {
  const round = await getArtifactRevisionRound(database.db, roundId.toLowerCase())
  if (round === undefined) throw new ApiError(404, 'NOT_FOUND', 'revision round not found')
  const task = await getTask(database.db, round.taskId)
  if (task === undefined) throw new ApiError(404, 'NOT_FOUND', 'task not found')
  requireAssignee(task, actor)
  if (round.status === 'cancelled') throw new ApiError(409, 'CONFLICT', '本轮修订已取消')
  // Device facts are read before acquiring database locks: the callback uses the
  // normal pool, so invoking it under the Task lock could require a second connection.
  // A previously committed Run can still be rebound even if its device is now offline.
  let deviceFact: { ok: true; version: string | undefined } | { ok: false; error: unknown } = {
    ok: true,
    version: undefined,
  }
  if (round.runId === null) {
    try {
      deviceFact = { ok: true, version: await dshDistributionVersionFor(request.deviceId) }
    } catch (error) {
      deviceFact = { ok: false, error }
    }
  }
  const outcome = await transactCommand(
    database,
    `artifact.review.start:${actor.userId}:${round.id}:${idempotencyKey}`,
    async (tx) => {
      // One transaction, one lock order: Task -> round. The Task lock is reused by
      // createWithinTransaction; no independently committed claim or nested create().
      const [lockedTask] = await tx
        .select()
        .from(schema.tasks)
        .where(eq(schema.tasks.id, round.taskId))
        .for('update')
      if (lockedTask === undefined) throw new ApiError(404, 'NOT_FOUND', 'task not found')
      requireAssignee(lockedTask, actor)
      const [lockedRound] = await tx
        .select()
        .from(schema.artifactRevisionRounds)
        .where(eq(schema.artifactRevisionRounds.id, round.id))
        .for('update')
      if (lockedRound === undefined)
        throw new ApiError(404, 'NOT_FOUND', 'revision round not found')
      if (lockedRound.status === 'cancelled') throw new ApiError(409, 'CONFLICT', '本轮修订已取消')
      if (lockedRound.runId !== null) return { id: lockedRound.id }

      // Compatibility recovery for the old two-transaction implementation: a crash
      // could leave starting (or preparing after a caught post-commit error). The lock
      // excludes every new start; recover an existing Run before considering creation.
      const recovered = await findRunByReviewRoundId(tx, lockedRound.id)
      const input = ReviewInputManifestSchema.parse(lockedRound.input)
      const manifestArtifacts = [input.sourceArtifact, ...input.references]
      if (lockedRound.status === 'preparing') {
        const claimed = await claimArtifactRevisionRoundStart(tx, lockedRound.id)
        if (claimed === undefined) throw new ApiError(409, 'CONFLICT', '本轮修订状态已变化')
      }
      let runId: string
      if (recovered !== undefined) runId = recovered.id
      else {
        for (const entry of manifestArtifacts) {
          const row = await loadArtifactOr404(tx, entry.artifactId)
          if (
            row.status !== 'published' ||
            row.sha256 !== entry.sha256 ||
            Number(row.byteSize) !== entry.byteSize
          )
            throw new ApiError(409, 'CONFLICT', '本轮冻结的材料已不可用或摘要不一致')
        }
        if (
          request.resumeFromRunId !== undefined &&
          request.resumeFromRunId.toLowerCase() !== input.sourceArtifact.runId.toLowerCase()
        )
          throw new ApiError(409, 'CONFLICT', '只能续接原产出会话；要换执行请选择新执行')
        if (!deviceFact.ok) throw deviceFact.error
        if (deviceFact.version === undefined)
          throw new ApiError(409, 'DEVICE_OFFLINE', 'device is not connected')
        runId = (
          await orchestrator.createWithinTransaction(tx, actor, lockedTask.id, {
            idempotencyKey: `artifact.review.start:${actor.userId}:${lockedRound.id}:${idempotencyKey}`,
            agentId: request.agentId,
            ...(request.profileRevisionId === undefined
              ? {}
              : { profileRevisionId: request.profileRevisionId }),
            deviceId: request.deviceId,
            workspaceId: request.workspaceId,
            prompt: request.prompt ?? defaultPrompt(input),
            artifactInputIds: manifestArtifacts.map((entry) => entry.artifactId),
            reviewInput: input,
            dshDistributionVersion: deviceFact.version,
            ...(request.expectedApprovalPolicy === undefined
              ? {}
              : { expectedApprovalPolicy: request.expectedApprovalPolicy }),
            ...(request.resumeFromRunId === undefined
              ? {}
              : { resumeFromRunId: request.resumeFromRunId }),
          })
        ).id
      }
      const marked = await markArtifactRevisionRoundStarted(tx, lockedRound.id, runId, new Date())
      if (marked === undefined) throw new ApiError(409, 'CONFLICT', '本轮修订状态已变化')
      await appendTeamEvent(tx, {
        type: 'artifact.changed',
        payload: {
          artifactId: lockedRound.sourceArtifactId,
          taskId: lockedRound.taskId,
          runId,
          status: 'published',
          change: 'review_round_started',
        },
      })
      return { id: lockedRound.id }
    },
  )
  return loadRoundView(database.db, outcome.id, actor)
}

export async function linkRevisionCandidate(
  database: Database,
  actor: Actor,
  roundId: string,
  request: LinkArtifactRevisionCandidateRequest,
  idempotencyKey: string,
): Promise<ArtifactRevisionRoundView> {
  const round = await getArtifactRevisionRound(database.db, roundId.toLowerCase())
  if (round === undefined) throw new ApiError(404, 'NOT_FOUND', 'revision round not found')
  const task = await getTask(database.db, round.taskId)
  if (task === undefined) throw new ApiError(404, 'NOT_FOUND', 'task not found')
  requireAssignee(task, actor)
  if (round.status !== 'started' || round.runId === null) {
    throw new ApiError(409, 'CONFLICT', '本轮修订尚未开始执行')
  }
  const candidate = await loadArtifactOr404(database.db, request.candidateArtifactId)
  if (candidate.taskId !== round.taskId || candidate.runId !== round.runId) {
    throw new ApiError(409, 'CONFLICT', '候选必须由本轮执行产出且属于本任务')
  }
  if (candidate.status !== 'candidate' && candidate.status !== 'published') {
    throw new ApiError(409, 'CONFLICT', '候选已不可用')
  }
  const existing = await getArtifactRevisionLinkByRound(database.db, round.id)
  if (existing !== undefined) {
    if (existing.candidateArtifactId !== candidate.id) {
      throw new ApiError(409, 'CONFLICT', '本轮已经关联了另一份新版')
    }
    return loadRoundView(database.db, round.id, actor)
  }
  await transactCommand(
    database,
    `artifact.review.candidate.link:${actor.userId}:${round.id}:${idempotencyKey}`,
    async (tx) => {
      await insertArtifactRevisionLinkIfAbsent(tx, {
        candidateArtifactId: candidate.id,
        sourceArtifactId: round.sourceArtifactId,
        roundId: round.id,
        linkedBy: actor.userId,
      })
      await appendTeamEvent(tx, {
        type: 'artifact.changed',
        payload: {
          artifactId: round.sourceArtifactId,
          taskId: round.taskId,
          runId: round.runId,
          status: 'published',
          change: 'review_candidate',
        },
      })
      return { roundId: round.id }
    },
  )
  const linked = await getArtifactRevisionLinkByRound(database.db, round.id)
  if (linked === undefined || linked.candidateArtifactId !== candidate.id) {
    throw new ApiError(409, 'CONFLICT', '候选已被其他批次关联')
  }
  return loadRoundView(database.db, round.id, actor)
}

export async function resolveReviewComment(
  database: Database,
  actor: Actor,
  roundId: string,
  request: ResolveArtifactCommentRequest,
): Promise<ArtifactRevisionRoundView> {
  const round = await getArtifactRevisionRound(database.db, roundId.toLowerCase())
  if (round === undefined) throw new ApiError(404, 'NOT_FOUND', 'revision round not found')
  const task = await getTask(database.db, round.taskId)
  if (task === undefined) throw new ApiError(404, 'NOT_FOUND', 'task not found')
  const selected = await listArtifactRevisionRoundCommentIds(database.db, round.id)
  const commentId = request.commentId.toLowerCase()
  if (!selected.includes(commentId)) {
    throw new ApiError(404, 'NOT_FOUND', 'comment is not part of this round')
  }
  const link = await getArtifactRevisionLinkByRound(database.db, round.id)
  if (link === undefined) throw new ApiError(409, 'CONFLICT', '本轮还没有关联新版')
  const candidate = await loadArtifactOr404(database.db, link.candidateArtifactId)
  if (candidate.status !== 'published') {
    throw new ApiError(409, 'CONFLICT', '新版尚未发布，暂不能确认批注已解决')
  }
  const comment = await getArtifactComment(database.db, commentId)
  if (comment === undefined) throw new ApiError(404, 'NOT_FOUND', 'comment not found')
  const isAuthor = comment.authorUserId === actor.userId
  const isOwner = task.assigneeUserId === actor.userId
  if (!isAuthor && !isOwner) {
    throw new ApiError(403, 'FORBIDDEN', 'only the comment author or task assignee can resolve')
  }
  const note = request.note?.trim()
  if (!isAuthor && (note === undefined || note === '')) {
    throw new ApiError(400, 'VALIDATION_FAILED', '责任人代为收口时必须写明理由')
  }
  await database.transaction(async (tx) => {
    await upsertArtifactCommentResolution(tx, {
      id: randomUUID(),
      roundId: round.id,
      commentId,
      candidateArtifactId: candidate.id,
      status: request.status,
      resolvedBy: actor.userId,
      ...(note === undefined || note === '' ? {} : { note }),
      now: new Date(),
    })
    await appendTeamEvent(tx, {
      type: 'artifact.changed',
      payload: {
        artifactId: round.sourceArtifactId,
        taskId: round.taskId,
        runId: round.runId,
        status: 'published',
        change: 'review_resolution',
      },
    })
  })
  return loadRoundView(database.db, round.id, actor)
}

export type { ArtifactCommentResolutionView }
