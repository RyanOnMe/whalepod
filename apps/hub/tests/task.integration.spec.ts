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
  insertPublishedArtifact,
  insertRunRow,
  resetDatabase,
  seedRunChainForUser,
  type TestApp,
} from './helpers.js'

async function createProject(ctx: TestApp, alice: { cookie: string }, name = 'Apollo') {
  const res = await apiInject(ctx, alice, {
    method: 'POST',
    url: '/api/v1/projects',
    payload: { name },
  })
  if (res.statusCode !== 201)
    throw new Error(`create project failed: ${res.statusCode} ${res.body}`)
  return res.json().data.id as string
}

// G2-01/03/06 + Task Room 聚合与脱敏 + 由真人收口的 Task 生命周期。
describe('task API (G2-01/03/06 + lifecycle)', () => {
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

  it('G2-01: creates a Task with pending assignment, both members see it', async () => {
    const alice = await driveSetup(ctx)
    const { session: bob } = await driveInviteAndAccept(ctx, alice, {
      username: 'bob',
      displayName: 'Bob',
      password: 'correct horse battery staple',
    })
    const projectId = await createProject(ctx, alice)
    const created = await apiInject(ctx, alice, {
      method: 'POST',
      url: `/api/v1/projects/${projectId}/tasks`,
      payload: { title: 'Wire schemas', assigneeUserId: bob.userId },
    })
    expect(created.statusCode).toBe(201)
    const task = created.json().data
    expect(task).toMatchObject({
      status: 'open',
      assignmentStatus: 'pending',
      assigneeUserId: bob.userId,
      createdBy: alice.userId,
    })
    expect(task.acceptedAt).toBeNull()

    // 不静默接受人工指派：Assignment 仍 pending（02 Step 1）。
    const room = await apiInject(ctx, alice, { method: 'GET', url: `/api/v1/tasks/${task.id}` })
    expect(room.json().data.task.assignmentStatus).toBe('pending')
    const bobRoom = await apiInject(ctx, bob, { method: 'GET', url: `/api/v1/tasks/${task.id}` })
    expect(bobRoom.statusCode).toBe(200)
  })

  it('rejects a Task whose assignee is not an active member', async () => {
    const alice = await driveSetup(ctx)
    const projectId = await createProject(ctx, alice)
    const res = await apiInject(ctx, alice, {
      method: 'POST',
      url: `/api/v1/projects/${projectId}/tasks`,
      payload: { title: 'x', assigneeUserId: '00000000-0000-0000-0000-000000000000' },
    })
    expect(res.statusCode).toBe(400)
    expect(res.json().error.code).toBe('VALIDATION_FAILED')
  })

  it('G2-03: Bob accepts the assignment', async () => {
    const alice = await driveSetup(ctx)
    const { session: bob } = await driveInviteAndAccept(ctx, alice, {
      username: 'bob',
      displayName: 'Bob',
      password: 'correct horse battery staple',
    })
    const projectId = await createProject(ctx, alice)
    const task = (
      await apiInject(ctx, alice, {
        method: 'POST',
        url: `/api/v1/projects/${projectId}/tasks`,
        payload: { title: 'Accept me', assigneeUserId: bob.userId },
      })
    ).json().data
    const accepted = await apiInject(ctx, bob, {
      method: 'POST',
      url: `/api/v1/tasks/${task.id}/accept`,
    })
    expect(accepted.statusCode).toBe(200)
    expect(accepted.json().data).toMatchObject({ assignmentStatus: 'accepted' })
    expect(accepted.json().data.acceptedAt).not.toBeNull()
  })

  it('forbids a non-assignee from accepting', async () => {
    const alice = await driveSetup(ctx)
    const { session: bob } = await driveInviteAndAccept(ctx, alice, {
      username: 'bob',
      displayName: 'Bob',
      password: 'correct horse battery staple',
    })
    const projectId = await createProject(ctx, alice)
    const task = (
      await apiInject(ctx, alice, {
        method: 'POST',
        url: `/api/v1/projects/${projectId}/tasks`,
        payload: { title: 't', assigneeUserId: bob.userId },
      })
    ).json().data
    const res = await apiInject(ctx, alice, {
      method: 'POST',
      url: `/api/v1/tasks/${task.id}/accept`,
    })
    expect(res.statusCode).toBe(403)
    expect(res.json().error.code).toBe('FORBIDDEN')
  })

  it('Task Room hides runtime internals (02 Step 1 desensitization)', async () => {
    const alice = await driveSetup(ctx)
    const { session: bob } = await driveInviteAndAccept(ctx, alice, {
      username: 'bob',
      displayName: 'Bob',
      password: 'correct horse battery staple',
    })
    const projectId = await createProject(ctx, alice)
    const task = (
      await apiInject(ctx, alice, {
        method: 'POST',
        url: `/api/v1/projects/${projectId}/tasks`,
        payload: { title: 'Room', assigneeUserId: bob.userId },
      })
    ).json().data
    await apiInject(ctx, bob, { method: 'POST', url: `/api/v1/tasks/${task.id}/accept` })

    // 种一条带 dshSessionId 的 Run + 一个 published Artifact（含 storageKey 本地路径）。
    const chain = await seedRunChainForUser(database.db, bob.userId)
    const runId = await insertRunRow(database.db, {
      taskId: task.id,
      ownerUserId: bob.userId,
      ...chain,
      status: 'completed',
      dshSessionId: 'secret-dsh-session-id',
    })
    await insertPublishedArtifact(database.db, { taskId: task.id, runId, ownerUserId: bob.userId })

    const room = await apiInject(ctx, alice, { method: 'GET', url: `/api/v1/tasks/${task.id}` })
    expect(room.statusCode).toBe(200)
    const data = room.json().data
    expect(data.task.status).toBe('open')
    expect(data.runs).toHaveLength(1)
    expect(data.runs[0].id).toBe(runId)
    expect(data.runs[0]).not.toHaveProperty('dshSessionId')
    expect(data.artifacts).toHaveLength(1)
    expect(data.artifacts[0]).not.toHaveProperty('storageKey')
    // 脱敏断言：JSON 不含 workspacePath / dshSession / modelApiKey（02 Step 1）。
    expect(JSON.stringify(data)).not.toMatch(/workspacePath|dshSession|modelApiKey/)
  })

  it('G2-06: comments keep stable (createdAt, id) order across authors', async () => {
    const alice = await driveSetup(ctx)
    const { session: bob } = await driveInviteAndAccept(ctx, alice, {
      username: 'bob',
      displayName: 'Bob',
      password: 'correct horse battery staple',
    })
    const projectId = await createProject(ctx, alice)
    const task = (
      await apiInject(ctx, alice, {
        method: 'POST',
        url: `/api/v1/projects/${projectId}/tasks`,
        payload: { title: 'Discuss', assigneeUserId: bob.userId },
      })
    ).json().data
    await apiInject(ctx, alice, {
      method: 'POST',
      url: `/api/v1/tasks/${task.id}/comments`,
      payload: { body: 'alice first' },
    })
    await apiInject(ctx, bob, {
      method: 'POST',
      url: `/api/v1/tasks/${task.id}/comments`,
      payload: { body: 'bob second' },
    })
    const room = await apiInject(ctx, alice, { method: 'GET', url: `/api/v1/tasks/${task.id}` })
    const comments = room.json().data.comments
    expect(comments).toHaveLength(2)
    expect(comments.map((c: { body: string }) => c.body)).toEqual(['alice first', 'bob second'])
  })

  it('PATCH updates non-status fields idempotently', async () => {
    const alice = await driveSetup(ctx)
    const projectId = await createProject(ctx, alice)
    const task = (
      await apiInject(ctx, alice, {
        method: 'POST',
        url: `/api/v1/projects/${projectId}/tasks`,
        payload: { title: 'Old', assigneeUserId: alice.userId },
      })
    ).json().data
    const key = idemKey()
    const first = await apiInject(ctx, alice, {
      method: 'PATCH',
      url: `/api/v1/tasks/${task.id}`,
      payload: { title: 'New', description: 'desc' },
      idempotencyKey: key,
    })
    expect(first.statusCode).toBe(200)
    expect(first.json().data.title).toBe('New')
    const replay = await apiInject(ctx, alice, {
      method: 'PATCH',
      url: `/api/v1/tasks/${task.id}`,
      payload: { title: 'New', description: 'desc' },
      idempotencyKey: key,
    })
    expect(replay.json().data).toMatchObject(first.json().data)
  })

  it('does not create a second task on idempotency replay', async () => {
    const alice = await driveSetup(ctx)
    const projectId = await createProject(ctx, alice)
    const key = idemKey()
    const first = await apiInject(ctx, alice, {
      method: 'POST',
      url: `/api/v1/projects/${projectId}/tasks`,
      payload: { title: 'Idem', assigneeUserId: alice.userId },
      idempotencyKey: key,
    })
    const replay = await apiInject(ctx, alice, {
      method: 'POST',
      url: `/api/v1/projects/${projectId}/tasks`,
      payload: { title: 'Idem', assigneeUserId: alice.userId },
      idempotencyKey: key,
    })
    expect(replay.json().data.id).toBe(first.json().data.id)
  })

  it('submit-review requires a published artifact and no active run', async () => {
    const alice = await driveSetup(ctx)
    const projectId = await createProject(ctx, alice)
    const task = (
      await apiInject(ctx, alice, {
        method: 'POST',
        url: `/api/v1/projects/${projectId}/tasks`,
        payload: { title: 'Review', assigneeUserId: alice.userId },
      })
    ).json().data
    await apiInject(ctx, alice, { method: 'POST', url: `/api/v1/tasks/${task.id}/accept` })
    // 推到 in_progress（直接置状态，模拟 run_started 已发生且 Run 已终态）。
    await database.db
      .update(schema.tasks)
      .set({ status: 'in_progress' })
      .where(eq(schema.tasks.id, task.id))
    // 无 published Artifact → 409。
    const noArtifact = await apiInject(ctx, alice, {
      method: 'POST',
      url: `/api/v1/tasks/${task.id}/submit-review`,
    })
    expect(noArtifact.statusCode).toBe(409)
    expect(noArtifact.json().error.code).toBe('CONFLICT')
    // 有 published Artifact → in_review。
    const chain = await seedRunChainForUser(database.db, alice.userId)
    const runId = await insertRunRow(database.db, {
      taskId: task.id,
      ownerUserId: alice.userId,
      ...chain,
      status: 'completed',
    })
    await insertPublishedArtifact(database.db, {
      taskId: task.id,
      runId,
      ownerUserId: alice.userId,
    })
    const submitted = await apiInject(ctx, alice, {
      method: 'POST',
      url: `/api/v1/tasks/${task.id}/submit-review`,
    })
    expect(submitted.statusCode).toBe(200)
    expect(submitted.json().data.status).toBe('in_review')
    // 显式完成 → done（Run/Agent 不自动完成）。
    const completed = await apiInject(ctx, alice, {
      method: 'POST',
      url: `/api/v1/tasks/${task.id}/complete`,
    })
    expect(completed.statusCode).toBe(200)
    expect(completed.json().data.status).toBe('done')
    expect(completed.json().data.completedAt).not.toBeNull()
  })

  it('cancel cancels the task and its active run atomically (02 Step 6)', async () => {
    const alice = await driveSetup(ctx)
    const projectId = await createProject(ctx, alice)
    const task = (
      await apiInject(ctx, alice, {
        method: 'POST',
        url: `/api/v1/projects/${projectId}/tasks`,
        payload: { title: 'Cancel me', assigneeUserId: alice.userId },
      })
    ).json().data
    await apiInject(ctx, alice, { method: 'POST', url: `/api/v1/tasks/${task.id}/accept` })
    await database.db
      .update(schema.tasks)
      .set({ status: 'in_progress' })
      .where(eq(schema.tasks.id, task.id))
    const chain = await seedRunChainForUser(database.db, alice.userId)
    const runId = await insertRunRow(database.db, {
      taskId: task.id,
      ownerUserId: alice.userId,
      ...chain,
      status: 'running',
    })
    const cancelled = await apiInject(ctx, alice, {
      method: 'POST',
      url: `/api/v1/tasks/${task.id}/cancel`,
    })
    expect(cancelled.statusCode).toBe(200)
    expect(cancelled.json().data.status).toBe('cancelled')
    // Run 在同一事务内转 cancel_requested，并入了 run.cancel outbox。
    const [run] = await database.db.select().from(schema.runs).where(eq(schema.runs.id, runId))
    expect(run?.status).toBe('cancel_requested')
    const outbox = await database.db.select().from(schema.dispatchOutbox)
    expect(outbox.some((o) => o.type === 'run.cancel')).toBe(true)
  })
})
