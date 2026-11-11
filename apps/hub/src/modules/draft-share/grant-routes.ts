import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { z } from 'zod'
import { readIdempotencyKey } from '../auth/idempotency.js'
import type { RequireActor } from '../auth/session.js'
import { ApiError } from '../shared/http-error.js'
import type { DraftShareGrants } from './grants.js'

const Uuid = z.uuid()
const Offer = z.strictObject({
  recipientUserId: Uuid,
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  reviewReceiptId: Uuid,
  expiresAt: z.iso.datetime(),
  confirmsReadOnly: z.literal(true),
  replaceGrantId: Uuid.optional(),
})

function paramId(value: string): string {
  if (!Uuid.safeParse(value).success) throw new ApiError(404, 'NOT_FOUND', 'draft not found')
  return value.toLowerCase()
}

function requireEmptyBody(request: FastifyRequest): void {
  if (request.body !== undefined && !z.strictObject({}).safeParse(request.body).success)
    throw new ApiError(400, 'VALIDATION_FAILED', 'private draft action takes no payload')
}

function privateResponse(reply: FastifyReply) {
  return reply
    .header('cache-control', 'private, no-store')
    .header('x-content-type-options', 'nosniff')
    .header('content-security-policy', 'sandbox')
}

function sendBytes(reply: FastifyReply, bytes: Buffer) {
  return reply
    .header('content-type', 'application/octet-stream')
    .header('content-disposition', 'attachment; filename="managed-draft"')
    .header('content-length', String(bytes.length))
    .send(bytes)
}

function observed(request: FastifyRequest, action: string, id: string) {
  request.log.info({ component: 'hub.draft-share', action, id }, 'private draft authority recorded')
}

/** Only the protected human session routes can create, accept or read a grant. */
export function registerDraftShareGrantRoutes(
  app: FastifyInstance,
  deps: { grants: DraftShareGrants; requireActor: RequireActor },
): void {
  const { grants, requireActor } = deps
  const candidates = '/managed-draft-candidates'
  const inbox = '/draft-share-grants'
  app.get(candidates, async (request, reply) => {
    privateResponse(reply)
    return { ok: true, data: await grants.listCandidates(await requireActor(request)) }
  })
  app.get<{ Params: { artifactId: string } }>(
    candidates + '/:artifactId/content',
    {
      exposeHeadRoute: false,
    },
    async (request, reply) => {
      privateResponse(reply)
      const actor = await requireActor(request)
      const { bytes, admissionId } = await grants.inspect(actor, paramId(request.params.artifactId))
      observed(request, 'owner_inspection_admitted', admissionId)
      return sendBytes(reply.header('x-whalepod-draft-review-id', admissionId), bytes)
    },
  )
  app.post<{ Params: { artifactId: string } }>(
    candidates + '/:artifactId/grants',
    async (request, reply) => {
      privateResponse(reply)
      const actor = await requireActor(request)
      const artifactId = paramId(request.params.artifactId)
      const offer = Offer.safeParse(request.body)
      if (!offer.success)
        throw new ApiError(400, 'VALIDATION_FAILED', 'invalid private draft offer')
      const grant = await grants.offer(actor, artifactId, {
        ...offer.data,
        expiresAt: new Date(offer.data.expiresAt),
        idempotencyKey: readIdempotencyKey(request),
      })
      observed(request, 'offer_acknowledged', grant.grantId)
      return reply.code(201).send({ ok: true, data: grant })
    },
  )
  app.get(inbox, async (request, reply) => {
    privateResponse(reply)
    return { ok: true, data: await grants.listGrants(await requireActor(request)) }
  })
  app.post<{ Params: { grantId: string } }>(inbox + '/:grantId/accept', async (request, reply) => {
    privateResponse(reply)
    const actor = await requireActor(request)
    requireEmptyBody(request)
    const grant = await grants.accept(
      actor,
      paramId(request.params.grantId),
      readIdempotencyKey(request),
    )
    observed(request, 'accept_acknowledged', grant.grantId)
    return { ok: true, data: grant }
  })
  app.post<{ Params: { grantId: string } }>(inbox + '/:grantId/decline', async (request, reply) => {
    privateResponse(reply)
    const actor = await requireActor(request)
    const grantId = paramId(request.params.grantId)
    requireEmptyBody(request)
    await grants.close(actor, grantId, 'declined', readIdempotencyKey(request))
    observed(request, 'decline_acknowledged', grantId)
    return reply.code(204).send()
  })
  app.delete<{ Params: { grantId: string } }>(inbox + '/:grantId', async (request, reply) => {
    privateResponse(reply)
    const actor = await requireActor(request)
    const grantId = paramId(request.params.grantId)
    requireEmptyBody(request)
    await grants.close(actor, grantId, 'revoked', readIdempotencyKey(request))
    observed(request, 'revocation_acknowledged', grantId)
    return reply.code(204).send()
  })
  app.get<{ Params: { grantId: string } }>(
    inbox + '/:grantId/content',
    {
      exposeHeadRoute: false,
    },
    async (request, reply) => {
      privateResponse(reply)
      const actor = await requireActor(request)
      const { bytes, admissionId } = await grants.read(actor, paramId(request.params.grantId))
      observed(request, 'grant_read_admitted', admissionId)
      return sendBytes(reply, bytes)
    },
  )
}
