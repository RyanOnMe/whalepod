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
import type { Database } from '@whalepod/db'
import { schema } from '@whalepod/db'
import { asUserId } from '@whalepod/domain'
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
    capabilities: {
      contextCapabilities: ['project-context.v1', 'context-state.v1', 'work-input.v1'],
    },
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

  it('approve → dispatch creates a machine Run with provenance and reactivates work on terminal', async () => {
    const work = await createWork(ctx, alice, taskId)
    await createMandate(ctx, alice, work.workKey, { allowedAgentIds: [agent.agentId] })
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
        workInputItemIds: [itemId],
      },
      idempotencyKey: idemKey(),
    })
    expect(dispatch.statusCode).toBe(409)
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
    expect(await database.db.select().from(schema.runs)).toHaveLength(0)
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
})
