import type { FastifyInstance } from 'fastify'
import { asUserId, authorize } from '@project311/domain'
import type { Actor } from '@project311/domain'
import type { Database } from '@project311/db'
import { AcceptInviteRequestSchema, CreateInviteRequestSchema } from '@project311/protocol'
import { audit } from '../shared/audit.js'
import { ApiError } from '../shared/http-error.js'
import { hashPassword } from '../auth/password.js'
import { setSessionCookie } from '../auth/session.js'
import type { RequireActor, SessionActor } from '../auth/session.js'
import type { RateLimiter } from '../auth/rate-limit.js'
import { acceptInvite, createInvite } from './commands.js'

export interface InviteRouteDeps {
  readonly database: Database
  readonly requireActor: RequireActor
  readonly anonymousLimiter: RateLimiter
  readonly secureCookie: boolean
}

function toDomainActor(actor: SessionActor): Actor {
  return { userId: asUserId(actor.userId), role: actor.role }
}

export function registerInviteRoutes(app: FastifyInstance, deps: InviteRouteDeps): void {
  // POST /invites：Owner/Admin（03 §4；权限判定走 domain 单一入口 authorize）。
  app.post('/invites', async (request, reply) => {
    const actor = await deps.requireActor(request)
    if (!authorize(toDomainActor(actor), 'create_invite')) {
      audit(request, 'invite.create', 'denied', actor.userId)
      throw new ApiError(403, 'FORBIDDEN', 'only owner or admin can create invites')
    }
    const body = CreateInviteRequestSchema.parse(request.body ?? {})
    const invite = await createInvite(deps.database, { role: body.role, createdBy: actor.userId })
    audit(request, 'invite.create', 'success', actor.userId)
    return reply.code(201).send({
      ok: true,
      data: {
        inviteId: invite.inviteId,
        token: invite.token,
        role: invite.role,
        expiresAt: invite.expiresAt.toISOString(),
      },
    })
  })

  // POST /invites/accept：匿名 + 一次性 Token；每 IP 每 15 分钟 20 次。
  app.post('/invites/accept', async (request, reply) => {
    if (!deps.anonymousLimiter.tryAcquire(`invite-accept|${request.ip}`)) {
      audit(request, 'invite.accept', 'rate_limited')
      throw new ApiError(429, 'FORBIDDEN', 'too many accept attempts')
    }
    const body = AcceptInviteRequestSchema.parse(request.body ?? {})
    const passwordHash = await hashPassword(body.password)
    const result = await acceptInvite(deps.database, {
      token: body.token,
      username: body.username,
      displayName: body.displayName,
      passwordHash,
    })
    setSessionCookie(
      reply,
      { token: result.sessionToken, expiresAt: result.sessionExpiresAt },
      deps.secureCookie,
    )
    audit(request, 'invite.accept', 'success', result.userId)
    return reply.code(201).send({
      ok: true,
      data: { userId: result.userId, role: result.role },
    })
  })
}
