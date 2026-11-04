/**
 * ADR-0028 §6（RD-03a）：受控派工端口。
 *
 * 驱动走生产 HTTP：工作/Mandate → 收件箱显式关联 → 影子准入生成 proposed 意图 →
 * assignee approve → dispatch 端口复核 → 机器 Run。Run 终态走真实 Node 事件路径
 * （ingestNodeEvent → run-status 收口），不直调 applyRunStatus。
 *
 * 夹具：Agent/Profile、Device/Workspace 为生产注册路径较长的前置依赖，按既有
 * integration 约定直插行；每处标注 removeWhen。Work/inbox/intent/Run 全部走生产命令。
 */
import { randomBytes, randomUUID } from 'node:crypto'
import { eq } from 'drizzle-orm'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { Database, MachineRunMandateFacts } from '@whalepod/db'
import { Outbox, markRunMandateInvalidated, schema } from '@whalepod/db'
import { asUserId } from '@whalepod/domain'
import {
  autoDispatchProposedIntent,
  cancelInvalidatedMachineRuns,
  mandateInvalidationReason,
  reconcileMandateInvalidation,
} from '../src/modules/dispatch/service.js'
import {
  apiInject,
  createTestApp,
  createTestDatabase,
  driveInviteAndAccept,
  driveSetup,
  idemKey,
  resetDatabase,
  runEventFrame,
  type Session,
  type TestApp,
} from './helpers.js'

const GOAL = '根据最新预算变化，产出下一版受控草稿'

async function createProject(ctx: TestApp, session: Session): Promise<string> {
  const res = await apiInject(ctx, session, {
    method: 'POST',
    url: '/api/v1/projects',
    payload: { name: `rd03a-${Date.now()}-${randomUUID().slice(0, 6)}` },
  })
  expect(res.statusCode).toBe(201)
  return res.json().data.id as string
}

async function createTask(
  ctx: TestApp,
  session: Session,
  projectId: string,
  assigneeUserId: string,
): Promise<string> {
  const res = await apiInject(ctx, session, {
    method: 'POST',
    url: `/api/v1/projects/${projectId}/tasks`,
    payload: { title: '预算草稿持续工作', assigneeUserId },
  })
  expect(res.statusCode).toBe(201)
  return res.json().data.id as string
}

async function acceptTask(ctx: TestApp, session: Session, taskId: string): Promise<void> {
  const res = await apiInject(ctx, session, {
    method: 'POST',
    url: `/api/v1/tasks/${taskId}/accept`,
  })
  expect(res.statusCode).toBe(200)
}

async function createAgent(
  database: Database,
  createdBy: string,
  approvalPolicy: 'approval_required' | 'full_access' = 'approval_required',
): Promise<{ agentId: string; revisionId: string }> {
  // removeWhen: Agent 创建尚无 HTTP 面；本夹具只造 profile FK，不写任何运行时状态。
  const suffix = randomUUID().slice(0, 8)
  const packId = randomUUID()
  const agentId = randomUUID()
  const revisionId = randomUUID()
  await database.db.insert(schema.pluginPacks).values({
    id: packId,
    name: `rd03a-pack-${suffix}`,
    installations: [],
    packDigest: 'a'.repeat(64),
    createdBy,
  })
  await database.db.insert(schema.agents).values({
    id: agentId,
    name: `rd03a-agent-${suffix}`,
    description: '',
    createdBy,
  })
  await database.db.insert(schema.agentProfileRevisions).values({
    id: revisionId,
    agentId,
    revision: 1,
    persona: '测试 Agent',
    provider: 'test',
    model: 'test',
    credentialSlot: 'test',
    maxTokens: 50000,
    inputPriceMicrosPerMillionTokens: 1000,
    outputPriceMicrosPerMillionTokens: 2000,
    approvalPolicy,
    pluginPackId: packId,
    profileDigest: 'b'.repeat(64),
    createdBy,
  })
  await database.db
    .update(schema.agents)
    .set({ currentRevisionId: revisionId })
    .where(eq(schema.agents.id, agentId))
  return { agentId, revisionId }
}

async function createDevice(
  database: Database,
  ownerUserId: string,
  capabilities: Record<string, unknown> = {
    contextCapabilities: ['project-context.v1', 'context-state.v1', 'work-input.v1'],
  },
): Promise<{ deviceId: string; workspaceId: string }> {
  // removeWhen: Device 配对是既有 WS 握手路径；本夹具只造在线设备/工作区 FK，
  // 不写 active_runtime/Run 投影。
  const suffix = randomUUID().slice(0, 8)
  const deviceId = randomUUID()
  const workspaceId = randomUUID()
  await database.db.insert(schema.devices).values({
    id: deviceId,
    ownerUserId,
    name: `rd03a-dev-${suffix}`,
    platform: 'darwin',
    architecture: 'arm64',
    nodeVersion: '24.12.0',
    nodeAppVersion: '0.1.0',
    tokenHash: randomBytes(32),
    capabilities,
    dshDistributionVersion: '0.1.0-rc.8',
    lastSeenAt: new Date(),
  })
  await database.db.insert(schema.workspaces).values({
    id: workspaceId,
    deviceId,
    ownerUserId,
    name: `rd03a-ws-${suffix}`,
    kind: 'directory',
    capabilities: { read: true, write: true },
    available: true,
  })
  return { deviceId, workspaceId }
}

async function createWork(ctx: TestApp, session: Session, taskId: string) {
  const res = await apiInject(ctx, session, {
    method: 'POST',
    url: `/api/v1/tasks/${taskId}/works`,
    payload: { goal: GOAL },
    idempotencyKey: idemKey(),
  })
  expect(res.statusCode).toBe(201)
  return res.json().data as { workKey: string }
}

async function createMandate(
  ctx: TestApp,
  session: Session,
  workKey: string,
  overrides: Record<string, unknown> = {},
) {
  const res = await apiInject(ctx, session, {
    method: 'POST',
    url: `/api/v1/works/${workKey}/mandates`,
    payload: {
      expiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
      allowedActionClasses: ['research', 'analysis', 'draft', 'revise'],
      allowedSourceTypes: ['task_message', 'context_entry'],
      allowedToolNames: ['read', 'glob'],
      ...overrides,
    },
    idempotencyKey: idemKey(),
  })
  expect(res.statusCode).toBe(201)
  return res.json().data
}

async function comment(ctx: TestApp, session: Session, taskId: string): Promise<string> {
  const res = await apiInject(ctx, session, {
    method: 'POST',
    url: `/api/v1/tasks/${taskId}/comments`,
    payload: { body: '预算从 12 万改为 8 万，请更新草稿。' },
    idempotencyKey: idemKey(),
  })
  expect(res.statusCode).toBe(201)
  return res.json().data.id as string
}

async function associate(
  ctx: TestApp,
  session: Session,
  workKey: string,
  messageId: string,
): Promise<string> {
  const res = await apiInject(ctx, session, {
    method: 'POST',
    url: `/api/v1/works/${workKey}/inbox-items`,
    payload: { sourceType: 'task_message', sourceId: messageId },
    idempotencyKey: idemKey(),
  })
  expect(res.statusCode).toBe(201)
  return res.json().data.id as string
}

async function proposeIntent(
  ctx: TestApp,
  session: Session,
  workKey: string,
  messageId: string,
): Promise<string> {
  const res = await apiInject(ctx, session, {
    method: 'POST',
    url: `/api/v1/works/${workKey}/admission-checks`,
    payload: { sourceType: 'task_message', sourceId: messageId },
    idempotencyKey: idemKey(),
  })
  expect(res.statusCode).toBe(200)
  const intentId = res.json().data.proposedIntent?.id
  expect(typeof intentId).toBe('string')
  return intentId as string
}

async function approve(
  ctx: TestApp,
  session: Session,
  workKey: string,
  intentId: string,
  expected = 200,
) {
  const res = await apiInject(ctx, session, {
    method: 'POST',
    url: `/api/v1/works/${workKey}/dispatch-intents/${intentId}/approve`,
    payload: {},
    idempotencyKey: idemKey(),
  })
  expect(res.statusCode).toBe(expected)
  return res
}

describe('RD-03a controlled dispatch (ADR-0028 §6)', () => {
  let database: Database
  let ctx: TestApp
  let alice: Session
  let bob: Session
  let projectId: string
  let taskId: string
  let agent: { agentId: string; revisionId: string }
  let device: { deviceId: string; workspaceId: string }

  beforeAll(async () => {
    database = await createTestDatabase()
  })

  beforeEach(async () => {
    await resetDatabase(database)
    ctx = await createTestApp(database)
    alice = await driveSetup(ctx, 'alice')
    bob = (
      await driveInviteAndAccept(ctx, alice, {
        username: 'bob',
        displayName: 'Bob',
        password: 'correct horse battery staple',
      })
    ).session
    projectId = await createProject(ctx, alice)
    taskId = await createTask(ctx, alice, projectId, alice.userId)
    await acceptTask(ctx, alice, taskId)
    agent = await createAgent(database, alice.userId)
    device = await createDevice(database, alice.userId)
  })

  afterEach(async () => {
    await ctx.app.close()
  })

  afterAll(async () => {
    await database.close()
  })

  async function prepareIntent(workKey: string): Promise<{ intentId: string; itemId: string }> {
    const messageId = await comment(ctx, alice, taskId)
    const itemId = await associate(ctx, alice, workKey, messageId)
    const intentId = await proposeIntent(ctx, alice, workKey, messageId)
    return { intentId, itemId }
  }

  /** RD-03c2 夹具：生产 HTTP 派工 + runtime.ready，得到一个 running 机器 Run。 */
  async function startRunningMachineRun() {
    const work = await createWork(ctx, alice, taskId)
    const mandate = await createMandate(ctx, alice, work.workKey, {
      allowedAgentIds: [agent.agentId],
    })
    const { intentId } = await prepareIntent(work.workKey)
    await approve(ctx, alice, work.workKey, intentId)
    const dispatched = await apiInject(ctx, alice, {
      method: 'POST',
      url: `/api/v1/works/${work.workKey}/dispatch-intents/${intentId}/dispatch`,
      payload: {
        agentId: agent.agentId,
        profileRevisionId: agent.revisionId,
        deviceId: device.deviceId,
        workspaceId: device.workspaceId,
        actionClass: 'draft',
      },
      idempotencyKey: idemKey(),
    })
    expect(dispatched.statusCode).toBe(200)
    const runId = String(dispatched.json().data.runId)
    await ctx.app.runOrchestrator.ingestNodeEvent(
      { deviceId: device.deviceId, ownerUserId: alice.userId },
      runEventFrame(runId, 1, { type: 'runtime.ready', dshSessionId: `rd03c2-${runId}` }),
    )
    const [run] = await database.db.select().from(schema.runs).where(eq(schema.runs.id, runId))
    expect(run?.status).toBe('running')
    return { work, mandate, intentId, runId }
  }

  it('approve → dispatch creates a machine Run with provenance and reactivates work on terminal', async () => {
    const work = await createWork(ctx, alice, taskId)
    const mandate = await createMandate(ctx, alice, work.workKey, {
      allowedAgentIds: [agent.agentId],
      allowedToolNames: ['write', 'edit'],
    })
    const { intentId, itemId } = await prepareIntent(work.workKey)

    const approved = await approve(ctx, alice, work.workKey, intentId)
    expect(approved.json().data).toMatchObject({
      id: intentId,
      workKey: work.workKey,
      status: 'approved',
      approvalBasis: 'human',
      onBehalfOfUserId: alice.userId,
    })

    const dispatched = await apiInject(ctx, alice, {
      method: 'POST',
      url: `/api/v1/works/${work.workKey}/dispatch-intents/${intentId}/dispatch`,
      payload: {
        agentId: agent.agentId,
        profileRevisionId: agent.revisionId,
        deviceId: device.deviceId,
        workspaceId: device.workspaceId,
        actionClass: 'draft',
        workInputItemIds: [itemId],
      },
      idempotencyKey: idemKey(),
    })
    expect(dispatched.statusCode).toBe(200)
    const intent = dispatched.json().data
    expect(intent).toMatchObject({
      status: 'dispatched',
      approvalBasis: 'human',
      agentId: agent.agentId,
      profileRevisionId: agent.revisionId,
      deviceId: device.deviceId,
      workspaceId: device.workspaceId,
      actionClass: 'draft',
    })
    expect(intent.runId).toMatch(/^[0-9a-f-]{36}$/)

    const [run] = await database.db
      .select()
      .from(schema.runs)
      .where(eq(schema.runs.id, intent.runId))
    expect(run).toMatchObject({
      origin: 'mandate',
      taskId,
      workKey: work.workKey,
      mandateId: intent.mandateId,
      dispatchIntentId: intentId,
      onBehalfOfUserId: alice.userId,
      status: 'queued',
    })
    const [workRow] = await database.db
      .select()
      .from(schema.works)
      .where(eq(schema.works.workKey, work.workKey))
    expect(workRow).toMatchObject({
      state: 'waiting',
      resumeMode: 'auto',
      resumeCondition: `run:${intent.runId}`,
    })

    // 真实下发前复核：work 已 waiting(auto, run:<id>)，端口必须认出这是本 Run
    // 自己的等待态，而不是 work_unavailable。
    const [startCommand] = await database.db
      .select()
      .from(schema.dispatchOutbox)
      .where(eq(schema.dispatchOutbox.type, 'run.start'))
    expect(startCommand).toBeDefined()
    expect(startCommand?.payload).toMatchObject({
      toolPolicy: {
        mode: 'draft',
        allowedToolNames: ['write', 'edit'],
        mandateVersion: mandate.version,
        workKey: work.workKey,
      },
    })
    expect(
      await ctx.app.runOrchestrator.beforeDispatch({
        id: startCommand!.id,
        deviceId: startCommand!.deviceId,
        type: startCommand!.type,
        payload: startCommand!.payload,
        attemptCount: 1,
        sentAt: null,
      }),
    ).toBe(true)
    expect(
      (
        await database.db
          .select()
          .from(schema.runs)
          .where(eq(schema.runs.id, String(intent.runId)))
      )[0]?.status,
    ).toBe('queued')

    const runView = await apiInject(ctx, alice, {
      method: 'GET',
      url: `/api/v1/runs/${String(intent.runId)}`,
    })
    expect(runView.statusCode).toBe(200)
    expect(runView.json().data).toMatchObject({
      origin: 'mandate',
      dispatchIntentId: intentId,
      onBehalfOfUserId: alice.userId,
      workKey: work.workKey,
      workInputItemCount: 1,
    })

    // 真实 Node 事件路径：runtime.ready 推进 running，run.completed 收敛终态。
    await ctx.app.runOrchestrator.ingestNodeEvent(
      { deviceId: device.deviceId, ownerUserId: alice.userId },
      runEventFrame(String(intent.runId), 1, {
        type: 'runtime.ready',
        dshSessionId: 'rd03a-session',
      }),
    )
    await ctx.app.runOrchestrator.ingestNodeEvent(
      { deviceId: device.deviceId, ownerUserId: alice.userId },
      runEventFrame(String(intent.runId), 2, {
        type: 'run.completed',
        finalText: 'draft ready',
      }),
    )
    const [after] = await database.db
      .select()
      .from(schema.works)
      .where(eq(schema.works.workKey, work.workKey))
    expect(after).toMatchObject({
      state: 'active',
      resumeMode: null,
      resumeCondition: null,
    })
  })

  it('rejects non-assignee approval/dispatch and keeps the intent proposed', async () => {
    const work = await createWork(ctx, alice, taskId)
    await createMandate(ctx, alice, work.workKey)
    const { intentId, itemId } = await prepareIntent(work.workKey)

    const deniedApprove = await approve(ctx, bob, work.workKey, intentId, 403)
    expect(deniedApprove.json().error.code).toBe('FORBIDDEN')
    const deniedDispatch = await apiInject(ctx, bob, {
      method: 'POST',
      url: `/api/v1/works/${work.workKey}/dispatch-intents/${intentId}/dispatch`,
      payload: {
        agentId: agent.agentId,
        deviceId: device.deviceId,
        workspaceId: device.workspaceId,
        actionClass: 'draft',
        workInputItemIds: [itemId],
      },
      idempotencyKey: idemKey(),
    })
    expect(deniedDispatch.statusCode).toBe(403)
    expect(deniedDispatch.json().error.code).toBe('FORBIDDEN')
    expect(await database.db.select().from(schema.runs)).toHaveLength(0)
  })

  it('cancels an approved intent when the mandate version is superseded', async () => {
    const work = await createWork(ctx, alice, taskId)
    const mandate = await createMandate(ctx, alice, work.workKey)
    const { intentId } = await prepareIntent(work.workKey)
    const approveKey = idemKey()
    const approved = await apiInject(ctx, alice, {
      method: 'POST',
      url: `/api/v1/works/${work.workKey}/dispatch-intents/${intentId}/approve`,
      payload: {},
      idempotencyKey: approveKey,
    })
    expect(approved.statusCode).toBe(200)
    const [approvedRow] = await database.db
      .select()
      .from(schema.dispatchIntents)
      .where(eq(schema.dispatchIntents.id, intentId))
    expect(approvedRow?.status).toBe('approved')

    const paused = await apiInject(ctx, alice, {
      method: 'POST',
      url: `/api/v1/mandates/${String(mandate.id)}/pause`,
      payload: {},
      idempotencyKey: idemKey(),
    })
    expect(paused.statusCode).toBe(200)
    const resumed = await apiInject(ctx, alice, {
      method: 'POST',
      url: `/api/v1/mandates/${String(paused.json().data.id)}/resume`,
      payload: {},
      idempotencyKey: idemKey(),
    })
    expect(resumed.statusCode).toBe(200)

    const [cancelled] = await database.db
      .select()
      .from(schema.dispatchIntents)
      .where(eq(schema.dispatchIntents.id, intentId))
    expect(cancelled).toMatchObject({ status: 'cancelled' })
    // 同幂等键重放必须回读当前状态，而不是缓存里的 approved。
    const replay = await apiInject(ctx, alice, {
      method: 'POST',
      url: `/api/v1/works/${work.workKey}/dispatch-intents/${intentId}/approve`,
      payload: {},
      idempotencyKey: approveKey,
    })
    expect(replay.statusCode).toBe(200)
    expect(replay.json().data.status).toBe('cancelled')
    const dispatch = await apiInject(ctx, alice, {
      method: 'POST',
      url: `/api/v1/works/${work.workKey}/dispatch-intents/${intentId}/dispatch`,
      payload: {
        agentId: agent.agentId,
        deviceId: device.deviceId,
        workspaceId: device.workspaceId,
        actionClass: 'draft',
      },
      idempotencyKey: idemKey(),
    })
    expect(dispatch.statusCode).toBe(409)
    expect(dispatch.json().error.code).toBe('CONFLICT')
    expect(await database.db.select().from(schema.runs)).toHaveLength(0)
  })

  it('reject records a stable resolution reason and cannot dispatch', async () => {
    const work = await createWork(ctx, alice, taskId)
    await createMandate(ctx, alice, work.workKey)
    const { intentId } = await prepareIntent(work.workKey)
    const rejected = await apiInject(ctx, alice, {
      method: 'POST',
      url: `/api/v1/works/${work.workKey}/dispatch-intents/${intentId}/reject`,
      payload: { reason: 'budget_not_approved' },
      idempotencyKey: idemKey(),
    })
    expect(rejected.statusCode).toBe(200)
    expect(rejected.json().data).toMatchObject({
      status: 'rejected',
      resolutionReason: 'budget_not_approved',
    })
    const dispatch = await apiInject(ctx, alice, {
      method: 'POST',
      url: `/api/v1/works/${work.workKey}/dispatch-intents/${intentId}/dispatch`,
      payload: {
        agentId: agent.agentId,
        deviceId: device.deviceId,
        workspaceId: device.workspaceId,
        actionClass: 'draft',
      },
      idempotencyKey: idemKey(),
    })
    expect(dispatch.statusCode).toBe(409)
    expect(dispatch.json().error.message).toContain('approve it first')
    expect(await database.db.select().from(schema.runs)).toHaveLength(0)
  })

  it('replays the same dispatch idempotency key without a second Run/outbox command', async () => {
    const work = await createWork(ctx, alice, taskId)
    await createMandate(ctx, alice, work.workKey)
    const { intentId, itemId } = await prepareIntent(work.workKey)
    await approve(ctx, alice, work.workKey, intentId)
    const key = idemKey()
    const body = {
      agentId: agent.agentId,
      deviceId: device.deviceId,
      workspaceId: device.workspaceId,
      actionClass: 'draft',
      workInputItemIds: [itemId],
    }
    const first = await apiInject(ctx, alice, {
      method: 'POST',
      url: `/api/v1/works/${work.workKey}/dispatch-intents/${intentId}/dispatch`,
      payload: body,
      idempotencyKey: key,
    })
    expect(first.statusCode).toBe(200)
    const second = await apiInject(ctx, alice, {
      method: 'POST',
      url: `/api/v1/works/${work.workKey}/dispatch-intents/${intentId}/dispatch`,
      payload: body,
      idempotencyKey: key,
    })
    expect(second.statusCode).toBe(200)
    expect(second.json().data.runId).toBe(first.json().data.runId)
    expect(await database.db.select().from(schema.runs)).toHaveLength(1)
    const outbox = await database.db.select().from(schema.dispatchOutbox)
    expect(outbox.filter((row) => row.type === 'run.start')).toHaveLength(1)
  })

  it('does not reuse the first Run when the same idempotency key carries a different dispatch body', async () => {
    const work = await createWork(ctx, alice, taskId)
    await createMandate(ctx, alice, work.workKey)
    const { intentId, itemId } = await prepareIntent(work.workKey)
    await approve(ctx, alice, work.workKey, intentId)
    const key = idemKey()
    const body = {
      agentId: agent.agentId,
      deviceId: device.deviceId,
      workspaceId: device.workspaceId,
      actionClass: 'draft',
      workInputItemIds: [itemId],
    }
    const first = await apiInject(ctx, alice, {
      method: 'POST',
      url: `/api/v1/works/${work.workKey}/dispatch-intents/${intentId}/dispatch`,
      payload: body,
      idempotencyKey: key,
    })
    expect(first.statusCode).toBe(200)

    // 同一幂等键但不是同一个请求：必须按新命令处理并由意图状态拒绝，
    // 不能把第一次的 Run 当成这次请求的回执（ADR-0028 §6 一意图一 Run）。
    const changed = await apiInject(ctx, alice, {
      method: 'POST',
      url: `/api/v1/works/${work.workKey}/dispatch-intents/${intentId}/dispatch`,
      payload: { ...body, profileRevisionId: agent.revisionId },
      idempotencyKey: key,
    })
    expect(changed.statusCode).toBe(409)
    expect(await database.db.select().from(schema.runs)).toHaveLength(1)
  })

  it('keeps a queued machine Run when resume is a no-op on the current active mandate', async () => {
    const work = await createWork(ctx, alice, taskId)
    const mandate = await createMandate(ctx, alice, work.workKey)
    const { intentId, itemId } = await prepareIntent(work.workKey)
    await approve(ctx, alice, work.workKey, intentId)
    const dispatched = await apiInject(ctx, alice, {
      method: 'POST',
      url: `/api/v1/works/${work.workKey}/dispatch-intents/${intentId}/dispatch`,
      payload: {
        agentId: agent.agentId,
        deviceId: device.deviceId,
        workspaceId: device.workspaceId,
        actionClass: 'draft',
        workInputItemIds: [itemId],
      },
      idempotencyKey: idemKey(),
    })
    expect(dispatched.statusCode).toBe(200)
    const runId = String(dispatched.json().data.runId)

    // no-op：resume 当前已 active 的 Mandate 不产生新版本，也不得取消仍由它授权的 Run。
    const resumed = await apiInject(ctx, alice, {
      method: 'POST',
      url: `/api/v1/mandates/${String(mandate.id)}/resume`,
      payload: {},
      idempotencyKey: idemKey(),
    })
    expect(resumed.statusCode).toBe(200)
    expect(resumed.json().data).toMatchObject({ id: mandate.id, status: 'active' })

    // 直接驱动生产取消端口：取消集合必须按 mandateId 过滤，不能只看 work。
    const cancellation = await cancelInvalidatedMachineRuns(
      {
        database,
        orchestrator: ctx.app.runOrchestrator,
        outbox: new Outbox(database),
        now: () => new Date(),
      },
      { userId: alice.userId, role: 'owner' },
      work.workKey,
    )
    expect(cancellation).toEqual({
      cancelled: 0,
      failed: 0,
      invalidated: 0,
      invalidateFailed: 0,
    })
    const [run] = await database.db.select().from(schema.runs).where(eq(schema.runs.id, runId))
    expect(run?.status).toBe('queued')
    const [workRow] = await database.db
      .select()
      .from(schema.works)
      .where(eq(schema.works.workKey, work.workKey))
    expect(workRow).toMatchObject({
      state: 'waiting',
      resumeMode: 'auto',
      resumeCondition: `run:${runId}`,
    })
  })

  it('pause marks a running machine Run mandate-invalidated and enqueues one signal', async () => {
    const work = await createWork(ctx, alice, taskId)
    const mandate = await createMandate(ctx, alice, work.workKey, {
      allowedAgentIds: [agent.agentId],
    })
    const { intentId, itemId } = await prepareIntent(work.workKey)
    await approve(ctx, alice, work.workKey, intentId)
    const dispatched = await apiInject(ctx, alice, {
      method: 'POST',
      url: `/api/v1/works/${work.workKey}/dispatch-intents/${intentId}/dispatch`,
      payload: {
        agentId: agent.agentId,
        profileRevisionId: agent.revisionId,
        deviceId: device.deviceId,
        workspaceId: device.workspaceId,
        actionClass: 'draft',
        workInputItemIds: [itemId],
      },
      idempotencyKey: idemKey(),
    })
    expect(dispatched.statusCode).toBe(200)
    const runId = String(dispatched.json().data.runId)
    await ctx.app.runOrchestrator.ingestNodeEvent(
      { deviceId: device.deviceId, ownerUserId: alice.userId },
      runEventFrame(runId, 1, { type: 'runtime.ready', dshSessionId: 'rd03c2-session' }),
    )
    const [running] = await database.db.select().from(schema.runs).where(eq(schema.runs.id, runId))
    expect(running?.status).toBe('running')

    const paused = await apiInject(ctx, alice, {
      method: 'POST',
      url: `/api/v1/mandates/${String(mandate.id)}/pause`,
      payload: {},
      idempotencyKey: idemKey(),
    })
    expect(paused.statusCode).toBe(200)

    const [run] = await database.db.select().from(schema.runs).where(eq(schema.runs.id, runId))
    expect(run?.status).toBe('running')
    expect(run?.mandateInvalidatedAt).not.toBeNull()
    expect(run?.mandateInvalidatedReason).toBe('mandate_paused')
    const signals = await database.db
      .select()
      .from(schema.dispatchOutbox)
      .where(eq(schema.dispatchOutbox.type, 'run.mandate_invalidated'))
    expect(signals).toHaveLength(1)
    expect(signals[0]?.payload).toMatchObject({
      runId,
      mandateId: mandate.id,
      reason: 'mandate_paused',
    })

    const view = await apiInject(ctx, alice, {
      method: 'GET',
      url: `/api/v1/runs/${runId}`,
    })
    expect(view.statusCode).toBe(200)
    expect(view.json().data).toMatchObject({
      status: 'running',
      mandateInvalidatedReason: 'mandate_paused',
    })
    expect(typeof view.json().data.mandateInvalidatedAt).toBe('string')

    // 重复回调（同一旧 Mandate）不得再入队第二条失效信号。
    const replay = await cancelInvalidatedMachineRuns(
      {
        database,
        orchestrator: ctx.app.runOrchestrator,
        outbox: new Outbox(database),
        now: () => new Date(),
      },
      { userId: alice.userId, role: 'owner' },
      work.workKey,
    )
    expect(replay.invalidated).toBe(0)
    expect(
      await database.db
        .select()
        .from(schema.dispatchOutbox)
        .where(eq(schema.dispatchOutbox.type, 'run.mandate_invalidated')),
    ).toHaveLength(1)
  })

  it('revoke marks a running machine Run mandate-invalidated', async () => {
    const { mandate, runId } = await startRunningMachineRun()
    const revoked = await apiInject(ctx, alice, {
      method: 'POST',
      url: `/api/v1/mandates/${String(mandate.id)}/revoke`,
      payload: {},
      idempotencyKey: idemKey(),
    })
    expect(revoked.statusCode).toBe(200)
    const [run] = await database.db.select().from(schema.runs).where(eq(schema.runs.id, runId))
    expect(run?.status).toBe('running')
    expect(run?.mandateInvalidatedReason).toBe('mandate_revoked')
    expect(
      await database.db
        .select()
        .from(schema.dispatchOutbox)
        .where(eq(schema.dispatchOutbox.type, 'run.mandate_invalidated')),
    ).toHaveLength(1)
    const view = await apiInject(ctx, alice, { method: 'GET', url: `/api/v1/runs/${runId}` })
    expect(view.json().data).toMatchObject({
      status: 'running',
      mandateInvalidatedReason: 'mandate_revoked',
    })
  })

  it('resume creates a new mandate version without duplicating the invalidation signal', async () => {
    const { mandate, runId } = await startRunningMachineRun()
    const paused = await apiInject(ctx, alice, {
      method: 'POST',
      url: `/api/v1/mandates/${String(mandate.id)}/pause`,
      payload: {},
      idempotencyKey: idemKey(),
    })
    expect(paused.statusCode).toBe(200)
    const [afterPause] = await database.db
      .select()
      .from(schema.runs)
      .where(eq(schema.runs.id, runId))
    const resumed = await apiInject(ctx, alice, {
      method: 'POST',
      url: `/api/v1/mandates/${String(paused.json().data.id)}/resume`,
      payload: {},
      idempotencyKey: idemKey(),
    })
    expect(resumed.statusCode).toBe(200)
    const [afterResume] = await database.db
      .select()
      .from(schema.runs)
      .where(eq(schema.runs.id, runId))
    expect(afterResume?.status).toBe('running')
    expect(afterResume?.mandateInvalidatedReason).toBe('mandate_paused')
    expect(afterResume?.mandateInvalidatedAt).toEqual(afterPause?.mandateInvalidatedAt)
    expect(
      await database.db
        .select()
        .from(schema.dispatchOutbox)
        .where(eq(schema.dispatchOutbox.type, 'run.mandate_invalidated')),
    ).toHaveLength(1)
  })

  it('does not mark a terminal machine Run during the expiry sweep', async () => {
    const { mandate, runId } = await startRunningMachineRun()
    await ctx.app.runOrchestrator.ingestNodeEvent(
      { deviceId: device.deviceId, ownerUserId: alice.userId },
      runEventFrame(runId, 2, {
        type: 'run.completed',
        finalText: 'done before expiry',
      }),
    )
    const expiresAt = new Date(Date.now() + 1_000)
    await database.db
      .update(schema.workMandates)
      .set({ expiresAt })
      .where(eq(schema.workMandates.id, mandate.id))
    const now = new Date(expiresAt.getTime() + 1_000)
    expect(
      await reconcileMandateInvalidation(
        { database, outbox: new Outbox(database), now: () => now },
        now,
      ),
    ).toEqual({ invalidated: 0, failed: 0 })
    const [run] = await database.db.select().from(schema.runs).where(eq(schema.runs.id, runId))
    expect(run?.status).toBe('completed')
    expect(run?.mandateInvalidatedAt).toBeNull()
    expect(
      await database.db
        .select()
        .from(schema.dispatchOutbox)
        .where(eq(schema.dispatchOutbox.type, 'run.mandate_invalidated')),
    ).toHaveLength(0)
  })

  it('markRunMandateInvalidated is idempotent at the row level', async () => {
    const { runId } = await startRunningMachineRun()
    const first = await database.transaction((tx) =>
      markRunMandateInvalidated(tx, runId, 'mandate_paused', new Date()),
    )
    expect(first).toBeDefined()
    const second = await database.transaction((tx) =>
      markRunMandateInvalidated(tx, runId, 'mandate_paused', new Date()),
    )
    expect(second).toBeUndefined()
  })

  it('does not scan human runs during the invalidation sweep', async () => {
    const created = await apiInject(ctx, alice, {
      method: 'POST',
      url: `/api/v1/tasks/${taskId}/runs`,
      payload: {
        agentId: agent.agentId,
        deviceId: device.deviceId,
        workspaceId: device.workspaceId,
        prompt: 'human run',
      },
    })
    expect(created.statusCode).toBe(201)
    const runId = String(created.json().data.id)
    await ctx.app.runOrchestrator.ingestNodeEvent(
      { deviceId: device.deviceId, ownerUserId: alice.userId },
      runEventFrame(runId, 1, { type: 'runtime.ready', dshSessionId: `human-${runId}` }),
    )
    const now = new Date()
    expect(
      await reconcileMandateInvalidation(
        { database, outbox: new Outbox(database), now: () => now },
        now,
      ),
    ).toEqual({ invalidated: 0, failed: 0 })
    const [run] = await database.db.select().from(schema.runs).where(eq(schema.runs.id, runId))
    expect(run?.status).toBe('running')
    expect(run?.mandateInvalidatedAt).toBeNull()
  })

  it('sweep marks a running machine Run when its work is retired', async () => {
    const { work, runId } = await startRunningMachineRun()
    const retired = await apiInject(ctx, alice, {
      method: 'POST',
      url: `/api/v1/works/${work.workKey}/retire`,
      payload: {},
      idempotencyKey: idemKey(),
    })
    expect(retired.statusCode).toBe(200)
    const now = new Date()
    expect(
      await reconcileMandateInvalidation(
        { database, outbox: new Outbox(database), now: () => now },
        now,
      ),
    ).toMatchObject({ invalidated: 1, failed: 0 })
    const [run] = await database.db.select().from(schema.runs).where(eq(schema.runs.id, runId))
    expect(run?.status).toBe('running')
    expect(run?.mandateInvalidatedReason).toBe('work_unavailable')
  })

  it('expiry sweep marks a running machine Run when its mandate has expired', async () => {
    const work = await createWork(ctx, alice, taskId)
    const mandate = await createMandate(ctx, alice, work.workKey, {
      allowedAgentIds: [agent.agentId],
    })
    const { intentId } = await prepareIntent(work.workKey)
    await approve(ctx, alice, work.workKey, intentId)
    const dispatched = await apiInject(ctx, alice, {
      method: 'POST',
      url: `/api/v1/works/${work.workKey}/dispatch-intents/${intentId}/dispatch`,
      payload: {
        agentId: agent.agentId,
        profileRevisionId: agent.revisionId,
        deviceId: device.deviceId,
        workspaceId: device.workspaceId,
        actionClass: 'draft',
      },
      idempotencyKey: idemKey(),
    })
    expect(dispatched.statusCode).toBe(200)
    const runId = String(dispatched.json().data.runId)
    await ctx.app.runOrchestrator.ingestNodeEvent(
      { deviceId: device.deviceId, ownerUserId: alice.userId },
      runEventFrame(runId, 1, { type: 'runtime.ready', dshSessionId: 'rd03c2-expiry' }),
    )
    // removeWhen: 没有把系统时钟拨到 Mandate 到期的 HTTP 面；只改到期时间，
    // 仍由生产周期清扫函数判定并写标记/命令。约束要求 expires_at > created_at，
    // 故取「一秒后到期 + 两秒后的清扫时刻」。
    const expiresAt = new Date(Date.now() + 1_000)
    await database.db
      .update(schema.workMandates)
      .set({ expiresAt })
      .where(eq(schema.workMandates.id, mandate.id))

    const now = new Date(expiresAt.getTime() + 1_000)
    const result = await reconcileMandateInvalidation(
      { database, outbox: new Outbox(database), now: () => now },
      now,
    )
    expect(result).toMatchObject({ invalidated: 1, failed: 0 })
    const [run] = await database.db.select().from(schema.runs).where(eq(schema.runs.id, runId))
    expect(run?.status).toBe('running')
    expect(run?.mandateInvalidatedReason).toBe('mandate_expired')
    const signals = await database.db
      .select()
      .from(schema.dispatchOutbox)
      .where(eq(schema.dispatchOutbox.type, 'run.mandate_invalidated'))
    expect(signals).toHaveLength(1)
    expect(signals[0]?.payload).toMatchObject({ runId, reason: 'mandate_expired' })

    // 第二轮清扫幂等：已标记行不再产生第二条命令。
    expect(
      await reconcileMandateInvalidation(
        { database, outbox: new Outbox(database), now: () => now },
        now,
      ),
    ).toEqual({ invalidated: 0, failed: 0 })
  })

  it('does not cancel a newer queued machine Run when an older pause command is replayed', async () => {
    const work = await createWork(ctx, alice, taskId)
    const mandate = await createMandate(ctx, alice, work.workKey)
    const pauseKey = idemKey()
    const paused = await apiInject(ctx, alice, {
      method: 'POST',
      url: `/api/v1/mandates/${String(mandate.id)}/pause`,
      payload: {},
      idempotencyKey: pauseKey,
    })
    expect(paused.statusCode).toBe(200)
    const pausedId = String(paused.json().data.id)
    const resumed = await apiInject(ctx, alice, {
      method: 'POST',
      url: `/api/v1/mandates/${pausedId}/resume`,
      payload: {},
      idempotencyKey: idemKey(),
    })
    expect(resumed.statusCode).toBe(200)

    // 新 Mandate 版本下正常派工，Run 仍在 queued。
    const { intentId, itemId } = await prepareIntent(work.workKey)
    await approve(ctx, alice, work.workKey, intentId)
    const dispatched = await apiInject(ctx, alice, {
      method: 'POST',
      url: `/api/v1/works/${work.workKey}/dispatch-intents/${intentId}/dispatch`,
      payload: {
        agentId: agent.agentId,
        deviceId: device.deviceId,
        workspaceId: device.workspaceId,
        actionClass: 'draft',
        workInputItemIds: [itemId],
      },
      idempotencyKey: idemKey(),
    })
    expect(dispatched.statusCode).toBe(200)
    const runId = String(dispatched.json().data.runId)

    // 重放旧 pause 只回执，不执行命令；不得用旧 Mandate 的副作用取消新 Run。
    const replay = await apiInject(ctx, alice, {
      method: 'POST',
      url: `/api/v1/mandates/${String(mandate.id)}/pause`,
      payload: {},
      idempotencyKey: pauseKey,
    })
    expect(replay.statusCode).toBe(200)
    const [run] = await database.db.select().from(schema.runs).where(eq(schema.runs.id, runId))
    expect(run?.status).toBe('queued')
    const [workRow] = await database.db
      .select()
      .from(schema.works)
      .where(eq(schema.works.workKey, work.workKey))
    expect(workRow).toMatchObject({
      state: 'waiting',
      resumeCondition: `run:${runId}`,
    })
  })

  it('beforeDispatch cancels a queued no-input machine Run after the work is retired', async () => {
    const work = await createWork(ctx, alice, taskId)
    await createMandate(ctx, alice, work.workKey)
    const { intentId } = await prepareIntent(work.workKey)
    await approve(ctx, alice, work.workKey, intentId)
    const dispatched = await apiInject(ctx, alice, {
      method: 'POST',
      url: `/api/v1/works/${work.workKey}/dispatch-intents/${intentId}/dispatch`,
      payload: {
        agentId: agent.agentId,
        deviceId: device.deviceId,
        workspaceId: device.workspaceId,
        actionClass: 'draft',
      },
      idempotencyKey: idemKey(),
    })
    expect(dispatched.statusCode).toBe(200)
    const runId = String(dispatched.json().data.runId)
    const retired = await apiInject(ctx, alice, {
      method: 'POST',
      url: `/api/v1/works/${work.workKey}/retire`,
      payload: {},
      idempotencyKey: idemKey(),
    })
    expect(retired.statusCode).toBe(200)

    const [start] = await database.db
      .select()
      .from(schema.dispatchOutbox)
      .where(eq(schema.dispatchOutbox.type, 'run.start'))
    expect(
      await ctx.app.runOrchestrator.beforeDispatch({
        id: start!.id,
        deviceId: start!.deviceId,
        type: start!.type,
        payload: start!.payload,
        attemptCount: 1,
        sentAt: null,
      }),
    ).toBe(false)
    const [run] = await database.db.select().from(schema.runs).where(eq(schema.runs.id, runId))
    expect(run?.status).toBe('cancelled')
  })

  it('cancels a dispatching machine Run when its mandate is paused', async () => {
    const work = await createWork(ctx, alice, taskId)
    const mandate = await createMandate(ctx, alice, work.workKey)
    const { intentId, itemId } = await prepareIntent(work.workKey)
    await approve(ctx, alice, work.workKey, intentId)
    const dispatched = await apiInject(ctx, alice, {
      method: 'POST',
      url: `/api/v1/works/${work.workKey}/dispatch-intents/${intentId}/dispatch`,
      payload: {
        agentId: agent.agentId,
        deviceId: device.deviceId,
        workspaceId: device.workspaceId,
        actionClass: 'draft',
        workInputItemIds: [itemId],
      },
      idempotencyKey: idemKey(),
    })
    expect(dispatched.statusCode).toBe(200)
    const runId = String(dispatched.json().data.runId)
    const [start] = await database.db
      .select()
      .from(schema.dispatchOutbox)
      .where(eq(schema.dispatchOutbox.type, 'run.start'))
    expect(start).toBeDefined()

    // 真实 Node 受理：run.start 已写入 Node spool，Run 进入 dispatching，Runtime 尚未 ready。
    await ctx.app.runOrchestrator.ingestNodeEvent(
      { deviceId: device.deviceId, ownerUserId: alice.userId },
      {
        protocolVersion: 1,
        messageId: randomUUID(),
        sentAt: new Date().toISOString(),
        type: 'command.ack',
        payload: { commandId: start!.id, accepted: true },
      },
    )
    const [dispatching] = await database.db
      .select()
      .from(schema.runs)
      .where(eq(schema.runs.id, runId))
    expect(dispatching?.status).toBe('dispatching')

    const paused = await apiInject(ctx, alice, {
      method: 'POST',
      url: `/api/v1/mandates/${String(mandate.id)}/pause`,
      payload: {},
      idempotencyKey: idemKey(),
    })
    expect(paused.statusCode).toBe(200)
    const [cancelling] = await database.db
      .select()
      .from(schema.runs)
      .where(eq(schema.runs.id, runId))
    expect(cancelling?.status).toBe('cancel_requested')
    const [cancelCommand] = await database.db
      .select()
      .from(schema.dispatchOutbox)
      .where(eq(schema.dispatchOutbox.type, 'run.cancel'))
    expect(cancelCommand).toBeDefined()
  })

  it('rejects a second approved intent while the machine Run is active and work is waiting', async () => {
    const work = await createWork(ctx, alice, taskId)
    await createMandate(ctx, alice, work.workKey)
    const first = await prepareIntent(work.workKey)
    const second = await prepareIntent(work.workKey)
    await approve(ctx, alice, work.workKey, first.intentId)
    await approve(ctx, alice, work.workKey, second.intentId)
    const target = {
      agentId: agent.agentId,
      deviceId: device.deviceId,
      workspaceId: device.workspaceId,
      actionClass: 'draft',
    }
    const dispatched = await apiInject(ctx, alice, {
      method: 'POST',
      url: `/api/v1/works/${work.workKey}/dispatch-intents/${first.intentId}/dispatch`,
      payload: { ...target, workInputItemIds: [first.itemId] },
      idempotencyKey: idemKey(),
    })
    expect(dispatched.statusCode).toBe(200)
    const blocked = await apiInject(ctx, alice, {
      method: 'POST',
      url: `/api/v1/works/${work.workKey}/dispatch-intents/${second.intentId}/dispatch`,
      payload: { ...target, workInputItemIds: [second.itemId] },
      idempotencyKey: idemKey(),
    })
    expect(blocked.statusCode).toBe(409)
    expect(blocked.json().error.message).toContain('waiting')
    expect(await database.db.select().from(schema.runs)).toHaveLength(1)
  })

  it('cancels an approved intent when work is retired', async () => {
    const work = await createWork(ctx, alice, taskId)
    await createMandate(ctx, alice, work.workKey)
    const { intentId } = await prepareIntent(work.workKey)
    await approve(ctx, alice, work.workKey, intentId)
    const retired = await apiInject(ctx, alice, {
      method: 'POST',
      url: `/api/v1/works/${work.workKey}/retire`,
      payload: {},
      idempotencyKey: idemKey(),
    })
    expect(retired.statusCode).toBe(200)
    const dispatch = await apiInject(ctx, alice, {
      method: 'POST',
      url: `/api/v1/works/${work.workKey}/dispatch-intents/${intentId}/dispatch`,
      payload: {
        agentId: agent.agentId,
        deviceId: device.deviceId,
        workspaceId: device.workspaceId,
        actionClass: 'draft',
      },
      idempotencyKey: idemKey(),
    })
    expect(dispatch.statusCode).toBe(409)
    expect(await database.db.select().from(schema.runs)).toHaveLength(0)
  })

  it('refuses a machine Run created outside the dispatch port without full provenance', async () => {
    const work = await createWork(ctx, alice, taskId)
    const mandate = await createMandate(ctx, alice, work.workKey)
    const attempt = database.transaction((tx) =>
      ctx.app.runOrchestrator.createWithinTransaction(
        tx,
        { userId: asUserId(alice.userId), role: 'owner' },
        taskId,
        {
          idempotencyKey: `bypass-${randomUUID()}`,
          agentId: agent.agentId,
          deviceId: device.deviceId,
          workspaceId: device.workspaceId,
          prompt: 'bypass',
          dshDistributionVersion: '0.1.0-rc.8',
          origin: 'mandate',
          workKey: work.workKey,
          mandateId: mandate.id,
          onBehalfOfUserId: alice.userId,
        },
      ),
    )
    await expect(attempt).rejects.toThrow('provenance is incomplete')
    expect(await database.db.select().from(schema.runs)).toHaveLength(0)
  })

  it('binds workKey for a machine Run even when no inbox items are selected', async () => {
    const work = await createWork(ctx, alice, taskId)
    await createMandate(ctx, alice, work.workKey)
    const { intentId } = await prepareIntent(work.workKey)
    await approve(ctx, alice, work.workKey, intentId)
    const dispatched = await apiInject(ctx, alice, {
      method: 'POST',
      url: `/api/v1/works/${work.workKey}/dispatch-intents/${intentId}/dispatch`,
      payload: {
        agentId: agent.agentId,
        deviceId: device.deviceId,
        workspaceId: device.workspaceId,
        actionClass: 'draft',
      },
      idempotencyKey: idemKey(),
    })
    expect(dispatched.statusCode).toBe(200)
    const [run] = await database.db
      .select()
      .from(schema.runs)
      .where(eq(schema.runs.id, dispatched.json().data.runId))
    expect(run).toMatchObject({
      origin: 'mandate',
      workKey: work.workKey,
      workInputManifest: null,
      workInputManifestDigest: null,
    })
  })

  it('rejects an action class or agent outside the mandate', async () => {
    const work = await createWork(ctx, alice, taskId)
    const other = await createAgent(database, alice.userId)
    await createMandate(ctx, alice, work.workKey, {
      allowedActionClasses: ['draft'],
      allowedAgentIds: [agent.agentId],
    })
    const { intentId } = await prepareIntent(work.workKey)
    await approve(ctx, alice, work.workKey, intentId)
    const target = {
      agentId: agent.agentId,
      deviceId: device.deviceId,
      workspaceId: device.workspaceId,
      actionClass: 'draft',
    }
    const wrongAction = await apiInject(ctx, alice, {
      method: 'POST',
      url: `/api/v1/works/${work.workKey}/dispatch-intents/${intentId}/dispatch`,
      payload: { ...target, actionClass: 'research' },
      idempotencyKey: idemKey(),
    })
    expect(wrongAction.statusCode).toBe(403)
    const wrongAgent = await apiInject(ctx, alice, {
      method: 'POST',
      url: `/api/v1/works/${work.workKey}/dispatch-intents/${intentId}/dispatch`,
      payload: { ...target, agentId: other.agentId },
      idempotencyKey: idemKey(),
    })
    expect(wrongAgent.statusCode).toBe(403)
    expect(await database.db.select().from(schema.runs)).toHaveLength(0)
  })

  it('rejects source drift after the intent was approved', async () => {
    const work = await createWork(ctx, alice, taskId)
    await createMandate(ctx, alice, work.workKey)
    const { intentId, itemId } = await prepareIntent(work.workKey)
    await approve(ctx, alice, work.workKey, intentId)
    // removeWhen: 来源编辑尚无 HTTP 面；此处只改来源正文/版本，验证派工端口
    // 重新读取来源而不是信任准入时的摘要。
    const messageId = (
      await database.db
        .select()
        .from(schema.workInboxItems)
        .where(eq(schema.workInboxItems.id, itemId))
    )[0]?.sourceId
    await database.db
      .update(schema.taskMessages)
      .set({ body: '预算又改成 9 万。', editedAt: new Date() })
      .where(eq(schema.taskMessages.id, String(messageId)))
    const dispatch = await apiInject(ctx, alice, {
      method: 'POST',
      url: `/api/v1/works/${work.workKey}/dispatch-intents/${intentId}/dispatch`,
      payload: {
        agentId: agent.agentId,
        deviceId: device.deviceId,
        workspaceId: device.workspaceId,
        actionClass: 'draft',
      },
      idempotencyKey: idemKey(),
    })
    expect(dispatch.statusCode).toBe(409)
    const [rejected] = await database.db
      .select()
      .from(schema.dispatchIntents)
      .where(eq(schema.dispatchIntents.id, intentId))
    expect(rejected?.status).toBe('rejected')
    expect(rejected?.resolutionReason).toContain('source changed')
    expect(await database.db.select().from(schema.runs)).toHaveLength(0)
  })

  it('rechecks the mandate version at dispatch even if an approved intent was reopened', async () => {
    const work = await createWork(ctx, alice, taskId)
    const mandate = await createMandate(ctx, alice, work.workKey)
    const { intentId } = await prepareIntent(work.workKey)
    await approve(ctx, alice, work.workKey, intentId)
    const paused = await apiInject(ctx, alice, {
      method: 'POST',
      url: `/api/v1/mandates/${String(mandate.id)}/pause`,
      payload: {},
      idempotencyKey: idemKey(),
    })
    expect(paused.statusCode).toBe(200)
    await apiInject(ctx, alice, {
      method: 'POST',
      url: `/api/v1/mandates/${String(paused.json().data.id)}/resume`,
      payload: {},
      idempotencyKey: idemKey(),
    })
    // removeWhen: 模拟旧状态机/迁移遗留的 approved 行；生产路径会在新 Mandate
    // 版本时把它置 cancelled。端口仍必须自己复核 work.mandateId/version。
    await database.db
      .update(schema.dispatchIntents)
      .set({
        status: 'approved',
        approvalBasis: 'human',
        approvedAt: new Date(),
        cancelledAt: null,
      })
      .where(eq(schema.dispatchIntents.id, intentId))
    const dispatch = await apiInject(ctx, alice, {
      method: 'POST',
      url: `/api/v1/works/${work.workKey}/dispatch-intents/${intentId}/dispatch`,
      payload: {
        agentId: agent.agentId,
        deviceId: device.deviceId,
        workspaceId: device.workspaceId,
        actionClass: 'draft',
      },
      idempotencyKey: idemKey(),
    })
    expect(dispatch.statusCode).toBe(409)
    expect(await database.db.select().from(schema.runs)).toHaveLength(0)
  })

  it('rejects an intent whose inputDigest no longer matches its trigger refs', async () => {
    const work = await createWork(ctx, alice, taskId)
    await createMandate(ctx, alice, work.workKey)
    const { intentId } = await prepareIntent(work.workKey)
    await approve(ctx, alice, work.workKey, intentId)
    // removeWhen: 模拟迁移/脏数据；端口必须按 triggerRefs 重算 inputDigest。
    await database.db
      .update(schema.dispatchIntents)
      .set({ inputDigest: 'f'.repeat(64) })
      .where(eq(schema.dispatchIntents.id, intentId))
    const dispatch = await apiInject(ctx, alice, {
      method: 'POST',
      url: `/api/v1/works/${work.workKey}/dispatch-intents/${intentId}/dispatch`,
      payload: {
        agentId: agent.agentId,
        deviceId: device.deviceId,
        workspaceId: device.workspaceId,
        actionClass: 'draft',
      },
      idempotencyKey: idemKey(),
    })
    expect(dispatch.statusCode).toBe(409)
    expect(dispatch.json().error.message).toContain('input digest changed')
    const [rejected] = await database.db
      .select()
      .from(schema.dispatchIntents)
      .where(eq(schema.dispatchIntents.id, intentId))
    expect(rejected?.status).toBe('rejected')
    expect(await database.db.select().from(schema.runs)).toHaveLength(0)
  })

  it('rejects selecting an inbox item that is not part of the approved intent', async () => {
    const work = await createWork(ctx, alice, taskId)
    await createMandate(ctx, alice, work.workKey)
    const first = await prepareIntent(work.workKey)
    await approve(ctx, alice, work.workKey, first.intentId)
    // 第二个来源与条目都合法、同 work，但不在意图 A 的 triggerRefs/inputDigest 里。
    const secondMessage = await comment(ctx, alice, taskId)
    const secondItem = await associate(ctx, alice, work.workKey, secondMessage)
    const dispatch = await apiInject(ctx, alice, {
      method: 'POST',
      url: `/api/v1/works/${work.workKey}/dispatch-intents/${first.intentId}/dispatch`,
      payload: {
        agentId: agent.agentId,
        deviceId: device.deviceId,
        workspaceId: device.workspaceId,
        actionClass: 'draft',
        workInputItemIds: [secondItem],
      },
      idempotencyKey: idemKey(),
    })
    expect(dispatch.statusCode).toBe(409)
    expect(dispatch.json().error.message).toContain('not part of the approved intent')
    expect(await database.db.select().from(schema.runs)).toHaveLength(0)
    const [intent] = await database.db
      .select()
      .from(schema.dispatchIntents)
      .where(eq(schema.dispatchIntents.id, first.intentId))
    expect(intent?.status).toBe('approved')
  })

  it('cancels the queued machine Run when the mandate is paused', async () => {
    const work = await createWork(ctx, alice, taskId)
    const mandate = await createMandate(ctx, alice, work.workKey)
    const { intentId, itemId } = await prepareIntent(work.workKey)
    await approve(ctx, alice, work.workKey, intentId)
    const dispatched = await apiInject(ctx, alice, {
      method: 'POST',
      url: `/api/v1/works/${work.workKey}/dispatch-intents/${intentId}/dispatch`,
      payload: {
        agentId: agent.agentId,
        deviceId: device.deviceId,
        workspaceId: device.workspaceId,
        actionClass: 'draft',
        workInputItemIds: [itemId],
      },
      idempotencyKey: idemKey(),
    })
    expect(dispatched.statusCode).toBe(200)
    const runId = String(dispatched.json().data.runId)
    const paused = await apiInject(ctx, alice, {
      method: 'POST',
      url: `/api/v1/mandates/${String(mandate.id)}/pause`,
      payload: {},
      idempotencyKey: idemKey(),
    })
    expect(paused.statusCode).toBe(200)
    const [run] = await database.db.select().from(schema.runs).where(eq(schema.runs.id, runId))
    expect(run?.status).toBe('cancelled')
    const [start] = await database.db
      .select()
      .from(schema.dispatchOutbox)
      .where(eq(schema.dispatchOutbox.type, 'run.start'))
    expect(start?.ackedAt ?? start?.failedAt).not.toBeNull()
    const [workRow] = await database.db
      .select()
      .from(schema.works)
      .where(eq(schema.works.workKey, work.workKey))
    expect(workRow?.state).toBe('active')
  })

  it('beforeDispatch cancels a queued machine Run when the mandate changed out of band', async () => {
    const work = await createWork(ctx, alice, taskId)
    const mandate = await createMandate(ctx, alice, work.workKey)
    const { intentId, itemId } = await prepareIntent(work.workKey)
    await approve(ctx, alice, work.workKey, intentId)
    const dispatched = await apiInject(ctx, alice, {
      method: 'POST',
      url: `/api/v1/works/${work.workKey}/dispatch-intents/${intentId}/dispatch`,
      payload: {
        agentId: agent.agentId,
        deviceId: device.deviceId,
        workspaceId: device.workspaceId,
        actionClass: 'draft',
        workInputItemIds: [itemId],
      },
      idempotencyKey: idemKey(),
    })
    expect(dispatched.statusCode).toBe(200)
    const runId = String(dispatched.json().data.runId)
    // 绕过 API 的取消回调，模拟撤权已提交但取消事务还没到达/失败：beforeDispatch
    // 仍必须 fail-closed，走既有 queued 取消路径。
    await database.db
      .update(schema.workMandates)
      .set({ status: 'revoked', revokedAt: new Date(), pausedAt: null })
      .where(eq(schema.workMandates.id, mandate.id))
    const [start] = await database.db
      .select()
      .from(schema.dispatchOutbox)
      .where(eq(schema.dispatchOutbox.type, 'run.start'))
    expect(
      await ctx.app.runOrchestrator.beforeDispatch({
        id: start!.id,
        deviceId: start!.deviceId,
        type: start!.type,
        payload: start!.payload,
        attemptCount: 1,
        sentAt: null,
      }),
    ).toBe(false)
    const [run] = await database.db.select().from(schema.runs).where(eq(schema.runs.id, runId))
    expect(run?.status).toBe('cancelled')
  })

  it('rejects an intent whose workKey/taskId was tampered with', async () => {
    const work = await createWork(ctx, alice, taskId)
    await createMandate(ctx, alice, work.workKey)
    const { intentId } = await prepareIntent(work.workKey)
    await approve(ctx, alice, work.workKey, intentId)
    // removeWhen: 模拟迁移/脏数据；端口必须自己复核意图与 work 的归属。
    const otherTask = await createTask(ctx, alice, projectId, alice.userId)
    await acceptTask(ctx, alice, otherTask)
    await database.db
      .update(schema.dispatchIntents)
      .set({ taskId: otherTask })
      .where(eq(schema.dispatchIntents.id, intentId))
    const dispatch = await apiInject(ctx, alice, {
      method: 'POST',
      url: `/api/v1/works/${work.workKey}/dispatch-intents/${intentId}/dispatch`,
      payload: {
        agentId: agent.agentId,
        deviceId: device.deviceId,
        workspaceId: device.workspaceId,
        actionClass: 'draft',
      },
      idempotencyKey: idemKey(),
    })
    expect(dispatch.statusCode).toBe(404)
    expect(await database.db.select().from(schema.runs)).toHaveLength(0)
  })

  it('rechecks that the referenced mandate is still active at dispatch', async () => {
    const work = await createWork(ctx, alice, taskId)
    const mandate = await createMandate(ctx, alice, work.workKey)
    const { intentId } = await prepareIntent(work.workKey)
    await approve(ctx, alice, work.workKey, intentId)
    // removeWhen: 暂停 API 会推进新版本并取消 approved 意图；这里直接改同一
    // Mandate 行的状态，专门验证端口对“同 id 但已 paused”的复核。
    await database.db
      .update(schema.workMandates)
      .set({ status: 'paused', pausedAt: new Date(), revokedAt: null })
      .where(eq(schema.workMandates.id, mandate.id))
    const dispatch = await apiInject(ctx, alice, {
      method: 'POST',
      url: `/api/v1/works/${work.workKey}/dispatch-intents/${intentId}/dispatch`,
      payload: {
        agentId: agent.agentId,
        deviceId: device.deviceId,
        workspaceId: device.workspaceId,
        actionClass: 'draft',
      },
      idempotencyKey: idemKey(),
    })
    expect(dispatch.statusCode).toBe(409)
    expect(dispatch.json().error.message).toContain('mandate')
    const [rejected] = await database.db
      .select()
      .from(schema.dispatchIntents)
      .where(eq(schema.dispatchIntents.id, intentId))
    expect(rejected?.status).toBe('rejected')
    expect(await database.db.select().from(schema.runs)).toHaveLength(0)
  })

  it('rechecks intent expiry at dispatch', async () => {
    const work = await createWork(ctx, alice, taskId)
    await createMandate(ctx, alice, work.workKey)
    const { intentId } = await prepareIntent(work.workKey)
    await approve(ctx, alice, work.workKey, intentId)
    await database.db
      .update(schema.dispatchIntents)
      .set({ expiresAt: new Date(Date.now() - 60_000) })
      .where(eq(schema.dispatchIntents.id, intentId))
    const dispatch = await apiInject(ctx, alice, {
      method: 'POST',
      url: `/api/v1/works/${work.workKey}/dispatch-intents/${intentId}/dispatch`,
      payload: {
        agentId: agent.agentId,
        deviceId: device.deviceId,
        workspaceId: device.workspaceId,
        actionClass: 'draft',
      },
      idempotencyKey: idemKey(),
    })
    expect(dispatch.statusCode).toBe(409)
    expect(dispatch.json().error.message).toContain('expired')
    const [expiredRow] = await database.db
      .select()
      .from(schema.dispatchIntents)
      .where(eq(schema.dispatchIntents.id, intentId))
    expect(expiredRow?.status).toBe('expired')
    expect(await database.db.select().from(schema.runs)).toHaveLength(0)
  })

  it('refuses a machine Run whose dispatch port did not freeze a tool policy', async () => {
    const work = await createWork(ctx, alice, taskId)
    const mandate = await createMandate(ctx, alice, work.workKey)
    const { intentId } = await prepareIntent(work.workKey)
    const attempt = database.transaction((tx) =>
      ctx.app.runOrchestrator.createWithinTransaction(
        tx,
        { userId: asUserId(alice.userId), role: 'owner' },
        taskId,
        {
          idempotencyKey: `no-tool-policy-${randomUUID()}`,
          agentId: agent.agentId,
          deviceId: device.deviceId,
          workspaceId: device.workspaceId,
          prompt: 'missing tool policy',
          dshDistributionVersion: '0.1.0-rc.8',
          origin: 'mandate',
          workKey: work.workKey,
          mandateId: mandate.id,
          dispatchIntentId: intentId,
          onBehalfOfUserId: alice.userId,
        },
      ),
    )
    await expect(attempt).rejects.toThrow('tool policy is incomplete')
    expect(await database.db.select().from(schema.runs)).toHaveLength(0)
  })

  it('refuses a human Run that carries a machine tool policy', async () => {
    const attempt = database.transaction((tx) =>
      ctx.app.runOrchestrator.createWithinTransaction(
        tx,
        { userId: asUserId(alice.userId), role: 'owner' },
        taskId,
        {
          idempotencyKey: `human-tool-policy-${randomUUID()}`,
          agentId: agent.agentId,
          deviceId: device.deviceId,
          workspaceId: device.workspaceId,
          prompt: 'human run with machine policy',
          dshDistributionVersion: '0.1.0-rc.8',
          toolPolicy: {
            mode: 'draft',
            allowedToolNames: ['read'],
            mandateVersion: 1,
            workKey: randomUUID(),
          },
        },
      ),
    )
    await expect(attempt).rejects.toThrow('tool policy is only for machine runs')
    expect(await database.db.select().from(schema.runs)).toHaveLength(0)
  })

  it('beforeDispatch cancels a legacy machine Run whose run.start has no tool policy', async () => {
    const work = await createWork(ctx, alice, taskId)
    await createMandate(ctx, alice, work.workKey)
    const { intentId } = await prepareIntent(work.workKey)
    await approve(ctx, alice, work.workKey, intentId)
    const dispatched = await apiInject(ctx, alice, {
      method: 'POST',
      url: `/api/v1/works/${work.workKey}/dispatch-intents/${intentId}/dispatch`,
      payload: {
        agentId: agent.agentId,
        deviceId: device.deviceId,
        workspaceId: device.workspaceId,
        actionClass: 'draft',
      },
      idempotencyKey: idemKey(),
    })
    expect(dispatched.statusCode).toBe(200)
    const runId = String(dispatched.json().data.runId)
    const [startCommand] = await database.db
      .select()
      .from(schema.dispatchOutbox)
      .where(eq(schema.dispatchOutbox.type, 'run.start'))
    expect(startCommand).toBeDefined()
    // 模拟升级前入队的旧行：payload 只有 runId，没有本版本固化的 toolPolicy。
    const allowed = await ctx.app.runOrchestrator.beforeDispatch({
      id: startCommand!.id,
      deviceId: startCommand!.deviceId,
      type: startCommand!.type,
      payload: { runId },
      attemptCount: 1,
      sentAt: null,
    })
    expect(allowed).toBe(false)
    const [run] = await database.db.select().from(schema.runs).where(eq(schema.runs.id, runId))
    expect(run?.status).toBe('cancelled')
  })

  it('human create() refuses to create a machine Run even with a valid intent', async () => {
    const work = await createWork(ctx, alice, taskId)
    const mandate = await createMandate(ctx, alice, work.workKey)
    const { intentId } = await prepareIntent(work.workKey)
    const attempt = ctx.app.runOrchestrator.create(
      { userId: asUserId(alice.userId), role: 'owner' },
      taskId,
      {
        idempotencyKey: `human-bypass-${randomUUID()}`,
        agentId: agent.agentId,
        deviceId: device.deviceId,
        workspaceId: device.workspaceId,
        prompt: 'bypass',
        dshDistributionVersion: '0.1.0-rc.8',
        origin: 'mandate',
        workKey: work.workKey,
        mandateId: mandate.id,
        dispatchIntentId: intentId,
        onBehalfOfUserId: alice.userId,
      },
    )
    await expect(attempt).rejects.toThrow('machine runs must be created by the dispatch port')
    expect(await database.db.select().from(schema.runs)).toHaveLength(0)
  })

  it('rejects a full_access candidate and an expired intent without creating a Run', async () => {
    const work = await createWork(ctx, alice, taskId)
    await createMandate(ctx, alice, work.workKey)
    const full = await createAgent(database, alice.userId, 'full_access')
    const { intentId: fullIntent } = await prepareIntent(work.workKey)
    await approve(ctx, alice, work.workKey, fullIntent)
    const fullDispatch = await apiInject(ctx, alice, {
      method: 'POST',
      url: `/api/v1/works/${work.workKey}/dispatch-intents/${fullIntent}/dispatch`,
      payload: {
        agentId: full.agentId,
        deviceId: device.deviceId,
        workspaceId: device.workspaceId,
        actionClass: 'draft',
      },
      idempotencyKey: idemKey(),
    })
    expect(fullDispatch.statusCode).toBe(403)

    const { intentId: expiredIntent } = await prepareIntent(work.workKey)
    await database.db
      .update(schema.dispatchIntents)
      .set({ expiresAt: new Date(Date.now() - 60_000) })
      .where(eq(schema.dispatchIntents.id, expiredIntent))
    const expired = await approve(ctx, alice, work.workKey, expiredIntent, 409)
    expect(expired.json().error.code).toBe('CONFLICT')
    expect(expired.json().error.message).toContain('expired')
    expect(await database.db.select().from(schema.runs)).toHaveLength(0)
  })

  it('auto dispatches a proposed intent under existing_task with mandate approval', async () => {
    const work = await createWork(ctx, alice, taskId)
    await createMandate(ctx, alice, work.workKey, {
      autoDispatch: 'existing_task',
      allowedAgentIds: [agent.agentId],
    })
    const { intentId } = await prepareIntent(work.workKey)
    const [intent] = await database.db
      .select()
      .from(schema.dispatchIntents)
      .where(eq(schema.dispatchIntents.id, intentId))
    expect(intent).toMatchObject({
      status: 'dispatched',
      approvalBasis: 'mandate',
      agentId: agent.agentId,
      deviceId: device.deviceId,
      workspaceId: device.workspaceId,
      actionClass: 'draft',
    })
    expect(intent?.approvedAt).not.toBeNull()
    expect(intent?.candidates).toHaveLength(1)
    const [run] = await database.db.select().from(schema.runs)
    expect(run).toMatchObject({
      origin: 'mandate',
      dispatchIntentId: intentId,
      onBehalfOfUserId: alice.userId,
      workKey: work.workKey,
    })
    const [workRow] = await database.db
      .select()
      .from(schema.works)
      .where(eq(schema.works.workKey, work.workKey))
    expect(workRow).toMatchObject({
      state: 'waiting',
      resumeMode: 'auto',
      resumeCondition: `run:${run?.id}`,
    })
  })

  it('shows the auto-dispatched intent with candidates in the work detail', async () => {
    const work = await createWork(ctx, alice, taskId)
    await createMandate(ctx, alice, work.workKey, {
      autoDispatch: 'existing_task',
      allowedAgentIds: [agent.agentId],
    })
    const { intentId } = await prepareIntent(work.workKey)
    const detail = await apiInject(ctx, alice, {
      method: 'GET',
      url: `/api/v1/works/${work.workKey}`,
    })
    expect(detail.statusCode).toBe(200)
    // RD-03d2a：有候选并成功派工时不应产生 ask。
    expect(detail.json().data.openQuestions).toEqual([])
    const view = detail.json().data.dispatchIntents as Array<Record<string, unknown>>
    expect(view.find((intent) => intent.id === intentId)).toMatchObject({
      status: 'dispatched',
      approvalBasis: 'mandate',
      runId: expect.any(String),
    })
    expect(view[0]?.candidates).toHaveLength(1)
  })

  it('keeps the intent proposed with exclusion reasons when the allowlist is empty', async () => {
    const work = await createWork(ctx, alice, taskId)
    await createMandate(ctx, alice, work.workKey, { autoDispatch: 'existing_task' })
    const { intentId } = await prepareIntent(work.workKey)
    const [intent] = await database.db
      .select()
      .from(schema.dispatchIntents)
      .where(eq(schema.dispatchIntents.id, intentId))
    expect(intent?.status).toBe('proposed')
    expect(intent?.candidates).toEqual([])
    expect(intent?.exclusionReasons).toEqual(
      expect.arrayContaining([{ kind: 'agent', reason: 'allowlist_empty' }]),
    )
    expect(await database.db.select().from(schema.runs)).toHaveLength(0)
  })

  it('uses the declared agent order and records lower-priority agents', async () => {
    const other = await createAgent(database, alice.userId)
    const work = await createWork(ctx, alice, taskId)
    await createMandate(ctx, alice, work.workKey, {
      autoDispatch: 'existing_task',
      allowedAgentIds: [other.agentId, agent.agentId],
    })
    const { intentId } = await prepareIntent(work.workKey)
    const [intent] = await database.db
      .select()
      .from(schema.dispatchIntents)
      .where(eq(schema.dispatchIntents.id, intentId))
    expect(intent?.status).toBe('dispatched')
    expect(intent?.agentId).toBe(other.agentId)
    expect(intent?.exclusionReasons).toEqual(
      expect.arrayContaining([{ kind: 'agent', id: agent.agentId, reason: 'lower_priority' }]),
    )
    const [run] = await database.db.select().from(schema.runs)
    expect(run?.agentId).toBe(other.agentId)
  })

  it('skips an online device without work-input capability and uses the next capable one', async () => {
    await database.db
      .update(schema.devices)
      .set({ lastSeenAt: new Date(Date.now() - 10_000) })
      .where(eq(schema.devices.id, device.deviceId))
    // removeWhen: 能力声明由 node.hello 刷新；这里只造一个缺 work-input.v1 的
    // 设备行验证候选硬筛，不写运行时状态。
    const incapable = await createDevice(database, alice.userId, { contextCapabilities: [] })
    const work = await createWork(ctx, alice, taskId)
    await createMandate(ctx, alice, work.workKey, {
      autoDispatch: 'existing_task',
      allowedAgentIds: [agent.agentId],
    })
    const { intentId } = await prepareIntent(work.workKey)
    const [intent] = await database.db
      .select()
      .from(schema.dispatchIntents)
      .where(eq(schema.dispatchIntents.id, intentId))
    expect(intent?.status).toBe('dispatched')
    expect(intent?.deviceId).toBe(device.deviceId)
    expect(intent?.exclusionReasons).toEqual(
      expect.arrayContaining([
        {
          kind: 'device',
          id: incapable.deviceId,
          reason: 'missing_work_input_capability',
        },
      ]),
    )
  })

  it('leaves the intent proposed when the only device is offline', async () => {
    // removeWhen: Device 在线态由 node.hello/心跳生产路径刷新；本用例只改 lastSeenAt
    // 验证候选硬筛，不写 Run/Runtime 投影。
    await database.db
      .update(schema.devices)
      .set({ lastSeenAt: new Date(Date.now() - 5 * 60 * 1000) })
      .where(eq(schema.devices.id, device.deviceId))
    const work = await createWork(ctx, alice, taskId)
    await createMandate(ctx, alice, work.workKey, {
      autoDispatch: 'existing_task',
      allowedAgentIds: [agent.agentId],
    })
    const { intentId } = await prepareIntent(work.workKey)
    const [intent] = await database.db
      .select()
      .from(schema.dispatchIntents)
      .where(eq(schema.dispatchIntents.id, intentId))
    expect(intent?.status).toBe('proposed')
    expect(intent?.candidates).toEqual([])
    expect(intent?.exclusionReasons).toEqual(
      expect.arrayContaining([{ kind: 'device', reason: 'no_online_device' }]),
    )
    expect(await database.db.select().from(schema.runs)).toHaveLength(0)
  })

  it('leaves the intent proposed when the online device has no available workspace', async () => {
    // removeWhen: Workspace available 由 Node inventory 刷新；本用例只改该列验证
    // 候选硬筛，不写 Run/Runtime 投影。
    await database.db
      .update(schema.workspaces)
      .set({ available: false })
      .where(eq(schema.workspaces.deviceId, device.deviceId))
    const work = await createWork(ctx, alice, taskId)
    await createMandate(ctx, alice, work.workKey, {
      autoDispatch: 'existing_task',
      allowedAgentIds: [agent.agentId],
    })
    const { intentId } = await prepareIntent(work.workKey)
    const [intent] = await database.db
      .select()
      .from(schema.dispatchIntents)
      .where(eq(schema.dispatchIntents.id, intentId))
    expect(intent?.status).toBe('proposed')
    expect(intent?.exclusionReasons).toEqual(
      expect.arrayContaining([
        { kind: 'workspace', deviceId: device.deviceId, reason: 'no_available_workspace' },
      ]),
    )
    expect(await database.db.select().from(schema.runs)).toHaveLength(0)
  })

  it('prefers the draft action class when the mandate allows it', async () => {
    const work = await createWork(ctx, alice, taskId)
    await createMandate(ctx, alice, work.workKey, {
      autoDispatch: 'existing_task',
      allowedAgentIds: [agent.agentId],
      allowedActionClasses: ['research', 'draft'],
    })
    const { intentId } = await prepareIntent(work.workKey)
    const [intent] = await database.db
      .select()
      .from(schema.dispatchIntents)
      .where(eq(schema.dispatchIntents.id, intentId))
    expect(intent).toMatchObject({ status: 'dispatched', actionClass: 'draft' })
    const [run] = await database.db.select().from(schema.runs)
    expect(run?.agentId).toBe(agent.agentId)
  })

  it('leaves the intent proposed when the trigger source has no pending inbox item', async () => {
    const work = await createWork(ctx, alice, taskId)
    await createMandate(ctx, alice, work.workKey, {
      autoDispatch: 'existing_task',
      allowedAgentIds: [agent.agentId],
    })
    const messageId = await comment(ctx, alice, taskId)
    const admission = await apiInject(ctx, alice, {
      method: 'POST',
      url: `/api/v1/works/${work.workKey}/admission-checks`,
      payload: { sourceType: 'task_message', sourceId: messageId },
      idempotencyKey: idemKey(),
    })
    expect(admission.statusCode).toBe(200)
    expect(admission.json().data.proposedIntent).toMatchObject({
      status: 'proposed',
      candidates: [],
    })
    expect(admission.json().data.proposedIntent.exclusionReasons).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: 'input', reason: 'no_pending_trigger_item' }),
      ]),
    )
    expect(await database.db.select().from(schema.runs)).toHaveLength(0)
  })

  it('applies maxRunsPerWork to the human-confirmed dispatch path too', async () => {
    const work = await createWork(ctx, alice, taskId)
    await createMandate(ctx, alice, work.workKey, { maxRunsPerWork: 0 })
    const { intentId, itemId } = await prepareIntent(work.workKey)
    await approve(ctx, alice, work.workKey, intentId)
    const dispatch = await apiInject(ctx, alice, {
      method: 'POST',
      url: `/api/v1/works/${work.workKey}/dispatch-intents/${intentId}/dispatch`,
      payload: {
        agentId: agent.agentId,
        deviceId: device.deviceId,
        workspaceId: device.workspaceId,
        actionClass: 'draft',
        workInputItemIds: [itemId],
      },
      idempotencyKey: idemKey(),
    })
    expect(dispatch.statusCode).toBe(409)
    expect(dispatch.json().error.message).toContain('max_runs_exhausted')
    expect(await database.db.select().from(schema.runs)).toHaveLength(0)
    const [intent] = await database.db
      .select()
      .from(schema.dispatchIntents)
      .where(eq(schema.dispatchIntents.id, intentId))
    expect(intent).toMatchObject({
      status: 'rejected',
      resolutionReason: 'max_runs_exhausted',
    })
  })

  it('rejects a proposed intent when maxRunsPerWork is exhausted', async () => {
    const work = await createWork(ctx, alice, taskId)
    await createMandate(ctx, alice, work.workKey, {
      autoDispatch: 'existing_task',
      allowedAgentIds: [agent.agentId],
      maxRunsPerWork: 1,
    })
    // 先正常自动派工一次并让 Run 终态，再用同 work 的新来源触发第二次。
    await prepareIntent(work.workKey)
    const [firstRun] = await database.db.select().from(schema.runs)
    await ctx.app.runOrchestrator.ingestNodeEvent(
      { deviceId: device.deviceId, ownerUserId: alice.userId },
      runEventFrame(String(firstRun?.id), 1, {
        type: 'runtime.ready',
        dshSessionId: 'rd03b-budget-session',
      }),
    )
    await ctx.app.runOrchestrator.ingestNodeEvent(
      { deviceId: device.deviceId, ownerUserId: alice.userId },
      runEventFrame(String(firstRun?.id), 2, {
        type: 'run.completed',
        finalText: 'first draft',
      }),
    )
    const messageId = await comment(ctx, alice, taskId)
    await associate(ctx, alice, work.workKey, messageId)
    const second = await apiInject(ctx, alice, {
      method: 'POST',
      url: `/api/v1/works/${work.workKey}/admission-checks`,
      payload: { sourceType: 'task_message', sourceId: messageId },
      idempotencyKey: idemKey(),
    })
    expect(second.statusCode).toBe(200)
    expect(second.json().data.proposedIntent).toMatchObject({
      status: 'rejected',
      resolutionReason: 'max_runs_exhausted',
    })
    expect(await database.db.select().from(schema.runs)).toHaveLength(1)
  })

  it('rejects a proposed intent when maxAttempts is exhausted', async () => {
    const work = await createWork(ctx, alice, taskId)
    await createMandate(ctx, alice, work.workKey, {
      autoDispatch: 'existing_task',
      allowedAgentIds: [agent.agentId],
      maxAttempts: 1,
    })
    await prepareIntent(work.workKey)
    const [firstRun] = await database.db.select().from(schema.runs)
    await ctx.app.runOrchestrator.ingestNodeEvent(
      { deviceId: device.deviceId, ownerUserId: alice.userId },
      runEventFrame(String(firstRun?.id), 1, {
        type: 'runtime.ready',
        dshSessionId: 'rd03b-attempt-session',
      }),
    )
    await ctx.app.runOrchestrator.ingestNodeEvent(
      { deviceId: device.deviceId, ownerUserId: alice.userId },
      runEventFrame(String(firstRun?.id), 2, {
        type: 'run.failed',
        code: 'INTERNAL_ERROR',
        summary: 'attempt failed',
      }),
    )
    const messageId = await comment(ctx, alice, taskId)
    await associate(ctx, alice, work.workKey, messageId)
    const second = await apiInject(ctx, alice, {
      method: 'POST',
      url: `/api/v1/works/${work.workKey}/admission-checks`,
      payload: { sourceType: 'task_message', sourceId: messageId },
      idempotencyKey: idemKey(),
    })
    expect(second.statusCode).toBe(200)
    expect(second.json().data.proposedIntent).toMatchObject({
      status: 'rejected',
      resolutionReason: 'max_attempts_exhausted',
    })
    expect(await database.db.select().from(schema.runs)).toHaveLength(1)
  })

  it('records full_access as an exclusion and leaves the intent proposed', async () => {
    const work = await createWork(ctx, alice, taskId)
    await createMandate(ctx, alice, work.workKey, {
      autoDispatch: 'existing_task',
      allowedAgentIds: [agent.agentId],
    })
    // removeWhen: Mandate 创建已拒绝 full_access 候选；这里改 Revision 模拟
    // Mandate 创建后策略被改坏的防御面，不构造运行时状态。
    await database.db
      .update(schema.agentProfileRevisions)
      .set({ approvalPolicy: 'full_access' })
      .where(eq(schema.agentProfileRevisions.id, agent.revisionId))
    const { intentId } = await prepareIntent(work.workKey)
    const [intent] = await database.db
      .select()
      .from(schema.dispatchIntents)
      .where(eq(schema.dispatchIntents.id, intentId))
    expect(intent?.status).toBe('proposed')
    expect(intent?.exclusionReasons).toEqual(
      expect.arrayContaining([{ kind: 'agent', id: agent.agentId, reason: 'full_access' }]),
    )
    expect(await database.db.select().from(schema.runs)).toHaveLength(0)
  })

  it('selects the most recently seen online device with an available workspace', async () => {
    // removeWhen: 同上，仅改 Device lastSeenAt 验证排序，不写运行时状态。
    await database.db
      .update(schema.devices)
      .set({ lastSeenAt: new Date(Date.now() - 10_000) })
      .where(eq(schema.devices.id, device.deviceId))
    const second = await createDevice(database, alice.userId)
    const work = await createWork(ctx, alice, taskId)
    await createMandate(ctx, alice, work.workKey, {
      autoDispatch: 'existing_task',
      allowedAgentIds: [agent.agentId],
    })
    const { intentId } = await prepareIntent(work.workKey)
    const [intent] = await database.db
      .select()
      .from(schema.dispatchIntents)
      .where(eq(schema.dispatchIntents.id, intentId))
    expect(intent?.status).toBe('dispatched')
    expect(intent?.deviceId).toBe(second.deviceId)
    expect(intent?.workspaceId).toBe(second.workspaceId)
  })

  it('leaves a proposed intent with active_run when a human Run is already active', async () => {
    await ctx.app.runOrchestrator.create(
      { userId: asUserId(alice.userId), role: 'owner' },
      taskId,
      {
        idempotencyKey: `human-active-${randomUUID()}`,
        agentId: agent.agentId,
        profileRevisionId: agent.revisionId,
        deviceId: device.deviceId,
        workspaceId: device.workspaceId,
        prompt: 'human run first',
        dshDistributionVersion: '0.1.0-rc.8',
      },
    )
    const work = await createWork(ctx, alice, taskId)
    await createMandate(ctx, alice, work.workKey, {
      autoDispatch: 'existing_task',
      allowedAgentIds: [agent.agentId],
    })
    const messageId = await comment(ctx, alice, taskId)
    await associate(ctx, alice, work.workKey, messageId)
    const admission = await apiInject(ctx, alice, {
      method: 'POST',
      url: `/api/v1/works/${work.workKey}/admission-checks`,
      payload: { sourceType: 'task_message', sourceId: messageId },
      idempotencyKey: idemKey(),
    })
    expect(admission.statusCode).toBe(200)
    expect(admission.json().data.proposedIntent).toMatchObject({
      status: 'proposed',
      candidates: [],
    })
    expect(admission.json().data.proposedIntent.exclusionReasons).toEqual(
      expect.arrayContaining([{ kind: 'run', reason: 'active_run' }]),
    )
    expect(await database.db.select().from(schema.runs)).toHaveLength(1)
  })

  it('never selects another member device when the assignee device is offline', async () => {
    await database.db
      .update(schema.devices)
      .set({ lastSeenAt: new Date(Date.now() - 5 * 60 * 1000) })
      .where(eq(schema.devices.id, device.deviceId))
    const bobDevice = await createDevice(database, bob.userId)
    const work = await createWork(ctx, alice, taskId)
    await createMandate(ctx, alice, work.workKey, {
      autoDispatch: 'existing_task',
      allowedAgentIds: [agent.agentId],
    })
    const { intentId } = await prepareIntent(work.workKey)
    const [intent] = await database.db
      .select()
      .from(schema.dispatchIntents)
      .where(eq(schema.dispatchIntents.id, intentId))
    expect(intent?.status).toBe('proposed')
    expect(intent?.deviceId).toBeNull()
    expect(intent?.exclusionReasons).toEqual(
      expect.arrayContaining([{ kind: 'device', reason: 'no_online_device' }]),
    )
    expect(intent?.exclusionReasons).not.toEqual(
      expect.arrayContaining([{ kind: 'device', id: bobDevice.deviceId }]),
    )
    expect(await database.db.select().from(schema.runs)).toHaveLength(0)
  })

  it('rejects a proposed intent when its trigger source drifts before auto dispatch', async () => {
    // 先让设备离线，得到 proposed 意图；随后改来源，再用新幂等键重放准入。
    await database.db
      .update(schema.devices)
      .set({ lastSeenAt: new Date(Date.now() - 5 * 60 * 1000) })
      .where(eq(schema.devices.id, device.deviceId))
    const work = await createWork(ctx, alice, taskId)
    await createMandate(ctx, alice, work.workKey, {
      autoDispatch: 'existing_task',
      allowedAgentIds: [agent.agentId],
    })
    const messageId = await comment(ctx, alice, taskId)
    await associate(ctx, alice, work.workKey, messageId)
    const first = await apiInject(ctx, alice, {
      method: 'POST',
      url: `/api/v1/works/${work.workKey}/admission-checks`,
      payload: { sourceType: 'task_message', sourceId: messageId },
      idempotencyKey: idemKey(),
    })
    expect(first.statusCode).toBe(200)
    expect(first.json().data.proposedIntent.status).toBe('proposed')
    const intentId = String(first.json().data.proposedIntent.id)

    // removeWhen: 来源编辑尚无 HTTP 面；只改来源正文/编辑时间，验证自动端口重读来源。
    await database.db
      .update(schema.taskMessages)
      .set({ body: '预算又改成 9 万。', editedAt: new Date() })
      .where(eq(schema.taskMessages.id, messageId))
    // 直接驱动生产自动端口：新来源会生成新意图，只有旧意图能证明派工前重读；
    // 该路径与准入回调调用的是同一函数。
    const auto = await autoDispatchProposedIntent(
      {
        database,
        orchestrator: ctx.app.runOrchestrator,
        outbox: new Outbox(database),
        now: () => new Date(),
      },
      { userId: alice.userId, role: 'owner' },
      work.workKey,
      intentId,
    )
    expect(auto).toMatchObject({
      status: 'rejected',
      resolutionReason: 'source changed since the intent was approved',
    })
    expect(await database.db.select().from(schema.runs)).toHaveLength(0)
  })

  it('does not create a second Run when the same admission is replayed', async () => {
    const work = await createWork(ctx, alice, taskId)
    await createMandate(ctx, alice, work.workKey, {
      autoDispatch: 'existing_task',
      allowedAgentIds: [agent.agentId],
    })
    const messageId = await comment(ctx, alice, taskId)
    await associate(ctx, alice, work.workKey, messageId)
    const first = await apiInject(ctx, alice, {
      method: 'POST',
      url: `/api/v1/works/${work.workKey}/admission-checks`,
      payload: { sourceType: 'task_message', sourceId: messageId },
      idempotencyKey: idemKey(),
    })
    expect(first.statusCode).toBe(200)
    expect(first.json().data.proposedIntent.status).toBe('dispatched')
    const replay = await apiInject(ctx, alice, {
      method: 'POST',
      url: `/api/v1/works/${work.workKey}/admission-checks`,
      payload: { sourceType: 'task_message', sourceId: messageId },
      idempotencyKey: idemKey(),
    })
    expect(replay.statusCode).toBe(200)
    expect(replay.json().data.proposedIntent.status).toBe('dispatched')
    expect(await database.db.select().from(schema.runs)).toHaveLength(1)
  })
})

describe('mandateInvalidationReason（ADR-0028 §9 纯映射）', () => {
  const now = new Date('2026-11-04T00:00:00.000Z')
  const healthy: MachineRunMandateFacts = {
    runId: '01905f7c-0000-7000-8000-000000000907',
    deviceId: '01905f7c-0000-7000-8000-000000000908',
    mandateId: '01905f7c-0000-7000-8000-000000000909',
    status: 'running',
    workState: 'waiting',
    workResumeMode: 'auto',
    workResumeCondition: 'run:01905f7c-0000-7000-8000-000000000907',
    workMandateId: '01905f7c-0000-7000-8000-000000000909',
    mandateStatus: 'active',
    mandateExpiresAt: new Date('2026-11-05T00:00:00.000Z'),
    currentMandateStatus: 'active',
    currentMandateExpiresAt: new Date('2026-11-05T00:00:00.000Z'),
  }

  it('returns undefined for a healthy active run', () => {
    expect(mandateInvalidationReason(healthy, now)).toBeUndefined()
  })

  it('maps work/task unavailability before mandate state', () => {
    expect(
      mandateInvalidationReason(
        { ...healthy, workState: 'waiting', workResumeCondition: 'run:other' },
        now,
      ),
    ).toBe('work_unavailable')
    expect(mandateInvalidationReason({ ...healthy, workState: 'retired' }, now)).toBe(
      'work_unavailable',
    )
  })

  it('maps the current mandate status when the pointer moved', () => {
    const moved = { ...healthy, workMandateId: '01905f7c-0000-7000-8000-000000000910' }
    expect(mandateInvalidationReason({ ...moved, currentMandateStatus: 'paused' }, now)).toBe(
      'mandate_paused',
    )
    expect(mandateInvalidationReason({ ...moved, currentMandateStatus: 'revoked' }, now)).toBe(
      'mandate_revoked',
    )
    expect(mandateInvalidationReason({ ...moved, currentMandateStatus: 'expired' }, now)).toBe(
      'mandate_expired',
    )
    expect(mandateInvalidationReason({ ...moved, currentMandateStatus: 'active' }, now)).toBe(
      'mandate_changed',
    )
  })

  it('maps same-pointer expiry and older mandate status', () => {
    expect(
      mandateInvalidationReason(
        { ...healthy, mandateExpiresAt: new Date('2026-11-03T23:59:59Z') },
        now,
      ),
    ).toBe('mandate_expired')
    expect(mandateInvalidationReason({ ...healthy, mandateStatus: 'paused' }, now)).toBe(
      'mandate_paused',
    )
    expect(mandateInvalidationReason({ ...healthy, mandateStatus: 'revoked' }, now)).toBe(
      'mandate_revoked',
    )
  })

  it('ignores terminal or non-machine bindings', () => {
    expect(mandateInvalidationReason({ ...healthy, status: 'completed' }, now)).toBeUndefined()
    expect(mandateInvalidationReason({ ...healthy, mandateId: null }, now)).toBeUndefined()
  })
})
