import { randomUUID } from 'node:crypto'
import { eq } from 'drizzle-orm'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { Database } from '@whalepod/db'
import { getRun, listTeamEvents, schema } from '@whalepod/db'
import {
  createTestDatabase,
  makeActor,
  makeCreateInput,
  makeHarness,
  resetDatabase,
  runEventFrame,
  seedRunPrereqs,
  seedSecondUserDevice,
} from './helpers.js'

// 取消与状态机守卫（03 §3.2 边、02 Task 10 Step 5：queued 取消不得派发 start）。
describe('run policy: cancel and transitions', () => {
  let database: Database
  beforeAll(async () => {
    database = await createTestDatabase()
  })
  beforeEach(async () => {
    await resetDatabase(database)
  })
  afterAll(async () => {
    await database.close()
  })

  it('cancelling a queued run supersedes the pending run.start (never dispatched)', async () => {
    const ids = await seedRunPrereqs(database.db)
    const harness = makeHarness(database)
    const run = await harness.orchestrator.create(
      makeActor(ids.userId),
      ids.taskId,
      makeCreateInput(ids),
    )

    const cancelled = await harness.orchestrator.cancel(makeActor(ids.userId), run.id)
    expect(cancelled.status).toBe('cancelled')
    expect(cancelled.finishedAt).not.toBeNull()

    const [row] = await database.db.select().from(schema.dispatchOutbox)
    expect(row?.failedAt).not.toBeNull()
    await harness.worker.dispatchOnce()
    expect(harness.gateway.sent).toHaveLength(0)
    expect(harness.gateway.runtimeStartCount).toBe(0)
    const teamEvents = await listTeamEvents(database.db)
    expect(
      teamEvents.some(
        (event) =>
          event.type === 'run.changed' &&
          (event.payload as { status?: string }).status === 'cancelled',
      ),
    ).toBe(true)
  })

  it('cancelling a running run sends run.cancel and completes on node confirmation', async () => {
    const ids = await seedRunPrereqs(database.db)
    const harness = makeHarness(database)
    const run = await harness.orchestrator.create(
      makeActor(ids.userId),
      ids.taskId,
      makeCreateInput(ids),
    )
    await harness.pump(ids)
    await harness.orchestrator.ingestNodeEvent(
      harness.deviceFor(ids),
      runEventFrame(run.id, 1, { type: 'runtime.ready', dshSessionId: 's-1' }),
    )

    const requested = await harness.orchestrator.cancel(makeActor(ids.userId), run.id)
    expect(requested.status).toBe('cancel_requested')

    await harness.pump(ids)
    const cancelFrame = harness.gateway.sent.find(({ frame }) => frame.type === 'run.cancel')
    expect(cancelFrame?.frame.type).toBe('run.cancel')
    if (cancelFrame?.frame.type !== 'run.cancel') throw new Error('unreachable')
    expect(cancelFrame.frame.payload).toMatchObject({ runId: run.id, cause: 'user' })
    expect(harness.gateway.cancelledRunIds).toContain(run.id)
    expect((await getRun(database.db, run.id))?.status).toBe('cancel_requested')

    await harness.orchestrator.ingestNodeEvent(
      harness.deviceFor(ids),
      runEventFrame(run.id, 2, { type: 'run.cancelled', forced: false }),
    )
    const cancelled = await getRun(database.db, run.id)
    expect(cancelled?.status).toBe('cancelled')
    expect(cancelled?.finishedAt).not.toBeNull()
  })

  it('forbids cancel by a non-owner member; allows a team admin (cause=admin)', async () => {
    const ids = await seedRunPrereqs(database.db)
    const other = await seedSecondUserDevice(database.db, ids)
    const harness = makeHarness(database)
    const run = await harness.orchestrator.create(
      makeActor(ids.userId),
      ids.taskId,
      makeCreateInput(ids),
    )

    await expect(
      harness.orchestrator.cancel(makeActor(other.userId, 'member'), run.id),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' })

    const cancelled = await harness.orchestrator.cancel(makeActor(other.userId, 'admin'), run.id)
    expect(cancelled.status).toBe('cancelled')
  })

  it('repeated cancel is idempotent; cancelling a completed run is an invalid transition', async () => {
    const ids = await seedRunPrereqs(database.db)
    const harness = makeHarness(database)
    const run = await harness.orchestrator.create(
      makeActor(ids.userId),
      ids.taskId,
      makeCreateInput(ids),
    )

    const first = await harness.orchestrator.cancel(makeActor(ids.userId), run.id)
    const second = await harness.orchestrator.cancel(makeActor(ids.userId), run.id)
    expect(second).toEqual(first)
    expect(await database.db.select().from(schema.dispatchOutbox)).toHaveLength(1)

    // 另一条跑到 completed 后取消 → INVALID_RUN_TRANSITION（同项目下第二个 Task）。
    const secondTaskId = randomUUID()
    await database.db.insert(schema.tasks).values({
      id: secondTaskId,
      projectId: ids.projectId,
      title: 'Second task',
      assigneeUserId: ids.userId,
      assignmentStatus: 'accepted',
      acceptedAt: new Date(),
      createdBy: ids.userId,
    })
    const run2 = await harness.orchestrator.create(
      makeActor(ids.userId),
      secondTaskId,
      makeCreateInput(ids),
    )
    await harness.pump(ids)
    await harness.orchestrator.ingestNodeEvent(
      harness.deviceFor(ids),
      runEventFrame(run2.id, 1, { type: 'runtime.ready', dshSessionId: 's-1' }),
    )
    await harness.orchestrator.ingestNodeEvent(
      harness.deviceFor(ids),
      runEventFrame(run2.id, 2, { type: 'run.completed', finalText: 'done' }),
    )
    await expect(harness.orchestrator.cancel(makeActor(ids.userId), run2.id)).rejects.toMatchObject(
      { code: 'INVALID_RUN_TRANSITION' },
    )
  })

  it('表外越边事件：事件留证 + Run 级收敛 failed(INVALID_RUN_TRANSITION)，不炸通道（#52/ADR-0007）', async () => {
    const ids = await seedRunPrereqs(database.db)
    const violations: { message: string; context: Record<string, unknown> }[] = []
    const harness = makeHarness(
      database,
      {},
      { warn: (message, context) => violations.push({ message, context }) },
    )
    const run = await harness.orchestrator.create(
      makeActor(ids.userId),
      ids.taskId,
      makeCreateInput(ids),
    )

    // queued 上收到 run.completed 是表外边（§3.2 有意不开）：旧姿势是抛错→连接级
    // 惩罚（毒帧循环的引擎）；新姿势是事件照常落库留证 + 单 Run 收敛为终态。
    await harness.orchestrator.ingestNodeEvent(
      harness.deviceFor(ids),
      runEventFrame(run.id, 1, { type: 'run.completed', finalText: 'premature' }, 'owner'),
    )
    const row = await getRun(database.db, run.id)
    expect(row?.status).toBe('failed')
    expect(row?.failureCode).toBe('INVALID_RUN_TRANSITION')
    expect(row?.failureSummary).toContain('cannot apply')
    const events = await database.db
      .select()
      .from(schema.runEvents)
      .where(eq(schema.runEvents.runId, run.id))
    expect(events).toHaveLength(1) // 留证：事件行不随迁移失败回滚

    // ADR-0007 撤销连接级安全网的代价论证 = 结构化违例 warn——补偿控制必须机器
    // 钉死：降级收敛必然发出一条、字段齐（component 归因 + runId/fromStatus/reason
    // 取证），缺省静默的 warn 通道不算兜住。
    expect(violations).toHaveLength(1)
    expect(violations[0]?.context).toMatchObject({
      component: 'hub.run.orchestrator.transition-violation',
      runId: run.id,
      deviceId: ids.deviceId,
      fromStatus: 'queued',
    })
    expect(String(violations[0]?.context.reason)).toContain('cannot apply')
  })

  it('表内合法裁决边（waiting_approval + run.completed）正常收敛，不得误发越边告警', async () => {
    const ids = await seedRunPrereqs(database.db)
    const violations: { message: string; context: Record<string, unknown> }[] = []
    const harness = makeHarness(
      database,
      {},
      { warn: (message, context) => violations.push({ message, context }) },
    )
    const run = await harness.orchestrator.create(
      makeActor(ids.userId),
      ids.taskId,
      makeCreateInput(ids),
    )
    await harness.pump(ids)
    await harness.orchestrator.ingestNodeEvent(
      harness.deviceFor(ids),
      runEventFrame(run.id, 1, { type: 'runtime.ready', dshSessionId: 's-1' }),
    )
    const approvalId = '00000000-0000-4000-8000-0000000aa009'
    await harness.orchestrator.ingestNodeEvent(
      harness.deviceFor(ids),
      runEventFrame(run.id, 2, {
        type: 'approval.requested',
        approval: {
          approvalId,
          runId: run.id,
          callId: 'call-1',
          toolName: 'fs.write',
          reason: 'needs to write a file',
          preview: { path: 'src/index.ts' },
          status: 'pending',
          requestedAt: new Date().toISOString(),
          expiresAt: new Date(Date.now() + 600_000).toISOString(),
        },
      }),
    )
    expect((await getRun(database.db, run.id))?.status).toBe('waiting_approval')

    // 新加的表内裁决边：completed 是终态裁决，折叠悬置审批——但它是合法边，
    // 违例告警必须零发（否则 warn 沦为噪声，补偿控制失去指认价值）。
    await harness.orchestrator.ingestNodeEvent(
      harness.deviceFor(ids),
      runEventFrame(run.id, 3, { type: 'run.completed', finalText: 'done' }, 'owner'),
    )
    const row = await getRun(database.db, run.id)
    expect(row?.status).toBe('completed')
    expect(row?.failureCode).toBeNull()
    const [approval] = await database.db
      .select()
      .from(schema.approvals)
      .where(eq(schema.approvals.id, approvalId))
    expect(approval?.status).toBe('cancelled') // 折叠照常，但不是违例
    expect(violations).toHaveLength(0)
  })

  it('never revives a terminal run when a late event arrives (03 §3.2 终态禁复活)', async () => {
    const ids = await seedRunPrereqs(database.db)
    const harness = makeHarness(database)
    const run = await harness.orchestrator.create(
      makeActor(ids.userId),
      ids.taskId,
      makeCreateInput(ids),
    )
    await harness.orchestrator.cancel(makeActor(ids.userId), run.id)

    // 迟到的合法历史事件（同 seq 未见过）：持久留证，但状态不动。
    await harness.orchestrator.ingestNodeEvent(
      harness.deviceFor(ids),
      runEventFrame(run.id, 1, { type: 'run.phase', phase: 'thinking' }),
    )
    expect((await getRun(database.db, run.id))?.status).toBe('cancelled')
  })

  it('approval flow: requested opens waiting_approval; last decision returns to running', async () => {
    const ids = await seedRunPrereqs(database.db)
    const harness = makeHarness(database)
    const run = await harness.orchestrator.create(
      makeActor(ids.userId),
      ids.taskId,
      makeCreateInput(ids),
    )
    await harness.pump(ids)
    await harness.orchestrator.ingestNodeEvent(
      harness.deviceFor(ids),
      runEventFrame(run.id, 1, { type: 'runtime.ready', dshSessionId: 's-1' }),
    )

    const approvalId = '00000000-0000-4000-8000-0000000aa001'
    await harness.orchestrator.ingestNodeEvent(
      harness.deviceFor(ids),
      runEventFrame(run.id, 2, {
        type: 'approval.requested',
        approval: {
          approvalId,
          runId: run.id,
          callId: 'call-1',
          toolName: 'fs.write',
          reason: 'needs to write a file',
          preview: { path: 'src/index.ts' },
          status: 'pending',
          requestedAt: new Date().toISOString(),
          expiresAt: new Date(Date.now() + 600_000).toISOString(),
        },
      }),
    )
    expect((await getRun(database.db, run.id))?.status).toBe('waiting_approval')

    await harness.orchestrator.ingestNodeEvent(
      harness.deviceFor(ids),
      runEventFrame(run.id, 3, {
        type: 'approval.decided',
        approvalId,
        status: 'allowed_once',
      }),
    )
    expect((await getRun(database.db, run.id))?.status).toBe('running')
    const [approval] = await database.db
      .select()
      .from(schema.approvals)
      .where(eq(schema.approvals.id, approvalId))
    expect(approval).toMatchObject({ status: 'allowed_once', decidedBy: ids.userId })
  })
})
