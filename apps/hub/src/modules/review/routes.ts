/**
 * 交付物审阅 HTTP 面（#429；ADR-0021 §2-4）。
 *
 * 全部端点都要登录 Session；读取面与写入面都按 Artifact 当前可见性重新判权，
 * 不可见与不存在同作 404（不泄露存在性）。写端点要求 Idempotency-Key。
 */
import type { FastifyInstance } from 'fastify'
import {
  CreateArtifactCommentRequestSchema,
  CreateArtifactReviewInvitationsRequestSchema,
  CreateArtifactRevisionRoundRequestSchema,
  LinkArtifactRevisionCandidateRequestSchema,
  ResolveArtifactCommentRequestSchema,
  StartArtifactRevisionRoundRequestSchema,
  SubmitArtifactReviewRequestSchema,
} from '@whalepod/protocol'
import type { Database } from '@whalepod/db'
import { asUserId } from '@whalepod/domain'
import { readIdempotencyKey } from '../auth/idempotency.js'
import type { RequireActor, SessionActor } from '../auth/session.js'
import { audit } from '../shared/audit.js'
import { ApiError } from '../shared/http-error.js'
import type { ArtifactStore } from '../artifact/store.js'
import {
  createArtifactComment,
  getArtifactReviewView,
  inviteReviewers,
  submitArtifactReview,
} from './review.js'
import {
  createRevisionRound,
  getRevisionRoundView,
  linkRevisionCandidate,
  listRevisionRoundViews,
  resolveReviewComment,
  startRevisionRound,
} from './rounds.js'
import type { RunOrchestrator } from '../run/orchestrator.js'

export interface ReviewRouteDeps {
  readonly database: Database
  readonly store: ArtifactStore
  readonly requireActor: RequireActor
  /** 修订批次启动复用既有 Run 创建入口（不新建执行通道）。 */
  readonly orchestrator: RunOrchestrator
  readonly dshDistributionVersionFor: (deviceId: string) => Promise<string | undefined>
}

function parseOr400<T>(
  schema: {
    safeParse: (
      value: unknown,
    ) =>
      | { success: true; data: T }
      | { success: false; error: { issues: Array<{ message: string }> } }
  },
  body: unknown,
): T {
  const parsed = schema.safeParse(body)
  if (!parsed.success) {
    throw new ApiError(400, 'VALIDATION_FAILED', parsed.error.issues[0]?.message ?? 'bad request')
  }
  return parsed.data
}

function actorFrom(session: SessionActor) {
  return { userId: asUserId(session.userId), role: session.role }
}

export function registerReviewRoutes(app: FastifyInstance, deps: ReviewRouteDeps): void {
  app.get('/artifacts/:artifactId/review', async (request, reply) => {
    const session = await deps.requireActor(request)
    const { artifactId } = request.params as { artifactId: string }
    const view = await getArtifactReviewView(deps.database.db, actorFrom(session), artifactId)
    return reply.header('cache-control', 'no-store').send({ ok: true, data: view })
  })

  app.post('/artifacts/:artifactId/comments', async (request, reply) => {
    const session = await deps.requireActor(request)
    const { artifactId } = request.params as { artifactId: string }
    const parsed = CreateArtifactCommentRequestSchema.safeParse(request.body)
    if (!parsed.success) {
      return reply.code(400).send({
        ok: false,
        error: {
          code: 'VALIDATION_FAILED',
          message: parsed.error.issues[0]?.message ?? 'bad comment request',
          requestId: String(request.id),
        },
      })
    }
    const comment = await createArtifactComment(
      deps.database,
      deps.store,
      actorFrom(session),
      artifactId,
      parsed.data,
      readIdempotencyKey(request),
    )
    audit(request, 'artifact.comment.create', 'success', session.userId)
    return reply.code(201).send({ ok: true, data: comment })
  })

  app.post('/artifacts/:artifactId/review-invitations', async (request, reply) => {
    const session = await deps.requireActor(request)
    const { artifactId } = request.params as { artifactId: string }
    const parsed = CreateArtifactReviewInvitationsRequestSchema.safeParse(request.body)
    if (!parsed.success) {
      return reply.code(400).send({
        ok: false,
        error: {
          code: 'VALIDATION_FAILED',
          message: parsed.error.issues[0]?.message ?? 'bad invitation request',
          requestId: String(request.id),
        },
      })
    }
    const invitations = await inviteReviewers(
      deps.database,
      actorFrom(session),
      artifactId,
      parsed.data,
      readIdempotencyKey(request),
    )
    audit(request, 'artifact.review.invite', 'success', session.userId)
    return reply.code(201).send({ ok: true, data: invitations })
  })

  app.post('/tasks/:taskId/artifact-revision-rounds', async (request, reply) => {
    const session = await deps.requireActor(request)
    const { taskId } = request.params as { taskId: string }
    const body = parseOr400(CreateArtifactRevisionRoundRequestSchema, request.body)
    const round = await createRevisionRound(
      deps.database,
      actorFrom(session),
      taskId,
      body,
      readIdempotencyKey(request),
    )
    audit(request, 'artifact.review.round_create', 'success', session.userId)
    return reply.code(201).send({ ok: true, data: round })
  })

  app.get('/tasks/:taskId/artifact-revision-rounds', async (request) => {
    await deps.requireActor(request)
    const { taskId } = request.params as { taskId: string }
    return { ok: true, data: await listRevisionRoundViews(deps.database.db, taskId) }
  })

  app.get('/artifact-revision-rounds/:roundId', async (request) => {
    await deps.requireActor(request)
    const { roundId } = request.params as { roundId: string }
    return { ok: true, data: await getRevisionRoundView(deps.database.db, roundId) }
  })

  app.post('/artifact-revision-rounds/:roundId/start', async (request) => {
    const session = await deps.requireActor(request)
    const { roundId } = request.params as { roundId: string }
    const body = parseOr400(StartArtifactRevisionRoundRequestSchema, request.body)
    const round = await startRevisionRound(
      deps.database,
      deps.orchestrator,
      actorFrom(session),
      roundId,
      body,
      readIdempotencyKey(request),
      deps.dshDistributionVersionFor,
    )
    audit(request, 'artifact.review.round_start', 'success', session.userId)
    return { ok: true, data: round }
  })

  app.post('/artifact-revision-rounds/:roundId/candidates', async (request) => {
    const session = await deps.requireActor(request)
    const { roundId } = request.params as { roundId: string }
    const body = parseOr400(LinkArtifactRevisionCandidateRequestSchema, request.body)
    const round = await linkRevisionCandidate(
      deps.database,
      actorFrom(session),
      roundId,
      body,
      readIdempotencyKey(request),
    )
    audit(request, 'artifact.review.candidate_link', 'success', session.userId)
    return { ok: true, data: round }
  })

  app.post('/artifact-revision-rounds/:roundId/resolutions', async (request) => {
    const session = await deps.requireActor(request)
    const { roundId } = request.params as { roundId: string }
    const body = parseOr400(ResolveArtifactCommentRequestSchema, request.body)
    const round = await resolveReviewComment(deps.database, actorFrom(session), roundId, body)
    audit(request, 'artifact.review.comment_resolve', 'success', session.userId)
    return { ok: true, data: round }
  })

  app.post('/artifacts/:artifactId/review-submissions', async (request, reply) => {
    const session = await deps.requireActor(request)
    const { artifactId } = request.params as { artifactId: string }
    const parsed = SubmitArtifactReviewRequestSchema.safeParse(request.body)
    if (!parsed.success) {
      return reply.code(400).send({
        ok: false,
        error: {
          code: 'VALIDATION_FAILED',
          message: parsed.error.issues[0]?.message ?? 'bad review submission',
          requestId: String(request.id),
        },
      })
    }
    const invitation = await submitArtifactReview(
      deps.database,
      actorFrom(session),
      artifactId,
      parsed.data,
      readIdempotencyKey(request),
    )
    audit(request, 'artifact.review.submit', 'success', session.userId)
    return reply.code(200).send({ ok: true, data: invitation })
  })
}
