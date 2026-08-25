import fastify from 'fastify'
import type { FastifyInstance, FastifyReply, FastifyRequest, FastifyServerOptions } from 'fastify'
import cookie from '@fastify/cookie'
import { ZodError } from 'zod'
import { DomainError } from '@project311/domain'
import { LastOwnerError } from '@project311/db'
import type { Database } from '@project311/db'
import type { ApiFailure, ErrorCode } from '@project311/protocol'
import type { HubConfig } from './config.js'
import { DEFAULT_RATE_LIMIT, isSecureCookieRequired } from './config.js'
import { ApiError } from './modules/shared/http-error.js'
import { assertSameOrigin } from './modules/auth/origin.js'
import { assertIdempotencyKey } from './modules/auth/idempotency.js'
import { RateLimiter } from './modules/auth/rate-limit.js'
import { makeRequireActor } from './modules/auth/session.js'
import { registerAuthRoutes } from './modules/auth/routes.js'
import { registerTeamRoutes } from './modules/team/routes.js'
import { registerInviteRoutes } from './modules/team/invite-routes.js'
import { SetupTokenStore } from './modules/team/setup-token.js'

export interface HubDeps {
  readonly config: HubConfig
  readonly database: Database
  readonly logger?: FastifyServerOptions['logger']
  readonly setupTokenStore?: SetupTokenStore
}

/** 统一失败 envelope（03 §4）：错误响应不含 SQL、绝对路径或堆栈（03 §10）。 */
function failure(
  reply: FastifyReply,
  statusCode: number,
  code: ErrorCode,
  message: string,
  requestId: string,
  details?: unknown,
): FastifyReply {
  const body: ApiFailure = {
    ok: false,
    error: {
      code,
      message,
      requestId,
      ...(details !== undefined ? { details: details as ApiFailure['error']['details'] } : {}),
    },
  }
  return reply.code(statusCode).send(body)
}

function errorHandler(error: unknown, request: FastifyRequest, reply: FastifyReply): FastifyReply {
  const requestId = String(request.id)
  if (error instanceof ApiError) {
    return failure(reply, error.statusCode, error.code, error.message, requestId)
  }
  if (error instanceof ZodError) {
    return failure(reply, 400, 'VALIDATION_FAILED', 'request validation failed', requestId, {
      issues: error.issues.map((issue) => ({
        path: issue.path.join('.'),
        code: issue.code,
        message: issue.message,
      })),
    })
  }
  // 最后 Owner 保护（G1-06）：db 事务策略抛出，wire 上映射 409（03 §10 无专用码）。
  if (error instanceof LastOwnerError) {
    return failure(reply, 409, 'CONFLICT', error.message, requestId)
  }
  if (error instanceof DomainError) {
    return failure(reply, 409, error.code, error.message, requestId)
  }
  // Fastify 框架错误（畸形 JSON、body 过大、Unsupported Media Type 等）统一 400 形态。
  const statusCode = (error as { statusCode?: unknown }).statusCode
  if (typeof statusCode === 'number' && statusCode >= 400 && statusCode < 500) {
    return failure(reply, statusCode, 'VALIDATION_FAILED', 'malformed request', requestId)
  }
  // 500 只记 name/message，不记 stack（绝对路径不进日志的红线）。
  request.log.error(
    {
      component: 'hub.http',
      requestId,
      errorName: error instanceof Error ? error.name : 'UnknownError',
      errorMessage: error instanceof Error ? error.message : String(error),
    },
    'unhandled error',
  )
  return failure(reply, 500, 'INTERNAL_ERROR', 'internal error', requestId)
}

/** 未知路由与「无权对象」共用同一 404 形态（04 §6.1：不能枚举对象）。 */
function notFoundHandler(request: FastifyRequest, reply: FastifyReply): FastifyReply {
  return failure(reply, 404, 'NOT_FOUND', 'not found', String(request.id))
}

/**
 * 可组合的 Fastify app（02 Task 5 Interfaces）：生产与测试共用 buildApp。
 * 测试用 app.inject 走真人同一条 HTTP 路径。
 */
export async function buildApp(deps: HubDeps): Promise<FastifyInstance> {
  const { config, database } = deps
  const app = fastify({ logger: deps.logger ?? false })
  await app.register(cookie)

  const rateLimit = { ...DEFAULT_RATE_LIMIT, ...deps.config.rateLimit }
  const loginLimiter = new RateLimiter(rateLimit.loginMax, rateLimit.windowMs)
  const anonymousLimiter = new RateLimiter(rateLimit.anonymousMax, rateLimit.windowMs)
  const setupTokenStore = deps.setupTokenStore ?? new SetupTokenStore(config.setupTokenPath)
  const requireActor = makeRequireActor(database)
  const secureCookie = isSecureCookieRequired(config.publicOrigin)

  // 03 §4 末段：所有 /api/v1 非安全方法先过 Origin 与 Idempotency-Key，
  // 再进业务 handler；挂在根实例上，未知路径的 404 也先被这两道门拦截。
  app.addHook('onRequest', async (request) => {
    if (!request.url.startsWith('/api/v1')) return
    assertSameOrigin(request, config.publicOrigin)
    assertIdempotencyKey(request)
  })

  app.setErrorHandler(errorHandler)
  app.setNotFoundHandler(notFoundHandler)

  await app.register(
    async (api) => {
      registerAuthRoutes(api, { database, requireActor, loginLimiter, secureCookie })
      registerTeamRoutes(api, {
        database,
        requireActor,
        setupTokenStore,
        anonymousLimiter,
        secureCookie,
      })
      registerInviteRoutes(api, { database, requireActor, anonymousLimiter, secureCookie })
    },
    { prefix: '/api/v1' },
  )

  return app
}
