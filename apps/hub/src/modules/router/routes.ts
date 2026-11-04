import { z } from 'zod'
import type { FastifyInstance } from 'fastify'
import { getRouterApplication, listRouterEvaluations } from '@whalepod/db'
import {
  ConfigureProjectRouterRequestSchema,
  RouterReevaluateRequestSchema,
} from '@whalepod/protocol'
import type { RequireActor } from '../auth/session.js'
import { readIdempotencyKey } from '../auth/idempotency.js'
import { authenticateDevice } from '../plugin/pack-resolver.js'
import { lockWorkContext, requireAssignee } from '../work/context.js'
import {
  configureRouterForActor,
  downloadRouterInput,
  reevaluateRouterForActor,
  requestRouterEvaluation,
  routerEvaluationView,
  type RouterDeps,
} from './service.js'
const Id = z.uuid()
const EvaluationRequest = z.strictObject({
  sourceType: z.enum(['task_message', 'context_entry']),
  sourceId: Id,
})

export function registerRouterRoutes(
  app: FastifyInstance,
  deps: RouterDeps & { requireActor: RequireActor },
): void {
  app.post('/projects/:projectId/router/config', async (request, reply) => {
    reply.header('cache-control', 'private, no-store')
    const actor = await deps.requireActor(request)
    const { projectId } = request.params as { projectId: string }
    const input = ConfigureProjectRouterRequestSchema.parse(request.body)
    const data = await configureRouterForActor(
      deps,
      actor,
      Id.parse(projectId),
      input,
      readIdempotencyKey(request),
    )
    return { ok: true, data }
  })
  app.post('/works/:workKey/router/evaluate', async (request, reply) => {
    reply.header('cache-control', 'private, no-store')
    const actor = await deps.requireActor(request)
    const { workKey } = request.params as { workKey: string }
    const input = EvaluationRequest.parse(request.body)
    const data = await requestRouterEvaluation(
      deps,
      actor,
      Id.parse(workKey),
      {
        ...input,
        triggerKey: `explicit:${input.sourceType}:${input.sourceId}`,
      },
      readIdempotencyKey(request),
    )
    return { ok: true, data }
  })
  app.get('/works/:workKey/router/evaluations', async (request, reply) => {
    reply.header('cache-control', 'private, no-store')
    const actor = await deps.requireActor(request)
    const { workKey } = request.params as { workKey: string }
    const key = Id.parse(workKey)
    const data = await deps.database.transaction(async (tx) => {
      const { task } = await lockWorkContext(tx, key)
      await requireAssignee(tx, task, actor.userId)
      const rows = (await listRouterEvaluations(tx, key)).filter(
        (row) => row.principalUserId === actor.userId,
      )
      const views = []
      for (const row of rows)
        views.push(routerEvaluationView(row, await getRouterApplication(tx, row.id)))
      return views
    })
    return { ok: true, data }
  })
  // RD-03r2：显式重评（wait 当前代次或明确重试已结束评估），不把回答当立即执行。
  app.post('/works/:workKey/router/re-evaluate', async (request, reply) => {
    reply.header('cache-control', 'private, no-store')
    const actor = await deps.requireActor(request)
    const { workKey } = request.params as { workKey: string }
    const input = RouterReevaluateRequestSchema.parse(request.body)
    const data = await reevaluateRouterForActor(
      deps,
      actor,
      Id.parse(workKey),
      input,
      readIdempotencyKey(request),
    )
    return { ok: true, data }
  })
  app.get('/coordination/evaluations/:evaluationId/inputs/:entryId', async (request, reply) => {
    reply.header('cache-control', 'private, no-store')
    const identity = await authenticateDevice(deps.database, request)
    const { evaluationId, entryId } = request.params as { evaluationId: string; entryId: string }
    const attempt = z.coerce
      .number()
      .int()
      .positive()
      .parse(request.headers['x-coordination-attempt'])
    const leaseToken = z.string().min(32).max(256).parse(request.headers['x-coordination-lease'])
    const data = await downloadRouterInput(
      deps,
      identity.deviceId,
      Id.parse(evaluationId),
      Id.parse(entryId),
      attempt,
      leaseToken,
    )
    return { ok: true, data }
  })
}
