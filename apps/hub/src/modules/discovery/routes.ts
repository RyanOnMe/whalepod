import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { ConfigureDiscoveryRequestSchema, DiscoveryConsentRequestSchema } from '@whalepod/protocol'
import { readIdempotencyKey } from '../auth/idempotency.js'
import type { RequireActor } from '../auth/session.js'
import { authenticateDevice } from '../plugin/pack-resolver.js'
import type { RouterDeps } from '../router/service.js'
import {
  changeDiscoveryConsent,
  configureDiscovery,
  discoveryConsentBasis,
  withdrawDiscoverySource,
} from './admission.js'
import { downloadDiscoveryInput, listDiscoveryCandidates } from './service.js'

const Project = z.object({ projectId: z.uuid() })
const base = '/projects/:projectId/discovery'

export function registerDiscoveryRoutes(
  app: FastifyInstance,
  deps: RouterDeps & { requireActor: RequireActor },
) {
  app.post(`${base}/config`, async (request, reply) => {
    reply.header('cache-control', 'private, no-store')
    const actor = await deps.requireActor(request)
    const { projectId } = Project.parse(request.params)
    const settings = ConfigureDiscoveryRequestSchema.parse(request.body)
    const data = await configureDiscovery(
      deps.database,
      actor,
      projectId,
      settings,
      readIdempotencyKey(request),
    )
    return { ok: true, data }
  })
  app.get(`${base}/config`, async (request, reply) => {
    reply.header('cache-control', 'private, no-store')
    const actor = await deps.requireActor(request)
    const { projectId } = Project.parse(request.params)
    return { ok: true, data: await discoveryConsentBasis(deps.database, actor, projectId) }
  })
  for (const kind of ['permit', 'participation'] as const) {
    app.post(`${base}/${kind}`, async (request, reply) => {
      reply.header('cache-control', 'private, no-store')
      const actor = await deps.requireActor(request)
      const { projectId } = Project.parse(request.params)
      const { configVersion } = DiscoveryConsentRequestSchema.parse(request.body)
      const data = await changeDiscoveryConsent(
        deps.database,
        actor,
        projectId,
        kind,
        true,
        configVersion,
        readIdempotencyKey(request),
      )
      return { ok: true, data }
    })
    app.delete(`${base}/${kind}`, async (request, reply) => {
      reply.header('cache-control', 'private, no-store')
      const actor = await deps.requireActor(request)
      const { projectId } = Project.parse(request.params)
      const data = await changeDiscoveryConsent(
        deps.database,
        actor,
        projectId,
        kind,
        false,
        undefined,
        readIdempotencyKey(request),
      )
      return { ok: true, data }
    })
  }
  app.post(`${base}/sources/:sourceId/withdraw`, async (request, reply) => {
    reply.header('cache-control', 'private, no-store')
    const actor = await deps.requireActor(request)
    const { projectId, sourceId } = Project.extend({ sourceId: z.uuid() }).parse(request.params)
    const data = await withdrawDiscoverySource(
      deps.database,
      actor,
      projectId,
      sourceId,
      readIdempotencyKey(request),
    )
    return { ok: true, data }
  })
  app.get(`${base}/candidates`, async (request, reply) => {
    reply.header('cache-control', 'private, no-store')
    const actor = await deps.requireActor(request)
    const { projectId } = Project.parse(request.params)
    return { ok: true, data: await listDiscoveryCandidates(deps, projectId, actor.userId) }
  })
  app.get('/discovery/evaluations/:evaluationId/inputs/:entryId', async (request, reply) => {
    reply.header('cache-control', 'private, no-store')
    const identity = await authenticateDevice(deps.database, request)
    const { evaluationId, entryId } = z
      .object({ evaluationId: z.uuid(), entryId: z.uuid() })
      .parse(request.params)
    const attempt = z.coerce
      .number()
      .int()
      .positive()
      .parse(request.headers['x-coordination-attempt'])
    const leaseToken = z.string().min(32).max(256).parse(request.headers['x-coordination-lease'])
    const data = await downloadDiscoveryInput(
      deps,
      identity.deviceId,
      {
        purpose: 'discovery',
        evaluationId,
        attempt,
        leaseToken,
      },
      entryId,
    )
    return { ok: true, data }
  })
}
