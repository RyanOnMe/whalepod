import { randomUUID } from 'node:crypto'
import { eq } from 'drizzle-orm'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { Database } from '@whalepod/db'
import { listMessages, schema, setRunStatus } from '@whalepod/db'
import { sendRunFollowup } from '../src/modules/run/followup.js'
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
 * 本文件同时用 `FakeDeviceGateway.refuseCommand` 复刻 Node 的这条守卫：若将来有人把下发
 * 提前回去，用例会以「消息被拒」的形态变红（而不是静默通过）。
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

  /** 复刻 Node 的受理守卫：Run 不在 running 就拒绝下行命令。 */
  const refuseUnlessRunning = (runId: string) => async () => {
    const rows = await database.db
      .select({ status: schema.runs.status })
      .from(schema.runs)
      .where(eq(schema.runs.id, runId))
    const status = rows[0]?.status
    if (status === 'running') return undefined
    return {
      code: 'INVALID_RUN_TRANSITION' as const,
      message: `run is ${status ?? 'unknown'}; runtime.ready has not arrived`,
    }
  }

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

  it('二次进入 running（审批往返）不重复下发旧指令，且 waiting_approval 窗口照旧排队', async () => {
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

    // ① dispatching → running：补发第一句。
    await feed(1, { type: 'runtime.ready', dshSessionId: 'dsh-1' })
    const afterFirst = await database.db
      .select()
      .from(schema.dispatchOutbox)
      .where(eq(schema.dispatchOutbox.type, 'run.followup'))
    expect(afterFirst.map((row) => row.messageId)).toEqual([first.id])

    // ② running → waiting_approval：此时说话**只排队**（审批阻塞的执行路径不得塞追问）。
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

    // ③ 审批通过 → 回到 running：只补发第二句；第一句**不得**再入队一次（幂等靠 message_id）。
    await feed(3, {
      type: 'approval.decided',
      approvalId: (await database.db.select().from(schema.approvals))[0]?.id ?? randomUUID(),
      status: 'allowed_once',
    })
    const afterSecond = await database.db
      .select()
      .from(schema.dispatchOutbox)
      .where(eq(schema.dispatchOutbox.type, 'run.followup'))
      .orderBy(schema.dispatchOutbox.id)
    expect(afterSecond.map((row) => row.messageId)).toEqual([first.id, second.id])
    // 第一句的命令 id 没变（不是「又发了一次、消息 id 相同」）。
    expect(afterSecond[0]?.id).toBe(afterFirst[0]?.id)
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
