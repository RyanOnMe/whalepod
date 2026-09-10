/**
 * #141：邀请 UI 的 Hub 面——成员列表、邀请详情预检、已登录成员接受邀请。
 *
 * 三条新路由都是 UI 的**可达前置**（Issue #141「怎样算修好」1/2 条）：
 * - GET /team/members：成员页要在接受成功后看到「Bob 出现在成员列表里」；
 * - GET /invites/:token：接受页在未登录时只能靠它拿到「加入哪个团队、什么角色、
 *   是否还有效」，才能先引导登录/建号；过期/已用要能给出明确文案（不显示裸错误码）；
 * - POST /invites/:token/accept：已登录成员一键加入。匿名那条腿要建账号，对已登录者
 *   不适用（同名 username 必撞 409），因此已登录路径单列。
 *
 * 「409 + error.details」是本分支新引入的**最小区分**约定（见 routes 里 GET /invites/:token
 * 的注释）：main 侧失效邀请只有一种不可枚举形态（commands.ts 的 inviteConflict =
 * 409 CONFLICT 一句话），接受页却要分别对「已过期」与「已被使用」给人话。可选的替代
 * 做法都更差：
 *   - 拆成两个错误码 → 扩张 wire ErrorCode（协议面变更，超出本 Issue）；
 *   - 按 Token 去枚举判断 → 等于把 Token 空间变成可探测面；
 *   - 直接把 expiresAt/consumedAt 塞进 200 → 提前泄漏邀请状态与时间戳。
 * 故选「既有错误码 + 两个布尔 details」：状态码语义不变（既有客户端照旧把 409 当
 * 不可用），拿到 details 的新客户端能给人话；details 不含 Token、成员身份或时间戳。
 *
 * 单 Team 部署的事实（03 §2.1 team_singleton）：任何能通过 Session 的账号都已经在
 * 团队里，所以「已登录接受」在本实例上永远是幂等的「已经在队里」分支——这条正是
 * 接受页「一键加入」按钮重复点击（多标签页/回退重开）要走的路。
 */
import { createHash, randomBytes } from 'node:crypto'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { Database } from '@whalepod/db'
import {
  apiInject,
  createTestApp,
  createTestDatabase,
  driveInviteAndAccept,
  driveSetup,
  idemKey,
  resetDatabase,
} from './helpers.js'
import type { Session, TestApp } from './helpers.js'

let database: Database
let ctx: TestApp
let owner: Session

beforeAll(async () => {
  database = await createTestDatabase()
})

beforeEach(async () => {
  await resetDatabase(database)
  ctx = await createTestApp(database)
  owner = await driveSetup(ctx)
})

afterEach(async () => {
  await ctx.close()
})

afterAll(async () => {
  await database.close()
})

/** 造一条邀请：返回明文 Token（只存在于本测试进程内，不落库、不进日志）。 */
async function createInviteToken(
  actor: Session,
  role: 'admin' | 'member' = 'member',
): Promise<{ token: string; inviteId: string }> {
  const response = await apiInject(ctx, actor, {
    method: 'POST',
    url: '/api/v1/invites',
    payload: { role },
  })
  expect(response.statusCode).toBe(201)
  return response.json().data as { token: string; inviteId: string }
}

/** 匿名 GET（接受页的真实形态：没有 Cookie，只带 Origin 与幂等键）。 */
async function anonymousGet(url: string) {
  const app = ctx.app
  return app.inject({
    method: 'GET',
    url,
    headers: { origin: ctx.origin, 'idempotency-key': idemKey() },
  })
}

describe('成员列表（GET /team/members）', () => {
  it('Owner 能看到自己；Bob 接受邀请后出现在列表里且角色为 member', async () => {
    const { session: bob } = await driveInviteAndAccept(ctx, owner, {
      username: 'bob',
      displayName: 'Bob',
      password: 'bob password',
    })

    const response = await apiInject(ctx, owner, { method: 'GET', url: '/api/v1/team/members' })
    expect(response.statusCode).toBe(200)
    // #136 的形态：data 即数组（与 /projects、/agents、/devices 一致），不包 { members }。
    const members = response.json().data as Array<{
      userId: string
      username: string
      displayName: string
      role: string
      enabled: boolean
    }>
    expect(Array.isArray(response.json().data)).toBe(true)
    expect(members.map((member) => member.username)).toEqual(['alice', 'bob'])
    expect(members[0]?.userId).toBe(owner.userId)
    expect(members[0]?.role).toBe('owner')
    expect(members[1]?.displayName).toBe('Bob')
    expect(members[1]?.role).toBe('member')
    expect(members[1]?.userId).toBe(bob.userId)
    // 字段最小集：#136 的 schema 只出 enabled（未停用判据），不含裸 disabledAt/joinedAt。
    expect(members[1]?.enabled).toBe(true)
    expect(Object.keys(members[1] ?? {}).sort()).toEqual([
      'displayName',
      'enabled',
      'role',
      'userId',
      'username',
    ])
  })

  it('匿名请求成员列表返回 401（成员名单不匿名可见）', async () => {
    const response = await anonymousGet('/api/v1/team/members')
    expect(response.statusCode).toBe(401)
    expect(response.json().error.code).toBe('AUTH_REQUIRED')
  })

  it('Member 也能看到成员名单（加入者要能看见自己进队了）', async () => {
    const { session: bob } = await driveInviteAndAccept(ctx, owner, {
      username: 'bob',
      displayName: 'Bob',
      password: 'bob password',
    })
    const response = await apiInject(ctx, bob, { method: 'GET', url: '/api/v1/team/members' })
    expect(response.statusCode).toBe(200)
    expect(response.json().data).toHaveLength(2)
  })
})

describe('邀请详情预检（GET /invites/:token）', () => {
  it('有效邀请对匿名者返回团队名、角色与有效期（接受页要先说清加入哪里）', async () => {
    const { token, inviteId } = await createInviteToken(owner, 'admin')
    const response = await anonymousGet(`/api/v1/invites/${token}`)
    expect(response.statusCode).toBe(200)
    const data = response.json().data as Record<string, unknown>
    expect(data.teamName).toBe('Acme')
    expect(data.role).toBe('admin')
    expect(data.expired).toBe(false)
    expect(data.consumed).toBe(false)
    expect(typeof data.expiresAt).toBe('string')
    // 字段最小集（InvitePreflightSchema 是 strictObject）：多一列少一列都该红，
    // 成员信息/Token 不可能随字段漂移漏出。
    expect(Object.keys(data).sort()).toEqual([
      'consumed',
      'expiresAt',
      'expired',
      'role',
      'teamName',
    ])
    // 预检不回显 Token 本身（Token 明文只有链接持有者与本次响应知道）。
    expect(response.body).not.toContain(token)
    expect(inviteId).toBeTruthy()
  })

  it('已消费邀请返回 409，且预检可区分「已用过」（接受页要能给出明确文案）', async () => {
    const { token } = await createInviteToken(owner)
    const consumed = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/invites/accept',
      headers: { origin: ctx.origin, 'idempotency-key': idemKey() },
      payload: {
        token,
        username: 'bob',
        displayName: 'Bob',
        password: 'bob password',
      },
    })
    expect(consumed.statusCode).toBe(201)

    const used = await anonymousGet(`/api/v1/invites/${token}`)
    expect(used.statusCode).toBe(409)
    expect(used.json().error.code).toBe('CONFLICT')
    expect(used.json().error.details).toEqual({ expired: false, consumed: true })
  })

  it('过期邀请返回 409，且预检可区分「已过期」', async () => {
    const token = randomBytes(32).toString('base64url')
    await database.sql`
      insert into invite (id, token_hash, role, created_by, expires_at)
      values (
        ${'01930e00-0000-7000-8000-00000000000a'},
        ${createHash('sha256').update(token).digest()},
        'member',
        ${owner.userId},
        now() - interval '1 second'
      )
    `
    const response = await anonymousGet(`/api/v1/invites/${token}`)
    expect(response.statusCode).toBe(409)
    expect(response.json().error.code).toBe('CONFLICT')
    expect(response.json().error.details).toEqual({ expired: true, consumed: false })
  })

  it('未知 Token 返回 404，响应体不回显 Token', async () => {
    const token = randomBytes(32).toString('base64url')
    const response = await anonymousGet(`/api/v1/invites/${token}`)
    expect(response.statusCode).toBe(404)
    expect(response.json().error.code).toBe('NOT_FOUND')
    expect(response.body).not.toContain(token)
  })
})

/**
 * 预检是匿名可读的，因此必须有配额——否则它就是**无成本的 Token 枚举通道**
 * （拿 200/404 二分探测 Token 空间）。配额与 setup、匿名 invite-accept 同一把
 * 匿名限流器、同一姿态（429 FORBIDDEN + 审计 rate_limited）；键带
 * `invite-preflight|` 前缀，与那两条路由各自独立计数。
 */
describe('邀请预检速率限制（GET /invites/:token）', () => {
  it('每 IP 超过配额后 429（同 setup / 匿名 invite-accept 姿态）', async () => {
    const { token } = await createInviteToken(owner)
    const limited = await createTestApp(database, { rateLimit: { anonymousMax: 2 } })
    try {
      const attempt = () =>
        limited.app.inject({
          method: 'GET',
          url: `/api/v1/invites/${token}`,
          headers: { origin: limited.origin },
        })
      expect((await attempt()).statusCode).toBe(200)
      expect((await attempt()).statusCode).toBe(200)
      const blocked = await attempt()
      expect(blocked.statusCode).toBe(429)
      expect(blocked.json().error.code).toBe('FORBIDDEN')
      const audit = limited.auditEvents.find(
        (event) => event.action === 'invite.preflight' && event.outcome === 'rate_limited',
      )
      expect(audit).toBeDefined()
    } finally {
      await limited.close()
    }
  })

  it('预检配额与匿名 invite-accept 各自独立计数（前缀不同，不共享桶）', async () => {
    const { token } = await createInviteToken(owner)
    const limited = await createTestApp(database, { rateLimit: { anonymousMax: 1 } })
    try {
      // 预检打满自己的桶。
      expect(
        (
          await limited.app.inject({
            method: 'GET',
            url: `/api/v1/invites/${token}`,
            headers: { origin: limited.origin },
          })
        ).statusCode,
      ).toBe(200)
      expect(
        (
          await limited.app.inject({
            method: 'GET',
            url: `/api/v1/invites/${token}`,
            headers: { origin: limited.origin },
          })
        ).statusCode,
      ).toBe(429)
      // 另一条匿名腿不受影响：同一个 IP、同一个限流器，但键前缀不同。
      const accept = await limited.app.inject({
        method: 'POST',
        url: '/api/v1/invites/accept',
        headers: { origin: limited.origin, 'idempotency-key': idemKey() },
        payload: {
          token: randomBytes(32).toString('base64url'),
          username: 'bob',
          displayName: 'Bob',
          password: 'bob password',
        },
      })
      expect(accept.statusCode).toBe(409)
    } finally {
      await limited.close()
    }
  })
})

describe('已登录成员接受邀请（POST /invites/:token/accept）', () => {
  it('已是本团队成员再确认加入：幂等成功（joined=false），不重复插成员行', async () => {
    // 单 Team 部署下能通过 Session 的账号必然已在队里——这就是真人路径上
    // 「点了一次又点一次 / 多标签页」要走的收束分支。
    const { session: bob } = await driveInviteAndAccept(ctx, owner, {
      username: 'bob',
      displayName: 'Bob',
      password: 'bob password',
    })
    const { token } = await createInviteToken(owner, 'member')

    const response = await apiInject(ctx, bob, {
      method: 'POST',
      url: `/api/v1/invites/${token}/accept`,
    })
    expect(response.statusCode).toBe(200)
    const data = response.json().data as Record<string, unknown>
    expect(data.teamName).toBe('Acme')
    expect(data.joined).toBe(false)
    expect(data.alreadyMember).toBe(true)
    expect(data.role).toBe('member')
    // 字段最小集（InviteAcceptResultSchema 是 strictObject）。
    expect(Object.keys(data).sort()).toEqual(['alreadyMember', 'joined', 'role', 'teamName'])

    const members = await database.sql`select * from team_member order by joined_at`
    expect(members).toHaveLength(2)
  })

  it('同一邀请重复提交（同一个人重放）：仍 200 幂等，成员行不增', async () => {
    const { session: bob } = await driveInviteAndAccept(ctx, owner, {
      username: 'bob',
      displayName: 'Bob',
      password: 'bob password',
    })
    const { token } = await createInviteToken(owner)
    const first = await apiInject(ctx, bob, {
      method: 'POST',
      url: `/api/v1/invites/${token}/accept`,
    })
    const second = await apiInject(ctx, bob, {
      method: 'POST',
      url: `/api/v1/invites/${token}/accept`,
    })
    expect(first.statusCode).toBe(200)
    expect(second.statusCode).toBe(200)
    expect(await database.sql`select * from team_member`).toHaveLength(2)
  })

  /**
   * Idempotency-Key 的真实姿态：本路由**不读键值**（无 transactCommand 回执），
   * 但重复加入没有副作用——去重由数据保证（consumeInvite 的原子 UPDATE 是唯一
   * 消费点 + team_member(team_id,user_id) 唯一）。这条用例把「同键重放」钉死：
   * 两次都 200、都 joined=false，且 command_receipt 不因此多一行（证明没走回执路径）。
   */
  it('同一 Idempotency-Key 重放：两次都 200，成员行与回执都不增', async () => {
    const { session: bob } = await driveInviteAndAccept(ctx, owner, {
      username: 'bob',
      displayName: 'Bob',
      password: 'bob password',
    })
    const { token } = await createInviteToken(owner)
    const key = idemKey()
    const first = await apiInject(ctx, bob, {
      method: 'POST',
      url: `/api/v1/invites/${token}/accept`,
      idempotencyKey: key,
    })
    const second = await apiInject(ctx, bob, {
      method: 'POST',
      url: `/api/v1/invites/${token}/accept`,
      idempotencyKey: key,
    })
    expect(first.statusCode).toBe(200)
    expect(second.statusCode).toBe(200)
    expect(first.json().data).toEqual(second.json().data)
    expect(second.json().data.joined).toBe(false)
    expect(second.json().data.alreadyMember).toBe(true)
    expect(await database.sql`select * from team_member`).toHaveLength(2)
    const receipts = await database.sql`select * from command_receipt`
    expect(receipts).toHaveLength(0)
  })

  it('已登录打开一条被**别人**用掉的邀请：409 CONFLICT，不产生成员行', async () => {
    // 自己先以一条邀请加入，再用同一条邀请（consumed_by 是自己）之外的失效链接：
    // 用一条随机 Token，属于「无效」这一类。
    const { session: bob } = await driveInviteAndAccept(ctx, owner, {
      username: 'bob',
      displayName: 'Bob',
      password: 'bob password',
    })
    const token = randomBytes(32).toString('base64url')
    const response = await apiInject(ctx, bob, {
      method: 'POST',
      url: `/api/v1/invites/${token}/accept`,
    })
    expect(response.statusCode).toBe(409)
    expect(response.json().error.code).toBe('CONFLICT')
    expect(await database.sql`select * from team_member`).toHaveLength(2)
  })

  it('匿名接受返回 401（这条腿要求 Session，不建账号）', async () => {
    const { token } = await createInviteToken(owner)
    const response = await ctx.app.inject({
      method: 'POST',
      url: `/api/v1/invites/${token}/accept`,
      headers: { origin: ctx.origin, 'idempotency-key': idemKey() },
    })
    expect(response.statusCode).toBe(401)
    expect(response.json().error.code).toBe('AUTH_REQUIRED')
  })

  it('写 invite.accept 审计事件（actor 是加入者，不记 Token）', async () => {
    const { session: bob } = await driveInviteAndAccept(ctx, owner, {
      username: 'bob',
      displayName: 'Bob',
      password: 'bob password',
    })
    const { token } = await createInviteToken(owner)
    const read = await anonymousGet(`/api/v1/invites/${token}`)
    expect(read.statusCode).toBe(200)
    await apiInject(ctx, bob, { method: 'POST', url: `/api/v1/invites/${token}/accept` })
    const audit = ctx.auditEvents.find(
      (event) => event.action === 'invite.accept' && event.actor === bob.userId,
    )
    expect(audit?.outcome).toBe('success')
    // 审计行只有 action/actor/outcome/requestId（03 §9）：Token 明文不进日志。
    expect(JSON.stringify(audit)).not.toContain(token)
  })
})
