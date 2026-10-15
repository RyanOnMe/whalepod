import { randomUUID } from 'node:crypto'
import { eq, sql } from 'drizzle-orm'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Database } from '@whalepod/db'
import { listMessages, schema } from '@whalepod/db'
import {
  apiInject,
  createTestApp,
  createTestDatabase,
  driveInviteAndAccept,
  driveSetup,
  makeActor,
  makeHarness,
  resetDatabase,
  runEventFrame,
  seedRunChainForUser,
  type TestApp,
  type Session,
  TEST_DSH_VERSION,
} from './helpers.js'
let db: Database
let ctx: TestApp
let owner: Session
let member: Session
beforeEach(async () => {
  db = await createTestDatabase()
  await resetDatabase(db)
  ctx = await createTestApp(db)
  owner = await driveSetup(ctx)
  member = (
    await driveInviteAndAccept(ctx, owner, {
      username: 'helper',
      displayName: 'Helper',
      password: 'correct horse battery staple',
    })
  ).session
})
afterEach(async () => {
  await ctx.close()
  await db.close()
})
async function setup() {
  const project = await apiInject(ctx, owner, {
    method: 'POST',
    url: '/api/v1/projects',
    payload: { name: '撤销验证' },
  })
  const task = await apiInject(ctx, owner, {
    method: 'POST',
    url: `/api/v1/projects/${project.json().data.id}/tasks`,
    payload: { title: '撤销验证', assigneeUserId: owner.userId },
  })
  const taskId = task.json().data.id as string
  await apiInject(ctx, owner, { method: 'POST', url: `/api/v1/tasks/${taskId}/accept` })
  const chain = await seedRunChainForUser(db.db, owner.userId)
  const harness = makeHarness(db)
  harness.clock.advance(Date.now() - harness.clock.now().getTime())
  const dispatch = () => {
    harness.clock.advance(Math.max(0, Date.now() - harness.clock.now().getTime()) + 1)
    return harness.worker.dispatchOnce()
  }
  const run = await harness.orchestrator.create(makeActor(owner.userId), taskId, {
    ...chain,
    idempotencyKey: randomUUID(),
    prompt: 'owner work',
    dshDistributionVersion: TEST_DSH_VERSION,
  })
  expect(
    (
      await apiInject(ctx, owner, {
        method: 'POST',
        url: `/api/v1/tasks/${taskId}/instruction-grants`,
        payload: { userId: member.userId },
      })
    ).statusCode,
  ).toBe(201)
  const send = async (as: Session, text: string) => {
    const result = await apiInject(ctx, as, {
      method: 'POST',
      url: `/api/v1/tasks/${taskId}/instructions`,
      payload: { text, intent: { kind: 'followup', runId: run.id } },
    })
    expect(result.statusCode).toBe(201)
    return result.json().data.id as string
  }
  const revoke = () =>
    apiInject(ctx, owner, {
      method: 'DELETE',
      url: `/api/v1/tasks/${taskId}/instruction-grants/${member.userId}`,
    })
  const ready = async () => {
    await dispatch()
    for (const frame of harness.gateway.drainUpstream())
      await harness.orchestrator.ingestNodeEvent(
        { deviceId: chain.deviceId, ownerUserId: owner.userId },
        frame,
      )
    await harness.orchestrator.ingestNodeEvent(
      { deviceId: chain.deviceId, ownerUserId: owner.userId },
      runEventFrame(run.id, 1, {
        type: 'runtime.ready',
        dshSessionId: 'revocation-fixture-session',
      }),
    )
  }
  return { taskId, chain, harness, run, send, revoke, ready, dispatch }
}
describe('授权撤销的派发边界（#321）', () => {
  it('撤销先完成：排队追问拒绝，责任人的合法追问仍补发', async () => {
    const flow = await setup()
    await flow.send(member, 'member queued')
    await flow.send(owner, 'owner queued')
    expect((await flow.revoke()).statusCode).toBe(200)
    const before = await listMessages(db.db, flow.taskId)
    expect(before.find((row) => row.authorUserId === member.userId)).toMatchObject({
      instructionState: 'rejected',
      instructionErrorCode: 'FORBIDDEN',
    })
    await flow.ready()
    await flow.dispatch()
    const followups = flow.harness.gateway.sent.filter((row) => row.frame.type === 'run.followup')
    expect(followups).toHaveLength(1)
    expect(followups[0]!.frame.payload).toMatchObject({ text: 'owner queued' })
    expect(
      (
        await apiInject(ctx, member, {
          method: 'POST',
          url: `/api/v1/tasks/${flow.taskId}/instructions`,
          payload: { text: 'after revoke', intent: { kind: 'followup', runId: flow.run.id } },
        })
      ).statusCode,
    ).toBe(403)
  })
  it('已入Outbox但尚未尝试：撤销使命令永久失败，worker零派发', async () => {
    const flow = await setup()
    await flow.ready()
    await flow.send(member, 'not attempted')
    expect((await flow.revoke()).statusCode).toBe(200)
    const command = (
      await db.db
        .select()
        .from(schema.dispatchOutbox)
        .where(eq(schema.dispatchOutbox.type, 'run.followup'))
    )[0]!
    expect(command.attemptCount).toBe(0)
    expect(command.failedAt).not.toBeNull()
    expect((await listMessages(db.db, flow.taskId))[0]).toMatchObject({
      instructionState: 'rejected',
      instructionErrorCode: 'FORBIDDEN',
    })
    expect((await flow.dispatch()).sent).toBe(0)
  })
  it('已派发但ack迟到：撤销不伪造撤回，真实ack仍accepted', async () => {
    const flow = await setup()
    await flow.ready()
    await flow.send(member, 'already attempted')
    await flow.dispatch()
    const acks = flow.harness.gateway.drainUpstream()
    await flow.revoke()
    expect((await listMessages(db.db, flow.taskId))[0]!.instructionState).toBe('pending')
    for (const frame of acks)
      await flow.harness.orchestrator.ingestNodeEvent(
        { deviceId: flow.chain.deviceId, ownerUserId: owner.userId },
        frame,
      )
    expect((await listMessages(db.db, flow.taskId))[0]!.instructionState).toBe('accepted')
  })
  it('撤销与ready竞争：真实Run锁等待保证撤销先完成时零补发', async () => {
    const flow = await setup()
    await flow.send(member, 'queued race')
    await flow.dispatch()
    for (const frame of flow.harness.gateway.drainUpstream())
      await flow.harness.orchestrator.ingestNodeEvent(
        { deviceId: flow.chain.deviceId, ownerUserId: owner.userId },
        frame,
      )
    let release!: () => void
    let locked!: (pid: number) => void
    const releaseGate = new Promise<void>((resolve) => {
      release = resolve
    })
    const lockedGate = new Promise<number>((resolve) => {
      locked = resolve
    })
    // 只锁已存在Run并观察pg锁，不直接写运行/权限/投影状态；驱动仍是HTTP与协议帧。
    const holder = db.transaction(async (tx) => {
      const [backend] = await tx.execute<{ pid: number }>(sql`select pg_backend_pid() as pid`)
      await tx.select().from(schema.runs).where(eq(schema.runs.id, flow.run.id)).for('update')
      if (backend === undefined) throw new Error('missing lock holder')
      locked(backend.pid)
      await releaseGate
    })
    const blocker = await lockedGate
    const revoke = flow.revoke()
    const waiting = async () => {
      const [row] = await db.sql<
        { count: number }[]
      >`select count(*)::int as count from pg_stat_activity where datname=current_database() and pid<>${blocker} and wait_event_type='Lock' and cardinality(pg_blocking_pids(pid))>0 and exists(select 1 from pg_locks where pg_locks.pid=pg_stat_activity.pid and relation='run'::regclass and mode='RowShareLock' and granted)`
      if (row === undefined) throw new Error('missing lock observation')
      return row.count
    }
    let ready: Promise<void> | undefined
    try {
      await expect.poll(waiting, { timeout: 5000 }).toBe(1)
      ready = flow.harness.orchestrator.ingestNodeEvent(
        { deviceId: flow.chain.deviceId, ownerUserId: owner.userId },
        runEventFrame(flow.run.id, 1, {
          type: 'runtime.ready',
          dshSessionId: 'revocation-race-session',
        }),
      )
      await expect.poll(waiting, { timeout: 5000 }).toBe(2)
    } finally {
      release()
      await holder
    }
    expect((await revoke).statusCode).toBe(200)
    await ready
    await flow.dispatch()
    expect(
      flow.harness.gateway.sent.filter((row) => row.frame.type === 'run.followup'),
    ).toHaveLength(0)
    expect((await listMessages(db.db, flow.taskId))[0]).toMatchObject({
      instructionState: 'rejected',
      instructionErrorCode: 'FORBIDDEN',
    })
  })
  it('成员停用后：补发器重新判定作者，零投递且拒绝理由可见', async () => {
    const flow = await setup()
    await flow.send(member, 'disabled before ready')
    expect(
      (
        await apiInject(ctx, owner, {
          method: 'POST',
          url: `/api/v1/team/members/${member.userId}/disable`,
        })
      ).statusCode,
    ).toBe(200)
    await flow.ready()
    await flow.dispatch()
    expect(
      flow.harness.gateway.sent.filter((row) => row.frame.type === 'run.followup'),
    ).toHaveLength(0)
    expect((await listMessages(db.db, flow.taskId))[0]).toMatchObject({
      instructionState: 'rejected',
      instructionErrorCode: 'FORBIDDEN',
    })
  })
})
