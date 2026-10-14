import { randomUUID } from 'node:crypto'
import { eq } from 'drizzle-orm'
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
    return result.json().data.messageId as string
  }
  const revoke = () =>
    apiInject(ctx, owner, {
      method: 'DELETE',
      url: `/api/v1/tasks/${taskId}/instruction-grants/${member.userId}`,
    })
  const ready = async () => {
    await harness.worker.dispatchOnce()
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
  return { taskId, chain, harness, run, send, revoke, ready }
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
    await flow.harness.worker.dispatchOnce()
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
    expect((await flow.harness.worker.dispatchOnce()).sent).toBe(0)
  })
  it('已派发但ack迟到：撤销不伪造撤回，真实ack仍accepted', async () => {
    const flow = await setup()
    await flow.ready()
    await flow.send(member, 'already attempted')
    await flow.harness.worker.dispatchOnce()
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
    await flow.harness.worker.dispatchOnce()
    expect(
      flow.harness.gateway.sent.filter((row) => row.frame.type === 'run.followup'),
    ).toHaveLength(0)
    expect((await listMessages(db.db, flow.taskId))[0]).toMatchObject({
      instructionState: 'rejected',
      instructionErrorCode: 'FORBIDDEN',
    })
  })
})
