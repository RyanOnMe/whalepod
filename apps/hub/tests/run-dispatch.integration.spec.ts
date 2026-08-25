import { eq } from 'drizzle-orm'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { Database } from '@project311/db'
import { getRun, listRunEvents, listTeamEvents, schema } from '@project311/db'
import { parseNodeFrame } from '@project311/protocol'
import {
  createTestDatabase,
  makeActor,
  makeCreateInput,
  makeHarness,
  resetDatabase,
  runEventFrame,
  seedRunPrereqs,
} from './helpers.js'

// G4-01：queued→dispatching→running，证据为 DB 状态、Outbox ack 与 Fake Node 侧的
// Runtime 启动计数（真实 PID 属于 P1-12 Node 门，这里以「恰好启动一次」等价替代）。
describe('run dispatch (G4-01)', () => {
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

  it('walks queued → dispatching → running → completed with wire-valid frames', async () => {
    const ids = await seedRunPrereqs(database.db)
    const harness = makeHarness(database)
    const run = await harness.orchestrator.create(
      makeActor(ids.userId),
      ids.taskId,
      makeCreateInput(ids),
    )

    // 1. worker 派发 run.start；帧必须过协议 schema（序列化往返，与真实 WS 同形）。
    await harness.worker.dispatchOnce()
    expect(harness.gateway.sent).toHaveLength(1)
    const sentFrame = parseNodeFrame(
      JSON.parse(JSON.stringify(harness.gateway.sent[0]?.frame)),
      'downstream',
    )
    expect(sentFrame.type).toBe('run.start')
    if (sentFrame.type !== 'run.start') throw new Error('unreachable')
    expect(sentFrame.payload).toMatchObject({
      runId: run.id,
      taskId: ids.taskId,
      ownerUserId: ids.userId,
      workspaceId: ids.workspaceId,
      expectedProfileDigest: 'b'.repeat(64),
      expectedPluginPackDigest: 'a'.repeat(64),
      prompt: 'implement the task',
    })
    expect(sentFrame.payload.agent).toMatchObject({
      id: ids.agentId,
      profileRevisionId: ids.revisionId,
      model: 'deepseek-chat',
    })
    // commandId 即 outbox 行 id（03 §2.6）。
    const [outboxRow] = await database.db
      .select()
      .from(schema.dispatchOutbox)
      .where(eq(schema.dispatchOutbox.id, sentFrame.payload.commandId))
    expect(outboxRow).toBeDefined()
    expect(harness.gateway.runtimeStartCount).toBe(1)
    // send 成功不等于 ack：outbox 行要等 Node 上行 command.ack 才落 acked_at（03 §2.6）。
    expect(outboxRow?.ackedAt).toBeNull()
    expect((await getRun(database.db, run.id))?.status).toBe('queued')

    // 2. Node ack：queued → dispatching，outbox 落 ack。
    for (const frame of harness.gateway.drainUpstream()) {
      await harness.orchestrator.ingestNodeEvent(harness.deviceFor(ids), frame)
    }
    expect((await getRun(database.db, run.id))?.status).toBe('dispatching')
    const [ackedRow] = await database.db
      .select()
      .from(schema.dispatchOutbox)
      .where(eq(schema.dispatchOutbox.id, sentFrame.payload.commandId))
    expect(ackedRow?.ackedAt).not.toBeNull()

    // 3. Runtime ready：dispatching → running，dshSessionId 与 startedAt 写入。
    await harness.orchestrator.ingestNodeEvent(
      harness.deviceFor(ids),
      runEventFrame(run.id, 1, { type: 'runtime.ready', dshSessionId: 'dsh-session-1' }),
    )
    const running = await getRun(database.db, run.id)
    expect(running).toMatchObject({ status: 'running', dshSessionId: 'dsh-session-1' })
    expect(running?.startedAt).not.toBeNull()

    // 4. run.completed → completed + finishedAt；事件持久且进 team_event 流。
    await harness.orchestrator.ingestNodeEvent(
      harness.deviceFor(ids),
      runEventFrame(run.id, 2, { type: 'run.completed', finalText: 'done' }),
    )
    const completed = await getRun(database.db, run.id)
    expect(completed?.status).toBe('completed')
    expect(completed?.finishedAt).not.toBeNull()
    const persisted = await listRunEvents(database.db, run.id)
    expect(persisted.map((event) => [event.seq, event.type])).toEqual([
      [1, 'runtime.ready'],
      [2, 'run.completed'],
    ])
    const teamEventTypes = (await listTeamEvents(database.db)).map((event) => event.type)
    expect(teamEventTypes).toContain('run.event')
  })

  it('keeps the run queued while the device is offline and never reports failed', async () => {
    const ids = await seedRunPrereqs(database.db)
    const harness = makeHarness(database, { online: false })
    const run = await harness.orchestrator.create(
      makeActor(ids.userId),
      ids.taskId,
      makeCreateInput(ids),
    )

    const result = await harness.worker.dispatchOnce()
    expect(result.sent).toBe(0)
    expect(harness.gateway.sent).toHaveLength(0)
    // 不伪报 failed（02 Task 10 Step 5）：保持 queued，命令留待重投。
    expect((await getRun(database.db, run.id))?.status).toBe('queued')
    const [row] = await database.db.select().from(schema.dispatchOutbox)
    expect(row?.ackedAt).toBeNull()
    expect(row?.failedAt).toBeNull()

    // 设备上线后退避重投成功。
    harness.gateway.online = true
    harness.clock.advance(60_000)
    await harness.pump(ids)
    expect(harness.gateway.runtimeStartCount).toBe(1)
    expect((await getRun(database.db, run.id))?.status).toBe('dispatching')
  })

  it('applies a duplicated (runId, seq) event exactly once', async () => {
    const ids = await seedRunPrereqs(database.db)
    const harness = makeHarness(database)
    const run = await harness.orchestrator.create(
      makeActor(ids.userId),
      ids.taskId,
      makeCreateInput(ids),
    )
    await harness.pump(ids)

    const frame = runEventFrame(run.id, 1, { type: 'runtime.ready', dshSessionId: 's-1' })
    await harness.orchestrator.ingestNodeEvent(harness.deviceFor(ids), frame)
    await harness.orchestrator.ingestNodeEvent(harness.deviceFor(ids), frame)

    expect(await listRunEvents(database.db, run.id)).toHaveLength(1)
    expect((await getRun(database.db, run.id))?.status).toBe('running')
  })

  it('rejects frames from a device that does not own the run', async () => {
    const ids = await seedRunPrereqs(database.db)
    const harness = makeHarness(database)
    const run = await harness.orchestrator.create(
      makeActor(ids.userId),
      ids.taskId,
      makeCreateInput(ids),
    )

    await expect(
      harness.orchestrator.ingestNodeEvent(
        { deviceId: '00000000-0000-4000-8000-00000000e1e1', ownerUserId: ids.userId },
        runEventFrame(run.id, 1, { type: 'runtime.ready', dshSessionId: 's-1' }),
      ),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' })
    expect((await getRun(database.db, run.id))?.status).toBe('queued')
  })
})
