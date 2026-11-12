import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import {
  ConfigureDiscoveryRequestSchema,
  DiscoveryConsentRequestSchema,
  DiscoveryExecutionAuthorizationRequestSchema,
  DiscoveryExecutorSourceGrantRequestSchema,
  DiscoveryPermitRequestSchema,
  DiscoverySlotVerificationRequestSchema,
  DiscoverySourceCorrectionRequestSchema,
  DiscoverySourceVerificationRequestSchema,
} from '@whalepod/protocol'
import { getDiscoveryCandidateById } from '@whalepod/db'
import { readIdempotencyKey } from '../auth/idempotency.js'
import type { RequireActor } from '../auth/session.js'
import { authenticateDevice } from '../plugin/pack-resolver.js'
import type { RouterDeps } from '../router/service.js'
import {
  changeDiscoveryConsent,
  configureDiscovery,
  correctDiscoverySource,
  discoveryConsentBasis,
  discoverySourceIdentity,
  verifyDiscoverySource,
  withdrawDiscoverySource,
} from './admission.js'
import { applyDiscoveryCandidate, getDiscoverySlotView, verifyDiscoverySlot } from './creation.js'
import {
  authorizeDiscoveryExecution,
  discoveryExecutionBasis,
  revokeDiscoveryExecutionByPrincipal,
} from './execution.js'
import { downloadDiscoveryInput, listDiscoveryCandidates } from './service.js'
import { ApiError } from '../shared/http-error.js'
import { grantExecutorSource, revokeExecutorSource } from './executor-source-grants.js'
import type { DiscoveryLivePolicy } from './replay-binding.js'

const Project = z.object({ projectId: z.uuid() })
const base = '/projects/:projectId/discovery'

export function registerDiscoveryRoutes(
  app: FastifyInstance,
  deps: RouterDeps & {
    requireActor: RequireActor
    discoveryExecutorLive?: DiscoveryLivePolicy | undefined
  } & Pick<Parameters<typeof authorizeDiscoveryExecution>[0], 'dispatchDiscoveryReplay'>,
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
  app.post(`${base}/permit`, async (request, reply) => {
    reply.header('cache-control', 'private, no-store')
    const actor = await deps.requireActor(request)
    const { projectId } = Project.parse(request.params)
    const input = DiscoveryPermitRequestSchema.parse(request.body)
    const data = await changeDiscoveryConsent(
      deps.database,
      actor,
      projectId,
      'permit',
      true,
      input.configVersion,
      readIdempotencyKey(request),
      input,
    )
    return { ok: true, data }
  })
  app.delete(`${base}/permit`, async (request, reply) => {
    reply.header('cache-control', 'private, no-store')
    const actor = await deps.requireActor(request)
    const { projectId } = Project.parse(request.params)
    const data = await changeDiscoveryConsent(
      deps.database,
      actor,
      projectId,
      'permit',
      false,
      undefined,
      readIdempotencyKey(request),
    )
    return { ok: true, data }
  })
  app.post(`${base}/participation`, async (request, reply) => {
    reply.header('cache-control', 'private, no-store')
    const actor = await deps.requireActor(request)
    const { projectId } = Project.parse(request.params)
    const { configVersion } = DiscoveryConsentRequestSchema.parse(request.body)
    const data = await changeDiscoveryConsent(
      deps.database,
      actor,
      projectId,
      'participation',
      true,
      configVersion,
      readIdempotencyKey(request),
    )
    return { ok: true, data }
  })
  app.delete(`${base}/participation`, async (request, reply) => {
    reply.header('cache-control', 'private, no-store')
    const actor = await deps.requireActor(request)
    const { projectId } = Project.parse(request.params)
    const data = await changeDiscoveryConsent(
      deps.database,
      actor,
      projectId,
      'participation',
      false,
      undefined,
      readIdempotencyKey(request),
    )
    return { ok: true, data }
  })
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
  app.post(`${base}/sources/:sourceId/correct`, async (request, reply) => {
    reply.header('cache-control', 'private, no-store')
    const actor = await deps.requireActor(request)
    const { projectId, sourceId } = Project.extend({ sourceId: z.uuid() }).parse(request.params)
    const { body } = DiscoverySourceCorrectionRequestSchema.parse(request.body)
    const data = await correctDiscoverySource(
      deps.database,
      actor,
      projectId,
      sourceId,
      body,
      readIdempotencyKey(request),
    )
    return { ok: true, data }
  })
  app.get(`${base}/sources/:sourceId`, async (request, reply) => {
    reply.header('cache-control', 'private, no-store')
    const actor = await deps.requireActor(request)
    const { projectId, sourceId } = Project.extend({ sourceId: z.uuid() }).parse(request.params)
    return {
      ok: true,
      data: await discoverySourceIdentity(deps.database, actor, projectId, sourceId),
    }
  })
  app.post(`${base}/sources/:sourceId/verify`, async (request, reply) => {
    reply.header('cache-control', 'private, no-store')
    const actor = await deps.requireActor(request)
    const { projectId, sourceId } = Project.extend({ sourceId: z.uuid() }).parse(request.params)
    const input = DiscoverySourceVerificationRequestSchema.parse(request.body)
    const data = await verifyDiscoverySource(
      deps.database,
      actor,
      projectId,
      sourceId,
      input,
      readIdempotencyKey(request),
    )
    return { ok: true, data }
  })
  app.get(`${base}/slots/:slotId`, async (request, reply) => {
    reply.header('cache-control', 'private, no-store')
    const actor = await deps.requireActor(request)
    const { projectId, slotId } = Project.extend({ slotId: z.uuid() }).parse(request.params)
    return { ok: true, data: await getDiscoverySlotView(deps, actor.userId, projectId, slotId) }
  })
  app.post(`${base}/slots/:slotId/verify`, async (request, reply) => {
    reply.header('cache-control', 'private, no-store')
    const actor = await deps.requireActor(request)
    const { projectId, slotId } = Project.extend({ slotId: z.uuid() }).parse(request.params)
    const input = DiscoverySlotVerificationRequestSchema.parse(request.body)
    const data = await verifyDiscoverySlot(deps, actor.userId, projectId, slotId, input)
    return { ok: true, data }
  })
  app.get(`${base}/applications/:applicationId/execution`, async (request, reply) => {
    reply.header('cache-control', 'private, no-store')
    const actor = await deps.requireActor(request)
    const { projectId, applicationId } = Project.extend({ applicationId: z.uuid() }).parse(
      request.params,
    )
    return {
      ok: true,
      data: await discoveryExecutionBasis(deps, actor.userId, projectId, applicationId),
    }
  })
  const grantPath = `${base}/applications/:applicationId/executor-source-grants`
  const applicationParams = Project.extend({ applicationId: z.uuid() })
  app.post(grantPath, async (request, reply) => {
    reply.header('cache-control', 'private, no-store')
    const actor = await deps.requireActor(request)
    if (!deps.discoveryExecutorLive)
      throw new ApiError(404, 'NOT_FOUND', 'executor source grant unavailable')
    const { projectId, applicationId } = applicationParams.parse(request.params)
    const input = DiscoveryExecutorSourceGrantRequestSchema.parse(request.body)
    return {
      ok: true,
      data: await grantExecutorSource(
        deps.database,
        actor.userId,
        projectId,
        applicationId,
        input,
        deps.discoveryExecutorLive.route,
      ),
    }
  })
  app.delete(`${grantPath}/:grantId`, async (request, reply) => {
    reply.header('cache-control', 'private, no-store')
    const actor = await deps.requireActor(request)
    const { projectId, applicationId, grantId } = applicationParams
      .extend({ grantId: z.uuid() })
      .parse(request.params)
    await revokeExecutorSource(deps.database, actor.userId, projectId, applicationId, grantId)
    return reply.code(204).send()
  })
  app.post(`${base}/applications/:applicationId/execution`, async (request, reply) => {
    reply.header('cache-control', 'private, no-store')
    const actor = await deps.requireActor(request)
    const { projectId, applicationId } = Project.extend({ applicationId: z.uuid() }).parse(
      request.params,
    )
    const input = DiscoveryExecutionAuthorizationRequestSchema.parse(request.body)
    return {
      ok: true,
      data: await authorizeDiscoveryExecution(
        deps,
        actor.userId,
        projectId,
        applicationId,
        input,
        readIdempotencyKey(request),
      ),
    }
  })
  app.delete(`${base}/applications/:applicationId/execution`, async (request, reply) => {
    reply.header('cache-control', 'private, no-store')
    const actor = await deps.requireActor(request)
    const { projectId, applicationId } = Project.extend({ applicationId: z.uuid() }).parse(
      request.params,
    )
    return {
      ok: true,
      data: await revokeDiscoveryExecutionByPrincipal(deps, actor.userId, projectId, applicationId),
    }
  })
  app.post(`${base}/candidates/:candidateId/apply`, async (request, reply) => {
    reply.header('cache-control', 'private, no-store')
    const actor = await deps.requireActor(request)
    const { projectId, candidateId } = Project.extend({ candidateId: z.uuid() }).parse(
      request.params,
    )
    const candidate = await getDiscoveryCandidateById(deps.database.db, candidateId)
    // Do not confirm existence to non-principals: both cases are the same 404.
    if (
      !candidate ||
      candidate.projectId !== projectId ||
      candidate.principalUserId !== actor.userId
    )
      throw new ApiError(404, 'NOT_FOUND', 'discovery candidate not found')
    return { ok: true, data: await applyDiscoveryCandidate(deps, candidate.id) }
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
