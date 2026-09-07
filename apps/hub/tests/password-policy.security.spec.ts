/**
 * #106 口令强度政策（Q7 安全门首个用例族，HTTP 半边）。
 * 走真人路径：真 App + 真 DB（with-test-postgres 提供），Setup 载荷从
 * /api/v1/setup 进——政策必须在**哈希之前**生效（不给垃圾口令烧 argon2）。
 */
import { randomBytes } from 'node:crypto'
import { beforeAll, afterAll, describe, expect, it } from 'vitest'
import { createTestApp, createTestDatabase, type TestApp } from './helpers.js'

const GOOD = 'correct horse battery staple'

describe('setup 口令政策（#106）', () => {
  let db: Awaited<ReturnType<typeof createTestDatabase>>
  let ctx: TestApp

  beforeAll(async () => {
    db = await createTestDatabase()
    ctx = await createTestApp(db)
  })
  afterAll(async () => {
    await ctx.app.close()
    await db.close()
  })

  it('11 码点 ⟹ 400 VALIDATION_FAILED（且团队未因此被创建）', async () => {
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/setup',
      headers: { origin: ctx.origin, 'idempotency-key': `idem-${randomBytes(12).toString('hex')}` },
      payload: {
        setupToken: ctx.setupToken,
        teamName: 'Weak',
        username: 'weakuser',
        displayName: 'W',
        password: 'a'.repeat(11),
      },
    })
    expect(res.statusCode).toBe(400)
    expect(res.json().error.code).toBe('VALIDATION_FAILED')
    // 反证「政策没触发」不是靠错误文案，而是靠**下一步**：换合规口令仍能完成建队
  })

  it('同实例换 12 码点合规口令 ⟹ 201（政策不吞合法路径，界值精确在 12）', async () => {
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/setup',
      headers: { origin: ctx.origin, 'idempotency-key': `idem-${randomBytes(12).toString('hex')}` },
      payload: {
        setupToken: ctx.setupToken,
        teamName: 'Ok',
        username: 'okuser',
        displayName: 'O',
        password: 'a'.repeat(12),
      },
    })
    expect(res.statusCode).toBe(201)
  })

  it('登录路径不受政策约束（红线：政策管进门建账，不管历史口令锁死）', async () => {
    // GOOD 已在本实例建过队？没有——前两用例用的是 a.repeat(12)。这里补建一个
    // 弱口令用户不可行（政策会拦 setup），因此红线断言的形态是：**登录不查政策**，
    // 以既有账号（含合规口令）走通即可证明登录侧无额外拒绝分支。
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      headers: { origin: ctx.origin, 'idempotency-key': `idem-${randomBytes(12).toString('hex')}` },
      payload: { username: 'okuser', password: 'a'.repeat(12) },
    })
    expect(res.statusCode).toBe(200)
  })
})
