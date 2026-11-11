import { getTaskForUpdate, type Database } from '@whalepod/db'
import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { readIdempotencyKey } from '../auth/idempotency.js'
import type { RequireActor } from '../auth/session.js'
import { audit } from '../shared/audit.js'
import { ApiError } from '../shared/http-error.js'
import { requireAssignee } from '../work/context.js'
import {
  lockManagedDraftModelBinding,
  registerManagedDraftSource,
  revokeManagedDraftSource,
  type ManagedSourceModelRoute,
} from './source-registry.js'

const Registration = z.strictObject({
  projectId: z.uuid(),
  revisionId: z.uuid(),
  recipientUserId: z.uuid(),
  permitsPublishedAudience: z.boolean(),
  confirmsOwnershipAndUses: z.literal(true),
  modelBindingDigest: z.string().regex(/^[a-f0-9]{64}$/),
  expiresAt: z.iso.datetime(),
})
const missing = () => new ApiError(404, 'NOT_FOUND', 'managed draft source not found')

export function registerManagedDraftSourceRoutes(
  app: FastifyInstance,
  deps: {
    database: Database
    requireActor: RequireActor
    ownerUserId: string
    modelRoute: ManagedSourceModelRoute
  },
): void {
  const base = '/tasks/:taskId/managed-draft-sources'
  app.get<{ Params: { taskId: string } }>(base, async (request, reply) => {
    reply.header('cache-control', 'private, no-store')
    const actor = await deps.requireActor(request)
    if (actor.userId !== deps.ownerUserId || !z.uuid().safeParse(request.params.taskId).success)
      throw missing()
    const now = new Date()
    return deps.database.transaction(async (tx) => {
      const task = await getTaskForUpdate(tx, request.params.taskId)
      if (task === undefined || task.assigneeUserId !== actor.userId) throw missing()
      await requireAssignee(tx, task, actor.userId)
      const bindingDigest = await lockManagedDraftModelBinding(tx, deps.modelRoute, now)
      if (bindingDigest === undefined) throw missing()
      return { ok: true, data: { ...deps.modelRoute, bindingDigest } }
    })
  })
  app.post<{ Params: { taskId: string } }>(base, async (request, reply) => {
    reply.header('cache-control', 'private, no-store')
    const actor = await deps.requireActor(request)
    if (actor.userId !== deps.ownerUserId || !z.uuid().safeParse(request.params.taskId).success)
      throw missing()
    const parsed = Registration.safeParse(request.body)
    if (!parsed.success)
      throw new ApiError(400, 'VALIDATION_FAILED', 'invalid managed draft source registration')
    const { expiresAt, modelBindingDigest, ...input } = parsed.data
    const data = await registerManagedDraftSource(
      deps.database,
      actor.userId,
      {
        ...input,
        taskId: request.params.taskId,
        idempotencyKey: readIdempotencyKey(request),
        expiresAt: new Date(expiresAt),
        confirmedModelBindingDigest: modelBindingDigest,
      },
      deps.modelRoute,
      new Date(),
    )
    audit(request, 'managed_draft_source.register', 'success', actor.userId)
    return reply.code(201).send({ ok: true, data })
  })
  app.delete<{ Params: { taskId: string; sourceId: string } }>(
    `${base}/:sourceId`,
    async (request, reply) => {
      reply.header('cache-control', 'private, no-store')
      const actor = await deps.requireActor(request)
      const { taskId, sourceId } = request.params
      if (!z.uuid().safeParse(sourceId).success || !z.uuid().safeParse(taskId).success)
        throw missing()
      await revokeManagedDraftSource(deps.database, actor.userId, sourceId, new Date(), taskId)
      audit(request, 'managed_draft_source.revoke', 'success', actor.userId)
      return reply.code(204).send()
    },
  )
}
