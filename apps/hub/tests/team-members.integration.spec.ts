/**
 * #136 成员列表 API：GET /api/v1/team/members（Session 鉴权）。
 *
 * 动线：真人创建任务时必须能选责任人（而不是手贴 UUID）。本 spec 钉 Hub 面契约：
 *  - 字段最小暴露：userId/username/displayName/role/enabled（无 passwordHash/disabledAt 裸时间戳）；
 *  - 停用成员 enabled=false（Web 选择器据此过滤，G6 停用纪律延伸）；
 *  - 与 GET /team 同级的鉴权：无 Session 401。
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { Database } from '@whalepod/db'
import {
  apiInject,
  createTestApp,
  createTestDatabase,
  driveInviteAndAccept,
  driveSetup,
  resetDatabase,
  type Session,
  type TestApp,
} from './helpers.js'

describe('#136 GET /team/members（集成 · PostgreSQL）', () => {
  let database: Database
  let ctx: TestApp
  let alice: Session
  let bob: Session

  beforeAll(async () => {
    database = await createTestDatabase()
  })

  beforeEach(async () => {
    await resetDatabase(database)
    ctx = await createTestApp(database)
    alice = await driveSetup(ctx, 'alice')
    const invited = await driveInviteAndAccept(ctx, alice, {
      username: 'bob',
      displayName: 'Bob',
      password: 'pass-WORD-42!',
    })
    bob = invited.session
  })

  afterEach(async () => {
    await ctx.close()
  })

  afterAll(async () => {
    await database.close()
  })

  it('成员可见全列表：owner+member 两条，字段最小集', async () => {
    const res = await apiInject(ctx, alice, { method: 'GET', url: '/api/v1/team/members' })
    expect(res.statusCode).toBe(200)
    const body = res.json() as {
      ok: true
      data: Array<{
        userId: string
        username: string
        displayName: string
        role: string
        enabled: boolean
      }>
    }
    // 形态契约：data 即数组（与 GET /projects、/agents、/devices 一致）
    expect(Array.isArray(body.data)).toBe(true)
    const byName = Object.fromEntries(body.data.map((m) => [m.username, m]))
    expect(Object.keys(byName).sort()).toEqual(['alice', 'bob'])
    expect(byName.alice?.role).toBe('owner')
    expect(byName.bob?.role).toBe('member')
    expect(byName.alice?.enabled).toBe(true)
    expect(byName.bob?.enabled).toBe(true)
    // 最小暴露面：任何一条都不带敏感键
    for (const m of body.data) {
      expect(Object.keys(m).sort()).toEqual(
        ['displayName', 'enabled', 'role', 'userId', 'username'].sort(),
      )
    }
  })

  it('停用成员 enabled=false（选择器过滤的数据前提）', async () => {
    const disable = await apiInject(ctx, alice, {
      method: 'POST',
      url: `/api/v1/team/members/${bob.userId}/disable`,
    })
    expect(disable.statusCode).toBe(200)

    const list = await apiInject(ctx, alice, { method: 'GET', url: '/api/v1/team/members' })
    expect(list.statusCode).toBe(200)
    const members = (list.json() as { data: Array<Record<string, unknown>> }).data
    const bobRow = members.find((m) => m.username === 'bob')
    expect(bobRow).toBeDefined()
    expect(bobRow?.enabled).toBe(false)
    // 不泄露 disabledAt 裸时间戳（最小暴露面）
    expect(Object.keys(bobRow ?? {}).sort()).toEqual(
      ['displayName', 'enabled', 'role', 'userId', 'username'].sort(),
    )
  })

  it('无 Session 401：成员列表不因未初始化泄漏', async () => {
    const res = await ctx.app.inject({
      method: 'GET',
      url: '/api/v1/team/members',
      headers: { origin: ctx.origin },
    })
    expect(res.statusCode).toBe(401)
  })
})
