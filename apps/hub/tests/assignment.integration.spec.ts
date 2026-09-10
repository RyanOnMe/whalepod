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
  return res.json().data.id as string
}

// G2-04（拒绝后重新指派）+ G2-05（有活跃 Run 时改 assignee → 409）+ 权限守卫。
describe('assignment API (G2-04/05)', () => {
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

  it('G2-04: reject then reassign resets assignment to pending', async () => {
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

    const rejected = await apiInject(ctx, bob, {
      method: 'POST',
      url: `/api/v1/tasks/${task.id}/reject`,
    })
    expect(rejected.statusCode).toBe(200)
    expect(rejected.json().data.assignmentStatus).toBe('rejected')
    expect(rejected.json().data.assigneeUserId).toBe(bob.userId)

    // Alice（Owner）重新指派给自己 → assignment 重置 pending，assignee 变化。
    const reassigned = await apiInject(ctx, alice, {
      method: 'POST',
      url: `/api/v1/tasks/${task.id}/reassign`,
      payload: { assigneeUserId: alice.userId },
    })
    expect(reassigned.statusCode).toBe(200)
    expect(reassigned.json().data).toMatchObject({
      assigneeUserId: alice.userId,
      assignmentStatus: 'pending',
    })
    expect(reassigned.json().data.acceptedAt).toBeNull()
  })

  it('G2-05: reassigning a task with an active run is rejected with 409', async () => {
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
    await apiInject(ctx, bob, { method: 'POST', url: `/api/v1/tasks/${task.id}/accept` })
    await database.db
      .update(schema.tasks)
      .set({ status: 'in_progress' })
      .where(eq(schema.tasks.id, task.id))
    const chain = await seedRunChainForUser(database.db, bob.userId)
    await insertRunRow(database.db, {
      taskId: task.id,
      ownerUserId: bob.userId,
      ...chain,
      status: 'running',
    })

    const res = await apiInject(ctx, alice, {
      method: 'POST',
      url: `/api/v1/tasks/${task.id}/reassign`,
      payload: { assigneeUserId: alice.userId },
    })
    expect(res.statusCode).toBe(409)
    expect(res.json().error.code).toBe('CONFLICT')
    // Run 不受影响（G2-05）。
    const [run] = await database.db
      .select()
      .from(schema.runs)
      .where(eq(schema.runs.taskId, task.id))
    expect(run?.status).toBe('running')
  })

  it('forbids a non-admin member from reassigning', async () => {
    const alice = await driveSetup(ctx)
    const { session: bob } = await driveInviteAndAccept(ctx, alice, {
      username: 'bob',
      displayName: 'Bob',
      password: 'correct horse battery staple',
    })
    const { session: carol } = await driveInviteAndAccept(
      ctx,
      alice,
      { username: 'carol', displayName: 'Carol', password: 'correct horse battery staple' },
      'member',
    )
    const projectId = await createProject(ctx, alice)
    const task = (
      await apiInject(ctx, alice, {
        method: 'POST',
        url: `/api/v1/projects/${projectId}/tasks`,
        payload: { title: 't', assigneeUserId: bob.userId },
      })
    ).json().data
    await apiInject(ctx, bob, { method: 'POST', url: `/api/v1/tasks/${task.id}/reject` })
    const res = await apiInject(ctx, carol, {
      method: 'POST',
      url: `/api/v1/tasks/${task.id}/reassign`,
      payload: { assigneeUserId: carol.userId },
    })
    expect(res.statusCode).toBe(403)
    expect(res.json().error.code).toBe('FORBIDDEN')
  })

  it('rejects reassign to a non-member and to a pending assignment', async () => {
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
    await apiInject(ctx, bob, { method: 'POST', url: `/api/v1/tasks/${task.id}/reject` })

    // 重新指派给非成员 → 400。
    const nonMember = await apiInject(ctx, alice, {
      method: 'POST',
      url: `/api/v1/tasks/${task.id}/reassign`,
      payload: { assigneeUserId: '00000000-0000-0000-0000-000000000000' },
    })
    expect(nonMember.statusCode).toBe(400)

    // 重新指派后再 reassign（此时 pending）→ 非法迁移 409（03 §3.1 无 pending→pending 边）。
    await apiInject(ctx, alice, {
      method: 'POST',
      url: `/api/v1/tasks/${task.id}/reassign`,
      payload: { assigneeUserId: alice.userId },
    })
    const pendingReassign = await apiInject(ctx, alice, {
      method: 'POST',
      url: `/api/v1/tasks/${task.id}/reassign`,
      payload: { assigneeUserId: bob.userId },
    })
    expect(pendingReassign.statusCode).toBe(409)
    expect(pendingReassign.json().error.code).toBe('INVALID_ASSIGNMENT_TRANSITION')
  })
})
