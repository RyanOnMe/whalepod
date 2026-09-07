/**
 * G1-03 / G1-04 / G1-05：邀请创建、接受、重复使用拒绝、角色门。
 */
import { createHash, randomBytes } from 'node:crypto'
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

describe('邀请主链（G1-03）', () => {
  it('Owner 创建 member 邀请，Bob 接受并成为 Member，可独立登录', async () => {
    const { session: bob } = await driveInviteAndAccept(ctx, owner, {
      username: 'bob',
      displayName: 'Bob',
      password: 'bob password',
    })

    const users = await database.sql`select * from user_account order by created_at`
    expect(users).toHaveLength(2)
    const members = await database.sql`select * from team_member order by joined_at`
    expect(members).toHaveLength(2)
    expect(members[1]?.role).toBe('member')

    const invites = await database.sql`select * from invite`
    expect(invites).toHaveLength(1)
    expect(invites[0]?.consumed_by).toBe(bob.userId)
    expect(invites[0]?.consumed_at).not.toBeNull()

    // 独立 Cookie：与 Owner 会话不同，且能访问 Member 接口
    expect(bob.cookie).not.toBe(owner.cookie)
    const teamResponse = await ctx.app.inject({
      method: 'GET',
      url: '/api/v1/team',
      headers: { cookie: bob.cookie },
    })
    expect(teamResponse.statusCode).toBe(200)
    expect(teamResponse.json().data.name).toBe('Acme')

    const sessionResponse = await ctx.app.inject({
      method: 'GET',
      url: '/api/v1/auth/session',
      headers: { cookie: bob.cookie },
    })
    expect(sessionResponse.json().data.role).toBe('member')
  })

  it('邀请 Token 只以 SHA-256 落库，明文不出现在数据库', async () => {
    const { inviteToken, inviteId } = await driveInviteAndAccept(ctx, owner, {
      username: 'bob',
      displayName: 'Bob',
      password: 'bob password',
    })
    const rows = await database.sql`select token_hash from invite where id = ${inviteId}`
    const stored = rows[0]?.token_hash as Buffer
    expect(stored.byteLength).toBe(32)
    expect(stored.equals(createHash('sha256').update(inviteToken).digest())).toBe(true)
    expect(stored.toString('utf8')).not.toBe(inviteToken)
  })

  it('审计：invite.create 与 invite.accept 各记一条 success', async () => {
    await driveInviteAndAccept(ctx, owner, {
      username: 'bob',
      displayName: 'Bob',
      password: 'bob password',
    })
    expect(
      ctx.auditEvents.some(
        (event) => event.action === 'invite.create' && event.outcome === 'success',
      ),
    ).toBe(true)
    expect(
      ctx.auditEvents.some(
        (event) => event.action === 'invite.accept' && event.outcome === 'success',
      ),
    ).toBe(true)
  })
})

describe('邀请 Token 重复使用（G1-04）', () => {
  it('重复接受同一邀请返回 409，不创建第二账号', async () => {
    const { inviteToken } = await driveInviteAndAccept(ctx, owner, {
      username: 'bob',
      displayName: 'Bob',
      password: 'bob password',
    })
    const replay = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/invites/accept',
      headers: { origin: ctx.origin, 'idempotency-key': idemKey() },
      payload: {
        token: inviteToken,
        username: 'robert',
        displayName: 'Robert',
        password: 'robert password',
      },
    })
    expect(replay.statusCode).toBe(409)
    expect(replay.json().error.code).toBe('CONFLICT')
    expect(await database.sql`select * from user_account`).toHaveLength(2)
    expect(await database.sql`select * from invite`).toHaveLength(1)
  })

  it('并发接受同一邀请：恰一个 201 一个 409', async () => {
    const create = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/invites',
      headers: { origin: ctx.origin, 'idempotency-key': idemKey(), cookie: owner.cookie },
      payload: { role: 'member' },
    })
    const { token } = create.json().data as { token: string }
    const accept = (username: string) =>
      ctx.app.inject({
        method: 'POST',
        url: '/api/v1/invites/accept',
        headers: { origin: ctx.origin, 'idempotency-key': idemKey() },
        payload: { token, username, displayName: username, password: 'shared password' },
      })
    const [a, b] = await Promise.all([accept('bob'), accept('robert')])
    expect([a.statusCode, b.statusCode].sort()).toEqual([201, 409])
    expect(await database.sql`select * from user_account`).toHaveLength(2)
  })

  it('未知 Token 与已消费 Token 返回同样的 409 形态（不可枚举）', async () => {
    const { inviteToken } = await driveInviteAndAccept(ctx, owner, {
      username: 'bob',
      displayName: 'Bob',
      password: 'bob password',
    })
    const replay = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/invites/accept',
      headers: { origin: ctx.origin, 'idempotency-key': idemKey() },
      payload: {
        token: inviteToken,
        username: 'robert',
        displayName: 'Robert',
        password: 'robert password',
      },
    })
    const unknown = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/invites/accept',
      headers: { origin: ctx.origin, 'idempotency-key': idemKey() },
      payload: {
        token: randomBytes(32).toString('base64url'),
        username: 'robert',
        displayName: 'Robert',
        password: 'robert password',
      },
    })
    expect(replay.statusCode).toBe(409)
    expect(unknown.statusCode).toBe(409)
    const shapeOf = (body: { error: Record<string, unknown> }) => Object.keys(body.error).sort()
    expect(shapeOf(unknown.json())).toEqual(shapeOf(replay.json()))
    expect(unknown.json().error.code).toBe(replay.json().error.code)
  })

  it('过期邀请返回 409', async () => {
    const token = randomBytes(32).toString('base64url')
    await database.sql`
      insert into invite (id, token_hash, role, created_by, expires_at)
      values (
        ${'01930e00-0000-7000-8000-000000000002'},
        ${createHash('sha256').update(token).digest()},
        'member',
        ${owner.userId},
        now() - interval '1 second'
      )
    `
    const response = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/invites/accept',
      headers: { origin: ctx.origin, 'idempotency-key': idemKey() },
      payload: { token, username: 'bob', displayName: 'Bob', password: 'bob password' },
    })
    expect(response.statusCode).toBe(409)
    expect(response.json().error.code).toBe('CONFLICT')
    expect(await database.sql`select * from user_account`).toHaveLength(1)
  })

  it('已占用 username 返回 409，邀请不被消费', async () => {
    const create = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/invites',
      headers: { origin: ctx.origin, 'idempotency-key': idemKey(), cookie: owner.cookie },
      payload: { role: 'member' },
    })
    const { token, inviteId } = create.json().data as { token: string; inviteId: string }
    const response = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/invites/accept',
      headers: { origin: ctx.origin, 'idempotency-key': idemKey() },
      payload: { token, username: 'alice', displayName: 'Alice Clone', password: 'x'.repeat(12) }, // #106 起 8 字符会先撞政策 400，本案测的是 username 冲突
    })
    expect(response.statusCode).toBe(409)
    expect(response.json().error.code).toBe('CONFLICT')
    const invites = await database.sql`select consumed_at from invite where id = ${inviteId}`
    expect(invites[0]?.consumed_at).toBeNull()
  })
})

describe('邀请权限（G1-05）', () => {
  it('Member 创建邀请返回 403 FORBIDDEN 并写审计事件', async () => {
    const { session: bob } = await driveInviteAndAccept(ctx, owner, {
      username: 'bob',
      displayName: 'Bob',
      password: 'bob password',
    })
    const response = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/invites',
      headers: { origin: ctx.origin, 'idempotency-key': idemKey(), cookie: bob.cookie },
      payload: { role: 'member' },
    })
    expect(response.statusCode).toBe(403)
    expect(response.json().error.code).toBe('FORBIDDEN')
    const audit = ctx.auditEvents.find(
      (event) => event.action === 'invite.create' && event.outcome === 'denied',
    )
    expect(audit?.actor).toBe(bob.userId)
    expect(await database.sql`select * from invite`).toHaveLength(1)
  })

  it('Admin 可以创建邀请', async () => {
    const { session: admin } = await driveInviteAndAccept(
      ctx,
      owner,
      { username: 'carol', displayName: 'Carol', password: 'carol password' },
      'admin',
    )
    const response = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/invites',
      headers: { origin: ctx.origin, 'idempotency-key': idemKey(), cookie: admin.cookie },
      payload: { role: 'member' },
    })
    expect(response.statusCode).toBe(201)
  })

  it('不能邀请 Owner 角色（schema 枚举拒绝，400）', async () => {
    const response = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/invites',
      headers: { origin: ctx.origin, 'idempotency-key': idemKey(), cookie: owner.cookie },
      payload: { role: 'owner' },
    })
    expect(response.statusCode).toBe(400)
    expect(response.json().error.code).toBe('VALIDATION_FAILED')
  })

  it('匿名创建邀请返回 401', async () => {
    const response = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/invites',
      headers: { origin: ctx.origin, 'idempotency-key': idemKey() },
      payload: { role: 'member' },
    })
    expect(response.statusCode).toBe(401)
    expect(response.json().error.code).toBe('AUTH_REQUIRED')
  })
})

describe('邀请接受速率限制', () => {
  it('每 IP 超过配额后 429', async () => {
    const limited = await createTestApp(database, { rateLimit: { anonymousMax: 2 } })
    try {
      const attempt = () =>
        limited.app.inject({
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
      expect((await attempt()).statusCode).toBe(409)
      expect((await attempt()).statusCode).toBe(409)
      expect((await attempt()).statusCode).toBe(429)
    } finally {
      await limited.close()
    }
  })
})
