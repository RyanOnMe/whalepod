/**
 * #301 / ADR-0012「事件即受理证据」的 Hub 侧机器证据。
 *
 * 背景（A0-8 发布取证实录）：`queued --dispatch_acked--> dispatching` 由 Node 的
 * `command.ack` 驱动，而 ack 可能丢（传输/崩溃窗）；Node 一旦受理就把 Runtime 起起来
 * 并上行 `runtime.ready`。此时若 Hub 仍停在 `queued`，按表边处理会把 Run 记成
 * `failed(INVALID_RUN_TRANSITION)`——账本与事实分叉（Hub 说失败、Node 在跑）。
 * Q5 的 R7 场景（丢一次 ack）在本地第 3 轮连跑复现过，这条判据是它的**确定性回归**。
 *
 * 判据（Issue #301「怎样算修好」）：
 *   1) queued + 归属合法的 runtime.ready（无 ack）⟹ Run 收敛到 **running**，
 *      failureCode 为空、run_event 留证 ≥1 行、run.changed 里出现 dispatching 一步；
 *   2) **不伪造 ack**：outbox 行的 acked_at 仍为空（重发照旧），事件驱动不代签收；
 *   3) 反证：**他设备**的同一事件仍 FORBIDDEN，Run 停在 queued（隐式确认不放宽归属）。
 */
import { randomUUID } from 'node:crypto'
import { eq } from 'drizzle-orm'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { Database } from '@whalepod/db'
import { listTeamEvents, schema } from '@whalepod/db'
import {
  makeActor,
  makeCreateInput,
  makeHarness,
  createTestDatabase,
  resetDatabase,
  runEventFrame,
  seedRunPrereqs,
} from './helpers.js'

describe('#301 / ADR-0012：事件即受理证据（丢 ack 不得判死）', () => {
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

  it('queued + 合法 runtime.ready（ack 丢失）⟹ running 而非 failed；outbox 行不被伪造为已 ack', async () => {
    const ids = await seedRunPrereqs(database.db)
    const harness = makeHarness(database)
    const run = await harness.orchestrator.create(
      makeActor(ids.userId),
      ids.taskId,
      makeCreateInput(ids),
    )
    expect(run.status).toBe('queued')

    // 派发一轮：run.start 到达（Fake）Node，但**不回喂 ack**——模拟 ack 丢失的那一帧。
    await harness.worker.dispatchOnce()
    const [afterDispatch] = await database.db
      .select()
      .from(schema.runs)
      .where(eq(schema.runs.id, run.id))
    expect(afterDispatch?.status, '无 ack 时 Hub 必须仍停在 queued（前提成立才谈得上复现）').toBe(
      'queued',
    )

    // Node 受理并把 Runtime 起起来 → 上行 runtime.ready（归属合法：本 Run 的设备）。
    await harness.orchestrator.ingestNodeEvent(
      harness.deviceFor(ids),
      runEventFrame(run.id, 1, { type: 'runtime.ready', dshSessionId: 'sess-implicit' }, 'owner'),
    )

    const [settled] = await database.db.select().from(schema.runs).where(eq(schema.runs.id, run.id))
    expect(settled?.status, '事件即受理证据：必须收敛到 running，不得判 failed').toBe('running')
    expect(settled?.failureCode).toBeNull()
    expect(settled?.dshSessionId).toBe('sess-implicit')

    // 事件留证（不是"吞掉事件换个状态"）。
    const events = await database.db
      .select()
      .from(schema.runEvents)
      .where(eq(schema.runEvents.runId, run.id))
    expect(events.length).toBeGreaterThanOrEqual(1)

    // 广播面：queued→dispatching 与 dispatching→running 两步都要能被 UI 看见。
    const statuses = (await listTeamEvents(database.db))
      .filter((event) => event.type === 'run.changed')
      .map((event) => (event.payload as { status?: string }).status)
    expect(statuses).toContain('dispatching')
    expect(statuses).toContain('running')

    // 不伪造 ack：outbox 的 acked_at 只由真实 command.ack 写，事件驱动不代签收。
    const [command] = await database.db.select().from(schema.dispatchOutbox)
    expect(command?.ackedAt, '隐式确认不得伪造 ack（重发路径要照旧保留）').toBeNull()
  })

  it('反证：他设备上行的 runtime.ready 仍 FORBIDDEN，Run 停在 queued', async () => {
    const ids = await seedRunPrereqs(database.db)
    const harness = makeHarness(database)
    const run = await harness.orchestrator.create(
      makeActor(ids.userId),
      ids.taskId,
      makeCreateInput(ids),
    )

    await expect(
      harness.orchestrator.ingestNodeEvent(
        { deviceId: randomUUID(), ownerUserId: ids.userId }, // 非本 Run 的设备
        runEventFrame(run.id, 1, { type: 'runtime.ready', dshSessionId: 'sess-forged' }, 'owner'),
      ),
    ).rejects.toThrow(/does not belong to this device/)

    const [after] = await database.db.select().from(schema.runs).where(eq(schema.runs.id, run.id))
    expect(after?.status, '归属校验在隐式确认之前——伪造事件不得推进状态').toBe('queued')
  })
})
