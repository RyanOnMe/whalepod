/**
 * P1-14 一次性 Approval 闭环（04 §4 G5-01..07 的 Hub 侧机器证据）。
 *
 * 两类驱动：
 * - HTTP 决策面（真人路径）：POST /approvals/:approvalId/decisions 走 Fastify
 *   inject；上游 Approval/Run 行是固定夹具（与 insertRunRow/insertPublishedArtifact
 *   同惯例），被测路径是决策本身。
 * - Orchestrator 深模块：过期清扫（G5-05）、取消联动（G5-07）、Node decided 回显
 *   幂等（R6），沿用 run-projection 集成测试的 ingestNodeEvent 配方。
 *
 * 判据以 03-领域模型与运行协议.md §3.3（first-wins）/§4（Run owner 决策）为准。
 */
import { randomUUID } from 'node:crypto'
import { eq } from 'drizzle-orm'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { Database } from '@whalepod/db'
import { insertProject, insertTask, listTeamEvents, Outbox, schema } from '@whalepod/db'
import { expireApprovals } from '../src/modules/run/approval-expiry.js'
import {
  apiInject,
  createTestApp,
  createTestDatabase,
  driveInviteAndAccept,
  driveSetup,
  idemKey,
  insertRunRow,
  makeActor,
  makeCreateInput,
  makeHarness,
  resetDatabase,
  runEventFrame,
  seedRunChainForUser,
  seedRunPrereqs,
  seedSecondUserDevice,
  type Session,
  type TestApp,
} from './helpers.js'

const TASK_ID = '11111111-0000-4000-8000-00000000a001'
const PROJECT_ID = '11111111-0000-4000-8000-00000000a002'

interface Fixture {
  alice: Session
  bob: Session
  runId: string
  bobDeviceId: string
}

async function seedApprovalFixture(database: Database, ctx: TestApp): Promise<Fixture> {
  const alice = await driveSetup(ctx)
  const { session: bob } = await driveInviteAndAccept(ctx, alice, {
    username: 'bob',
    displayName: 'Bob',
    password: 'correct horse battery staple',
  })
  const chain = await seedRunChainForUser(database.db, bob.userId)
  await insertProject(database.db, { id: PROJECT_ID, name: 'approval', createdBy: alice.userId })
  await insertTask(database.db, {
    id: TASK_ID,
    projectId: PROJECT_ID,
    title: 'approval task',
    assigneeUserId: bob.userId,
    assignmentStatus: 'accepted',
    acceptedAt: new Date(),
    createdBy: alice.userId,
  })
  const runId = await insertRunRow(database.db, {
    taskId: TASK_ID,
    ownerUserId: bob.userId,
    agentId: chain.agentId,
    profileRevisionId: chain.profileRevisionId,
    deviceId: chain.deviceId,
    workspaceId: chain.workspaceId,
    status: 'waiting_approval',
    dshSessionId: 's-approval-1',
  })
  return { alice, bob, runId, bobDeviceId: chain.deviceId }
}

interface ApprovalFixtureOptions {
  readonly expiresAt: Date
  readonly status?: 'pending'
}

async function insertPendingApproval(
  database: Database,
  fixture: Fixture,
  options: ApprovalFixtureOptions,
): Promise<{ approvalId: string; callId: string }> {
  const approvalId = randomUUID()
  const callId = randomUUID()
  await database.db.insert(schema.approvals).values({
    id: approvalId,
    runId: fixture.runId,
    callId,
    toolName: 'bash',
    reason: 'needs rm',
    preview: { command: 'rm -rf <workspace>/build' },
    status: options.status ?? 'pending',
    requestedAt: new Date(),
    expiresAt: options.expiresAt,
  })
  return { approvalId, callId }
}

function decide(
  ctx: TestApp,
  session: Session,
  approvalId: string,
  decision: 'allowed_once' | 'rejected',
) {
  return apiInject(ctx, session, {
    method: 'POST',
    url: `/api/v1/approvals/${approvalId}/decisions`,
    payload: { decision },
  })
}

async function approvalRow(database: Database, approvalId: string) {
  const [row] = await database.db
    .select()
    .from(schema.approvals)
    .where(eq(schema.approvals.id, approvalId))
  return row
}

async function approvalDecideCommands(database: Database) {
  return database.db
    .select()
    .from(schema.dispatchOutbox)
    .where(eq(schema.dispatchOutbox.type, 'approval.decide'))
}

describe('approval decisions (HTTP 决策面)', () => {
  let database: Database
  let ctx: TestApp
  let fixture: Fixture

  beforeAll(async () => {
    database = await createTestDatabase()
  })
  beforeEach(async () => {
    await resetDatabase(database)
    ctx = await createTestApp(database)
    fixture = await seedApprovalFixture(database, ctx)
  })
  afterEach(async () => {
    await ctx.close()
  })
  afterAll(async () => {
    await database.close()
  })

  it('G5-03：Run owner allowed_once → 终态落库、decide 命令入队、Run 回 running', async () => {
    const { approvalId } = await insertPendingApproval(database, fixture, {
      expiresAt: new Date(Date.now() + 600_000),
    })

    const response = await decide(ctx, fixture.bob, approvalId, 'allowed_once')
    expect(response.statusCode).toBe(200)
    const body = response.json() as {
      ok: boolean
      data: { status: string; decidedBy: string; callId: string }
    }
    expect(body.ok).toBe(true)
    expect(body.data.status).toBe('allowed_once')
    expect(body.data.decidedBy).toBe(fixture.bob.userId)

    const row = await approvalRow(database, approvalId)
    expect(row?.status).toBe('allowed_once')
    expect(row?.decidedBy).toBe(fixture.bob.userId)
    expect(row?.decidedAt).not.toBeNull()

    // Hub→Node 命令链（G5-03 trace 前半）：approval.decide 带 callId 入 outbox。
    const commands = await approvalDecideCommands(database)
    expect(commands).toHaveLength(1)
    expect(commands[0]?.payload).toMatchObject({
      runId: fixture.runId,
      approvalId,
      decision: 'allowed_once',
    })
    const callId = (commands[0]?.payload as { callId?: string }).callId
    expect(typeof callId).toBe('string')
    expect((callId as string).length).toBeGreaterThan(0)

    // 最后一条 pending 结束：Run 回 running（03 §3.2 特殊规则）。
    const [run] = await database.db
      .select()
      .from(schema.runs)
      .where(eq(schema.runs.id, fixture.runId))
    expect(run?.status).toBe('running')

    // Team Event：approval.changed 带 taskId（Task Room 卡实时刷新依据）。
    const events = await listTeamEvents(database.db)
    const changed = events.find((e) => e.type === 'approval.changed')
    expect(changed?.payload).toMatchObject({
      approvalId,
      runId: fixture.runId,
      taskId: TASK_ID,
      status: 'allowed_once',
    })
    expect(
      events.some(
        (e) => e.type === 'run.changed' && (e.payload as { status?: string }).status === 'running',
      ),
    ).toBe(true)
  })

  it('G5-04：rejected 同样闭环，decide 命令携带 rejected', async () => {
    const { approvalId } = await insertPendingApproval(database, fixture, {
      expiresAt: new Date(Date.now() + 600_000),
    })

    const response = await decide(ctx, fixture.bob, approvalId, 'rejected')
    expect(response.statusCode).toBe(200)
    const row = await approvalRow(database, approvalId)
    expect(row?.status).toBe('rejected')
    const commands = await approvalDecideCommands(database)
    expect(commands[0]?.payload).toMatchObject({ decision: 'rejected' })
    const [run] = await database.db
      .select()
      .from(schema.runs)
      .where(eq(schema.runs.id, fixture.runId))
    expect(run?.status).toBe('running')
  })

  it('G5-02：非 owner（团队 Owner 角色）决策被拒 403，决定仍 pending', async () => {
    const { approvalId } = await insertPendingApproval(database, fixture, {
      expiresAt: new Date(Date.now() + 600_000),
    })

    const response = await decide(ctx, fixture.alice, approvalId, 'allowed_once')
    expect(response.statusCode).toBe(403)
    expect(response.json()).toMatchObject({ error: { code: 'FORBIDDEN' } })

    const row = await approvalRow(database, approvalId)
    expect(row?.status).toBe('pending')
    expect(row?.decidedBy).toBeNull()
    expect(await approvalDecideCommands(database)).toHaveLength(0)
  })

  it('未登录决策 401；不存在的 approval 404', async () => {
    const { approvalId } = await insertPendingApproval(database, fixture, {
      expiresAt: new Date(Date.now() + 600_000),
    })
    const anonymous = await ctx.app.inject({
      method: 'POST',
      url: `/api/v1/approvals/${approvalId}/decisions`,
      headers: { origin: ctx.origin, 'idempotency-key': idemKey() },
      payload: { decision: 'allowed_once' },
    })
    expect(anonymous.statusCode).toBe(401)

    const missing = await decide(ctx, fixture.bob, randomUUID(), 'allowed_once')
    expect(missing.statusCode).toBe(404)
    expect(missing.json()).toMatchObject({ error: { code: 'NOT_FOUND' } })
  })

  it('重复相同决定幂等返回第一次结果，不重发命令、不重复事件', async () => {
    const { approvalId } = await insertPendingApproval(database, fixture, {
      expiresAt: new Date(Date.now() + 600_000),
    })
    const first = await decide(ctx, fixture.bob, approvalId, 'allowed_once')
    expect(first.statusCode).toBe(200)
    const decidedAt = (await approvalRow(database, approvalId))?.decidedAt

    const second = await decide(ctx, fixture.bob, approvalId, 'allowed_once')
    expect(second.statusCode).toBe(200)
    expect((second.json() as { data: { status: string } }).data.status).toBe('allowed_once')

    expect(await approvalDecideCommands(database)).toHaveLength(1)
    const events = (await listTeamEvents(database.db)).filter((e) => e.type === 'approval.changed')
    expect(events).toHaveLength(1)
    expect((await approvalRow(database, approvalId))?.decidedAt).toEqual(decidedAt)
  })

  it('冲突决定 409 APPROVAL_ALREADY_DECIDED，终态不被改写', async () => {
    const { approvalId } = await insertPendingApproval(database, fixture, {
      expiresAt: new Date(Date.now() + 600_000),
    })
    expect((await decide(ctx, fixture.bob, approvalId, 'allowed_once')).statusCode).toBe(200)

    const conflict = await decide(ctx, fixture.bob, approvalId, 'rejected')
    expect(conflict.statusCode).toBe(409)
    expect(conflict.json()).toMatchObject({ error: { code: 'APPROVAL_ALREADY_DECIDED' } })
    expect((await approvalRow(database, approvalId))?.status).toBe('allowed_once')
    expect(await approvalDecideCommands(database)).toHaveLength(1)
  })

  it('G5-06：并发 allow 与 reject，第一决定获胜，另一请求冲突', async () => {
    const { approvalId } = await insertPendingApproval(database, fixture, {
      expiresAt: new Date(Date.now() + 600_000),
    })

    const [allow, reject] = await Promise.all([
      decide(ctx, fixture.bob, approvalId, 'allowed_once'),
      decide(ctx, fixture.bob, approvalId, 'rejected'),
    ])
    const codes = [allow.statusCode, reject.statusCode].sort()
    expect(codes).toEqual([200, 409])
    const winner = allow.statusCode === 200 ? 'allowed_once' : 'rejected'
    const loserBody = (allow.statusCode === 200 ? reject : allow).json() as {
      error: { code: string }
    }
    expect(loserBody.error.code).toBe('APPROVAL_ALREADY_DECIDED')

    const row = await approvalRow(database, approvalId)
    expect(row?.status).toBe(winner)
    expect(await approvalDecideCommands(database)).toHaveLength(1)
    const events = (await listTeamEvents(database.db)).filter((e) => e.type === 'approval.changed')
    expect(events).toHaveLength(1)
    expect(events[0]?.payload).toMatchObject({ status: winner })
  })

  it('G5-05（决策面）：过期后的 allow 被拒 APPROVAL_EXPIRED，决定仍 pending', async () => {
    const { approvalId } = await insertPendingApproval(database, fixture, {
      expiresAt: new Date(Date.now() - 1_000),
    })

    const response = await decide(ctx, fixture.bob, approvalId, 'allowed_once')
    expect(response.statusCode).toBe(409)
    expect(response.json()).toMatchObject({ error: { code: 'APPROVAL_EXPIRED' } })

    const row = await approvalRow(database, approvalId)
    expect(row?.status).toBe('pending')
    expect(await approvalDecideCommands(database)).toHaveLength(0)
  })
})

describe('approval expiry sweep (G5-05 清扫面)', () => {
  let database: Database
  let ctx: TestApp
  let fixture: Fixture

  beforeAll(async () => {
    database = await createTestDatabase()
  })
  beforeEach(async () => {
    await resetDatabase(database)
    ctx = await createTestApp(database)
    fixture = await seedApprovalFixture(database, ctx)
  })
  afterEach(async () => {
    await ctx.close()
  })
  afterAll(async () => {
    await database.close()
  })

  it('过期 pending → expired（等价拒绝：decide(rejected) 入队），Run 回 running；重复清扫幂等', async () => {
    const { approvalId } = await insertPendingApproval(database, fixture, {
      expiresAt: new Date(Date.now() - 1_000),
    })

    // 组合根（server.ts 10s 循环）同一函数，直接驱动。
    const outbox = new Outbox(database)
    const acted = await expireApprovals({ database, outbox, now: () => new Date() }, new Date())
    expect(acted).toBe(1)

    const row = await approvalRow(database, approvalId)
    expect(row?.status).toBe('expired')
    expect(row?.decidedBy).toBe(fixture.bob.userId)
    expect(row?.decidedAt).not.toBeNull()

    // 等价拒绝：Runtime 的挂起请求被 rejected 解除阻塞。
    const commands = await approvalDecideCommands(database)
    expect(commands).toHaveLength(1)
    expect(commands[0]?.payload).toMatchObject({ decision: 'rejected', approvalId })

    const [run] = await database.db
      .select()
      .from(schema.runs)
      .where(eq(schema.runs.id, fixture.runId))
    expect(run?.status).toBe('running')
    const events = await listTeamEvents(database.db)
    expect(
      events.some(
        (e) =>
          e.type === 'approval.changed' && (e.payload as { status?: string }).status === 'expired',
      ),
    ).toBe(true)

    // 重复清扫幂等：无第二命令、无第二事件。
    const again = await expireApprovals({ database, outbox, now: () => new Date() }, new Date())
    expect(again).toBe(0)
    expect(await approvalDecideCommands(database)).toHaveLength(1)
  })

  it('多 pending：只过期已到期的；剩余 pending 让 Run 维持 waiting_approval', async () => {
    const expired = await insertPendingApproval(database, fixture, {
      expiresAt: new Date(Date.now() - 1_000),
    })
    const fresh = await insertPendingApproval(database, fixture, {
      expiresAt: new Date(Date.now() + 600_000),
    })

    const acted = await expireApprovals(
      { database, outbox: new Outbox(database), now: () => new Date() },
      new Date(),
    )
    expect(acted).toBe(1)
    expect((await approvalRow(database, expired.approvalId))?.status).toBe('expired')
    expect((await approvalRow(database, fresh.approvalId))?.status).toBe('pending')

    const [run] = await database.db
      .select()
      .from(schema.runs)
      .where(eq(schema.runs.id, fixture.runId))
    expect(run?.status).toBe('waiting_approval')

    // 剩余一条由 owner 决策闭环：waiting_approval → running。
    const decideResponse = await decide(ctx, fixture.bob, fresh.approvalId, 'allowed_once')
    expect(decideResponse.statusCode).toBe(200)
    const [after] = await database.db
      .select()
      .from(schema.runs)
      .where(eq(schema.runs.id, fixture.runId))
    expect(after?.status).toBe('running')
  })
})

describe('approval cancel linkage (G5-07) 与 decided 回显幂等', () => {
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

  /** ingestNodeEvent 配方（run-projection 集成同款）：runtime.ready → waiting_approval。 */
  async function seedWaitingApprovalRun() {
    const ids = await seedRunPrereqs(database.db)
    const harness = makeHarness(database)
    const run = await harness.orchestrator.create(
      makeActor(ids.userId),
      ids.taskId,
      makeCreateInput(ids),
    )
    await harness.pump(ids)
    const approvalId = randomUUID()
    const callId = randomUUID()
    const card = {
      approvalId,
      runId: run.id,
      callId,
      toolName: 'bash',
      reason: 'needs rm',
      preview: { command: 'rm -rf <workspace>/build' },
      status: 'pending' as const,
      requestedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 600_000).toISOString(),
    }
    await harness.orchestrator.ingestNodeEvent(
      harness.deviceFor(ids),
      runEventFrame(run.id, 1, { type: 'runtime.ready', dshSessionId: 's-1' }),
    )
    await harness.orchestrator.ingestNodeEvent(
      harness.deviceFor(ids),
      runEventFrame(run.id, 2, { type: 'approval.requested', approval: card }),
    )
    const [row] = await database.db.select().from(schema.runs).where(eq(schema.runs.id, run.id))
    expect(row?.status).toBe('waiting_approval')
    return { ids, harness, run, approvalId, callId }
  }

  it('G5-07：取消 waiting_approval Run → pending Approval 全部 cancelled，run.cancel 入队', async () => {
    const { ids, harness, run, approvalId } = await seedWaitingApprovalRun()

    const cancelled = await harness.orchestrator.cancel(makeActor(ids.userId), run.id)
    expect(cancelled.status).toBe('cancel_requested')

    const approval = await approvalRow(database, approvalId)
    expect(approval?.status).toBe('cancelled')
    expect(approval?.decidedAt).not.toBeNull()
    expect(approval?.decidedBy).toBe(ids.userId)

    const events = await listTeamEvents(database.db)
    expect(
      events.some(
        (e) =>
          e.type === 'approval.changed' &&
          (e.payload as { status?: string }).status === 'cancelled',
      ),
    ).toBe(true)
    // 取消走 run.cancel；不得借道 approval.decide。
    const outbox = await database.db.select().from(schema.dispatchOutbox)
    expect(outbox.some((c) => c.type === 'run.cancel')).toBe(true)
    expect(outbox.some((c) => c.type === 'approval.decide')).toBe(false)
  })

  it('Node decided 回显幂等：Hub 已决后重放/迟到回显不改写终态、不重复事件', async () => {
    const { ids, harness, run, approvalId } = await seedWaitingApprovalRun()

    /** approval.changed 里的「已决」事件（pending 是 requested 时的合法事件，不计）。 */
    const decidedApprovalEvents = async () =>
      (await listTeamEvents(database.db)).filter(
        (e) =>
          e.type === 'approval.changed' && (e.payload as { status?: string }).status !== 'pending',
      )

    // 深模块面决策（决策的 HTTP 面已在上方 describe 覆盖；此处被测对象是回显幂等）。
    await harness.orchestrator.decideApproval(makeActor(ids.userId), approvalId, 'allowed_once')
    expect(await decidedApprovalEvents()).toHaveLength(1)

    // Node 回显（决定生效后的 approval.decided，owner 行）。
    await harness.orchestrator.ingestNodeEvent(
      harness.deviceFor(ids),
      runEventFrame(run.id, 3, { type: 'approval.decided', approvalId, status: 'allowed_once' }),
    )
    // 同一事实换 seq 重放（R6 变体）：仍不得改写终态或重复事件。
    await harness.orchestrator.ingestNodeEvent(
      harness.deviceFor(ids),
      runEventFrame(run.id, 4, { type: 'approval.decided', approvalId, status: 'allowed_once' }),
    )
    expect(await decidedApprovalEvents()).toHaveLength(1)
    expect((await approvalRow(database, approvalId))?.status).toBe('allowed_once')
    const [runRow] = await database.db.select().from(schema.runs).where(eq(schema.runs.id, run.id))
    expect(runRow?.status).toBe('running')
  })

  it('second user（非 owner）经 orchestrator 决策被拒（G5-02 深模块面）', async () => {
    const ids = await seedRunPrereqs(database.db)
    const second = await seedSecondUserDevice(database.db, ids)
    const harness = makeHarness(database)
    const run = await harness.orchestrator.create(
      makeActor(ids.userId),
      ids.taskId,
      makeCreateInput(ids),
    )
    const approvalId = randomUUID()
    await database.db.insert(schema.approvals).values({
      id: approvalId,
      runId: run.id,
      callId: randomUUID(),
      toolName: 'bash',
      reason: 'needs rm',
      preview: {},
      status: 'pending',
      requestedAt: new Date(),
      expiresAt: new Date(Date.now() + 600_000),
    })
    await expect(
      harness.orchestrator.decideApproval(makeActor(second.userId), approvalId, 'allowed_once'),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' })
  })
})
