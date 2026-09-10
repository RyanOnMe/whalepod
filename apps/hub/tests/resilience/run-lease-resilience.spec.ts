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
import type { Database } from '@whalepod/db'
import { getRun, listRunEvents, listTeamEvents, schema } from '@whalepod/db'
import { eq } from 'drizzle-orm'
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
    // #119：nodeLostRun 臂只适用于「心跳有过机会列出它」的 Run——先把时钟
    // 推进过宽限期（30s，与 DEVICE_LEASE_MS 同口径），再造空心跳，隔离臂语义。
    harness.clock.advance(31_000)
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

  it('#119 新生儿宽限：刚派发的 Run 不在当次心跳里是正常窗口，不得判 lost', async () => {
    // alpha.2 狗食实录（三跑三判 lost，最速 +353ms）：run.start ack 后节点要
    // 等下一个 10s 心跳才有机会把 Run 列进 activeRunIds；若 reconcile 恰好
    // 落在窗口内，nodeLostRun（心跳新鲜+未列出）直接把活 Run 打成 lost，
    // 且事件继续落账（runtime.ready 在 lost 之后 415ms 仍被收录）——僵尸 Run。
    const { harness, run } = await dispatchingRun()
    await harness.orchestrator.ingestNodeEvent(
      harness.deviceFor(ids),
      heartbeatFrame(ids.deviceId, []), // 节点还来不及列出新 Run（正常窗口）
    )
    harness.clock.advance(1_000)
    await harness.orchestrator.reconcileLeases(harness.clock.now())

    const alive = await getRun(database.db, run.id)
    expect(alive?.status).toBe('dispatching')
    // 宽限期后心跳仍不含 → 才允许判 lost（边界互补钉死）。
    harness.clock.advance(31_000)
    await harness.orchestrator.ingestNodeEvent(
      harness.deviceFor(ids),
      heartbeatFrame(ids.deviceId, []),
    )
    harness.clock.advance(1_000)
    await harness.orchestrator.reconcileLeases(harness.clock.now())
    expect((await getRun(database.db, run.id))?.status).toBe('lost')
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

describe('#88: 终态 Run 仍被心跳报 active → 收敛 run.cancel(admin) 回收 Runtime', () => {
  it('lost 后重连心跳仍列出该 Run → 入队 admin run.cancel；账本状态不动（禁复活）', async () => {
    const { harness, run } = await dispatchingRun()
    harness.clock.advance(31_000)
    await harness.orchestrator.reconcileLeases(harness.clock.now())
    expect((await getRun(database.db, run.id))?.status).toBe('lost')

    // Node 重连：本地 Runtime 还在（如等审批），心跳如实列出 → Hub 发收敛取消。
    await harness.orchestrator.ingestNodeEvent(
      harness.deviceFor(ids),
      heartbeatFrame(ids.deviceId, [run.id]),
    )
    await harness.worker.dispatchOnce()

    const cancels = harness.gateway.sent.filter(
      (f) => f.frame.type === 'run.cancel' && f.frame.payload.runId === run.id,
    )
    expect(cancels).toHaveLength(1)
    expect(
      (cancels[0]!.frame as Extract<(typeof cancels)[0]['frame'], { type: 'run.cancel' }>).payload
        .cause,
    ).toBe('admin')
    // 账本不动：无状态迁移、无 run.changed 重开。
    expect((await getRun(database.db, run.id))?.status).toBe('lost')
    expect((await getRun(database.db, run.id))?.failureCode).toBe('RUNTIME_LOST')
  })

  it('同一 Run 的收敛取消只入队一次（心跳每 10s 一拍，不得刷出重发风暴）', async () => {
    const { harness, run } = await dispatchingRun()
    harness.clock.advance(31_000)
    await harness.orchestrator.reconcileLeases(harness.clock.now())

    // pump = dispatchOnce + ack 回流处理：ack 后 outbox 行收敛，不再重发；
    // 后续心跳命中进程内去重，不再入队第二条。
    for (let round = 0; round < 3; round += 1) {
      harness.clock.advance(10_000)
      await harness.orchestrator.ingestNodeEvent(
        harness.deviceFor(ids),
        heartbeatFrame(ids.deviceId, [run.id]),
      )
      await harness.pump(ids)
    }
    const cancels = harness.gateway.sent.filter(
      (f) => f.frame.type === 'run.cancel' && f.frame.payload.runId === run.id,
    )
    expect(cancels).toHaveLength(1)
  })

  it('非终态 Run 照常出现在心跳里 → 绝不误发收敛取消', async () => {
    const { harness, run } = await dispatchingRun()
    await harness.orchestrator.ingestNodeEvent(
      harness.deviceFor(ids),
      heartbeatFrame(ids.deviceId, [run.id]),
    )
    await harness.worker.dispatchOnce()
    const cancels = harness.gateway.sent.filter((f) => f.frame.type === 'run.cancel')
    expect(cancels).toHaveLength(0)
    expect((await getRun(database.db, run.id))?.status).toBe('dispatching')
  })
})

describe('#84: 不变式补洞——lease→lost 路径同样折叠 pending Approval', () => {
  it('waiting_approval 的 Run 被判 lost 时，悬置审批同事务折叠（run_terminal_fold）', async () => {
    const { harness, run } = await dispatchingRun()
    await harness.orchestrator.ingestNodeEvent(
      harness.deviceFor(ids),
      runEventFrame(run.id, 1, { type: 'runtime.ready', dshSessionId: 's-84' }),
    )
    const approvalId = '00000000-0000-4000-8000-0000000aa084'
    await harness.orchestrator.ingestNodeEvent(
      harness.deviceFor(ids),
      runEventFrame(run.id, 2, {
        type: 'approval.requested',
        approval: {
          approvalId,
          runId: run.id,
          callId: 'call-84',
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

    // 断链超租约 → reconcile 判 lost。不变式（ADR-0007）：终态 Run 不挂
    // pending Approval——lease→lost 路径不得例外（此前靠 approval-expiry
    // 10 分钟清扫兜底，窗口内账本违反不变式）。
    harness.clock.advance(31_000)
    await harness.orchestrator.reconcileLeases(harness.clock.now())

    const lost = await getRun(database.db, run.id)
    expect(lost?.status).toBe('lost')
    const [approval] = await database.db
      .select()
      .from(schema.approvals)
      .where(eq(schema.approvals.id, approvalId))
    expect(approval?.status).toBe('cancelled') // 折叠，不是 expired/rejected（无人做决定）
    const events = await listTeamEvents(database.db)
    const fold = events.find(
      (event) =>
        event.type === 'approval.changed' &&
        (event.payload as { approvalId?: string; status?: string }).approvalId === approvalId &&
        (event.payload as { status?: string }).status === 'cancelled',
    )
    expect(fold).toBeDefined()
    expect((fold!.payload as { cause?: string }).cause).toBe('run_terminal_fold')
  })
})
