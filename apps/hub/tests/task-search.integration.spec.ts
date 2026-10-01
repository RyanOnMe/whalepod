/**
 * 任务搜索（#254；#243 第 5 条刀二）。真人 HTTP：建房后按标题检索。
 *
 * 判定基线：
 * - title ILIKE **不区分大小写**；不匹配不回；结果按最近活动排序、复用刀一的
 *   `RecentTaskView` 形状（含 projectName）；
 * - 上限 8；空 q / 全空白 → 400（协议层判，不静默全量）；
 * - 关键词参数化（ILIKE 拼接走 drizzle 参数，不把用户输入接进 SQL 文本）。
 */
import { eq } from 'drizzle-orm'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { Database } from '@whalepod/db'
import { schema } from '@whalepod/db'
import {
  apiInject,
  createTestApp,
  createTestDatabase,
  driveInviteAndAccept,
  driveSetup,
  idemKey,
  resetDatabase,
  type Session,
  type TestApp,
} from './helpers.js'

interface SearchItem {
  id: string
  title: string
  projectName: string | null
  lastActiveAt: string
}

describe('task search (GET /tasks/search, #254)', () => {
  let database: Database
  let ctx: TestApp
  let bob: Session

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

  async function search(q: string): Promise<{ status: number; data?: SearchItem[] }> {
    const res = await apiInject(ctx, bob, {
      method: 'GET',
      url: `/api/v1/tasks/search?q=${encodeURIComponent(q)}`,
    })
    const json = res.json() as { data?: SearchItem[] }
    return { status: res.statusCode, data: res.statusCode === 200 ? json.data : undefined }
  }

  it('大小写不敏感匹配标题；不匹配不回；形状带 projectName', async () => {
    await seedWorld()
    const project = await createProject('search-proj')
    const hit = await createTask(project, '修复登录页 Bug')
    await createTask(project, '写周报')
    // 小写关键词命中大写标题里的词。
    const result = await search('登录')
    expect(result.status).toBe(200)
    expect(result.data?.map((t) => t.id)).toEqual([hit])
    expect(result.data?.[0]?.projectName).toBe('search-proj')
    // 大小写不敏感的英文。
    await createTask(project, 'Refactor Login Flow')
    expect((await search('login')).data).toHaveLength(1)
    expect((await search('LOGIN')).data).toHaveLength(1)
    // 不匹配：空结果，不回别的任务。
    expect((await search('不存在的词')).data).toEqual([])
  })

  it('上限 8 条；空 q 与全空白 → 400', async () => {
    await seedWorld()
    const project = await createProject('limit-proj')
    for (let i = 1; i <= 9; i += 1) {
      await createTask(project, `登录项${i}`)
    }
    expect((await search('登录项')).data).toHaveLength(8)
    expect((await search('')).status).toBe(400)
    expect((await search('   ')).status).toBe(400)
  })

  it('单引号等特殊字符不炸（参数化证明：输入不当 SQL 片段用）', async () => {
    await seedWorld()
    const project = await createProject('quote-proj')
    await createTask(project, "O'Brien's task")
    const result = await search("O'Brien'")
    expect(result.status).toBe(200)
    expect(result.data).toHaveLength(1)
    // % 与 _ 是 ILIKE 通配符：按字面匹配而不是当通配符（转义后按字面）。
    await createTask(project, '100% 完成')
    expect((await search('100%')).data).toHaveLength(1)
    expect((await search('100%完成')).data).toHaveLength(0)
  })
})
