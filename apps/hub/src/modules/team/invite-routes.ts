import type { FastifyInstance } from 'fastify'
import { asUserId, authorize, isPasswordAcceptable } from '@whalepod/domain'
import type { Actor } from '@whalepod/domain'
import { getTeam } from '@whalepod/db'
import type { Database } from '@whalepod/db'
import {
  AcceptInviteRequestSchema,
  CreateInviteRequestSchema,
  InviteAcceptResultSchema,
  InvitePreflightSchema,
} from '@whalepod/protocol'
import { audit } from '../shared/audit.js'
import { ApiError } from '../shared/http-error.js'
import { hashPassword } from '../auth/password.js'
import { setSessionCookie } from '../auth/session.js'
import type { RequireActor, SessionActor } from '../auth/session.js'
import type { RateLimiter } from '../auth/rate-limit.js'
import { acceptInvite, acceptInviteAsMember, createInvite, readInvite } from './commands.js'

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

  /**
   * GET /invites/:token：接受页预检（#141），匿名可读——被邀请人通常还没有账号。
   * 只回「加入哪个团队、什么角色、还有没有效」，不回任何成员信息。
   * 未知 Token 404；已用/已过期 409 且 details 里给出区分（UI 才能给明确文案，
   * 而不是把裸错误码丢给用户）。Token 本身不回显。
   *
   * 匿名可读就必须限流（与 POST /setup、匿名 POST /invites/accept 同姿态）：
   * 否则预检是**无成本的 Token 枚举通道**——拿它可以把 Token 空间当在线 oracle 打
   * （200 与 404 二分）。每 IP 每窗口 20 次，超限 429（同码同文案形态）。
   */
  app.get('/invites/:token', async (request) => {
    if (!deps.anonymousLimiter.tryAcquire(`invite-preflight|${request.ip}`)) {
      audit(request, 'invite.preflight', 'rate_limited')
      throw new ApiError(429, 'FORBIDDEN', 'too many invite preflight attempts')
    }
    const { token } = request.params as { token: string }
    const invite = await readInvite(deps.database, { token })
    if (invite === undefined) throw new ApiError(404, 'NOT_FOUND', 'invite not found')
    if (!invite.valid) {
      // 409 + details 是本分支新引入的约定：#141 接受页要对「已过期」与「已被使用」
      // 给人话，而**不能**靠枚举 Token 去区分。复用既有 CONFLICT（与 commands.ts 的
      // inviteConflict 同码同文案，错误码零扩张），只在 details 补两个布尔——
      // 最小可区分信息，不含 Token、成员身份或时间戳细节。
      throw new ApiError(409, 'CONFLICT', 'invite token is invalid, expired or already consumed', {
        expired: invite.expired,
        consumed: invite.consumed,
      })
    }
    const team = await getTeam(deps.database.db)
    if (team === undefined) throw new ApiError(404, 'NOT_FOUND', 'team not found')
    // 出网前过 schema（#136 起的新惯例）：字段最小集由 protocol 钉死，
    // 多一列少一列都是红——成员信息泄漏在结构上不可能发生。
    return {
      ok: true,
      data: InvitePreflightSchema.parse({
        role: invite.role,
        expiresAt: invite.expiresAt.toISOString(),
        teamName: team.name,
        expired: false,
        consumed: false,
      }),
    }
  })

  /**
   * POST /invites/:token/accept：**已登录**成员一键加入（#141 接受页）。
   * 匿名那条腿走 POST /invites/accept（要建账号），这条腿不建账号、不换 Session。
   * Token 从 path 取（链接形态），body 语义上没有需要消费者填的字段。
   *
   * 速率限制不加：本路由要求有效 Session（匿名在这里先 401），且消费是原子的。
   * Idempotency-Key：组合根的 onRequest 钩子仍强制该头（缺头/不合规 400，在进本
   * handler 之前就被拒），但本路由**不读键值**——重复加入的去重不靠 command_receipt，
   * 而由数据保证：consumeInvite 的原子 UPDATE 是唯一消费点，重放走「本人已消费」
   * 分支返回 joined=false（commands.ts 的 acceptInviteAsMember），无重复成员行。
   */
  app.post('/invites/:token/accept', async (request, reply) => {
    const actor = await deps.requireActor(request)
    const { token } = request.params as { token: string }
    const result = await acceptInviteAsMember(deps.database, { token, userId: actor.userId })
    audit(request, 'invite.accept', 'success', actor.userId)
    return reply.send({
      ok: true,
      data: InviteAcceptResultSchema.parse({
        role: result.role,
        teamName: result.teamName,
        joined: result.joined,
        alreadyMember: result.alreadyMember,
      }),
    })
  })
}
