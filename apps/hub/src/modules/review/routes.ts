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
  SubmitArtifactReviewRequestSchema,
} from '@whalepod/protocol'
import type { Database } from '@whalepod/db'
import { asUserId } from '@whalepod/domain'
import { readIdempotencyKey } from '../auth/idempotency.js'
import type { RequireActor, SessionActor } from '../auth/session.js'
import { audit } from '../shared/audit.js'
import type { ArtifactStore } from '../artifact/store.js'
import {
  createArtifactComment,
  getArtifactReviewView,
  inviteReviewers,
  submitArtifactReview,
} from './review.js'

export interface ReviewRouteDeps {
  readonly database: Database
  readonly store: ArtifactStore
  readonly requireActor: RequireActor
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
