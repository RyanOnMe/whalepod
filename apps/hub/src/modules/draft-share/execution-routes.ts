import type { Database } from '@whalepod/db'
import {
  ManagedDraftModelForwardRequestSchema,
  ManagedDraftSourceReadRequestSchema,
} from '@whalepod/protocol'
import type { FastifyInstance, FastifyRequest } from 'fastify'
import { z } from 'zod'
import type { ManagedDraftHost } from '../../config.js'
import { ApiError } from '../shared/http-error.js'
import type { ManagedDraftExecution } from './execution.js'
import { deviceForNodeRequest, matchesManagedDraftHost } from './host-auth.js'

const missing = () => new ApiError(404, 'NOT_FOUND', 'managed draft execution unavailable')

export function registerManagedDraftExecutionRoutes(
  app: FastifyInstance,
  deps: {
    database: Database
    host: ManagedDraftHost
    requiresTls: boolean
    execution: ManagedDraftExecution
  },
): void {
  const base = '/node/managed-drafts/:runId'
  async function requireHost(request: FastifyRequest): Promise<void> {
    const device = await deviceForNodeRequest(deps.database, request)
    if (!matchesManagedDraftHost(request, deps.host, device, deps.requiresTls)) throw missing()
  }
  app.post<{ Params: { runId: string } }>(
    `${base}/source`,
    { bodyLimit: 2_048 },
    async (request, reply) => {
      reply.header('cache-control', 'private, no-store')
      await requireHost(request)
      const run = z.uuid().safeParse(request.params.runId)
      const body = ManagedDraftSourceReadRequestSchema.safeParse(request.body)
      if (!run.success || !body.success) throw missing()
      if (request.raw.aborted || reply.raw.destroyed) throw missing()
      const bytes = await deps.execution.source(run.data, body.data)
      if (bytes === undefined) throw missing()
      request.log.info(
        {
          component: 'hub.managed-draft',
          action: 'source.admitted',
          runId: run.data,
          requestId: body.data.requestId,
        },
        'managed source transfer admitted',
      )
      return reply.type('application/octet-stream').send(bytes)
    },
  )
  app.post<{ Params: { runId: string } }>(
    `${base}/model`,
    { bodyLimit: 2_048 },
    async (request, reply) => {
      reply.header('cache-control', 'private, no-store')
      const controller = new AbortController()
      const close = () => controller.abort()
      reply.raw.once('close', close)
      if (request.raw.aborted || reply.raw.destroyed || reply.raw.writableEnded) close()
      try {
        await requireHost(request)
        const run = z.uuid().safeParse(request.params.runId)
        const body = ManagedDraftModelForwardRequestSchema.safeParse(request.body)
        if (!run.success || !body.success || controller.signal.aborted) throw missing()
        const result = await deps.execution.model(run.data, body.data, controller.signal)
        if (result === undefined) throw missing()
        request.log.info(
          {
            component: 'hub.managed-draft',
            action: 'model.responded',
            runId: run.data,
            attemptId: body.data.attemptId,
          },
          'managed model response admitted',
        )
        return reply.send({ ok: true, data: result })
      } finally {
        reply.raw.off('close', close)
      }
    },
  )
}
