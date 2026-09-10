import type { FastifyInstance } from 'fastify'
import { findSessionActor, findUserByUsername } from '@whalepod/db'
import type { Database } from '@whalepod/db'
import { LoginRequestSchema } from '@whalepod/protocol'
import { audit } from '../shared/audit.js'
import { ApiError } from '../shared/http-error.js'
import type { RateLimiter } from './rate-limit.js'
import { dummyPasswordHash, verifyPassword } from './password.js'
import { hashToken } from './token.js'
import { SESSION_COOKIE, issueSession, revokeCurrentSession, setSessionCookie } from './session.js'
import type { RequireActor } from './session.js'

export interface AuthRouteDeps {
  readonly database: Database
  readonly requireActor: RequireActor
  readonly loginLimiter: RateLimiter
  readonly secureCookie: boolean
}

export function registerAuthRoutes(app: FastifyInstance, deps: AuthRouteDeps): void {
  // 登录：每 IP + username 每 15 分钟 10 次（02 Task 5 Step 7）；
  // 错误统一 INVALID_CREDENTIALS，未知用户也做一次 Argon2 校验拉平耗时。
  app.post('/auth/login', async (request, reply) => {
    const body = LoginRequestSchema.parse(request.body ?? {})
    if (!deps.loginLimiter.tryAcquire(`login|${request.ip}|${body.username}`)) {
      audit(request, 'auth.login', 'rate_limited')
      throw new ApiError(429, 'FORBIDDEN', 'too many login attempts')
    }
    const user = await findUserByUsername(deps.database.db, body.username)
    const passwordHash = user?.passwordHash ?? (await dummyPasswordHash())
    const valid = await verifyPassword(passwordHash, body.password)
    if (user === undefined || !valid || user.disabledAt !== null) {
      audit(request, 'auth.login', 'denied')
      throw new ApiError(401, 'INVALID_CREDENTIALS', 'invalid username or password')
    }
    const issued = await issueSession(deps.database, user.id)
    const actor = await findSessionActor(deps.database.db, hashToken(issued.token))
    if (actor === undefined) throw new ApiError(500, 'INTERNAL_ERROR', 'session not readable')
    setSessionCookie(reply, issued, deps.secureCookie)
    audit(request, 'auth.login', 'success', user.id)
    return reply.send({
      ok: true,
      data: {
        userId: actor.userId,
        username: actor.username,
        displayName: actor.displayName,
        role: actor.role,
      },
    })
  })

  app.post('/auth/logout', async (request, reply) => {
    const actor = await deps.requireActor(request)
    await revokeCurrentSession(deps.database, actor.sessionId)
    void reply.clearCookie(SESSION_COOKIE, { path: '/' })
    audit(request, 'auth.logout', 'success', actor.userId)
    return reply.send({ ok: true, data: {} })
  })

  app.get('/auth/session', async (request) => {
    const actor = await deps.requireActor(request)
    return {
      ok: true,
      data: {
        userId: actor.userId,
        username: actor.username,
        displayName: actor.displayName,
        role: actor.role,
      },
    }
  })
}
