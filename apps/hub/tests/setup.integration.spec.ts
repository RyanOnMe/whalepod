/**
 * G1-01 / G1-02：首次 Setup 与重复 Setup。
 * 安全用例：错误 Setup Token、速率限制、Cookie 属性、明文不落库。
 */
import { access } from 'node:fs/promises'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { Database } from '@project311/db'
import {
  createTestApp,
  createTestDatabase,
  driveSetup,
  extractSessionCookie,
  idemKey,
  resetDatabase,
} from './helpers.js'
import type { TestApp } from './helpers.js'

let database: Database
let ctx: TestApp

beforeAll(async () => {
  database = await createTestDatabase()
  ctx = await createTestApp(database)
})

beforeEach(async () => {
  await resetDatabase(database)
  // Setup Token 是一次性文件：成功 setup 会消费掉，每个用例重建。
  const { writeFile } = await import('node:fs/promises')
  await writeFile(ctx.setupTokenPath, ctx.setupToken, { mode: 0o600 })
})

afterAll(async () => {
  await ctx.close()
  await database.close()
})

describe('GET /api/v1/setup/status', () => {
  it('匿名返回 initialized=false，setup 后变为 true', async () => {
    const before = await ctx.app.inject({ method: 'GET', url: '/api/v1/setup/status' })
    expect(before.statusCode).toBe(200)
    expect(before.json()).toEqual({ ok: true, data: { initialized: false } })

    await driveSetup(ctx)

    const after = await ctx.app.inject({ method: 'GET', url: '/api/v1/setup/status' })
    expect(after.json()).toEqual({ ok: true, data: { initialized: true } })
  })
})

describe('POST /api/v1/setup（G1-01）', () => {
  it('创建唯一 Team、Owner 与 Session，Cookie 带安全属性', async () => {
    const response = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/setup',
      headers: { origin: ctx.origin, 'idempotency-key': idemKey() },
      payload: {
        setupToken: ctx.setupToken,
        teamName: 'Acme',
        username: 'alice',
        displayName: 'Alice',
        password: 'correct horse battery staple',
      },
    })
    expect(response.statusCode).toBe(201)
    const envelope = response.json()
    expect(envelope.ok).toBe(true)
    expect(envelope.data.teamId).toMatch(/^[0-9a-f-]{36}$/)
    expect(envelope.data.userId).toMatch(/^[0-9a-f-]{36}$/)

    const setCookie = response.headers['set-cookie']
    const cookieHeader = Array.isArray(setCookie) ? setCookie.join(';') : (setCookie ?? '')
    expect(cookieHeader).toContain('project311_session=')
    expect(cookieHeader).toContain('HttpOnly')
    expect(cookieHeader).toContain('SameSite=Lax')
    expect(cookieHeader).toContain('Path=/')

    // 三张表记录（G1-01）：team / user_account / team_member
    const teams = await database.sql`select * from team`
    const users = await database.sql`select * from user_account`
    const members = await database.sql`select * from team_member`
    expect(teams).toHaveLength(1)
    expect(users).toHaveLength(1)
    expect(members).toHaveLength(1)
    expect(teams[0]?.name).toBe('Acme')
    expect(members[0]?.role).toBe('owner')

    // Setup 事务同时创建不可变 core-empty Plugin Pack（02 Task 5 Step 3）
    const packs = await database.sql`select * from plugin_pack`
    expect(packs).toHaveLength(1)
    expect(packs[0]?.name).toBe('core-empty')
    expect(packs[0]?.installations).toEqual([])
    expect(packs[0]?.pack_digest).toMatch(/^[0-9a-f]{64}$/)

    // 密码存 Argon2id PHC；Session 只存 token hash（32 字节 SHA-256），明文不分库
    const passwordHash = users[0]?.password_hash as string
    expect(passwordHash.startsWith('$argon2id$')).toBe(true)
    expect(passwordHash).not.toContain('correct horse battery staple')
    const sessions = await database.sql`select * from auth_session`
    expect(sessions).toHaveLength(1)
    const tokenHash = sessions[0]?.token_hash as Buffer
    expect(tokenHash.byteLength).toBe(32)
    const plainToken = extractSessionCookie(setCookie).split('=')[1]
    expect(tokenHash.toString('utf8')).not.toBe(plainToken)
    expect(tokenHash.toString('base64url')).not.toBe(plainToken)
  })

  it('setup 成功后一次性 Setup Token 文件被消费', async () => {
    await driveSetup(ctx)
    await expect(access(ctx.setupTokenPath)).rejects.toThrow()
  })

  it('并发两个 setup：恰一个 201 一个 409，只有一条 team 记录', async () => {
    const make = (username: string) =>
      ctx.app.inject({
        method: 'POST',
        url: '/api/v1/setup',
        headers: { origin: ctx.origin, 'idempotency-key': idemKey() },
        payload: {
          setupToken: ctx.setupToken,
          teamName: 'Acme',
          username,
          displayName: username,
          password: 'correct horse battery staple',
        },
      })
    const [a, b] = await Promise.all([make('alice'), make('alicia')])
    const statuses = [a.statusCode, b.statusCode].sort()
    expect(statuses).toEqual([201, 409])
    const loser = a.statusCode === 409 ? a : b
    expect(loser.json().error.code).toBe('CONFLICT')
    expect(await database.sql`select * from team`).toHaveLength(1)
    expect(await database.sql`select * from user_account`).toHaveLength(1)
  })

  it('审计：setup 成功记录 actor/action/outcome/requestId', async () => {
    await driveSetup(ctx)
    const entry = ctx.auditEvents.find(
      (event) => event.action === 'setup' && event.outcome === 'success',
    )
    expect(entry).toBeDefined()
    expect(entry?.actor).toMatch(/^[0-9a-f-]{36}$/)
    expect(entry?.requestId).toBeDefined()
  })
})

describe('POST /api/v1/setup（G1-02 与拒绝路径）', () => {
  it('再次调用 /setup 返回 409 CONFLICT，不新增记录', async () => {
    await driveSetup(ctx)
    const response = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/setup',
      headers: { origin: ctx.origin, 'idempotency-key': idemKey() },
      payload: {
        setupToken: ctx.setupToken,
        teamName: 'Evil',
        username: 'mallory',
        displayName: 'Mallory',
        password: 'whatever password',
      },
    })
    expect(response.statusCode).toBe(409)
    expect(response.json().error.code).toBe('CONFLICT')
    expect(await database.sql`select * from team`).toHaveLength(1)
    expect(await database.sql`select * from user_account`).toHaveLength(1)
  })

  it('错误 Setup Token 返回 401 INVALID_CREDENTIALS，不创建任何记录', async () => {
    const response = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/setup',
      headers: { origin: ctx.origin, 'idempotency-key': idemKey() },
      payload: {
        setupToken: 'wrong-token',
        teamName: 'Acme',
        username: 'alice',
        displayName: 'Alice',
        password: 'correct horse battery staple',
      },
    })
    expect(response.statusCode).toBe(401)
    expect(response.json().error.code).toBe('INVALID_CREDENTIALS')
    expect(await database.sql`select * from team`).toHaveLength(0)
  })

  it('多余 body 字段被严格模式拒绝（400 VALIDATION_FAILED）', async () => {
    const response = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/setup',
      headers: { origin: ctx.origin, 'idempotency-key': idemKey() },
      payload: {
        setupToken: ctx.setupToken,
        teamName: 'Acme',
        username: 'alice',
        displayName: 'Alice',
        password: 'correct horse battery staple',
        isAdmin: true,
      },
    })
    expect(response.statusCode).toBe(400)
    expect(response.json().error.code).toBe('VALIDATION_FAILED')
  })

  it('非法 username 被拒绝（400）', async () => {
    const response = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/setup',
      headers: { origin: ctx.origin, 'idempotency-key': idemKey() },
      payload: {
        setupToken: ctx.setupToken,
        teamName: 'Acme',
        username: 'Alice Upper',
        displayName: 'Alice',
        password: 'correct horse battery staple',
      },
    })
    expect(response.statusCode).toBe(400)
    expect(response.json().error.code).toBe('VALIDATION_FAILED')
  })

  it('错误响应不泄露 SQL/路径，形态为统一 envelope', async () => {
    const response = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/setup',
      headers: { origin: ctx.origin, 'idempotency-key': idemKey() },
      payload: { setupToken: 'x' },
    })
    expect(response.statusCode).toBe(400)
    const body = response.json()
    expect(body.ok).toBe(false)
    expect(body.error.code).toBe('VALIDATION_FAILED')
    expect(typeof body.error.requestId).toBe('string')
    expect(JSON.stringify(body)).not.toMatch(/\/Users\/|select |insert /i)
  })
})

describe('Setup 速率限制', () => {
  it('每 IP 超过窗口配额后返回 429', async () => {
    const limited = await createTestApp(database, { rateLimit: { anonymousMax: 2 } })
    try {
      const attempt = () =>
        limited.app.inject({
          method: 'POST',
          url: '/api/v1/setup',
          headers: { origin: limited.origin, 'idempotency-key': idemKey() },
          payload: {
            setupToken: 'wrong-token',
            teamName: 'Acme',
            username: 'alice',
            displayName: 'Alice',
            password: 'correct horse battery staple',
          },
        })
      expect((await attempt()).statusCode).toBe(401)
      expect((await attempt()).statusCode).toBe(401)
      const blocked = await attempt()
      expect(blocked.statusCode).toBe(429)
      expect(blocked.json().error.code).toBe('FORBIDDEN')
      const audit = limited.auditEvents.find(
        (event) => event.action === 'setup' && event.outcome === 'rate_limited',
      )
      expect(audit).toBeDefined()
    } finally {
      await limited.close()
    }
  })
})

describe('Cookie Secure 属性', () => {
  it('public origin 为 https 时 Cookie 带 Secure', async () => {
    const secure = await createTestApp(database, { origin: 'https://hub.example.com' })
    try {
      const response = await secure.app.inject({
        method: 'POST',
        url: '/api/v1/setup',
        headers: { origin: secure.origin, 'idempotency-key': idemKey() },
        payload: {
          setupToken: secure.setupToken,
          teamName: 'Acme',
          username: 'alice',
          displayName: 'Alice',
          password: 'correct horse battery staple',
        },
      })
      expect(response.statusCode).toBe(201)
      expect(response.headers['set-cookie']).toContain('Secure')
    } finally {
      await secure.close()
    }
  })

  it('localhost origin 允许无 Secure（开发分支）', async () => {
    const response = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/setup',
      headers: { origin: ctx.origin, 'idempotency-key': idemKey() },
      payload: {
        setupToken: ctx.setupToken,
        teamName: 'Acme',
        username: 'alice',
        displayName: 'Alice',
        password: 'correct horse battery staple',
      },
    })
    expect(response.statusCode).toBe(201)
    expect(response.headers['set-cookie']).not.toContain('Secure')
  })
})
