import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import type { Database } from '@whalepod/db'
import { getProject } from '@whalepod/db'
import { audit } from '../shared/audit.js'
import { ApiError } from '../shared/http-error.js'
import { readIdempotencyKey } from '../auth/idempotency.js'
import type { RequireActor } from '../auth/session.js'
import { requestCoordinationEvaluation } from './commands.js'
import { loadProjectCoordination } from './queries.js'

export interface CoordinationRouteDeps {
  readonly database: Database
  readonly requireActor: RequireActor
}

function parseUuid(value: string, label: string): string {
  const parsed = z.uuid().safeParse(value)
  if (!parsed.success) throw new ApiError(400, 'VALIDATION_FAILED', `invalid ${label}`)
  return parsed.data
}

export function registerCoordinationRoutes(
  app: FastifyInstance,
  deps: CoordinationRouteDeps,
): void {
  // GET /projects/:projectId/coordination：协调状态、最近评估、最新 Inference 与开放问题。
  app.get('/projects/:projectId/coordination', async (request) => {
    await deps.requireActor(request)
    const { projectId: rawProjectId } = request.params as { projectId: string }
    const projectId = parseUuid(rawProjectId, 'project id')
    const project = await getProject(deps.database.db, projectId)
    if (project === undefined) throw new ApiError(404, 'NOT_FOUND', 'project not found')
    return { ok: true, data: await loadProjectCoordination(deps.database.db, projectId) }
  })

  // POST /projects/:projectId/coordination/evaluate：成员显式触发（幂等）。
  app.post('/projects/:projectId/coordination/evaluate', async (request, reply) => {
    const actor = await deps.requireActor(request)
    const { projectId: rawProjectId } = request.params as { projectId: string }
    const projectId = parseUuid(rawProjectId, 'project id')
    const project = await getProject(deps.database.db, projectId)
    if (project === undefined) throw new ApiError(404, 'NOT_FOUND', 'project not found')
    const result = await requestCoordinationEvaluation(
      deps.database,
      { userId: actor.userId, role: actor.role },
      projectId,
      readIdempotencyKey(request),
    )
    audit(request, 'coordination.evaluate', 'success', actor.userId)
    if (result.queuedEvaluationId !== null && result.queuedChanged) {
      request.log.info(
        {
          component: 'hub.context',
          action: 'coordination.evaluation_queued',
          projectId,
          evaluationId: result.queuedEvaluationId,
        },
        'coordination evaluation queued',
      )
    }
    request.log.info(
      {
        component: 'hub.context',
        action:
          result.evaluation.status === 'completed'
            ? 'coordination.evaluation_completed'
            : 'coordination.evaluation_skipped',
        projectId,
        evaluationId: result.evaluation.id,
        status: result.evaluation.status,
        reason: result.evaluation.failureCode,
        inferenceEntryId: result.inferenceEntryId,
      },
      'coordination evaluation finished',
    )
    return reply.code(200).send({ ok: true, data: result })
  })
}
