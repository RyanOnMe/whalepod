import { mkdir, writeFile } from 'node:fs/promises'
import { isDeepStrictEqual } from 'node:util'
import { eq, sql } from 'drizzle-orm'
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
      idempotencyKey: 'reassign-retry-key',
      payload: { assigneeUserId: alice.userId },
    })
    expect(reassigned.statusCode).toBe(200)
    expect(reassigned.json().data).toMatchObject({
      assigneeUserId: alice.userId,
      assignmentStatus: 'pending',
    })
    expect(reassigned.json().data.acceptedAt).toBeNull()
    const retry = await apiInject(ctx, alice, {
      method: 'POST',
      url: `/api/v1/tasks/${task.id}/reassign`,
      idempotencyKey: 'reassign-retry-key',
      payload: { assigneeUserId: alice.userId },
    })
    expect(retry.statusCode).toBe(200)
    expect(retry.json().data).toEqual(reassigned.json().data)
  })

  it('#314 同 key 并发重新指派在 Task 锁后回放首次结果', async () => {
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
        payload: { title: 'concurrent reassignment', assigneeUserId: bob.userId },
      })
    ).json().data
    await apiInject(ctx, bob, { method: 'POST', url: `/api/v1/tasks/${task.id}/reject` })
    const [before] = await database.sql<{ count: number }[]>`
      select count(*)::int as count from team_event
      where type = 'task.changed' and payload->>'taskId' = ${task.id}
    `

    if (before === undefined) throw new Error('missing pre-reassignment event count')
    const beforeEvents = before.count
    let blockedRequests = 0

    let release!: () => void
    const releaseGate = new Promise<void>((resolve) => {
      release = resolve
    })
    let locked!: (pid: number) => void
    const lockedGate = new Promise<number>((resolve) => {
      locked = resolve
    })
    // 只锁既有 Task，不注入业务状态；两请求仍走生产 HTTP 与事务路径。
    // pg_blocking_pids 证明两请求均已越过事务开头的回执早查，避免靠定时猜竞态。
    const holder = database.transaction(async (tx) => {
      const [backend] = await tx.execute<{ pid: number }>(
        // 驱动参数来自已创建 Task；后台 pid 只用于观测锁等待。
        sql`select pg_backend_pid() as pid`,
      )
      await tx.select().from(schema.tasks).where(eq(schema.tasks.id, task.id)).for('update')
      if (backend === undefined) throw new Error('missing lock holder backend')
      locked(backend.pid)
      await releaseGate
    })
    const blockerPid = await lockedGate
    const request = () =>
      apiInject(ctx, alice, {
        method: 'POST',
        url: `/api/v1/tasks/${task.id}/reassign`,
        idempotencyKey: 'concurrent-reassign-key',
        payload: { assigneeUserId: alice.userId },
      })
    const responses = Promise.all([request(), request()])
    try {
      await expect
        .poll(
          async () => {
            const [waiting] = await database.sql<{ count: number }[]>`
          select count(*)::int as count from pg_stat_activity
          where datname = current_database() and wait_event_type = 'Lock'
            and pid <> ${blockerPid} and cardinality(pg_blocking_pids(pid)) > 0
            and exists (select 1 from pg_locks where pg_locks.pid = pg_stat_activity.pid
              and relation = 'task'::regclass and mode = 'RowShareLock' and granted)
        `
            if (waiting === undefined) throw new Error('missing concurrent lock observation')
            blockedRequests = waiting.count
            return blockedRequests
          },
          { timeout: 5_000 },
        )
        .toBe(2)
    } finally {
      release()
      await holder
    }
    const [first, second] = await responses
    expect([first.statusCode, second.statusCode]).toEqual([200, 200])
    expect(second.json().data).toEqual(first.json().data)
    expect(first.json().data).toMatchObject({
      id: task.id,
      assigneeUserId: alice.userId,
      assignmentStatus: 'pending',
    })
    const [after] = await database.sql<{ count: number }[]>`
      select count(*)::int as count from team_event
      where type = 'task.changed' and payload->>'taskId' = ${task.id}
    `
    if (after === undefined) throw new Error('missing post-reassignment event count')
    const afterEvents = after.count
    expect(afterEvents - beforeEvents).toBe(1)
    const receiptKey = `task.reassign:${alice.userId}:${task.id}:concurrent-reassign-key`
    const [receipt] = await database.sql<{ count: number }[]>`
      select count(*)::int as count from command_receipt where key = ${receiptKey}
    `
    if (receipt === undefined) throw new Error('missing command receipt count')
    const receipts = receipt.count
    expect(receipts).toBe(1)
    await mkdir('artifacts/evidence/task-reassignment', { recursive: true })
    await writeFile(
      'artifacts/evidence/task-reassignment/concurrency.json',
      JSON.stringify(
        {
          component: 'hub.task',
          scenario: 'same-key-concurrent-reassignment',
          taskId: task.id,
          responseStatuses: [first.statusCode, second.statusCode],
          blockedRequests,
          sameResult: isDeepStrictEqual(first.json().data, second.json().data),
          assignmentStatus: first.json().data.assignmentStatus,
          taskChangedEvents: afterEvents - beforeEvents,
          commandReceipts: receipts,
        },
        null,
        2,
      ),
    )
  }, 15_000)

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
