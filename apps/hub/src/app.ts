import fastify from 'fastify'
import type { FastifyInstance, FastifyReply, FastifyRequest, FastifyServerOptions } from 'fastify'
import cookie from '@fastify/cookie'
import { ZodError } from 'zod'
import { DomainError } from '@project311/domain'
import { LastOwnerError, Outbox } from '@project311/db'
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
import { registerProjectRoutes } from './modules/project/routes.js'
import { registerTaskRoutes } from './modules/task/routes.js'
import { registerAgentRoutes } from './modules/agent/routes.js'
import { registerDeviceRoutes } from './modules/device/routes.js'

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
  // Task 取消带活跃 Run 时需在事务内入队 run.cancel；与 Run 模块共享同一 Outbox 类型。
  const outbox = new Outbox(database)

  // 03 §4 末段：所有 /api/v1 非安全方法先过 Origin 与 Idempotency-Key，
  // 再进业务 handler；挂在根实例上，未知路径的 404 也先被这两道门拦截。
  // 例外（同段明文）：Node 匿名路由不以 Browser Origin 作身份证明
  // （pairing-claims 换 Token；/node/** 为 P1-12 预留）——Idempotency-Key 仍强制。
  app.addHook('onRequest', async (request) => {
    const path = request.url.split('?')[0] ?? request.url
    if (!path.startsWith('/api/v1')) return
    const nodeRoute =
      path.startsWith('/api/v1/devices/pairing-claims') || path.startsWith('/api/v1/node/')
    if (!nodeRoute) assertSameOrigin(request, config.publicOrigin)
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
      registerProjectRoutes(api, { database, requireActor })
      registerTaskRoutes(api, { database, requireActor, outbox })
      registerAgentRoutes(api, { database, requireActor })
      registerDeviceRoutes(api, { database, requireActor })
    },
    { prefix: '/api/v1' },
  )

  return app
}
