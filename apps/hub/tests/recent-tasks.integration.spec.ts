/**
 * 最近任务（#252；#243 第 5 条刀一）。真人 HTTP 路径建房/发言/建 Run，只读
 * `GET /tasks/recent` 的排序与投影。
 *
 * 判定基线：
 * - 「最近活动」= greatest(task.updated_at, 该任务最新 task_message.created_at,
 *   该任务最新 run.created_at)——**按活动排序，不按建单**：后发消息的旧任务必须
 *   排在新建任务前面，Run 活动同样算数（这两条是本 spec 的核心判据）；
 * - 投影含 projectName（侧栏条目要能区分同名任务）；上限 8 条。
 */
import { eq } from 'drizzle-orm'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { Database } from '@whalepod/db'
import { listRecentTasks, schema } from '@whalepod/db'
import {
  apiInject,
  createTestApp,
  createTestDatabase,
  driveInviteAndAccept,
  driveSetup,
  idemKey,
  resetDatabase,
  seedRunChainForUser,
  type Session,
  type TestApp,
  TEST_DSH_VERSION,
} from './helpers.js'

interface RecentItem {
  id: string
  projectId: string
  projectName: string
  title: string
  status: string
  lastActiveAt: string
}

describe('recent tasks (GET /tasks/recent, #252)', () => {
  let database: Database
  let ctx: TestApp
  let bob: Session
  let bobChain: Awaited<ReturnType<typeof seedRunChainForUser>>

  beforeAll(async () => {
    database = await createTestDatabase()
  })
  beforeEach(async () => {
    await resetDatabase(database)
  })
  afterEach(async () => {
    if (ctx !== undefined) await ctx.close()
  })
  afterAll(async () => {
    await database.close()
  })

  async function seedWorld(): Promise<void> {
    ctx = await createTestApp(database)
    const alice = await driveSetup(ctx, 'alice')
    const bobInvite = await driveInviteAndAccept(ctx, alice, {
      username: 'bob',
      displayName: 'Bob',
      password: 'correct horse battery staple',
    })
    bob = bobInvite.session
    bobChain = await seedRunChainForUser(database.db, bob.userId)
    await database.db
      .update(schema.devices)
      .set({ dshDistributionVersion: TEST_DSH_VERSION })
      .where(eq(schema.devices.id, bobChain.deviceId))
  }

  async function createProject(name: string): Promise<string> {
    const res = await apiInject(ctx, bob, {
      method: 'POST',
      url: '/api/v1/projects',
      payload: { name },
    })
    return (res.json() as { data: { id: string } }).data.id
  }

  async function createTask(projectId: string, title: string): Promise<string> {
    const res = await apiInject(ctx, bob, {
      method: 'POST',
      url: `/api/v1/projects/${projectId}/tasks`,
      payload: { title, assigneeUserId: bob.userId },
      idempotencyKey: idemKey(),
    })
    return (res.json() as { data: { id: string } }).data.id
  }

  async function recent(): Promise<RecentItem[]> {
    const res = await apiInject(ctx, bob, { method: 'GET', url: '/api/v1/tasks/recent' })
    if (res.statusCode !== 200) {
      // TEMP-DEBUG(#252)：CI 定位用——直接调仓储把完整错误链打进日志（定位后删）。
      try {
        await listRecentTasks(database.db, 8)
      } catch (repoError) {
        console.error('TEMP-DEBUG recent repo error:', repoError)
      }
      console.error('TEMP-DEBUG recent http body:', JSON.stringify(res.body))
    }
    expect(res.statusCode).toBe(200)
    return (res.json() as { data: RecentItem[] }).data
  }

  it('按活动排序：后发消息的旧任务排前；Run 活动同样算数；投影含 projectName', async () => {
    await seedWorld()
    const p1 = await createProject('proj-one')
    const p2 = await createProject('proj-two')
    // A 先建（旧），B 后建（新）——按 updatedAt B 在前。
    const taskA = await createTask(p1, '旧任务A')
    const taskB = await createTask(p2, '新任务B')
    expect((await recent()).map((t) => t.id)).toEqual([taskB, taskA])

    // A 来了一条新消息（晚于 B 的建单）→ A 跳到最前（按活动不按建单）。
    const comment = await apiInject(ctx, bob, {
      method: 'POST',
      url: `/api/v1/tasks/${taskA}/comments`,
      payload: { body: '推进一下' },
    })
    expect(comment.statusCode).toBe(201)
    expect((await recent()).map((t) => t.id)).toEqual([taskA, taskB])

    // B 上建 Run（晚于 A 的消息）→ B 回到最前（run.created_at 也是活动）。
    const accept = await apiInject(ctx, bob, {
      method: 'POST',
      url: `/api/v1/tasks/${taskB}/accept`,
    })
    expect(accept.statusCode).toBe(200)
    const run = await apiInject(ctx, bob, {
      method: 'POST',
      url: `/api/v1/tasks/${taskB}/runs`,
      payload: {
        agentId: bobChain.agentId,
        deviceId: bobChain.deviceId,
        workspaceId: bobChain.workspaceId,
        prompt: 'go',
      },
      idempotencyKey: idemKey(),
    })
    expect(run.statusCode).toBe(201)
    expect((await recent()).map((t) => t.id)).toEqual([taskB, taskA])

    // 投影：projectName 在、title 在、lastActiveAt 是 ISO 时间。
    const first = (await recent())[0]!
    expect(first.projectName).toBe('proj-two')
    expect(first.title).toBe('新任务B')
    expect(Number.isNaN(Date.parse(first.lastActiveAt))).toBe(false)
  })

  it('上限 8 条：第 9 个任务不出现，最新者排最前', async () => {
    await seedWorld()
    const project = await createProject('limit-proj')
    const ids: string[] = []
    for (let i = 1; i <= 9; i += 1) {
      ids.push(await createTask(project, `任务${i}`))
    }
    const list = await recent()
    expect(list).toHaveLength(8)
    // 顺序按活动（此处=建单时间）降序：最新的任务9在最前，最早的任务1被截掉。
    expect(list[0]?.title).toBe('任务9')
    expect(list.some((t) => t.title === '任务1')).toBe(false)
  })
})
