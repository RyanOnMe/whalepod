/**
 * #106 口令强度政策（Q7 安全门首个用例族，HTTP 半边）。
 * 走真人路径：真 App + 真 DB（with-test-postgres 提供），载荷从真实路由进——
 * 政策必须在**哈希之前**生效（不给垃圾口令烧 argon2）。两条建账腿（setup /
 * invite accept）+ 一条豁免（login）各有用例；"拒绝发生在副作用之前"一律用
 * **下一步反证**（token/invite 未被烧），不信错误文案。
 */
import { randomBytes } from 'node:crypto'
import { beforeAll, afterAll, describe, expect, it } from 'vitest'
import { hashPassword } from '../src/modules/auth/password.js'
import { createTestApp, createTestDatabase, extractSessionCookie, type TestApp } from './helpers.js'

const idem = () => `idem-${randomBytes(12).toString('hex')}`

describe('口令政策：建账两腿封、登录腿豁免（#106）', () => {
  let db: Awaited<ReturnType<typeof createTestDatabase>>
  let ctx: TestApp
  let ownerCookie = ''

  beforeAll(async () => {
    db = await createTestDatabase()
    ctx = await createTestApp(db)
  })
  afterAll(async () => {
    await ctx.app.close()
    await db.close()
  })

  it('setup：11 码点 ⟹ 400 VALIDATION_FAILED', async () => {
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/setup',
      headers: { origin: ctx.origin, 'idempotency-key': idem() },
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
  })

  it('setup：同实例 12 码点 ⟹ 201（政策不吞合法路径；反证 setupToken 未被 400 烧掉）', async () => {
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/setup',
      headers: { origin: ctx.origin, 'idempotency-key': idem() },
      payload: {
        setupToken: ctx.setupToken,
        teamName: 'Ok',
        username: 'okuser',
        displayName: 'O',
        password: 'a'.repeat(12),
      },
    })
    expect(res.statusCode).toBe(201)
    ownerCookie = extractSessionCookie(res.headers['set-cookie'])
  })

  it('invite：11 码点接受 ⟹ 400 且**邀请未被消耗**、成员未建（B1 半边）', async () => {
    const create = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/invites',
      headers: { origin: ctx.origin, 'idempotency-key': idem(), cookie: ownerCookie },
      payload: { role: 'admin' }, // 评审点名的最高危角色：admin 可供给 pack、管成员
    })
    expect(create.statusCode).toBe(201)
    const { token } = create.json().data as { token: string }
    const bad = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/invites/accept',
      headers: { origin: ctx.origin, 'idempotency-key': idem() },
      payload: { token, username: 'weakbob', displayName: 'B', password: 'b'.repeat(11) },
    })
    expect(bad.statusCode).toBe(400)
    expect(bad.json().error.code).toBe('VALIDATION_FAILED')
    expect(await db.sql`select * from user_account`).toHaveLength(1) // 只有 owner
    // 反证"400 发生在烧 invite 之前"：同 token 换合规口令仍可接受
    const good = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/invites/accept',
      headers: { origin: ctx.origin, 'idempotency-key': idem() },
      payload: { token, username: 'okbob', displayName: 'B', password: 'b'.repeat(12) },
    })
    expect(good.statusCode).toBe(201)
  })

  it('login：历史弱口令**不被政策锁在门外**（DB 种 1 字符 hash 行 ⟹ 登录 200）', async () => {
    // 正形反证（评审 N2：12 字符登录 200 只证明"成功"，不证明"登录不查政策"）。
    // 建账路径已封死后弱口令进不来，模拟存量用测试基建直写库——这不是产品路径，
    // 产品语义是"政策只管进门，不管历史"。
    await db.sql`update user_account set password_hash = ${await hashPassword('a')} where username = 'okuser'`
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      headers: { origin: ctx.origin, 'idempotency-key': idem() },
      payload: { username: 'okuser', password: 'a' },
    })
    expect(res.statusCode).toBe(200)
  })
})
