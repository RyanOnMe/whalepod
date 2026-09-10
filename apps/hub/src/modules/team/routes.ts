import type { FastifyInstance, FastifyRequest } from 'fastify'
import { authorize, asUserId } from '@whalepod/domain'
import { getTeam, listTeamMembersWithUser } from '@whalepod/db'
import type { Database } from '@whalepod/db'
import { SetupRequestSchema, TeamMembersDataSchema } from '@whalepod/protocol'
import { audit } from '../shared/audit.js'
import { ApiError } from '../shared/http-error.js'
import { hashPassword } from '../auth/password.js'
import { isPasswordAcceptable } from '@whalepod/domain'
import { setSessionCookie } from '../auth/session.js'
import type { RequireActor } from '../auth/session.js'
import type { RateLimiter } from '../auth/rate-limit.js'
import {
  disableMember,
  migrateCoreEmptyPackDigest,
  MigrationLockTimeoutError,
  setupInstance,
} from './commands.js'
import type { SetupTokenStore } from './setup-token.js'

export interface TeamRouteDeps {
  readonly database: Database
  readonly requireActor: RequireActor
  readonly setupTokenStore: SetupTokenStore
  readonly anonymousLimiter: RateLimiter
  readonly secureCookie: boolean
}

/**
 * Setup Token 以 body 字段为准（protocol SetupRequestSchema 是 wire SSoT）；
 * `x-setup-token` 头作为 02 Task 5 示例形态的兼容入口，仅在 body 缺省时补入。
 */
function mergeSetupTokenHeader(request: FastifyRequest): unknown {
  const raw =
    typeof request.body === 'object' && request.body !== null
      ? { ...(request.body as Record<string, unknown>) }
      : {}
  const headerToken: string | string[] | undefined = request.headers['x-setup-token']
  if (raw['setupToken'] === undefined && typeof headerToken === 'string') {
    raw['setupToken'] = headerToken
  }
  return raw
}

export function registerTeamRoutes(app: FastifyInstance, deps: TeamRouteDeps): void {
  // GET /setup/status：匿名，只返回 initialized（03 §4）。
  app.get('/setup/status', async () => {
    const team = await getTeam(deps.database.db)
    return { ok: true, data: { initialized: team !== undefined } }
  })

  app.post('/setup', async (request, reply) => {
    // Setup 每 IP 每 15 分钟 20 次（02 Task 5 Step 7）
    if (!deps.anonymousLimiter.tryAcquire(`setup|${request.ip}`)) {
      audit(request, 'setup', 'rate_limited')
      throw new ApiError(429, 'FORBIDDEN', 'too many setup attempts')
    }
    const body = SetupRequestSchema.parse(mergeSetupTokenHeader(request))
    // #106 口令政策（Q7 首个用例族）：建账路径哈希之前判——垃圾口令不进 argon2
    // （弱网 DoS 面顺手收掉），错误形态走 VALIDATION_FAILED（政策在 domain，
    // 传输归因在这层；协议 PasswordSchema=min(1) 不动，两层各管各的）。
    if (!isPasswordAcceptable(body.password)) {
      throw new ApiError(400, 'VALIDATION_FAILED', 'password must be at least 12 characters')
    }
    // M10 断代迁移：旧 dev 库的 core-empty 行存的是旧算法 digest，先幂等修复
    // （已初始化实例重试 setup 也会经过此处），再走常规 409/建账流程。
    // 等锁超时（#55 N2）：结构化 warn 归因后 fail-fast 503，客户端可重试；
    // 不让 /setup 被病态持锁者无限排队。
    try {
      if (await migrateCoreEmptyPackDigest(deps.database)) {
        request.log.warn(
          { component: 'hub.setup', requestId: String(request.id) },
          'core-empty pack digest migrated from legacy algorithm to current digest',
        )
      }
    } catch (error) {
      if (error instanceof MigrationLockTimeoutError) {
        request.log.warn(
          {
            component: 'hub.setup',
            requestId: String(request.id),
            lockTimeoutMs: error.lockTimeoutMs,
          },
          'core-empty digest migration advisory lock wait timed out; failing fast',
        )
        throw new ApiError(503, 'INTERNAL_ERROR', 'migration lock timeout, retry later')
      }
      throw error
    }
    if ((await getTeam(deps.database.db)) !== undefined) {
      audit(request, 'setup', 'denied')
      throw new ApiError(409, 'CONFLICT', 'instance already initialized')
    }
    if (!(await deps.setupTokenStore.verify(body.setupToken))) {
      audit(request, 'setup', 'denied')
      throw new ApiError(401, 'INVALID_CREDENTIALS', 'invalid setup token')
    }
    const passwordHash = await hashPassword(body.password)
    const result = await setupInstance(deps.database, {
      teamName: body.teamName,
      username: body.username,
      displayName: body.displayName,
      passwordHash,
    })
    // 一次性 Token 用后即焚；删除失败不影响已完成的 setup（后续请求由 team 存在性挡 409）。
    try {
      await deps.setupTokenStore.consume()
    } catch {
      request.log.warn(
        { component: 'hub.setup', requestId: String(request.id) },
        'setup token consume failed; instance guard still prevents re-setup',
      )
    }
    setSessionCookie(
      reply,
      { token: result.sessionToken, expiresAt: result.sessionExpiresAt },
      deps.secureCookie,
    )
    audit(request, 'setup', 'success', result.userId)
    return reply.code(201).send({
      ok: true,
      data: { teamId: result.teamId, userId: result.userId },
    })
  })

  // GET /team：Member 可见的单 Team 基本信息（03 §4）。
  app.get('/team', async (request) => {
    await deps.requireActor(request)
    const team = await getTeam(deps.database.db)
    if (team === undefined) throw new ApiError(404, 'NOT_FOUND', 'team not found')
    return {
      ok: true,
      data: { id: team.id, name: team.name, createdAt: team.createdAt.toISOString() },
    }
  })

  // GET /team/members：成员列表（#136：任务责任人选择器的数据源）。
  // 任何已登录 Member 可见——指派动线要求创建者能列出可指的人；
  // 出网前过 TeamMembersDataSchema：字段最小集由 protocol 钉死（无密码散列、无裸时间戳）。
  app.get('/team/members', async (request) => {
    await deps.requireActor(request)
    const team = await getTeam(deps.database.db)
    if (team === undefined) throw new ApiError(404, 'NOT_FOUND', 'team not found')
    const members = await listTeamMembersWithUser(deps.database.db, team.id)
    return { ok: true, data: TeamMembersDataSchema.parse({ members }) }
  })

  // 成员停用：Owner/Admin（domain authorize: disable_member）；最后 Owner 由 db 策略保护。
  app.post('/team/members/:userId/disable', async (request, reply) => {
    const actor = await deps.requireActor(request)
    if (!authorize({ userId: asUserId(actor.userId), role: actor.role }, 'disable_member', {})) {
      audit(request, 'member.disable', 'denied', actor.userId)
      throw new ApiError(403, 'FORBIDDEN', 'only owner or admin can disable a member')
    }
    const { userId } = request.params as { userId: string }
    try {
      await disableMember(deps.database, { targetUserId: userId })
    } catch (error) {
      if (error instanceof ApiError && error.code === 'NOT_FOUND') throw error
      audit(request, 'member.disable', 'denied', actor.userId)
      throw error
    }
    audit(request, 'member.disable', 'success', actor.userId)
    return reply.send({ ok: true, data: {} })
  })
}
