/**
 * #137 项目任务列表 API：GET /api/v1/projects/:projectId/tasks（Session 鉴权）。
 *
 * 动线：Task 创建后进入 Task Room，一旦返回项目页/换设备，真人**没有任何界面路径**
 * 能再列出并打开该项目的任务（Task Room URL 里的 UUID 没人记得住）。本 spec 钉
 * Hub 面契约：
 *  - 只返回该项目自己的任务（跨项目隔离，不能靠前端过滤来「假装」）；
 *  - 空项目返回空数组而非 404（404 只留给「项目不存在」）；
 *  - 排序稳定：updatedAt DESC + id tiebreak（列表可预期，UI 不抖动）；
 *  - 字段与 TaskView 同形（复用 toTaskView，不另造一套投影）；
 *  - 无 Session 401。
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { Database } from '@whalepod/db'
import {
  apiInject,
  createTestApp,
  createTestDatabase,
  driveSetup,
  resetDatabase,
  type Session,
  type TestApp,
} from './helpers.js'

describe('#137 GET /projects/:projectId/tasks（集成 · PostgreSQL）', () => {
  let database: Database
  let ctx: TestApp
  let alice: Session
  let projectA: string
  let projectB: string

  const createProject = async (name: string): Promise<string> => {
    const res = await apiInject(ctx, alice, {
      method: 'POST',
      url: '/api/v1/projects',
      payload: { name },
    })
    expect(res.statusCode).toBe(201)
    return (res.json() as { data: { id: string } }).data.id
  }

  const createTask = async (projectId: string, title: string): Promise<string> => {
    const res = await apiInject(ctx, alice, {
      method: 'POST',
      url: `/api/v1/projects/${projectId}/tasks`,
      payload: { title, assigneeUserId: alice.userId },
    })
    expect(res.statusCode).toBe(201)
    return (res.json() as { data: { id: string } }).data.id
  }

  beforeAll(async () => {
    database = await createTestDatabase()
  })

  beforeEach(async () => {
    await resetDatabase(database)
    ctx = await createTestApp(database)
    alice = await driveSetup(ctx, 'alice')
    projectA = await createProject('潮汐观测站')
    projectB = await createProject('无关项目')
  })

  afterEach(async () => {
    await ctx.close()
  })

  afterAll(async () => {
    await database.close()
  })

  it('只返回本项目任务：跨项目隔离由 Hub 保证，不靠前端过滤', async () => {
    const a1 = await createTask(projectA, '起草验收报告')
    await createTask(projectB, '别的项目的任务')
    const a2 = await createTask(projectA, '补 API 使用示例')

    const res = await apiInject(ctx, alice, {
      method: 'GET',
      url: `/api/v1/projects/${projectA}/tasks`,
    })
    expect(res.statusCode).toBe(200)
    const body = res.json() as { data: Array<Record<string, unknown>> }
    // 形态契约：data 即数组（与 GET /projects、/agents、/devices 一致，不额外包一层）
    expect(Array.isArray(body.data)).toBe(true)
    const tasks = body.data
    expect(tasks.map((t) => t.id).sort()).toEqual([a1, a2].sort())
    expect(tasks.every((t) => t.projectId === projectA)).toBe(true)
    // 与 TaskView 同形：字段集合恰好一致（多一列少一列皆红）
    expect(Object.keys(tasks[0] ?? {}).sort()).toEqual(
      [
        'acceptedAt',
        'assignmentStatus',
        'assigneeUserId',
        'completedAt',
        'createdAt',
        'createdBy',
        'description',
        'id',
        'projectId',
        'status',
        'title',
        'updatedAt',
      ].sort(),
    )
  })

  it('排序稳定：updatedAt DESC（最近活动的在最前），id 作 tiebreak', async () => {
    const first = await createTask(projectA, '先建的')
    const second = await createTask(projectA, '后建的')
    // 显式推进第二条第 updatedAt（改标题走 PATCH /tasks/:taskId），保证顺序可判
    const patch = await apiInject(ctx, alice, {
      method: 'PATCH',
      url: `/api/v1/tasks/${second}`,
      payload: { title: '后建的（刚改过）' },
    })
    expect(patch.statusCode).toBe(200)

    const res = await apiInject(ctx, alice, {
      method: 'GET',
      url: `/api/v1/projects/${projectA}/tasks`,
    })
    const tasks = (res.json() as { data: Array<{ id: string; title: string }> }).data
    expect(tasks.map((t) => t.id)).toEqual([second, first])
    expect(tasks[0]?.title).toBe('后建的（刚改过）')
  })

  it('空项目返回空数组（404 只留给项目不存在）', async () => {
    const res = await apiInject(ctx, alice, {
      method: 'GET',
      url: `/api/v1/projects/${projectA}/tasks`,
    })
    expect(res.statusCode).toBe(200)
    expect((res.json() as { data: unknown[] }).data).toEqual([])
  })

  it('项目不存在 404；无 Session 401', async () => {
    const missing = await apiInject(ctx, alice, {
      method: 'GET',
      url: '/api/v1/projects/00000000-0000-4000-8000-0000000000ff/tasks',
    })
    expect(missing.statusCode).toBe(404)

    const anonymous = await ctx.app.inject({
      method: 'GET',
      url: `/api/v1/projects/${projectA}/tasks`,
      headers: { origin: ctx.origin },
    })
    expect(anonymous.statusCode).toBe(401)
  })
})
