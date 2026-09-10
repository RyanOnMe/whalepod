import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { Database } from '@whalepod/db'
import {
  apiInject,
  createTestApp,
  createTestDatabase,
  driveSetup,
  idemKey,
  resetDatabase,
  type TestApp,
} from './helpers.js'

async function createProjectAndTask(ctx: TestApp, alice: { cookie: string }) {
  const project = await apiInject(ctx, alice, {
    method: 'POST',
    url: '/api/v1/projects',
    payload: { name: 'P' },
  })
  const projectId = project.json().data.id
  const task = await apiInject(ctx, alice, {
    method: 'POST',
    url: `/api/v1/projects/${projectId}/tasks`,
    payload: { title: 't', assigneeUserId: alice.userId },
  })
  return task.json().data.id as string
}

// Comment 校验、幂等、404 与作者归因（03 §2.2）。
describe('comment API', () => {
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

  it('creates a comment attributed to the author', async () => {
    const alice = await driveSetup(ctx)
    const taskId = await createProjectAndTask(ctx, alice)
    const res = await apiInject(ctx, alice, {
      method: 'POST',
      url: `/api/v1/tasks/${taskId}/comments`,
      payload: { body: 'looks good' },
    })
    expect(res.statusCode).toBe(201)
    expect(res.json().data).toMatchObject({
      taskId,
      authorUserId: alice.userId,
      body: 'looks good',
    })
    expect(res.json().data.editedAt).toBeNull()
  })

  it('rejects empty and over-limit bodies', async () => {
    const alice = await driveSetup(ctx)
    const taskId = await createProjectAndTask(ctx, alice)
    const empty = await apiInject(ctx, alice, {
      method: 'POST',
      url: `/api/v1/tasks/${taskId}/comments`,
      payload: { body: '' },
    })
    expect(empty.statusCode).toBe(400)
    const tooLong = await apiInject(ctx, alice, {
      method: 'POST',
      url: `/api/v1/tasks/${taskId}/comments`,
      payload: { body: 'x'.repeat(10_001) },
    })
    expect(tooLong.statusCode).toBe(400)
  })

  it('does not create a second comment on idempotency replay', async () => {
    const alice = await driveSetup(ctx)
    const taskId = await createProjectAndTask(ctx, alice)
    const key = idemKey()
    const first = await apiInject(ctx, alice, {
      method: 'POST',
      url: `/api/v1/tasks/${taskId}/comments`,
      payload: { body: 'once' },
      idempotencyKey: key,
    })
    const replay = await apiInject(ctx, alice, {
      method: 'POST',
      url: `/api/v1/tasks/${taskId}/comments`,
      payload: { body: 'once' },
      idempotencyKey: key,
    })
    expect(replay.json().data.id).toBe(first.json().data.id)
    const room = await apiInject(ctx, alice, { method: 'GET', url: `/api/v1/tasks/${taskId}` })
    expect(room.json().data.comments).toHaveLength(1)
  })

  it('returns 404 for a comment on an unknown task', async () => {
    const alice = await driveSetup(ctx)
    const res = await apiInject(ctx, alice, {
      method: 'POST',
      url: '/api/v1/tasks/00000000-0000-0000-0000-000000000000/comments',
      payload: { body: 'x' },
    })
    expect(res.statusCode).toBe(404)
  })
})
