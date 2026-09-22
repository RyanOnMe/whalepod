/**
 * #136 成员列表 API：GET /api/v1/team/members（Session 鉴权）。
 *
 * 动线：真人创建任务时必须能选责任人（而不是手贴 UUID）。本 spec 钉 Hub 面契约：
 *  - 字段最小暴露：userId/username/displayName/role/enabled（无 passwordHash/disabledAt 裸时间戳）；
 *  - 停用成员 enabled=false（Web 选择器据此过滤，G6 停用纪律延伸）；
 *  - 与 GET /team 同级的鉴权：无 Session 401。
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { randomUUID } from 'node:crypto'
import type { Database } from '@whalepod/db'
import { insertUser, listTeamEvents } from '@whalepod/db'
import { acceptInviteAsMember } from '../src/modules/team/commands.js'
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

  it('#163 契约：新人加入必须进 Team Event 流（member.changed）——名册靠它自动刷新', async () => {
    // 断链背景与 device.changed（#142）同形：事件在协议里、Web 的 event-router 也等它，
    // 但 Hub 从未发布——「新人加入后别人自动看见」在服务端根本没有实现。
    // driveInviteAndAccept 在 beforeEach 里已经走过一次（bob），所以这里看 carol。
    await driveInviteAndAccept(ctx, alice, {
      username: 'carol',
      displayName: 'Carol',
      password: 'pass-WORD-42!',
    })
    const events = (await listTeamEvents(database.db)).filter((e) => e.type === 'member.changed')
    expect(events.length).toBeGreaterThanOrEqual(1)
    // 合并事件口径：只带 changedAt，不点名（不带 userId/role——隐私面最小化）。
    const payload = events[events.length - 1]?.payload as Record<string, unknown>
    expect(typeof payload.changedAt).toBe('string')
    expect(payload).not.toHaveProperty('userId')
    expect(payload).not.toHaveProperty('role')
  })

  it('#163 契约：成员停用同样进 Team Event 流（对方页面实时看到"已停用"）', async () => {
    const before = (await listTeamEvents(database.db)).filter((e) => e.type === 'member.changed')
    const disable = await apiInject(ctx, alice, {
      method: 'POST',
      url: `/api/v1/team/members/${bob.userId}/disable`,
    })
    expect(disable.statusCode).toBe(200)
    const after = (await listTeamEvents(database.db)).filter((e) => e.type === 'member.changed')
    expect(after.length).toBe(before.length + 1)
  })

  it('#163 契约：已登录成员走 acceptInviteAsMember 进队同样发 member.changed', async () => {
    // 第二条加入腿（评审 M4 抓到零覆盖）：单 Team 下已登录者本来就在队里，要在命令层
    // 造出 joined=true 必须先有一个"有账号、无成员行"的人——直接插 user 行（不插
    // member 行），再直调 acceptInviteAsMember（真人同一条命令路径；路由层在
    // invite-ui.integration.spec.ts 已覆盖）。这条腿发事件，重放（joined=false）不发。
    const daveId = randomUUID()
    await insertUser(database.db, {
      id: daveId,
      username: `dave-${daveId.slice(0, 6)}`,
      displayName: 'Dave',
      passwordHash: 'x',
    })
    const invite = await apiInject(ctx, alice, {
      method: 'POST',
      url: '/api/v1/invites',
      payload: { role: 'member' },
    })
    expect(invite.statusCode).toBe(201)
    const { token } = invite.json().data as { token: string }

    const before = (await listTeamEvents(database.db)).filter((e) => e.type === 'member.changed')
    const joined = await acceptInviteAsMember(database, { token, userId: daveId })
    expect(joined.joined).toBe(true)
    expect(joined.alreadyMember).toBe(false)
    const after = (await listTeamEvents(database.db)).filter((e) => e.type === 'member.changed')
    expect(after.length).toBe(before.length + 1)

    // 幂等重放（joined=false）：无状态变化，不发事件（发了是噪声）。
    const replayed = await acceptInviteAsMember(database, { token, userId: daveId })
    expect(replayed.joined).toBe(false)
    expect(replayed.alreadyMember).toBe(true)
    const afterReplay = (await listTeamEvents(database.db)).filter(
      (e) => e.type === 'member.changed',
    )
    expect(afterReplay.length).toBe(after.length)
  })
})
