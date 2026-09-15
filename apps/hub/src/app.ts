import fastify from 'fastify'
import type { FastifyInstance, FastifyReply, FastifyRequest, FastifyServerOptions } from 'fastify'
import cookie from '@fastify/cookie'
import fastifyWebsocket from '@fastify/websocket'
import { ZodError } from 'zod'
import { DomainError, asUserId } from '@whalepod/domain'
import { LastOwnerError, Outbox } from '@whalepod/db'
import type { Database } from '@whalepod/db'
import type { ApiFailure, ErrorCode } from '@whalepod/protocol'
import type { HubConfig } from './config.js'
import { DEFAULT_RATE_LIMIT, defaultPluginCatalogDir, isSecureCookieRequired } from './config.js'
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
import { loadPluginCatalog } from './modules/plugin/catalog.js'
import { registerPluginRoutes } from './modules/plugin/routes.js'
import { registerDeviceRoutes } from './modules/device/routes.js'
import { registerWorkspaceRoutes } from './modules/device/workspace-routes.js'
import { registerNodeWebsocket } from './modules/device/node-websocket.js'
import { RunOrchestrator } from './modules/run/index.js'
import { registerRunRoutes } from './modules/run/routes.js'
import { getDeviceDshDistributionVersion } from './modules/run/queries.js'
import { unwrapPgError } from '@whalepod/db'
import { registerRealtimeRoutes } from './modules/realtime/routes.js'
// P1-15：内容寻址 Artifact Store 与 HTTP 面。
import { ArtifactStore } from './modules/artifact/store.js'
import { registerArtifactRoutes } from './modules/artifact/routes.js'

// P1-16：server 组合根把 orchestrator 的内存心跳投影喂给租约 reconcile
// （「Node 在线但已不跑该 Run」的判定路径）；app 实例是唯一交接点。
declare module 'fastify' {
  interface FastifyInstance {
    runOrchestrator: RunOrchestrator
  }
}

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

/** PG 错误的 code / constraint（结构化字段，不含 SQL 与参数）。 */
function pgErrorCode(error: unknown): string | undefined {
  const pg = unwrapPgError(error)
  return typeof pg?.code === 'string' ? pg.code : undefined
}

function pgConstraintName(error: unknown): string | undefined {
  const pg = unwrapPgError(error)
  return typeof pg?.constraintName === 'string' ? pg.constraintName : undefined
}

/**
 * cause 链上**最内层**的 message：Drizzle 把 PG 错误包在外层（那句带 SQL 与参数），
 * 真正说明原因的是最里面那句（约束名 / 触发器文案）。
 */
function innermostErrorMessage(error: unknown): string {
  let message = error instanceof Error ? error.message : String(error)
  let cursor: unknown = error
  while (cursor instanceof Error) {
    const next: unknown = cursor.cause
    if (!(next instanceof Error)) break
    cursor = next
    message = next.message
  }
  return message
}

function errorHandler(error: unknown, request: FastifyRequest, reply: FastifyReply): FastifyReply {
  const requestId = String(request.id)
  if (error instanceof ApiError) {
    return failure(reply, error.statusCode, error.code, error.message, requestId, error.details)
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
  //
  // 但"message"本身也不安全（复核 #205 观察 1 实测）：数据库错误经 Drizzle 上抛时，最外层 message
  // 是 `Failed query: insert into "task_instruction_grant" (...) values ($1,$2,$3,$4, default) ...`
  // ——**含完整列名，且 string 里能搜到参数值**。所以对 PG 错误只记 code/constraint/detail 这类
  // 结构化字段，message 换成 cause 链上**最内层**那句（触发器/约束自己写的人话），
  // 原始 SQL 留在栈里、不进日志。
  const innermost = innermostErrorMessage(error)
  request.log.error(
    {
      component: 'hub.http',
      requestId,
      errorName: error instanceof Error ? error.name : 'UnknownError',
      errorMessage: innermost,
      pgCode: pgErrorCode(error),
      pgConstraint: pgConstraintName(error),
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
  const app = fastify({
    logger: deps.logger ?? false,
    // #113：反代形态由配置显式开启——request.ip 才信任 XFF 首跳（限流分桶真值）。
    trustProxy: config.trustProxy ?? false,
  })
  await app.register(cookie)
  // Node WS（P1-09）：/ws/v1/node 升级通道。
  await app.register(fastifyWebsocket)

  const rateLimit = { ...DEFAULT_RATE_LIMIT, ...deps.config.rateLimit }
  const loginLimiter = new RateLimiter(rateLimit.loginMax, rateLimit.windowMs)
  const anonymousLimiter = new RateLimiter(rateLimit.anonymousMax, rateLimit.windowMs)
  const setupTokenStore = deps.setupTokenStore ?? new SetupTokenStore(config.setupTokenPath)
  const requireActor = makeRequireActor(database)
  const secureCookie = isSecureCookieRequired(config.publicOrigin)
  // Task 取消带活跃 Run 时需在事务内入队 run.cancel；与 Run 模块共享同一 Outbox 类型。
  const outbox = new Outbox(database)
  // P1-17：curated 插件 catalog 在组合根一次性加载（坏文件 = 启动即失败，fail-closed；
  // 目录缺失 = 尚未部署 curated catalog，按空 catalog 启动）。插件端点共用同一份只读目录。
  const pluginCatalog = await loadPluginCatalog(
    config.pluginCatalogDir ?? defaultPluginCatalogDir(),
  )
  // 目录缺失 = 尚未部署 curated catalog：显式告警（安装面关闭），不静默启动
  // （空安装面常被误当作「目录配错」排查不到；不记绝对路径——红线）。
  if (pluginCatalog.dirMissing) {
    app.log.warn(
      { component: 'hub.plugin' },
      'plugin catalog directory missing; starting with empty catalog; plugin install surface closed',
    )
  }

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

  // 存活探针（P1-20 compose healthcheck 的锚点）：刻意不进 /api/v1——
  // 上面那道 CSRF 钩子只管业务面，探针必须**无前置条件**可答：无 cookie、
  // 无 Origin、Team 未初始化（空卷冷启动）也要 200。响应只陈述进程活着，
  // 不回显配置/路径/版本以外信息（红线：绝对路径不进任何对外面）。
  app.get('/healthz', async () => ({ ok: true, data: { status: 'ok' } }))

  app.setErrorHandler(errorHandler)
  app.setNotFoundHandler(notFoundHandler)

  // Node WS（P1-09）：/ws/v1/node 在 /api/v1 之外，直接挂根实例；
  // orchestrator 实例同时服务 WS 上行分发与 Run 路由组合（P1-13）。
  // Browser 实时链路先注册：拿到 RealtimeHub 注入 Node WS（live delta 投递面）。
  const realtime = registerRealtimeRoutes(app, { database, publicOrigin: config.publicOrigin })
  const orchestrator = new RunOrchestrator({
    database,
    outbox,
    // #52/ADR-0007：表外越边的 Run 级降级收敛走结构化 warn（component 分层，
    // 违例计数/告警的挂点；真人路径可观测，不做暗手）。
    warn: (message, context) => app.log.warn({ component: 'hub.run', ...context }, message),
  })
  app.decorate('runOrchestrator', orchestrator)
  registerNodeWebsocket(app, { database, orchestrator, realtime })

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
      registerTaskRoutes(api, {
        database,
        requireActor,
        outbox,
        orchestrator,
        dshDistributionVersionFor: (deviceId) =>
          getDeviceDshDistributionVersion(database.db, deviceId),
      })
      registerAgentRoutes(api, { database, requireActor })
      // P1-17：插件端点（03 §4）——catalog/安装/Pack 走 Session，descriptor 走 Device Token。
      registerPluginRoutes(api, {
        database,
        requireActor,
        catalog: pluginCatalog,
        allowLocalDevelopment: config.pluginDevMode ?? false,
      })
      registerDeviceRoutes(api, { database, requireActor, anonymousLimiter })
      registerWorkspaceRoutes(api, { database, requireActor })
      // P1-15：Artifact 面——Node 上传/manifest/受控下载 + owner 发布 + 内容下载。
      // Store 根来自配置（生产 data/artifact-store，测试注入临时目录）。
      registerArtifactRoutes(api, {
        database,
        store: new ArtifactStore({ root: config.artifactStoreDir }),
        requireActor,
      })
      // P1-13：Run HTTP 面（创建/投影/事件时间线）正式接线；dsh 版本取自
      // node.hello 回填的设备事实列（缺 = 设备不在线 → DEVICE_OFFLINE）。
      registerRunRoutes(api, {
        orchestrator,
        database,
        outbox,
        // SessionActor.userId 是裸 string；Run 命令面要领域 Actor（userId 带 brand）——
        // 与 task/routes.ts 同一转换先例。
        resolveActor: async (request) => {
          const session = await requireActor(request)
          return { userId: asUserId(session.userId), role: session.role }
        },
        dshDistributionVersionFor: (deviceId) =>
          getDeviceDshDistributionVersion(database.db, deviceId),
      })
    },
    { prefix: '/api/v1' },
  )

  return app
}
