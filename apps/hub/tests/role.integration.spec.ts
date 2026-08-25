/**
 * G1-06：最后 Owner 保护；成员停用主链；越权与 404 形态一致（04 §6.1）。
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { Database } from '@project311/db'
import {
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

function disableRequest(target: string, cookie?: string) {
  return ctx.app.inject({
    method: 'POST',
    url: `/api/v1/team/members/${target}/disable`,
    headers: {
      origin: ctx.origin,
      'idempotency-key': idemKey(),
      ...(cookie !== undefined ? { cookie } : {}),
    },
  })
}

describe('成员停用主链', () => {
  it('Owner 停用 Member：disabled_at 写入、全部 Session 撤销、可审计', async () => {
    const { session: bob } = await driveInviteAndAccept(ctx, owner, {
      username: 'bob',
      displayName: 'Bob',
      password: 'bob password',
    })
    const response = await disableRequest(bob.userId, owner.cookie)
    expect(response.statusCode).toBe(200)

    const users = await database.sql`select disabled_at from user_account where id = ${bob.userId}`
    expect(users[0]?.disabled_at).not.toBeNull()
    const sessions =
      await database.sql`select * from auth_session where user_id = ${bob.userId} and revoked_at is null`
    expect(sessions).toHaveLength(0)

    const audit = ctx.auditEvents.find(
      (event) => event.action === 'member.disable' && event.outcome === 'success',
    )
    expect(audit?.actor).toBe(owner.userId)
  })

  it('停用不存在的用户返回 404，与未知路由 404 形态一致', async () => {
    const missing = await disableRequest('01930e00-0000-7000-8000-000000000099', owner.cookie)
    expect(missing.statusCode).toBe(404)
    expect(missing.json().error.code).toBe('NOT_FOUND')

    const unknownRoute = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/team/members',
      headers: { origin: ctx.origin, 'idempotency-key': idemKey(), cookie: owner.cookie },
    })
    expect(unknownRoute.statusCode).toBe(404)
    expect(unknownRoute.json().error.code).toBe('NOT_FOUND')
    const shapeOf = (body: { error: Record<string, unknown> }) => Object.keys(body.error).sort()
    expect(shapeOf(missing.json())).toEqual(shapeOf(unknownRoute.json()))
  })

  it('Member 不能停用他人（403 + 审计）', async () => {
    const { session: bob } = await driveInviteAndAccept(ctx, owner, {
      username: 'bob',
      displayName: 'Bob',
      password: 'bob password',
    })
    const response = await disableRequest(owner.userId, bob.cookie)
    expect(response.statusCode).toBe(403)
    expect(response.json().error.code).toBe('FORBIDDEN')
    const audit = ctx.auditEvents.find(
      (event) => event.action === 'member.disable' && event.outcome === 'denied',
    )
    expect(audit?.actor).toBe(bob.userId)
    const users =
      await database.sql`select disabled_at from user_account where id = ${owner.userId}`
    expect(users[0]?.disabled_at).toBeNull()
  })

  it('匿名调用 401', async () => {
    const response = await disableRequest(owner.userId)
    expect(response.statusCode).toBe(401)
    expect(response.json().error.code).toBe('AUTH_REQUIRED')
  })
})

describe('最后 Owner 保护（G1-06）', () => {
  it('停用最后一个 Owner 返回 409，Owner 保留', async () => {
    const response = await disableRequest(owner.userId, owner.cookie)
    expect(response.statusCode).toBe(409)
    expect(response.json().error.code).toBe('CONFLICT')

    const members = await database.sql`select role from team_member where user_id = ${owner.userId}`
    expect(members[0]?.role).toBe('owner')
    const users =
      await database.sql`select disabled_at from user_account where id = ${owner.userId}`
    expect(users[0]?.disabled_at).toBeNull()
    // Owner 的 Session 不被撤销
    const sessionResponse = await ctx.app.inject({
      method: 'GET',
      url: '/api/v1/auth/session',
      headers: { cookie: owner.cookie },
    })
    expect(sessionResponse.statusCode).toBe(200)
  })

  it('存在第二个未停用 Owner 时可以停用原 Owner', async () => {
    const { session: second } = await driveInviteAndAccept(
      ctx,
      owner,
      { username: 'carol', displayName: 'Carol', password: 'carol password' },
      'admin',
    )
    // Admin 不是 Owner；把 Carol 提为 Owner 需要 db 层既有策略 setMemberRole
    await database.sql`update team_member set role = 'owner' where user_id = ${second.userId}`

    const response = await disableRequest(owner.userId, owner.cookie)
    expect(response.statusCode).toBe(200)
    const users =
      await database.sql`select disabled_at from user_account where id = ${owner.userId}`
    expect(users[0]?.disabled_at).not.toBeNull()
  })

  it('最后 Owner 停用自己时审计 outcome=denied', async () => {
    await disableRequest(owner.userId, owner.cookie)
    const audit = ctx.auditEvents.find(
      (event) => event.action === 'member.disable' && event.outcome === 'denied',
    )
    expect(audit?.actor).toBe(owner.userId)
  })
})
