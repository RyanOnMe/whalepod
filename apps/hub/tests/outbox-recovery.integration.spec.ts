import { eq } from 'drizzle-orm'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { Database } from '@whalepod/db'
import { getRun, schema } from '@whalepod/db'
import { OutboxWorker } from '../src/modules/run/index.js'
import {
  createTestDatabase,
  heartbeatFrame,
  makeActor,
  makeCreateInput,
  makeHarness,
  resetDatabase,
  runEventFrame,
  seedRunPrereqs,
} from './helpers.js'

// R7（ack 丢失重发，commandId 稳定，Node 不重复执行）与 R8（提交后 Hub 崩溃，
// worker 重启继续派发）；reconciler 租约与补命令语义（02 Task 10 Step 6）。
describe('outbox recovery (R7/R8)', () => {
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

  it('R7: resends the same commandId after a lost ack and the Node does not start a second runtime', async () => {
    const ids = await seedRunPrereqs(database.db)
    const harness = makeHarness(database, { autoAck: false })
    const run = await harness.orchestrator.create(
      makeActor(ids.userId),
      ids.taskId,
      makeCreateInput(ids),
    )

    // 第一次派发：Node 已执行，但 ack 丢失（autoAck=false）。
    await harness.worker.dispatchOnce()
    expect(harness.gateway.runtimeStartCount).toBe(1)
    const firstCommandId =
      harness.gateway.sent[0]?.frame.type === 'run.start'
        ? harness.gateway.sent[0].frame.payload.commandId
        : undefined
    expect(firstCommandId).toBeDefined()

    // ack 一直没来；退避到期后重发同一条命令（commandId 不变，03 §2.6 / 02 Step 4）。
    harness.clock.advance(60_000)
    await harness.worker.dispatchOnce()
    expect(harness.gateway.sent).toHaveLength(2)
    const resent = harness.gateway.sent[1]?.frame
    expect(resent?.type).toBe('run.start')
    if (resent?.type !== 'run.start') throw new Error('unreachable')
    expect(resent.payload.commandId).toBe(firstCommandId)
    // R7 失败判据：不得启动第二 Runtime。
    expect(harness.gateway.runtimeStartCount).toBe(1)

    // Node 按 commandId 返回旧 ack；ack 送达后 Run 正常推进。
    harness.gateway.autoAck = true
    harness.clock.advance(60_000)
    await harness.pump(ids)
    expect(harness.gateway.runtimeStartCount).toBe(1)
    expect((await getRun(database.db, run.id))?.status).toBe('dispatching')
  })

  it('R8: a worker restarted after a hub crash continues dispatching committed commands', async () => {
    const ids = await seedRunPrereqs(database.db)
    const harness = makeHarness(database)
    const run = await harness.orchestrator.create(
      makeActor(ids.userId),
      ids.taskId,
      makeCreateInput(ids),
    )
    // 事务已提交、Hub 崩溃：worker 从未运行，outbox 行仍在表里（表即事实来源）。
    expect(harness.gateway.sent).toHaveLength(0)

    // 「重启」= 全新的 worker / orchestrator 实例，只共享数据库。
    const recovered = makeHarness(database)
    const ensured = await recovered.orchestrator.reconcileLeases(recovered.clock.now())
    expect(ensured).toBe(0) // 行已在，健康 queued Run 不需要补救
    await recovered.pump(ids)

    expect(recovered.gateway.runtimeStartCount).toBe(1)
    expect((await getRun(database.db, run.id))?.status).toBe('dispatching')
  })

  it('reconciler marks runs lost when the device lease has expired (03 §3.2, 30s)', async () => {
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
    expect((await getRun(database.db, run.id))?.status).toBe('running')

    // 设备 31 秒无心跳（lastSeenAt 停在租约窗外）。
    await database.db
      .update(schema.devices)
      .set({ lastSeenAt: new Date(harness.clock.now().getTime() - 31_000) })
      .where(eq(schema.devices.id, ids.deviceId))
    const reconciled = await harness.orchestrator.reconcileLeases(harness.clock.now())

    expect(reconciled).toBe(1)
    const lost = await getRun(database.db, run.id)
    expect(lost).toMatchObject({ status: 'lost', failureCode: 'RUNTIME_LOST' })
    expect(lost?.finishedAt).not.toBeNull()
    // 终态禁止复活：再次 reconcile 不再触碰。
    expect(await harness.orchestrator.reconcileLeases(harness.clock.now())).toBe(0)
    expect((await getRun(database.db, run.id))?.status).toBe('lost')
  })

  it('a heartbeat refreshes the device lease and keeps the run alive', async () => {
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

    await harness.orchestrator.ingestNodeEvent(
      harness.deviceFor(ids),
      heartbeatFrame(ids.deviceId, [run.id]),
    )
    const acted = await harness.orchestrator.reconcileLeases(harness.clock.now())
    expect((await getRun(database.db, run.id))?.status).toBe('running')
    // 活跃 Run 在在线设备上：reconciler 补一条 run.status_request 探活。
    const statusRequests = await database.db
      .select()
      .from(schema.dispatchOutbox)
      .where(eq(schema.dispatchOutbox.type, 'run.status_request'))
    expect(statusRequests.length + acted).toBeGreaterThan(0)
  })

  it('reconciler re-enqueues a missing run.start for a queued run (defensive, crash window)', async () => {
    const ids = await seedRunPrereqs(database.db)
    const harness = makeHarness(database)
    const run = await harness.orchestrator.create(
      makeActor(ids.userId),
      ids.taskId,
      makeCreateInput(ids),
    )
    // 模拟崩溃窗口里行被标记 failed（例如旧实现的 supersede）：queued Run 不能永久无命令（R8 判据）。
    const [row] = await database.db.select().from(schema.dispatchOutbox)
    await harness.outbox.fail(row?.id ?? '')

    const acted = await harness.orchestrator.reconcileLeases(harness.clock.now())
    expect(acted).toBe(1)
    const pending = await database.db.select().from(schema.dispatchOutbox)
    expect(
      pending.some(
        (candidate) =>
          candidate.type === 'run.start' &&
          candidate.ackedAt === null &&
          candidate.failedAt === null,
      ),
    ).toBe(true)
    await harness.pump(ids)
    expect(harness.gateway.runtimeStartCount).toBe(1)
    expect((await getRun(database.db, run.id))?.status).toBe('dispatching')
  })

  it('R8 判据兜底：reconcile + worker 后不存在永远没有命令的 queued Run', async () => {
    const ids = await seedRunPrereqs(database.db)
    const harness = makeHarness(database)
    await harness.orchestrator.create(makeActor(ids.userId), ids.taskId, makeCreateInput(ids))

    const recovered = makeHarness(database)
    await recovered.orchestrator.reconcileLeases(recovered.clock.now())
    await recovered.pump(ids)

    const [run] = await database.db.select().from(schema.runs)
    expect(run?.status).not.toBe('queued')
    const unacked = await database.db
      .select()
      .from(schema.dispatchOutbox)
      .where(eq(schema.dispatchOutbox.type, 'run.start'))
    expect(unacked.every((row) => row.ackedAt !== null)).toBe(true)
  })
})
