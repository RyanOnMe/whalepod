import { eq } from 'drizzle-orm'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { Database } from '@whalepod/db'
import { listMessages, listTeamEvents, schema, setRunStatus } from '@whalepod/db'
import { parseNodeFrame } from '@whalepod/protocol'
import { sendRunFollowup } from '../src/modules/run/followup.js'
import {
  createTestDatabase,
  makeActor,
  makeCreateInput,
  makeHarness,
  resetDatabase,
  seedRunPrereqs,
} from './helpers.js'

/**
 * P1-186 切片③b：Hub 侧的指令路径（ADR-0009 决策 3、5）。
 *
 * 验的是「往活跃 Run 里继续说话」这条链在 Hub 半场的全部事实：
 *   受理 → 线程消息落 pending + `run.followup` 命令入队 → Node ack → 消息状态收敛（含拒绝理由）。
 *
 * 状态机推进本身由 run-dispatch.spec 覆盖，这里用 `setRunStatus` 直接摆前置状态
 *（本片验的是追问受理，不是 queued→running 的迁移）。
 */
describe('run followup (P1-186)', () => {
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

  /** 建一个 Run 并摆到指定状态。 */
  async function seedRun(status: 'running' | 'waiting_approval' | 'completed' = 'running') {
    const ids = await seedRunPrereqs(database.db)
    const harness = makeHarness(database)
    const run = await harness.orchestrator.create(
      makeActor(ids.userId),
      ids.taskId,
      makeCreateInput(ids),
    )
    // 让已入队的 run.start 出队，避免它的 ack 干扰本用例对 outbox 的断言。
    await harness.outbox.claim()
    if (status !== 'queued') await setRunStatus(database.db, run.id, status)
    return { ids, harness, run }
  }

  it('running：受理 → 消息 pending + 命令入队（载荷即 wire 帧）→ ack → 消息 accepted', async () => {
    const { ids, harness, run } = await seedRun('running')

    const message = await sendRunFollowup(database, harness.outbox, makeActor(ids.userId), run.id, {
      text: '顺便把 macOS 的冒烟结果也补进去',
      idempotencyKey: 'k1',
    })
    expect(message).toMatchObject({
      kind: 'followup',
      origin: 'human',
      runId: run.id,
      targetAgentId: ids.agentId,
      instructionState: 'pending',
      instructionErrorCode: null,
    })

    // 命令入队：载荷与 node-wire 的 run.followup 帧**逐字一致**（不得夹带 Hub 内部字段），
    // commandId → 消息的映射落在 outbox 行的 message_id 上。
    const [pending] = await database.db
      .select()
      .from(schema.dispatchOutbox)
      .where(eq(schema.dispatchOutbox.type, 'run.followup'))
    expect(pending).toBeDefined()
    // 载荷**恰好**是 wire 帧载荷：多一个字段会被 Node 侧 schema 拒，少一个（尤其 commandId）
    // 会让 worker 的 NodeDownstreamSchema 校验失败、命令永不派发。
    expect(pending?.payload).toEqual({
      commandId: pending?.id,
      runId: run.id,
      text: '顺便把 macOS 的冒烟结果也补进去',
    })
    expect(pending?.messageId).toBe(message.id)

    // 派发：帧要过协议 schema（与真实 WS 同形）。
    await harness.worker.dispatchOnce()
    const sent = harness.gateway.sent.find((frame) => frame.frame.type === 'run.followup')
    expect(sent).toBeDefined()
    const frame = parseNodeFrame(JSON.parse(JSON.stringify(sent?.frame)), 'downstream')
    expect(frame.type).toBe('run.followup')
    if (frame.type !== 'run.followup') throw new Error('unreachable')
    expect(frame.payload).toMatchObject({
      commandId: pending?.id,
      runId: run.id,
      text: '顺便把 macOS 的冒烟结果也补进去',
    })

    // ack 未回前消息仍 pending：受理≠送达（决策 3 的语义强度）。
    expect((await listMessages(database.db, ids.taskId))[0]?.instructionState).toBe('pending')

    for (const upstream of harness.gateway.drainUpstream()) {
      await harness.orchestrator.ingestNodeEvent(harness.deviceFor(ids), upstream)
    }
    const [settled] = await listMessages(database.db, ids.taskId)
    expect(settled).toMatchObject({ instructionState: 'accepted', instructionErrorCode: null })
    // outbox 行同时落 ack（既有 outbox 语义不变）。
    const [acked] = await database.db
      .select()
      .from(schema.dispatchOutbox)
      .where(eq(schema.dispatchOutbox.id, pending?.id ?? ''))
    expect(acked?.ackedAt).not.toBeNull()
  })

  it('waiting_approval：受理但排队（进程还在，帧进 stdin 队列）', async () => {
    const { ids, harness, run } = await seedRun('waiting_approval')

    const message = await sendRunFollowup(database, harness.outbox, makeActor(ids.userId), run.id, {
      text: '审批完继续',
      idempotencyKey: 'k2',
    })
    expect(message.instructionState).toBe('pending')
    const rows = await database.db
      .select()
      .from(schema.dispatchOutbox)
      .where(eq(schema.dispatchOutbox.type, 'run.followup'))
    expect(rows).toHaveLength(1)
  })

  it('终态 Run：**不受理**——消息落 rejected + 理由，且不入队任何命令', async () => {
    const { ids, harness, run } = await seedRun('completed')

    const message = await sendRunFollowup(database, harness.outbox, makeActor(ids.userId), run.id, {
      text: '已经结束了还想说话',
      idempotencyKey: 'k3',
    })
    expect(message).toMatchObject({
      instructionState: 'rejected',
      instructionErrorCode: 'INVALID_RUN_TRANSITION',
    })
    expect(message.instructionErrorMessage).toContain('completed')
    // 不受理就绝不驱动：没有命令入队（否则终态 Run 会被注入一段话）。
    const rows = await database.db
      .select()
      .from(schema.dispatchOutbox)
      .where(eq(schema.dispatchOutbox.type, 'run.followup'))
    expect(rows).toEqual([])
  })

  it('Node 拒绝 ack：消息落 rejected 且理由来自 Node 的错误码（不冒充受理成功）', async () => {
    const { ids, harness, run } = await seedRun('running')
    await sendRunFollowup(database, harness.outbox, makeActor(ids.userId), run.id, {
      text: '这句会被 Node 拒',
      idempotencyKey: 'k4',
    })
    await harness.worker.dispatchOnce()
    const [command] = await database.db
      .select()
      .from(schema.dispatchOutbox)
      .where(eq(schema.dispatchOutbox.type, 'run.followup'))
    harness.gateway.drainUpstream() // 丢掉 fake 的 accepted ack，改发拒绝 ack

    await harness.orchestrator.ingestNodeEvent(harness.deviceFor(ids), {
      protocolVersion: 1,
      messageId: '00000000-0000-4000-8000-0000000000aa',
      sentAt: new Date().toISOString(),
      type: 'command.ack',
      payload: {
        commandId: command?.id ?? '',
        accepted: false,
        error: { code: 'RUNTIME_LOST', message: 'runtime process is not supervised' },
      },
    })

    const [settled] = await listMessages(database.db, ids.taskId)
    expect(settled).toMatchObject({
      instructionState: 'rejected',
      instructionErrorCode: 'RUNTIME_LOST',
      instructionErrorMessage: 'runtime process is not supervised',
    })
  })

  it('重复 ack（R7 重发重放）不二次改写既成事实', async () => {
    const { ids, harness, run } = await seedRun('running')
    await sendRunFollowup(database, harness.outbox, makeActor(ids.userId), run.id, {
      text: '只该结算一次',
      idempotencyKey: 'k5',
    })
    await harness.worker.dispatchOnce()
    const upstream = harness.gateway.drainUpstream()
    for (const frame of upstream) {
      await harness.orchestrator.ingestNodeEvent(harness.deviceFor(ids), frame)
    }
    // 再把同一批 ack 原样重放一遍。
    for (const frame of upstream) {
      await harness.orchestrator.ingestNodeEvent(harness.deviceFor(ids), frame)
    }
    const messages = await listMessages(database.db, ids.taskId)
    expect(messages).toHaveLength(1)
    expect(messages[0]?.instructionState).toBe('accepted')
  })

  it('同 Idempotency-Key 重放：不产生第二条消息、不二次入队', async () => {
    const { ids, harness, run } = await seedRun('running')
    const first = await sendRunFollowup(database, harness.outbox, makeActor(ids.userId), run.id, {
      text: '同一句话',
      idempotencyKey: 'k6',
    })
    const second = await sendRunFollowup(database, harness.outbox, makeActor(ids.userId), run.id, {
      text: '同一句话',
      idempotencyKey: 'k6',
    })
    expect(second.id).toBe(first.id)
    expect(await listMessages(database.db, ids.taskId)).toHaveLength(1)
    const rows = await database.db
      .select()
      .from(schema.dispatchOutbox)
      .where(eq(schema.dispatchOutbox.type, 'run.followup'))
    expect(rows).toHaveLength(1)
  })

  it('非责任人：403 FORBIDDEN，且不落任何消息与命令（切片④ 的授权名单不在本片放宽）', async () => {
    const { ids, harness, run } = await seedRun('running')
    const outsider = await seedRunPrereqs(database.db).catch(() => undefined)
    // 单 Team 部署不能再 seed 第二个团队：直接造一个不属于本 Task 的 actor。
    void outsider
    await expect(
      sendRunFollowup(
        database,
        harness.outbox,
        makeActor('00000000-0000-4000-8000-0000000000bb'),
        run.id,
        {
          text: '我不是责任人',
          idempotencyKey: 'k7',
        },
      ),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' })
    expect(await listMessages(database.db, ids.taskId)).toEqual([])
    expect(
      await database.db
        .select()
        .from(schema.dispatchOutbox)
        .where(eq(schema.dispatchOutbox.type, 'run.followup')),
    ).toEqual([])
  })

  it('未知 Run：404 NOT_FOUND', async () => {
    const ids = await seedRunPrereqs(database.db)
    const harness = makeHarness(database)
    await expect(
      sendRunFollowup(
        database,
        harness.outbox,
        makeActor(ids.userId),
        '00000000-0000-4000-8000-0000000000cc',
        { text: '发给不存在的 Run', idempotencyKey: 'k8' },
      ),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' })
  })

  it('空文本/缺幂等键：VALIDATION_FAILED（不落库）', async () => {
    const { ids, harness, run } = await seedRun('running')
    await expect(
      sendRunFollowup(database, harness.outbox, makeActor(ids.userId), run.id, {
        text: '   ',
        idempotencyKey: 'k9',
      }),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' })
    await expect(
      sendRunFollowup(database, harness.outbox, makeActor(ids.userId), run.id, {
        text: '有正文但没幂等键',
        idempotencyKey: '',
      }),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' })
    expect(await listMessages(database.db, ids.taskId)).toEqual([])
  })

  it('受理状态变化写进 team_event（UI 靠它刷新线程）', async () => {
    const { ids, harness, run } = await seedRun('running')
    await sendRunFollowup(database, harness.outbox, makeActor(ids.userId), run.id, {
      text: '事件要能看见',
      idempotencyKey: 'k10',
    })
    await harness.worker.dispatchOnce()
    for (const frame of harness.gateway.drainUpstream()) {
      await harness.orchestrator.ingestNodeEvent(harness.deviceFor(ids), frame)
    }
    const events = await listTeamEvents(database.db, 0)
    expect(
      events.filter((event) => event.type === 'comment.created').length,
    ).toBeGreaterThanOrEqual(2)
  })
})
