import type { FastifyInstance } from 'fastify'
import { asUserId, authorize, isPasswordAcceptable } from '@whalepod/domain'
import type { Actor } from '@whalepod/domain'
import type { Database } from '@whalepod/db'
import { AcceptInviteRequestSchema, CreateInviteRequestSchema } from '@whalepod/protocol'
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
    // #106（B1，评审第二人抓出）：invite 接受是**第二条建账腿**且角色含 admin——
    // 权限等级与 Owner 弱口令同级，setup 半边封住不等于建账封住。判定与执行点
    // 同 setup 形态：domain 纯函数、哈希之前、既有错误码零扩张。
    if (!isPasswordAcceptable(body.password)) {
      throw new ApiError(400, 'VALIDATION_FAILED', 'password must be at least 12 characters')
    }
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
