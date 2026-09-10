/**
 * 登录 / 登出 / 会话解析。
 * 安全用例：统一 INVALID_CREDENTIALS、过期/撤销/停用会话 401、登录速率限制、审计。
 */
import { createHash, randomBytes } from 'node:crypto'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { Database } from '@project311/db'
import {
  createTestApp,
  createTestDatabase,
  driveInviteAndAccept,
  driveLogin,
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

describe('POST /api/v1/auth/login', () => {
  it('正确口令建立独立 Session Cookie', async () => {
    const response = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      headers: { origin: ctx.origin, 'idempotency-key': idemKey() },
      payload: { username: 'alice', password: 'correct horse battery staple' },
    })
    expect(response.statusCode).toBe(200)
    const body = response.json()
    expect(body.ok).toBe(true)
    expect(body.data.userId).toBe(owner.userId)
    expect(body.data.username).toBe('alice')
    expect(body.data.role).toBe('owner')
    const setCookie = response.headers['set-cookie'] as string
    expect(setCookie).toContain('HttpOnly')
    expect(setCookie).toContain('SameSite=Lax')
    // 独立 Cookie：与 setup 会话不是同一个 token
    const loginCookie = setCookie.split(';')[0]
    expect(loginCookie).not.toBe(owner.cookie)
    const sessions = await database.sql`select * from auth_session`
    expect(sessions).toHaveLength(2)
  })

  it('错误口令与不存在用户返回同样的 401 INVALID_CREDENTIALS', async () => {
    const wrongPassword = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      headers: { origin: ctx.origin, 'idempotency-key': idemKey() },
      payload: { username: 'alice', password: 'wrong password' },
    })
    expect(wrongPassword.statusCode).toBe(401)
    expect(wrongPassword.json().error.code).toBe('INVALID_CREDENTIALS')

    const unknownUser = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      headers: { origin: ctx.origin, 'idempotency-key': idemKey() },
      payload: { username: 'mallory', password: 'wrong password' },
    })
    expect(unknownUser.statusCode).toBe(401)
    // 形态一致（不可枚举用户是否存在）：除 requestId 外逐字段相同
    const strip = (body: { error: Record<string, unknown> }) => {
      const { requestId: _ignored, ...rest } = body.error
      return rest
    }
    expect(strip(unknownUser.json())).toEqual(strip(wrongPassword.json()))
  })

  it('登录成功与失败都写审计事件，且不记口令', async () => {
    await driveLogin(ctx, 'alice', 'correct horse battery staple')
    await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      headers: { origin: ctx.origin, 'idempotency-key': idemKey() },
      payload: { username: 'alice', password: 'wrong password' },
    })
    const success = ctx.auditEvents.find(
      (event) => event.action === 'auth.login' && event.outcome === 'success',
    )
    const denied = ctx.auditEvents.find(
      (event) => event.action === 'auth.login' && event.outcome === 'denied',
    )
    expect(success?.actor).toBe(owner.userId)
    expect(denied).toBeDefined()
    expect(JSON.stringify(ctx.auditEvents)).not.toContain('correct horse battery staple')
  })

  it('每 IP + username 超过登录配额后 429', async () => {
    const limited = await createTestApp(database, { rateLimit: { loginMax: 3 } })
    try {
      const attempt = () =>
        limited.app.inject({
          method: 'POST',
          url: '/api/v1/auth/login',
          headers: { origin: limited.origin, 'idempotency-key': idemKey() },
          payload: { username: 'alice', password: 'wrong password' },
        })
      for (let i = 0; i < 3; i += 1) {
        expect((await attempt()).statusCode).toBe(401)
      }
      const blocked = await attempt()
      expect(blocked.statusCode).toBe(429)
      expect(blocked.json().error.code).toBe('FORBIDDEN')
      // 不同 username 不受同一桶限制
      const other = await limited.app.inject({
        method: 'POST',
        url: '/api/v1/auth/login',
        headers: { origin: limited.origin, 'idempotency-key': idemKey() },
        payload: { username: 'bob', password: 'wrong password' },
      })
      expect(other.statusCode).toBe(401)
    } finally {
      await limited.close()
    }
  })

  it('#113 trustProxy 开启（反代形态）：限流按 XFF 首跳 IP 分桶——两人各有预算', async () => {
    const limited = await createTestApp(database, {
      rateLimit: { loginMax: 2 },
      trustProxy: true,
    })
    try {
      const attempt = (xff: string) =>
        limited.app.inject({
          method: 'POST',
          url: '/api/v1/auth/login',
          headers: {
            origin: limited.origin,
            'idempotency-key': idemKey(),
            'x-forwarded-for': xff,
          },
          payload: { username: 'alice', password: 'wrong password' },
        })
      // 同一 username：IP-A 打满预算 → 第 3 次 429；IP-B 不受影响（不共享）。
      expect((await attempt('10.0.0.1')).statusCode).toBe(401)
      expect((await attempt('10.0.0.1')).statusCode).toBe(401)
      expect((await attempt('10.0.0.1')).statusCode).toBe(429)
      expect((await attempt('10.0.0.2')).statusCode).toBe(401)
    } finally {
      await limited.close()
    }
  })

  it('#113 trustProxy 关闭（直连形态默认）：伪造 XFF 不生效——仍按对端 IP 计同一桶', async () => {
    const limited = await createTestApp(database, { rateLimit: { loginMax: 2 } })
    try {
      const attempt = (xff: string) =>
        limited.app.inject({
          method: 'POST',
          url: '/api/v1/auth/login',
          headers: {
            origin: limited.origin,
            'idempotency-key': idemKey(),
            'x-forwarded-for': xff,
          },
          payload: { username: 'alice', password: 'wrong password' },
        })
      // 每次伪造不同 XFF：直连形态全部忽略 → 同一桶，第 3 次即 429。
      expect((await attempt('10.0.0.1')).statusCode).toBe(401)
      expect((await attempt('10.0.0.2')).statusCode).toBe(401)
      expect((await attempt('10.0.0.3')).statusCode).toBe(429)
    } finally {
      await limited.close()
    }
  })
})

describe('GET /api/v1/auth/session', () => {
  it('返回当前 Member', async () => {
    const response = await ctx.app.inject({
      method: 'GET',
      url: '/api/v1/auth/session',
      headers: { cookie: owner.cookie },
    })
    expect(response.statusCode).toBe(200)
    expect(response.json()).toEqual({
      ok: true,
      data: { userId: owner.userId, username: 'alice', displayName: 'Alice', role: 'owner' },
    })
  })

  it('无 Cookie / 伪造 Cookie 一律 401 AUTH_REQUIRED', async () => {
    const missing = await ctx.app.inject({ method: 'GET', url: '/api/v1/auth/session' })
    expect(missing.statusCode).toBe(401)
    expect(missing.json().error.code).toBe('AUTH_REQUIRED')

    const forged = await ctx.app.inject({
      method: 'GET',
      url: '/api/v1/auth/session',
      headers: { cookie: `project311_session=${randomBytes(32).toString('base64url')}` },
    })
    expect(forged.statusCode).toBe(401)
    expect(forged.json().error.code).toBe('AUTH_REQUIRED')
  })

  it('过期 Session 返回 401 SESSION_EXPIRED', async () => {
    // 直接落一条已过期会话（token 明文只在测试内，不落库）
    const token = randomBytes(32).toString('base64url')
    await database.sql`
      insert into auth_session (id, user_id, token_hash, expires_at)
      values (
        ${'01930e00-0000-7000-8000-000000000001'},
        ${owner.userId},
        ${createHash('sha256').update(token).digest()},
        now() - interval '1 second'
      )
    `
    const response = await ctx.app.inject({
      method: 'GET',
      url: '/api/v1/auth/session',
      headers: { cookie: `project311_session=${token}` },
    })
    expect(response.statusCode).toBe(401)
    expect(response.json().error.code).toBe('SESSION_EXPIRED')
  })
})

describe('POST /api/v1/auth/logout', () => {
  it('撤销当前 Session，旧 Cookie 立即失效', async () => {
    const session = await driveLogin(ctx, 'alice', 'correct horse battery staple')
    const logout = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/auth/logout',
      headers: { origin: ctx.origin, 'idempotency-key': idemKey(), cookie: session.cookie },
    })
    expect(logout.statusCode).toBe(200)

    const after = await ctx.app.inject({
      method: 'GET',
      url: '/api/v1/auth/session',
      headers: { cookie: session.cookie },
    })
    expect(after.statusCode).toBe(401)
    const rows = await database.sql`select * from auth_session where revoked_at is not null`
    expect(rows).toHaveLength(1)
  })

  it('未认证调用 401', async () => {
    const response = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/auth/logout',
      headers: { origin: ctx.origin, 'idempotency-key': idemKey() },
    })
    expect(response.statusCode).toBe(401)
    expect(response.json().error.code).toBe('AUTH_REQUIRED')
  })
})

describe('被停用成员（04 §6.1）', () => {
  it('被停用用户的旧 Cookie 返回 401，且不能再登录', async () => {
    const bob = await driveInviteAndAccept(ctx, owner, {
      username: 'bob',
      displayName: 'Bob',
      password: 'bob password',
    })
    // Owner 停用 Bob
    const disable = await ctx.app.inject({
      method: 'POST',
      url: `/api/v1/team/members/${bob.session.userId}/disable`,
      headers: { origin: ctx.origin, 'idempotency-key': idemKey(), cookie: owner.cookie },
    })
    expect(disable.statusCode).toBe(200)

    const stale = await ctx.app.inject({
      method: 'GET',
      url: '/api/v1/auth/session',
      headers: { cookie: bob.session.cookie },
    })
    expect(stale.statusCode).toBe(401)

    const login = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      headers: { origin: ctx.origin, 'idempotency-key': idemKey() },
      payload: { username: 'bob', password: 'bob password' },
    })
    expect(login.statusCode).toBe(401)
    expect(login.json().error.code).toBe('INVALID_CREDENTIALS')
  })
})
