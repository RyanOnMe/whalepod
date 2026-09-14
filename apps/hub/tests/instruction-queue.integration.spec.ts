import { randomUUID } from 'node:crypto'
import { eq } from 'drizzle-orm'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { Database } from '@whalepod/db'
import { insertMessage, listMessages, schema, setRunStatus } from '@whalepod/db'
import { dispatchPendingInstructions, sendRunFollowup } from '../src/modules/run/followup.js'
import { expireApprovals } from '../src/modules/run/approval-expiry.js'
import {
  createTestDatabase,
  makeActor,
  makeCreateInput,
  makeHarness,
  resetDatabase,
  runEventFrame,
  seedRunPrereqs,
} from './helpers.js'

/**
 * P1-192 切片③c-1：Hub 侧的**真排队**（ADR-0009 决策 5；修 #189）。
 *
 * 验的是「Run 还没到 running 时说话」这条链：
 *   未 running 的窗口 → 只落 `pending`、**不下发命令** → Run 进 running 时按序补发 → ack 收敛。
 *
 * 为什么必须钉死（#189 实测）：③b 把「排队」实现成了「标 pending 但命令立刻入队」，而 Node 在
 * Run 未到 `runtime.ready` 时会**拒绝**该命令（`apps/node/src/run/run-manager.ts:392`
 * → `INVALID_RUN_TRANSITION`）→ 消息被写成 rejected，与决策 5「接着说永远成立」相反。
 * Node 那条守卫本身由 `FakeDeviceGateway.refuseCommand` 的复刻判据覆盖
 *（`packages/testkit/tests/fake-device-gateway.spec.ts`，4 条）；本文件只验 Hub 侧行为，
 * **不**注入该守卫（它对所有帧生效，会把正常链路的 `run.start` 也拒掉）。
 */
describe('instruction queue (P1-192)', () => {
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

  async function seedRun(
    status: 'queued' | 'dispatching' | 'running' | 'waiting_approval' = 'queued',
  ) {
    const ids = await seedRunPrereqs(database.db)
    const harness = makeHarness(database)
    const run = await harness.orchestrator.create(
      makeActor(ids.userId),
      ids.taskId,
      makeCreateInput(ids),
    )
    // 让 run.start 出队，避免它的 ack 与命令干扰本用例对 outbox 的断言。
    await harness.outbox.claim()
    if (status !== 'queued') await setRunStatus(database.db, run.id, status)
    return { ids, harness, run }
  }

  const queuedStatuses = ['queued', 'dispatching', 'waiting_approval'] as const

  for (const status of queuedStatuses) {
    it(`${status}：受理但**不下发**——消息 pending、outbox 里 0 条 run.followup`, async () => {
      const { ids, harness, run } = await seedRun(status)

      const message = await sendRunFollowup(
        database,
        harness.outbox,
        makeActor(ids.userId),
        run.id,
        { text: '接着说一句', idempotencyKey: `k-${status}` },
      )

      // 落账：消息在，状态 pending（受理≠送达），没有错误码。
      expect(message).toMatchObject({
        kind: 'followup',
        runId: run.id,
        instructionState: 'pending',
        instructionErrorCode: null,
      })
      // 关键：**一条命令都不许入队**。下发就会在 Node 侧被拒（run-manager.ts:392）。
      const commands = await database.db
        .select()
        .from(schema.dispatchOutbox)
        .where(eq(schema.dispatchOutbox.type, 'run.followup'))
      expect(commands).toEqual([])
    })
  }

  it('Run 进 running：排队的追问按 (created_at, id) 顺序补发，载荷即 wire 帧', async () => {
    const { ids, harness, run } = await seedRun('queued')
    const actor = makeActor(ids.userId)

    // 排队窗口里说两句（第一句进 waiting_approval 窗口，第二句在 dispatching 窗口）。
    const first = await sendRunFollowup(database, harness.outbox, actor, run.id, {
      text: '第一句：先跑 macOS 冒烟',
      idempotencyKey: 'q1',
    })
    await setRunStatus(database.db, run.id, 'dispatching')
    const second = await sendRunFollowup(database, harness.outbox, actor, run.id, {
      text: '第二句：再补 Windows',
      idempotencyKey: 'q2',
    })
    expect(
      (
        await database.db
          .select()
          .from(schema.dispatchOutbox)
          .where(eq(schema.dispatchOutbox.type, 'run.followup'))
      ).length,
    ).toBe(0)

    // 走真人路径推进：Node 上报 runtime.ready（dispatching → running）。
    await harness.orchestrator.ingestNodeEvent(
      harness.deviceFor(ids),
      runEventFrame(run.id, 1, { type: 'runtime.ready', dshSessionId: 'dsh-session-q' }),
    )

    const commands = await database.db
      .select()
      .from(schema.dispatchOutbox)
      .where(eq(schema.dispatchOutbox.type, 'run.followup'))
    expect(commands).toHaveLength(2)
    // 顺序 = 线程顺序：先入队第一句，再第二句（不允许倒序或乱序）。
    expect(commands.map((row) => row.messageId)).toEqual([first.id, second.id])
    expect(commands.map((row) => (row.payload as { text: string }).text)).toEqual([
      '第一句：先跑 macOS 冒烟',
      '第二句：再补 Windows',
    ])
    // 载荷逐字即 wire 帧（不得夹带 Hub 内部字段）。
    for (const row of commands) {
      expect(row.payload).toEqual({
        commandId: row.id,
        runId: run.id,
        text: (row.payload as { text: string }).text,
      })
    }
    // 消息仍 pending：入队≠受理，受理由 ack 决定（决策 3 的语义强度）。
    const stillPending = await listMessages(database.db, ids.taskId)
    expect(stillPending.every((row) => row.instructionState === 'pending')).toBe(true)

    // 派发 + ack → 两条都 accepted。
    await harness.worker.dispatchOnce()
    for (const upstream of harness.gateway.drainUpstream()) {
      await harness.orchestrator.ingestNodeEvent(harness.deviceFor(ids), upstream)
    }
    const settled = await listMessages(database.db, ids.taskId)
    expect(settled.map((row) => row.instructionState)).toEqual(['accepted', 'accepted'])
  })

  it('**真人路径**：审批窗口排队 → HTTP 决策通过（decideApproval）→ 补齐下发，且不重复发旧的', async () => {
    const { ids, harness, run } = await seedRun('dispatching')
    const actor = makeActor(ids.userId)
    const first = await sendRunFollowup(database, harness.outbox, actor, run.id, {
      text: '第一句（running 前说的）',
      idempotencyKey: 'first',
    })

    const feed = (seq: number, event: Parameters<typeof runEventFrame>[2]) =>
      harness.orchestrator.ingestNodeEvent(
        harness.deviceFor(ids),
        runEventFrame(run.id, seq, event),
      )

    // ① dispatching → running：下发第一句。
    await feed(1, { type: 'runtime.ready', dshSessionId: 'dsh-1' })
    const afterFirst = await database.db
      .select()
      .from(schema.dispatchOutbox)
      .where(eq(schema.dispatchOutbox.type, 'run.followup'))
    expect(afterFirst.map((row) => row.messageId)).toEqual([first.id])

    // ② running → waiting_approval：此时说话只排队。
    const approvalId = randomUUID()
    await feed(2, {
      type: 'approval.requested',
      approval: {
        approvalId,
        runId: run.id,
        callId: randomUUID(),
        toolName: 'bash',
        reason: 'needs rm',
        preview: { command: 'rm -rf <workspace>/build' },
        status: 'pending',
        requestedAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 600_000).toISOString(),
      },
    })
    const second = await sendRunFollowup(database, harness.outbox, actor, run.id, {
      text: '第二句（审批中说的）',
      idempotencyKey: 'second',
    })
    expect(
      await database.db
        .select()
        .from(schema.dispatchOutbox)
        .where(eq(schema.dispatchOutbox.type, 'run.followup')),
    ).toHaveLength(1)

    // ③ **走真人主路径**：审批决策由 HTTP 深模块在**同一事务**里把 Run 置回 running
    //   （评审 B1：这里若不收口，第二句会永远吊在 pending，直到终态被写成「没受理」）。
    await harness.orchestrator.decideApproval(actor, approvalId, 'allowed_once')

    const afterSecond = await database.db
      .select()
      .from(schema.dispatchOutbox)
      .where(eq(schema.dispatchOutbox.type, 'run.followup'))
      .orderBy(schema.dispatchOutbox.id)
    expect(afterSecond.map((row) => row.messageId).sort()).toEqual([first.id, second.id].sort())
    // 第一句的命令 id 没变（不是「又发了一次」）。
    expect(afterSecond.find((row) => row.messageId === first.id)?.id).toBe(afterFirst[0]?.id)
  })

  it('**reconciler 探活路径**：快照把 dispatching → running 时，排队的追问同样被放行', async () => {
    const { ids, harness, run } = await seedRun('dispatching')
    const message = await sendRunFollowup(database, harness.outbox, makeActor(ids.userId), run.id, {
      text: '探活前说的',
      idempotencyKey: 'snap',
    })
    expect(message.instructionState).toBe('pending')

    // 用 DB 里的**真实 runs 行**构造快照（`orchestrator.create` 的返回值不是该行的完整形状）。
    const [fresh] = await database.db.select().from(schema.runs).where(eq(schema.runs.id, run.id))
    if (fresh === undefined) throw new Error('run disappeared')

    // Node 对 run.status_request 的应答：快照 status=running（snapshotToEvent → runtime_ready）。
    await harness.orchestrator.ingestNodeEvent(harness.deviceFor(ids), {
      protocolVersion: 1,
      messageId: randomUUID(),
      sentAt: new Date().toISOString(),
      type: 'run.snapshot',
      // 注意：`run.snapshot` 的 payload **就是** RunSnapshot 本身
      //（`envelope('run.snapshot', RunSnapshotSchema)`），不是嵌套 {deviceId, snapshot}
      //——首版按嵌套写，被协议校验拒掉。
      payload: {
        runId: fresh.id,
        taskId: fresh.taskId,
        ownerUserId: fresh.ownerUserId,
        agentId: fresh.agentId,
        profileRevisionId: fresh.profileRevisionId,
        deviceId: fresh.deviceId,
        workspaceId: fresh.workspaceId,
        dshSessionId: null,
        status: 'running' as const,
        failureCode: null,
        failureSummary: null,
        rerunOfRunId: null,
        profileDigest: fresh.profileDigest,
        pluginPackDigest: fresh.pluginPackDigest,
        dshDistributionVersion: '0.0.0-test',
        createdAt: new Date(fresh.createdAt).toISOString(),
        startedAt: null,
        finishedAt: null,
      },
    })

    const [row] = await database.db.select().from(schema.runs).where(eq(schema.runs.id, run.id))
    expect(row?.status).toBe('running')
    const commands = await database.db
      .select()
      .from(schema.dispatchOutbox)
      .where(eq(schema.dispatchOutbox.type, 'run.followup'))
    expect(commands.map((command) => command.messageId)).toEqual([message.id])
  })

  it('**审批过期清扫路径**：过期回到 running 时同样放行排队指令', async () => {
    const { ids, harness, run } = await seedRun('dispatching')
    const feed = (seq: number, event: Parameters<typeof runEventFrame>[2]) =>
      harness.orchestrator.ingestNodeEvent(
        harness.deviceFor(ids),
        runEventFrame(run.id, seq, event),
      )
    await feed(1, { type: 'runtime.ready', dshSessionId: 'dsh-exp' })
    const expiresAt = new Date(Date.now() + 1000)
    await feed(2, {
      type: 'approval.requested',
      approval: {
        approvalId: randomUUID(),
        runId: run.id,
        callId: randomUUID(),
        toolName: 'bash',
        reason: 'needs rm',
        preview: { command: 'rm -rf <workspace>/build' },
        status: 'pending',
        requestedAt: new Date().toISOString(),
        expiresAt: expiresAt.toISOString(),
      },
    })
    const message = await sendRunFollowup(database, harness.outbox, makeActor(ids.userId), run.id, {
      text: '审批过期前说的',
      idempotencyKey: 'exp',
    })
    expect(
      await database.db
        .select()
        .from(schema.dispatchOutbox)
        .where(eq(schema.dispatchOutbox.type, 'run.followup')),
    ).toHaveLength(0)

    // 过期清扫：waiting_approval → running（approval-expiry.ts）。
    await expireApprovals(
      { database, outbox: harness.outbox, now: () => new Date(expiresAt.getTime() + 1) },
      new Date(expiresAt.getTime() + 1),
    )

    const [row] = await database.db.select().from(schema.runs).where(eq(schema.runs.id, run.id))
    expect(row?.status).toBe('running')
    const commands = await database.db
      .select()
      .from(schema.dispatchOutbox)
      .where(eq(schema.dispatchOutbox.type, 'run.followup'))
    expect(commands.map((command) => command.messageId)).toEqual([message.id])
  })

  it('顺序判据（钉住 (created_at, id)，而非主键序或堆序）：created_at 与 id 顺序**故意相反**时按 created_at', async () => {
    const { ids, harness, run } = await seedRun('running')
    // 用 db 层直接插三条消息：id 由 uuidv7 递增（插入序），而 createdAt 故意倒着给——
    // 这样「按 id 排」「不排序（堆序）」都会得到不同结果，判据才真的钉住契约（评审 O1）。
    const base = Date.parse('2026-08-25T00:00:00.000Z')
    // 显式给 id（`task_message.id` 无默认值），并让 **id 序与 created_at 序相反**：
    // created_at 最早的那条拿**最大**的 id，最晚的拿**最小**的 id。
    // 这样「按 id 排」（orderBy(id)）与「不排序」（Postgres 返回插入/堆序 = 晚→中→早）
    // 都会红，判据才真的钉住 `(created_at, id)` 契约（评审 O1）。
    // 首版把 id 按同一方向分配（early→0001…late→0003），于是 orderBy(id) 仍全绿——判据自己错了。
    const idEarly = 'ffffffff-0000-7000-8000-000000000003'
    const idMiddle = 'ffffffff-0000-7000-8000-000000000002'
    const idLate = 'ffffffff-0000-7000-8000-000000000001'
    const make = (id: string, body: string, createdAt: number) =>
      insertMessage(database.db, {
        id,
        taskId: ids.taskId,
        authorUserId: ids.userId,
        body,
        kind: 'followup' as const,
        origin: 'human' as const,
        targetAgentId: ids.agentId,
        runId: run.id,
        instructionState: 'pending' as const,
        createdAt: new Date(createdAt),
      })
    // 插入顺序 = 晚→中→早（= 堆序），id 序与 created_at 序都与它不同。
    const late = await make(idLate, '最晚说的（created_at 最晚，id 最小）', base + 3000)
    const middle = await make(idMiddle, '中间说的', base + 2000)
    const early = await make(idEarly, '最早说的（created_at 最早，id 最大）', base + 1000)

    // 传**最新**的 Run 行：补发器自带「必须 running」断言（评审 S1），而 `run` 是创建时的
    // 快照（那时还是 queued）——这条断言正好也让「拿旧快照乱调」当场失败。
    const [freshRun] = await database.db
      .select()
      .from(schema.runs)
      .where(eq(schema.runs.id, run.id))
    if (freshRun === undefined) throw new Error('run disappeared')
    await dispatchPendingInstructions(database.db, harness.outbox, freshRun)

    const commands = await database.db
      .select()
      .from(schema.dispatchOutbox)
      .where(eq(schema.dispatchOutbox.type, 'run.followup'))
    // 线程顺序 = createdAt 顺序（早→晚），与插入序/id 序**不同**。
    expect(commands.map((row) => row.messageId)).toEqual([early.id, middle.id, late.id])
  })

  it('排队期间 Run 进终态：消息被清扫成 rejected(RUN_TERMINAL)，不会被永远吊在 pending', async () => {
    const { ids, harness, run } = await seedRun('waiting_approval')
    const message = await sendRunFollowup(database, harness.outbox, makeActor(ids.userId), run.id, {
      text: '取消前的最后一句话',
      idempotencyKey: 'term',
    })
    expect(message.instructionState).toBe('pending')

    // 审批被取消 → Run 进终态（setRunStatus 是终态收敛点，会清扫 pending）。
    await setRunStatus(database.db, run.id, 'cancelled', { finishedAt: new Date() })

    const [settled] = await listMessages(database.db, ids.taskId)
    expect(settled).toMatchObject({
      instructionState: 'rejected',
      instructionErrorCode: 'RUN_TERMINAL',
    })
    // 而且**始终没有**下发过：终态清扫不产生新命令。
    expect(
      await database.db
        .select()
        .from(schema.dispatchOutbox)
        .where(eq(schema.dispatchOutbox.type, 'run.followup')),
    ).toEqual([])
  })
})
