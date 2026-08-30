/**
 * 租约韧性（P1-16 R4/R5 + R9 的 Hub 侧；03 §3.2、04 断线矩阵）。
 *
 * 判定基线（FakeClock 推进时间 + FakeDeviceGateway/真实 reconcileLeases 路径）：
 * - R4：Node 断网 10 秒 → Run 保持原状态（连接投影未知，不误判 lost）；重连后
 *   继续收敛（runtime.ready → running）；
 * - R5：断开超过 30 秒租约 → lost(RUNTIME_LOST)；重连只上报历史——心跳、
 *   snapshot、迟到事件都不复活终态（事件持久留证，状态不动）；
 * - R9（Hub 半边）：Node 重启后上报 run.snapshot(lost, RUNTIME_LOST) → Run 落
 *   lost(RUNTIME_LOST)——Hub 不要求 Node 侧有任何「复活」命令。
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { Database } from '@project311/db'
import { getRun, listRunEvents, listTeamEvents } from '@project311/db'
import {
  createTestDatabase,
  heartbeatFrame,
  makeActor,
  makeCreateInput,
  makeHarness,
  resetDatabase,
  runEventFrame,
  seedRunPrereqs,
  type SeedIds,
} from '../helpers.js'

let database: Database
let ids: SeedIds

beforeAll(async () => {
  database = await createTestDatabase()
})
beforeEach(async () => {
  await resetDatabase(database)
  ids = await seedRunPrereqs(database.db)
})
afterAll(async () => {
  await database.close()
})

/** 建一条 Run 并推进到 dispatching（ack 已回），设备租约刚刷新。 */
async function dispatchingRun() {
  const harness = makeHarness(database)
  const run = await harness.orchestrator.create(
    makeActor(ids.userId),
    ids.taskId,
    makeCreateInput(ids),
  )
  await harness.pump(ids) // run.start → ack → dispatching；ingest 刷新 lastSeenAt
  return { harness, run }
}

function snapshotLost(runId: string): unknown {
  return {
    protocolVersion: 1,
    messageId: '20000000-0000-4000-8000-000000000001',
    sentAt: new Date().toISOString(),
    type: 'run.snapshot',
    payload: {
      runId,
      taskId: ids.taskId,
      ownerUserId: ids.userId,
      agentId: ids.agentId,
      profileRevisionId: ids.revisionId,
      deviceId: ids.deviceId,
      workspaceId: ids.workspaceId,
      dshSessionId: null,
      status: 'lost',
      failureCode: 'RUNTIME_LOST',
      failureSummary: 'runtime orphaned after node restart',
      rerunOfRunId: null,
      profileDigest: 'b'.repeat(64),
      pluginPackDigest: 'a'.repeat(64),
      dshDistributionVersion: '0.1.0-rc.8',
      createdAt: new Date().toISOString(),
      startedAt: null,
      finishedAt: new Date().toISOString(),
    },
  }
}

describe('R4: 10s disconnect must not mark the run lost', () => {
  it('keeps the run in its current state while the lease is fresh; reconnect converges', async () => {
    const { harness, run } = await dispatchingRun()
    // 断网前最后一条心跳：Run 活跃。
    await harness.orchestrator.ingestNodeEvent(
      harness.deviceFor(ids),
      heartbeatFrame(ids.deviceId, [run.id]),
    )

    // 断网 10 秒：无任何上行帧。租约（30s）未过期 → Run 不得被标记 lost。
    harness.clock.advance(10_000)
    const acted = await harness.orchestrator.reconcileLeases(harness.clock.now())
    expect(acted).toBeGreaterThanOrEqual(0)
    const afterBlink = await getRun(database.db, run.id)
    expect(afterBlink?.status).toBe('dispatching')
    expect(afterBlink?.failureCode).toBeNull()

    // 重连继续：runtime.ready → running（没有 lost 插足）。
    await harness.orchestrator.ingestNodeEvent(
      harness.deviceFor(ids),
      runEventFrame(run.id, 1, { type: 'runtime.ready', dshSessionId: 's-r4' }),
    )
    const afterReconnect = await getRun(database.db, run.id)
    expect(afterReconnect?.status).toBe('running')

    const events = await listTeamEvents(database.db)
    const statuses = events
      .filter((event) => event.type === 'run.changed')
      .map((event) => (event.payload as { status?: string }).status)
    expect(statuses).not.toContain('lost')
  })

  it('a fresh heartbeat that still reports the run keeps it alive across reconcile rounds', async () => {
    const { harness, run } = await dispatchingRun()
    await harness.orchestrator.ingestNodeEvent(
      harness.deviceFor(ids),
      heartbeatFrame(ids.deviceId, [run.id]),
    )
    for (let round = 0; round < 3; round += 1) {
      harness.clock.advance(10_000)
      await harness.orchestrator.ingestNodeEvent(
        harness.deviceFor(ids),
        heartbeatFrame(ids.deviceId, [run.id]),
      )
      await harness.orchestrator.reconcileLeases(harness.clock.now())
    }
    expect((await getRun(database.db, run.id))?.status).toBe('dispatching')
  })
})

describe('R5: >30s lease expiry marks lost; reconnect never revives terminal', () => {
  it('marks the run lost(RUNTIME_LOST) after 31s of silence', async () => {
    const { harness, run } = await dispatchingRun()

    harness.clock.advance(31_000)
    await harness.orchestrator.reconcileLeases(harness.clock.now())

    const lost = await getRun(database.db, run.id)
    expect(lost?.status).toBe('lost')
    expect(lost?.failureCode).toBe('RUNTIME_LOST')
    expect(lost?.finishedAt).not.toBeNull()
    const events = await listTeamEvents(database.db)
    expect(
      events.some(
        (event) =>
          event.type === 'run.changed' && (event.payload as { status?: string }).status === 'lost',
      ),
    ).toBe(true)
  })

  it('a node that heartbeats without the run loses it (heartbeat projection path)', async () => {
    const { harness, run } = await dispatchingRun()
    await harness.orchestrator.ingestNodeEvent(
      harness.deviceFor(ids),
      heartbeatFrame(ids.deviceId, [run.id]),
    )
    // Node 在线且心跳新鲜，但 activeRunIds 已不含该 Run（重启后 Runtime 没了）。
    await harness.orchestrator.ingestNodeEvent(
      harness.deviceFor(ids),
      heartbeatFrame(ids.deviceId, []),
    )
    harness.clock.advance(1_000)
    await harness.orchestrator.reconcileLeases(harness.clock.now())

    const lost = await getRun(database.db, run.id)
    expect(lost?.status).toBe('lost')
    expect(lost?.failureCode).toBe('RUNTIME_LOST')
  })

  it('after lost: heartbeat, snapshot and late events never revive the terminal run', async () => {
    const { harness, run } = await dispatchingRun()
    harness.clock.advance(31_000)
    await harness.orchestrator.reconcileLeases(harness.clock.now())
    expect((await getRun(database.db, run.id))?.status).toBe('lost')

    // 1) 重连心跳声称 Run 仍活跃 → 终态不参与 reconcile 扫描。
    await harness.orchestrator.ingestNodeEvent(
      harness.deviceFor(ids),
      heartbeatFrame(ids.deviceId, [run.id]),
    )
    await harness.orchestrator.reconcileLeases(harness.clock.now())
    expect((await getRun(database.db, run.id))?.status).toBe('lost')

    // 2) Node 重启后上报历史 snapshot（status=running）→ 终态一律忽略。
    await harness.orchestrator.ingestNodeEvent(harness.deviceFor(ids), {
      protocolVersion: 1,
      messageId: '20000000-0000-4000-8000-000000000002',
      sentAt: new Date().toISOString(),
      type: 'run.snapshot',
      payload: {
        runId: run.id,
        taskId: ids.taskId,
        ownerUserId: ids.userId,
        agentId: ids.agentId,
        profileRevisionId: ids.revisionId,
        deviceId: ids.deviceId,
        workspaceId: ids.workspaceId,
        dshSessionId: 's-stale',
        status: 'running',
        failureCode: null,
        failureSummary: null,
        rerunOfRunId: null,
        profileDigest: 'b'.repeat(64),
        pluginPackDigest: 'a'.repeat(64),
        dshDistributionVersion: '0.1.0-rc.8',
        createdAt: new Date().toISOString(),
        startedAt: new Date().toISOString(),
        finishedAt: null,
      },
    })
    expect((await getRun(database.db, run.id))?.status).toBe('lost')

    // 3) 迟到的 runtime.ready 事件：持久留证，但状态不迁移。
    const before = (await listRunEvents(database.db, run.id)).length
    await harness.orchestrator.ingestNodeEvent(
      harness.deviceFor(ids),
      runEventFrame(run.id, 1, { type: 'runtime.ready', dshSessionId: 's-late' }),
    )
    expect((await getRun(database.db, run.id))?.status).toBe('lost')
    const after = await listRunEvents(database.db, run.id)
    expect(after.length).toBe(before + 1) // 事件留证
    expect(after.some((event) => event.type === 'runtime.ready')).toBe(true)
  })
})

describe('R9 (hub side): node-reported lost snapshot converges the run', () => {
  it('applies lost(RUNTIME_LOST) from a run.snapshot after node restart kills the orphan', async () => {
    const { harness, run } = await dispatchingRun()

    await harness.orchestrator.ingestNodeEvent(harness.deviceFor(ids), snapshotLost(run.id))

    const lost = await getRun(database.db, run.id)
    expect(lost?.status).toBe('lost')
    expect(lost?.failureCode).toBe('RUNTIME_LOST')
    expect(lost?.failureSummary).toContain('orphaned after node restart')

    // 之后任何迟到事实都不复活（与 R5 同一禁复活语义）。
    await harness.orchestrator.ingestNodeEvent(
      harness.deviceFor(ids),
      runEventFrame(run.id, 1, { type: 'runtime.ready', dshSessionId: 's-orphan' }),
    )
    expect((await getRun(database.db, run.id))?.status).toBe('lost')
  })

  it('a queued run is never touched by a node-reported lost snapshot (invalid edge skipped)', async () => {
    const harness = makeHarness(database)
    const run = await harness.orchestrator.create(
      makeActor(ids.userId),
      ids.taskId,
      makeCreateInput(ids),
    )
    await harness.orchestrator.ingestNodeEvent(harness.deviceFor(ids), snapshotLost(run.id))
    // queued → lost 不是合法边：跳过（陈旧投影），Run 保持 queued 等待派发语义。
    expect((await getRun(database.db, run.id))?.status).toBe('queued')
  })
})
