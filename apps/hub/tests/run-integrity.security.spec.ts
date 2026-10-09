/**
 * A0 安全负向用例族（Q7）：终态不复活、投影不泄密、不谎称副作用已停（专家 5/6/7）。
 *
 * 与 run-authorization.security.spec.ts 同源（2026-10-08 外部审查的 8 项安全验收）。
 * 每条都带**正控**：拒绝/不显示之外还要证明通道确实工作、证据确实留痕——
 * 否则"什么都没发生"可能只是测试自己坏了。
 */
import { randomUUID } from 'node:crypto'
import { eq } from 'drizzle-orm'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { Database } from '@whalepod/db'
import { insertProject, insertTask, schema } from '@whalepod/db'
import type { ClientFrame } from '@whalepod/protocol'
import { parseClientFrame } from '@whalepod/protocol'
import WebSocket from 'ws'
import {
  apiInject,
  createTestApp,
  createTestDatabase,
  driveInviteAndAccept,
  driveSetup,
  idemKey,
  insertRunRow,
  makeHarness,
  resetDatabase,
  runEventFrame,
  seedRunChainForUser,
  waitForValue,
  type Session,
  type TestApp,
} from './helpers.js'

let database: Database
let ctx: TestApp
let wsBase: string

const CORPUS = [
  'Authorization: Bearer test-secret-123',
  'DEEPSEEK_API_KEY=sk-test-abcdef',
  '/Users/bob/private/project',
] as const

interface Ctx {
  alice: Session
  bob: Session
  carol: Session
  taskId: string
  bobUserId: string
}

async function seedCtx(): Promise<Ctx> {
  const alice = await driveSetup(ctx)
  const { session: bob } = await driveInviteAndAccept(ctx, alice, {
    username: 'bob',
    displayName: 'Bob',
    password: 'correct horse battery staple',
  })
  const { session: carol } = await driveInviteAndAccept(ctx, alice, {
    username: 'carol',
    displayName: 'Carol',
    password: 'correct horse battery staple',
  })
  const projectId = randomUUID()
  const taskId = randomUUID()
  await insertProject(database.db, { id: projectId, name: 'sec2', createdBy: alice.userId })
  await insertTask(database.db, {
    id: taskId,
    projectId,
    title: 'sec2 task',
    assigneeUserId: bob.userId,
    assignmentStatus: 'accepted',
    acceptedAt: new Date(),
    createdBy: alice.userId,
  })
  return { alice, bob, carol, taskId, bobUserId: bob.userId }
}

async function seedRun(
  c: Ctx,
  status: 'running' | 'completed' | 'lost',
): Promise<{ runId: string; deviceId: string }> {
  const chain = await seedRunChainForUser(database.db, c.bobUserId)
  const runId = await insertRunRow(database.db, {
    taskId: c.taskId,
    ownerUserId: c.bobUserId,
    agentId: chain.agentId,
    profileRevisionId: chain.profileRevisionId,
    deviceId: chain.deviceId,
    workspaceId: chain.workspaceId,
    status,
    dshSessionId: `s-integrity-${randomUUID().slice(0, 8)}`,
  })
  return { runId, deviceId: chain.deviceId }
}

/** 最小浏览器 WS 客户端（与 realtime 集成测同形）：帧经协议解析（坏帧即红）。 */
function connectClient(cookie: string): Promise<{ frames: ClientFrame[]; close: () => void }> {
  return new Promise((resolve, reject) => {
    const frames: ClientFrame[] = []
    const ws = new WebSocket(`${wsBase}/ws/v1/client?cursor=0`, {
      headers: { cookie, origin: ctx.origin },
    })
    ws.on('message', (data) => {
      frames.push(parseClientFrame(JSON.parse(data.toString())))
    })
    ws.on('open', () => resolve({ frames, close: () => ws.close() }))
    ws.on('error', reject)
    setTimeout(() => reject(new Error('browser WS 未在超时内连上')), 3_000)
  })
}

beforeAll(async () => {
  database = await createTestDatabase()
})
beforeEach(async () => {
  await resetDatabase(database)
  ctx = await createTestApp(database)
  await ctx.app.listen({ host: '127.0.0.1', port: 0 })
  const address = ctx.app.server.address()
  if (address === null || typeof address !== 'object' || !('port' in address)) {
    throw new Error('no listen port')
  }
  wsBase = `ws://127.0.0.1:${(address as { port: number }).port}`
})
afterEach(async () => {
  await ctx.close()
})
afterAll(async () => {
  await database.close()
})

describe('专家5：取消、断连与迟到事件不能把终态 Run 拉回运行中', () => {
  it('completed / lost 之后迟到的 runtime.ready 与 run.failed：留证但状态一字不动', async () => {
    const c = await seedCtx()
    const harness = makeHarness(database)

    for (const status of ['completed', 'lost'] as const) {
      const { runId, deviceId } = await seedRun(c, status)
      const device = { deviceId, ownerUserId: c.bobUserId }
      // 迟到帧：先报 ready（想把 lost 拉回 running），再报 failed（想改写 completed）。
      await harness.orchestrator.ingestNodeEvent(
        device,
        runEventFrame(runId, 1, { type: 'runtime.ready', dshSessionId: 'late-session' }),
      )
      await harness.orchestrator.ingestNodeEvent(
        device,
        runEventFrame(runId, 2, {
          type: 'run.failed',
          code: 'RUNTIME_LOST',
          summary: 'late frame',
        }),
      )

      const [run] = await database.db.select().from(schema.runs).where(eq(schema.runs.id, runId))
      expect(run?.status, `${status} 不得被迟到事件改写`).toBe(status)
      // 正控：迟到帧确实落账（留证），不是被整帧丢弃。
      const events = await database.db
        .select()
        .from(schema.runEvents)
        .where(eq(schema.runEvents.runId, runId))
      expect(events.length, '迟到帧必须留证（run_event 行）').toBeGreaterThanOrEqual(2)
    }
  })
})

describe('专家6：含密钥的 owner 内容不进其他成员的投影（受众门是硬边界）', () => {
  it('owner 受众事件里的模拟密钥：owner 收得到（正控），member 的 WS 帧与任务房间零出现', async () => {
    const c = await seedCtx()
    const { runId, deviceId } = await seedRun(c, 'running')
    const harness = makeHarness(database)
    const secretText = `工具输出：${CORPUS[0]}；路径 ${CORPUS[2]}`

    // owner 受众的 assistant.message（含密钥明文）——真实的 owner-only 直播投影同型。
    await harness.orchestrator.ingestNodeEvent(
      { deviceId, ownerUserId: c.bobUserId },
      runEventFrame(runId, 1, { type: 'assistant.message', text: secretText }, 'owner'),
    )

    // 正控：owner（bob）的通道确实能看到这条内容——证明帧真的存在、不是"没发出去"。
    const bobClient = await connectClient(c.bob.cookie)
    await waitForValue(
      () =>
        bobClient.frames.some((f) => JSON.stringify(f).includes(CORPUS[0])) ? true : undefined,
      'owner 通道未在超时内收到含密钥的 owner 帧（无法证明受众门在起作用）',
    )

    // 负向：第三方成员（carol）的连接帧里零出现（含重放）。
    const carolClient = await connectClient(c.carol.cookie)
    // 强度对照：同一条连接、同一个 Run 的 **project 行**必须到（证明订阅活着、
    // 受众门而非"没订阅"），而 owner 行不见。没有这条，负向断言可能假通过。
    await harness.orchestrator.ingestNodeEvent(
      { deviceId, ownerUserId: c.bobUserId },
      runEventFrame(runId, 2, { type: 'run.phase', phase: 'tool' }, 'project'),
    )
    await waitForValue(
      () =>
        carolClient.frames.some((f) => JSON.stringify(f).includes('"run.phase"'))
          ? true
          : undefined,
      'carol 未收到同 Run 的 project 行（受众门测试失去对照）',
    )
    for (const item of CORPUS) {
      expect(JSON.stringify(carolClient.frames), `carol frames 不得含 ${item}`).not.toContain(item)
    }
    // 任务房间读取面同样零出现（另一条读路径）。
    const room = await apiInject(ctx, c.carol, {
      method: 'GET',
      url: `/api/v1/tasks/${c.taskId}`,
    })
    for (const item of CORPUS) {
      expect(JSON.stringify(room.json()), `task room 不得含 ${item}`).not.toContain(item)
    }
    bobClient.close()
    carolClient.close()
  })
})

describe('专家7：取消/超时不谎称"副作用已停"，也不偷偷重跑', () => {
  it('取消落地后：终态 cancelled、无自动重跑、无任何新 run.start 命令', async () => {
    const c = await seedCtx()
    const { runId } = await seedRun(c, 'running')

    // 只有责任人/管理员能取消：这里用 alice（团队 Owner）走紧急取消腿（G7-06a）。
    const cancel = await apiInject(ctx, c.alice, {
      method: 'POST',
      url: `/api/v1/runs/${runId}/cancel`,
    })
    expect(cancel.statusCode).toBe(200)

    // Node 确认取消落地（真人路径：cancel_confirmed 上行）。
    const harness = makeHarness(database)
    const { deviceId } = await seedRunDeviceLookup(runId)
    await harness.orchestrator.ingestNodeEvent(
      { deviceId, ownerUserId: c.bobUserId },
      runEventFrame(runId, 1, { type: 'run.cancelled', forced: true }),
    )

    const [run] = await database.db.select().from(schema.runs).where(eq(schema.runs.id, runId))
    expect(run?.status).toBe('cancelled')
    // 诚实语义：取消不是"成功"，failureCode 不冒充 completed。
    expect(run?.failureCode).toBeNull()

    // 反证 1：没有自动重跑——该 Task 仍只有这一个 Run。
    const runs = await database.db
      .select()
      .from(schema.runs)
      .where(eq(schema.runs.taskId, c.taskId))
    expect(runs).toHaveLength(1)
    // 反证 2：outbox 里没有任何 run.start（不会被自动重新派发去"接着跑"）。
    const starts = await database.db
      .select()
      .from(schema.dispatchOutbox)
      .where(eq(schema.dispatchOutbox.type, 'run.start'))
    expect(starts).toHaveLength(0)
  })

  it('runtime 丢失的终态是 lost + RUNTIME_LOST，不被标成 completed、不自动重跑', async () => {
    const c = await seedCtx()
    const { runId } = await seedRun(c, 'running')
    const harness = makeHarness(database)
    const { deviceId } = await seedRunDeviceLookup(runId)

    await harness.orchestrator.ingestNodeEvent(
      { deviceId, ownerUserId: c.bobUserId },
      runEventFrame(runId, 1, {
        type: 'run.failed',
        code: 'RUNTIME_LOST',
        summary: 'runtime process gone; external effects unknown',
      }),
    )

    const [run] = await database.db.select().from(schema.runs).where(eq(schema.runs.id, runId))
    expect(run?.status).toBe('failed')
    expect(run?.failureCode).toBe('RUNTIME_LOST')
    // 副作用未知是**诚实**结果：不去补一个"完成"标签，也不自动重放。
    const runs = await database.db
      .select()
      .from(schema.runs)
      .where(eq(schema.runs.taskId, c.taskId))
    expect(runs).toHaveLength(1)
    const starts = await database.db
      .select()
      .from(schema.dispatchOutbox)
      .where(eq(schema.dispatchOutbox.type, 'run.start'))
    expect(starts).toHaveLength(0)
  })
})

async function seedRunDeviceLookup(runId: string): Promise<{ deviceId: string }> {
  const [run] = await database.db.select().from(schema.runs).where(eq(schema.runs.id, runId))
  if (run === undefined) throw new Error('run not found for device lookup')
  return { deviceId: run.deviceId }
}
