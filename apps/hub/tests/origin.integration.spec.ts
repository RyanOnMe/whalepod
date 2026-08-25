/**
 * Origin gate 与 Idempotency-Key 线规（03 §4 末段、04 §6.1）：
 * 所有非安全方法必须带 exact Origin 与 16–128 字符 Idempotency-Key。
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { Database } from '@project311/db'
import { createTestApp, createTestDatabase, driveSetup, idemKey, resetDatabase } from './helpers.js'
import type { TestApp } from './helpers.js'

let database: Database
let ctx: TestApp

beforeAll(async () => {
  database = await createTestDatabase()
})

beforeEach(async () => {
  await resetDatabase(database)
  ctx = await createTestApp(database)
})

afterEach(async () => {
  await ctx.close()
})

afterAll(async () => {
  await database.close()
})

const loginPayload = { username: 'alice', password: 'correct horse battery staple' }

describe('Origin gate（非安全方法）', () => {
  it('缺失 Origin 的非安全请求返回 403 ORIGIN_REJECTED', async () => {
    const response = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      headers: { 'idempotency-key': idemKey() },
      payload: loginPayload,
    })
    expect(response.statusCode).toBe(403)
    expect(response.json().error.code).toBe('ORIGIN_REJECTED')
  })

  it('错误 Origin 返回 403', async () => {
    const response = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      headers: { origin: 'https://evil.example.com', 'idempotency-key': idemKey() },
      payload: loginPayload,
    })
    expect(response.statusCode).toBe(403)
    expect(response.json().error.code).toBe('ORIGIN_REJECTED')
  })

  it('Origin: null 返回 403', async () => {
    const response = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      headers: { origin: 'null', 'idempotency-key': idemKey() },
      payload: loginPayload,
    })
    expect(response.statusCode).toBe(403)
    expect(response.json().error.code).toBe('ORIGIN_REJECTED')
  })

  it('多值 Origin（逗号拼接形态）返回 403', async () => {
    const response = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      headers: {
        origin: `${ctx.origin}, https://evil.example.com`,
        'idempotency-key': idemKey(),
      },
      payload: loginPayload,
    })
    expect(response.statusCode).toBe(403)
    expect(response.json().error.code).toBe('ORIGIN_REJECTED')
  })

  it('Origin 多一个字符（端口不同）也拒绝：exact 比较', async () => {
    const response = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      headers: { origin: `${ctx.origin}9`, 'idempotency-key': idemKey() },
      payload: loginPayload,
    })
    expect(response.statusCode).toBe(403)
  })

  it('匿名 Setup 与 Invite accept 同样被 Origin gate 拦截', async () => {
    const setup = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/setup',
      headers: { 'idempotency-key': idemKey() },
      payload: {
        setupToken: ctx.setupToken,
        teamName: 'Acme',
        username: 'alice',
        displayName: 'Alice',
        password: 'correct horse battery staple',
      },
    })
    expect(setup.statusCode).toBe(403)
    expect(setup.json().error.code).toBe('ORIGIN_REJECTED')

    const accept = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/invites/accept',
      headers: { 'idempotency-key': idemKey() },
      payload: { token: 'x', username: 'bob', displayName: 'Bob', password: 'bob password' },
    })
    expect(accept.statusCode).toBe(403)
    expect(accept.json().error.code).toBe('ORIGIN_REJECTED')
  })

  it('GET 安全方法不要求 Origin', async () => {
    const response = await ctx.app.inject({ method: 'GET', url: '/api/v1/setup/status' })
    expect(response.statusCode).toBe(200)
  })

  it('DELETE 同样走 Origin gate', async () => {
    const response = await ctx.app.inject({
      method: 'DELETE',
      url: '/api/v1/auth/session',
      headers: { 'idempotency-key': idemKey() },
    })
    expect(response.statusCode).toBe(403)
    expect(response.json().error.code).toBe('ORIGIN_REJECTED')
  })
})

describe('Idempotency-Key 线规', () => {
  it('缺失 Idempotency-Key 的非安全请求返回 400 VALIDATION_FAILED', async () => {
    const response = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      headers: { origin: ctx.origin },
      payload: loginPayload,
    })
    expect(response.statusCode).toBe(400)
    expect(response.json().error.code).toBe('VALIDATION_FAILED')
  })

  it('过短（<16）与过长（>128）的 key 都被拒绝', async () => {
    const short = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      headers: { origin: ctx.origin, 'idempotency-key': 'short' },
      payload: loginPayload,
    })
    expect(short.statusCode).toBe(400)

    const long = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      headers: { origin: ctx.origin, 'idempotency-key': 'k'.repeat(129) },
      payload: loginPayload,
    })
    expect(long.statusCode).toBe(400)
  })

  it('边界 16 与 128 字符被接受（进入业务路径）', async () => {
    await driveSetup(ctx)
    const ok16 = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      headers: { origin: ctx.origin, 'idempotency-key': 'k'.repeat(16) },
      payload: loginPayload,
    })
    expect(ok16.statusCode).toBe(200)
    const ok128 = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      headers: { origin: ctx.origin, 'idempotency-key': 'k'.repeat(128) },
      payload: loginPayload,
    })
    expect(ok128.statusCode).toBe(200)
  })
})

describe('JSON 体线规', () => {
  it('畸形 JSON 返回统一 VALIDATION_FAILED envelope', async () => {
    const response = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      headers: {
        origin: ctx.origin,
        'idempotency-key': idemKey(),
        'content-type': 'application/json',
      },
      payload: '{not json',
    })
    expect(response.statusCode).toBe(400)
    const body = response.json()
    expect(body.ok).toBe(false)
    expect(body.error.code).toBe('VALIDATION_FAILED')
    expect(typeof body.error.requestId).toBe('string')
  })
})
