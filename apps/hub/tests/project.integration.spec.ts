import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { Database } from '@project311/db'
import {
  apiInject,
  createTestApp,
  createTestDatabase,
  driveInviteAndAccept,
  driveSetup,
  idemKey,
  resetDatabase,
  type TestApp,
} from './helpers.js'

// G2-01（Alice 创建 Project）+ 幂等/唯一/未认证守卫；判据以 04-验收矩阵与测试策略.md 为准。
describe('project API (G2-01)', () => {
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

  it('creates a project and lists / fetches it', async () => {
    const alice = await driveSetup(ctx)
    const created = await apiInject(ctx, alice, {
      method: 'POST',
      url: '/api/v1/projects',
      payload: { name: 'Apollo', description: 'moon program' },
    })
    expect(created.statusCode).toBe(201)
    const project = created.json().data
    expect(project).toMatchObject({
      name: 'Apollo',
      description: 'moon program',
      createdBy: alice.userId,
    })
    expect(project.id).toBeTruthy()

    const list = await apiInject(ctx, alice, { method: 'GET', url: '/api/v1/projects' })
    expect(list.statusCode).toBe(200)
    expect(list.json().data).toHaveLength(1)
    expect(list.json().data[0]).toMatchObject({ id: project.id, name: 'Apollo' })

    const detail = await apiInject(ctx, alice, {
      method: 'GET',
      url: `/api/v1/projects/${project.id}`,
    })
    expect(detail.statusCode).toBe(200)
    expect(detail.json().data.id).toBe(project.id)
  })

  it('rejects a duplicate project name with 409', async () => {
    const alice = await driveSetup(ctx)
    await apiInject(ctx, alice, {
      method: 'POST',
      url: '/api/v1/projects',
      payload: { name: 'Gemini' },
    })
    const dup = await apiInject(ctx, alice, {
      method: 'POST',
      url: '/api/v1/projects',
      payload: { name: 'Gemini' },
    })
    expect(dup.statusCode).toBe(409)
    expect(dup.json().error.code).toBe('CONFLICT')
  })

  it('does not create a second project on idempotency replay', async () => {
    const alice = await driveSetup(ctx)
    const key = idemKey()
    const first = await apiInject(ctx, alice, {
      method: 'POST',
      url: '/api/v1/projects',
      payload: { name: 'Mercury' },
      idempotencyKey: key,
    })
    expect(first.statusCode).toBe(201)
    const replay = await apiInject(ctx, alice, {
      method: 'POST',
      url: '/api/v1/projects',
      payload: { name: 'Mercury' },
      idempotencyKey: key,
    })
    expect(replay.statusCode).toBe(201)
    expect(replay.json().data.id).toBe(first.json().data.id)
    const list = await apiInject(ctx, alice, { method: 'GET', url: '/api/v1/projects' })
    expect(list.json().data).toHaveLength(1)
  })

  it('returns 404 for an unknown project and 401 unauthenticated', async () => {
    const alice = await driveSetup(ctx)
    const notFound = await apiInject(ctx, alice, {
      method: 'GET',
      url: '/api/v1/projects/00000000-0000-0000-0000-000000000000',
    })
    expect(notFound.statusCode).toBe(404)
    const anon = await ctx.app.inject({ method: 'GET', url: '/api/v1/projects' })
    expect(anon.statusCode).toBe(401)
  })

  it('lets an invited member see all projects (single team)', async () => {
    const alice = await driveSetup(ctx)
    const { session: bob } = await driveInviteAndAccept(ctx, alice, {
      username: 'bob',
      displayName: 'Bob',
      password: 'correct horse battery staple',
    })
    await apiInject(ctx, alice, {
      method: 'POST',
      url: '/api/v1/projects',
      payload: { name: 'Shared' },
    })
    const list = await apiInject(ctx, bob, { method: 'GET', url: '/api/v1/projects' })
    expect(list.statusCode).toBe(200)
    expect(list.json().data).toHaveLength(1)
    expect(list.json().data[0].name).toBe('Shared')
  })
})
