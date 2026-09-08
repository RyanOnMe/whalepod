/**
 * 存活探针 `/healthz`（P1-20 交付物「healthcheck」的机检面）。
 *
 * 存在的唯一理由：compose 需要一条**不依赖数据库、不依赖会话、不依赖 Team 是否
 * 初始化**的探活路径来给容器判活（Q9 冷启动链的锚点）。因此它的契约是「减法」：
 * - 不在 `/api/v1` 前缀下 ⟹ 不吃 Origin/Idempency CSRF 钩子（03 §4 的门只管业务面）；
 * - 未初始化（空卷、没有 Team）也必须有 200 ⟹ 否则冷启动编排永远等不到 healthy；
 * - 响应是 envelope 形状（03 §4），且不携带任何敏感/绝对路径信息（红线）。
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createTestDatabase, createTestApp, resetDatabase, type TestApp } from './helpers.js'

describe('#24 healthz 存活探针', () => {
  let database: Awaited<ReturnType<typeof createTestDatabase>>
  let testApp: TestApp

  beforeAll(async () => {
    database = await createTestDatabase()
    testApp = await createTestApp(database)
  })

  afterAll(async () => {
    await testApp.app.close()
    await database.close()
  })

  it('未初始化实例（无 cookie、无 Origin）返回 200 envelope——冷启动编排的锚点', async () => {
    await resetDatabase(database)
    const res = await testApp.app.inject({ method: 'GET', url: '/healthz' })
    expect(res.statusCode).toBe(200)
    const body = res.json() as { ok: boolean; data?: { status?: string } }
    expect(body.ok).toBe(true)
    expect(body.data?.status).toBe('ok')
  })

  it('带陌生 Origin 也 200：探针不吃 CSRF 钩子（它不在 /api/v1 下）', async () => {
    const res = await testApp.app.inject({
      method: 'GET',
      url: '/healthz',
      headers: { origin: 'http://evil.example' },
    })
    expect(res.statusCode).toBe(200)
  })

  it('同位置反证：/api/v1 下的 GET 仍受钩子管辖（陌生 Origin ⟹ 拒绝），两表面不得混同', async () => {
    const guarded = await testApp.app.inject({
      method: 'GET',
      url: '/api/v1/workspaces',
      headers: { origin: 'http://evil.example' },
    })
    expect(guarded.statusCode).not.toBe(200)
  })

  it('响应不回显任何绝对路径（探针字段将来加多也不给红线开口子）', async () => {
    const res = await testApp.app.inject({ method: 'GET', url: '/healthz' })
    // 锁的是文本形态而非 JSON 结构：`/home/...`、`/Users/...`、`C:\...` 一律不许出现。
    expect(res.body).not.toMatch(/\/(home|Users|private|var|etc)\//)
    expect(res.body).not.toMatch(/^[A-Za-z]:\\/)
  })
})
