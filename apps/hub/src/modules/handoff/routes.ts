/**
 * 交接草稿/版本的 HTTP 面（#379）。
 *
 * 私有面（owner 作用域；其他成员与管理员一律 404）：GET/POST/PATCH/publish on
 * `/runs/:runId/handoff-draft`；团队面：`GET /tasks/:taskId/handoff-revisions`
 * 与 `GET /handoff-revisions/:revisionId`（仅已发布）。
 * 写端点要求 Idempotency-Key（同键重放返回首次结果）。
 */
import type { FastifyInstance } from 'fastify'
import { HandoffNarrativeSchema } from '@whalepod/protocol'
import type { Database } from '@whalepod/db'
import { ApiError } from '../shared/http-error.js'
import { readIdempotencyKey } from '../auth/idempotency.js'
import type { RequireActor, SessionActor } from '../auth/session.js'
import { asUserId } from '@whalepod/domain'
import {
  createManualHandoffDraft,
  getHandoffRevisionView,
  getRunHandoffDraft,
  listTaskHandoffRevisions,
  publishHandoffDraft,
  updateManualHandoffDraft,
} from './drafts.js'

export interface HandoffRouteDeps {
  readonly database: Database
  readonly requireActor: RequireActor
}

function actorFrom(session: SessionActor) {
  return { userId: asUserId(session.userId), role: session.role }
}

export function registerHandoffRoutes(app: FastifyInstance, deps: HandoffRouteDeps): void {
  // GET /runs/:runId/handoff-draft：owner 看自己的草稿（未生成 → data: null）。
  app.get('/runs/:runId/handoff-draft', async (request) => {
    const session = await deps.requireActor(request)
    const { runId } = request.params as { runId: string }
    const draft = await getRunHandoffDraft(deps.database.db, runId, session.userId)
    return { ok: true, data: draft }
  })

  // POST /runs/:runId/handoff-draft：手工新建（失败恢复；仅终态 Run 的 owner）。
  app.post('/runs/:runId/handoff-draft', async (request, reply) => {
    const session = await deps.requireActor(request)
    const { runId } = request.params as { runId: string }
    const draft = await createManualHandoffDraft(
      deps.database,
      actorFrom(session),
      runId,
      readIdempotencyKey(request),
    )
    return reply.code(201).send({ ok: true, data: draft })
  })

  // PATCH /runs/:runId/handoff-draft：编辑叙述（系统块保持权威、发布时重算）。
  app.patch('/runs/:runId/handoff-draft', async (request, reply) => {
    const session = await deps.requireActor(request)
    const { runId } = request.params as { runId: string }
    const body = request.body as { narrative?: unknown; expectedDraftVersion?: unknown } | undefined
    const narrative = HandoffNarrativeSchema.safeParse(body?.narrative)
    const expected = body?.expectedDraftVersion
    if (
      !narrative.success ||
      typeof expected !== 'number' ||
      !Number.isInteger(expected) ||
      expected < 1
    ) {
      return reply.code(400).send({
        ok: false,
        error: {
          code: 'VALIDATION_FAILED',
          message: narrative.success
            ? 'expectedDraftVersion 必须是正整数'
            : narrative.error.message,
          requestId: String(request.id),
        },
      })
    }
    const draft = await updateManualHandoffDraft(
      deps.database,
      actorFrom(session),
      runId,
      { narrative: narrative.data, expectedDraftVersion: expected },
      readIdempotencyKey(request),
    )
    return reply.code(200).send({ ok: true, data: draft })
  })

  // POST /runs/:runId/handoff-draft/publish：owner 显式发布（校验见命令层）。
  app.post('/runs/:runId/handoff-draft/publish', async (request, reply) => {
    const session = await deps.requireActor(request)
    const { runId } = request.params as { runId: string }
    const result = await publishHandoffDraft(
      deps.database,
      actorFrom(session),
      runId,
      readIdempotencyKey(request),
    )
    return reply.code(201).send({ ok: true, data: result.revision })
  })

  // GET /tasks/:taskId/handoff-revisions：已发布交接版本（团队可见，倒序）。
  app.get('/tasks/:taskId/handoff-revisions', async (request) => {
    await deps.requireActor(request)
    const { taskId } = request.params as { taskId: string }
    return { ok: true, data: await listTaskHandoffRevisions(deps.database.db, taskId) }
  })

  // GET /handoff-revisions/:revisionId：单条已发布版本内容（团队可见）。
  app.get('/handoff-revisions/:revisionId', async (request) => {
    await deps.requireActor(request)
    const { revisionId } = request.params as { revisionId: string }
    const revision = await getHandoffRevisionView(deps.database.db, revisionId)
    if (revision === undefined) throw new ApiError(404, 'NOT_FOUND', 'handoff revision not found')
    return { ok: true, data: revision }
  })
}
