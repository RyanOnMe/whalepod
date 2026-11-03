/**
 * ADR-0028（RD-02a-2a / RD-02a-2b）：Run 工作输入清单冻结、交付/对账与消费回执。
 *
 * 驱动走生产 HTTP（建工作、关联收件箱条目、带 workInputItemIds 建 Run）、Device Token
 * bundle 下载与真实 PostgreSQL；Runtime/Node 的真实下载与工具面另见 Node/Q3 用例。
 */
import { randomUUID } from 'node:crypto'
import { eq } from 'drizzle-orm'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { Database } from '@whalepod/db'
import {
  getTeam,
  listDueUnconfirmedWorkInputIds,
  Outbox,
  schema,
  settleUnconfirmedWorkInput,
} from '@whalepod/db'
import { hashToken } from '../src/modules/auth/token.js'
import { canonicalJson, sha256Hex } from '../src/modules/coordination/digest.js'
import { applyRunStatus } from '../src/modules/run/run-status.js'
import { reconcileWorkInputs } from '../src/modules/work/run-inputs.js'
import {
  apiInject,
  createTestApp,
  createTestDatabase,
  driveInviteAndAccept,
  driveSetup,
  idemKey,
  makeHarness,
  resetDatabase,
  waitForValue,
  runEventFrame,
  type Harness,
  type Session,
  type TestApp,
} from './helpers.js'

const DEVICE_TOKEN = `work-input-device-${randomUUID()}`
const GOAL = '持续整理场地比较与预算变化，产出可审阅草稿'

interface Seed {
  agentId: string
  revisionId: string
  deviceId: string
  workspaceId: string
}

async function seedRunDependencies(database: Database, ownerUserId: string): Promise<Seed> {
  const team = await getTeam(database.db)
  if (team === undefined) throw new Error('team missing')
  const suffix = randomUUID().slice(0, 8)
  const agentId = randomUUID()
  const revisionId = randomUUID()
  const packId = randomUUID()
  const deviceId = randomUUID()
  const workspaceId = randomUUID()
  await database.db.insert(schema.pluginPacks).values({
    id: packId,
    name: `wi-pack-${suffix}`,
    installations: [],
    packDigest: 'a'.repeat(64),
    createdBy: ownerUserId,
  })
  await database.db.insert(schema.agents).values({
    id: agentId,
    name: `wi-agent-${suffix}`,
    createdBy: ownerUserId,
  })
  await database.db.insert(schema.agentProfileRevisions).values({
    id: revisionId,
    agentId,
    revision: 1,
    persona: 'You are a helpful agent.',
    provider: 'deepseek-official',
    model: 'deepseek-chat',
    credentialSlot: 'default',
    pluginPackId: packId,
    profileDigest: 'b'.repeat(64),
    createdBy: ownerUserId,
  })
  await database.db.update(schema.agents).set({ currentRevisionId: revisionId })
  await database.db.insert(schema.devices).values({
    id: deviceId,
    ownerUserId,
    name: `wi-dev-${suffix}`,
    platform: 'darwin',
    architecture: 'arm64',
    nodeVersion: '24.12.0',
    nodeAppVersion: '0.1.0',
    tokenHash: Buffer.from(hashToken(DEVICE_TOKEN)),
    capabilities: { contextCapabilities: ['project-context.v1', 'work-input.v1'] },
    dshDistributionVersion: '0.1.0-rc.8',
    lastSeenAt: new Date(),
  })
  await database.db.insert(schema.workspaces).values({
    id: workspaceId,
    deviceId,
    ownerUserId,
    name: `wi-ws-${suffix}`,
    kind: 'directory',
    capabilities: { read: true, write: true },
    available: true,
  })
  return { agentId, revisionId, deviceId, workspaceId }
}

async function createProject(ctx: TestApp, session: Session): Promise<string> {
  const res = await apiInject(ctx, session, {
    method: 'POST',
    url: '/api/v1/projects',
    payload: { name: `wi-${Date.now()}-${randomUUID().slice(0, 6)}` },
  })
  expect(res.statusCode, res.body).toBe(201)
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
    payload: { title: '工作输入测试', assigneeUserId },
  })
  expect(res.statusCode, res.body).toBe(201)
  const taskId = res.json().data.id as string
  const accepted = await apiInject(ctx, session, {
    method: 'POST',
    url: `/api/v1/tasks/${taskId}/accept`,
  })
  expect(accepted.statusCode, accepted.body).toBe(200)
  return taskId
}

async function createWork(ctx: TestApp, session: Session, taskId: string): Promise<string> {
  const res = await apiInject(ctx, session, {
    method: 'POST',
    url: `/api/v1/tasks/${taskId}/works`,
    payload: { goal: GOAL },
    idempotencyKey: idemKey(),
  })
  expect(res.statusCode, res.body).toBe(201)
  return res.json().data.workKey as string
}

async function comment(
  ctx: TestApp,
  session: Session,
  taskId: string,
  body: string,
): Promise<string> {
  const res = await apiInject(ctx, session, {
    method: 'POST',
    url: `/api/v1/tasks/${taskId}/comments`,
    payload: { body },
    idempotencyKey: idemKey(),
  })
  expect(res.statusCode, res.body).toBe(201)
  return res.json().data.id as string
}

async function associate(
  ctx: TestApp,
  session: Session,
  workKey: string,
  sourceId: string,
  sourceType: 'task_message' | 'context_entry' = 'task_message',
): Promise<Record<string, unknown>> {
  const res = await apiInject(ctx, session, {
    method: 'POST',
    url: `/api/v1/works/${workKey}/inbox-items`,
    payload: { sourceType, sourceId },
    idempotencyKey: idemKey(),
  })
  expect(res.statusCode, res.body).toBe(201)
  return res.json().data as Record<string, unknown>
}

async function createMandate(
  ctx: TestApp,
  session: Session,
  workKey: string,
): Promise<{ id: string; version: number }> {
  const res = await apiInject(ctx, session, {
    method: 'POST',
    url: `/api/v1/works/${workKey}/mandates`,
    payload: { expiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString() },
    idempotencyKey: idemKey(),
  })
  expect(res.statusCode, res.body).toBe(201)
  return res.json().data as { id: string; version: number }
}

async function subscribeTask(
  ctx: TestApp,
  session: Session,
  workKey: string,
  taskId: string,
): Promise<{ id: string; status: string }> {
  const res = await apiInject(ctx, session, {
    method: 'POST',
    url: `/api/v1/works/${workKey}/subscriptions`,
    payload: { targetType: 'task', targetRef: taskId },
    idempotencyKey: idemKey(),
  })
  expect(res.statusCode, res.body).toBe(201)
  return res.json().data as { id: string; status: string }
}

async function revokeSubscription(
  ctx: TestApp,
  session: Session,
  workKey: string,
  subscriptionId: string,
): Promise<void> {
  const res = await apiInject(ctx, session, {
    method: 'POST',
    url: `/api/v1/works/${workKey}/subscriptions/${subscriptionId}/revoke`,
    payload: { reason: '测试撤销' },
    idempotencyKey: idemKey(),
  })
  expect(res.statusCode, res.body).toBe(200)
}

async function confirmAgreement(ctx: TestApp, session: Session, task: string): Promise<void> {
  const draft = await apiInject(ctx, session, {
    method: 'POST',
    url: `/api/v1/tasks/${task}/agreement/draft`,
    payload: {
      content: {
        goal: '预算从 12 万改为 8 万',
        constraints: '不新增审批步骤',
        acceptance: '新预算出现在下一次比较',
        openQuestions: '供应商待定',
      },
    },
    idempotencyKey: idemKey(),
  })
  expect(draft.statusCode, draft.body).toBe(200)
  const confirmed = await apiInject(ctx, session, {
    method: 'POST',
    url: `/api/v1/tasks/${task}/agreement/confirm`,
    payload: { draftVersion: draft.json().data.draftVersion },
    idempotencyKey: idemKey(),
  })
  expect(confirmed.statusCode, confirmed.body).toBe(200)
}

async function startRun(
  ctx: TestApp,
  session: Session,
  taskId: string,
  seed: Seed,
  itemIds: string[] | undefined,
  key = idemKey(),
): Promise<{ statusCode: number; body: string; json: () => any }> {
  return apiInject(ctx, session, {
    method: 'POST',
    url: `/api/v1/tasks/${taskId}/runs`,
    payload: {
      agentId: seed.agentId,
      deviceId: seed.deviceId,
      workspaceId: seed.workspaceId,
      prompt: '使用工作输入',
      ...(itemIds === undefined ? {} : { workInputItemIds: itemIds }),
    },
    idempotencyKey: key,
  })
}

async function dispatchAndReady(
  harness: Harness,
  seed: Seed,
  ownerUserId: string,
  runId: string,
): Promise<void> {
  harness.clock.advance(Math.max(0, Date.now() - harness.clock.now().getTime()) + 1)
  await harness.worker.dispatchOnce()
  const device = { deviceId: seed.deviceId, ownerUserId }
  for (const ack of harness.gateway.drainUpstream()) {
    await harness.orchestrator.ingestNodeEvent(device, ack)
  }
  await harness.orchestrator.ingestNodeEvent(
    device,
    runEventFrame(runId, 1, { type: 'runtime.ready', dshSessionId: `wi-${runId}` }),
  )
}

async function completeRun(
  harness: Harness,
  seed: Seed,
  ownerUserId: string,
  runId: string,
): Promise<void> {
  await harness.orchestrator.ingestNodeEvent(
    { deviceId: seed.deviceId, ownerUserId },
    runEventFrame(runId, 2, { type: 'run.completed', finalText: 'done' }),
  )
}

async function runWorkInputManifest(
  database: Database,
  runId: string,
): Promise<{
  workKey: string
  manifestDigest: string
  entries: Array<{ inboxItemId: string; byteSize: number }>
}> {
  const row = (await database.db.select().from(schema.runs).where(eq(schema.runs.id, runId)))[0]
  if (row === undefined || row.workKey === null || row.workInputManifestDigest === null) {
    throw new Error('run has no work input manifest')
  }
  return {
    workKey: row.workKey,
    manifestDigest: row.workInputManifestDigest,
    entries: (
      row.workInputManifest as { entries: Array<{ inboxItemId: string; byteSize: number }> }
    ).entries,
  }
}

function workInputReceipt(input: {
  readonly runId: string
  readonly workKey: string
  readonly manifestDigest: string
  readonly receiptSeq: number
  readonly inboxItemId: string
  readonly byteSize: number
  readonly at: string
  readonly digestVerified?: boolean
  readonly readDigestVerified?: boolean
  readonly deliveredItemId?: string
}): unknown {
  const digestVerified = input.digestVerified ?? true
  return {
    protocolVersion: 1,
    messageId: randomUUID(),
    sentAt: new Date().toISOString(),
    type: 'run.work_input_receipt',
    payload: {
      runId: input.runId,
      workKey: input.workKey,
      manifestDigest: input.manifestDigest,
      receiptSeq: input.receiptSeq,
      entriesDelivered: [input.deliveredItemId ?? input.inboxItemId],
      entriesRead: [input.inboxItemId],
      readEvents: [
        {
          inboxItemId: input.inboxItemId,
          digestVerified: input.readDigestVerified ?? digestVerified,
          byteSize: input.byteSize,
          at: input.at,
        },
      ],
      missing: [],
      digestVerified,
      at: input.at,
    },
  }
}

describe('RD-02a-2a run work input manifest', () => {
  let database: Database
  let ctx: TestApp
  let alice: Session
  let bob: Session
  let projectId: string
  let taskId: string
  let workKey: string
  let seed: Seed
  let harness: Harness

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
    workKey = await createWork(ctx, alice, taskId)
    seed = await seedRunDependencies(database, alice.userId)
    harness = makeHarness(database)
    harness.clock.advance(Date.now() - harness.clock.now().getTime())
  })

  afterEach(async () => {
    await harness.gateway.drainUpstream()
    await ctx.app.close()
  })

  afterAll(async () => {
    await database.close()
  })

  it('freezes an immutable manifest and records deliveries atomically', async () => {
    const firstMessage = await comment(ctx, alice, taskId, '场地候选缩为两个。')
    const secondMessage = await comment(ctx, alice, taskId, '预算按含税口径重算。')
    const first = await associate(ctx, alice, workKey, firstMessage)
    const second = await associate(ctx, alice, workKey, secondMessage)

    const key = idemKey()
    const created = await startRun(
      ctx,
      alice,
      taskId,
      seed,
      [second.id as string, first.id as string],
      key,
    )
    expect(created.statusCode, created.body).toBe(201)
    const run = created.json().data
    expect(run).toMatchObject({
      workKey,
      workInputItemCount: 2,
      workInputManifestDigest: expect.stringMatching(/^[a-f0-9]{64}$/),
    })
    // 读面只给摘要与条目数；条目标识/标题/来源不进 RunView（回放与任意成员 GET 都不广播）。
    expect(run).not.toHaveProperty('workInputManifest')
    expect(JSON.stringify(run)).not.toContain(first.id)
    expect(JSON.stringify(run)).not.toContain(second.id)

    const runRowManifest = (
      await database.db.select().from(schema.runs).where(eq(schema.runs.id, run.id))
    )[0]?.workInputManifest
    expect(runRowManifest).not.toBeNull()
    expect(sha256Hex(canonicalJson(runRowManifest))).toBe(run.workInputManifestDigest)

    const rows = await database.db.select().from(schema.workInboxItems)
    expect(rows.every((row) => row.status === 'delivered')).toBe(true)
    expect(rows.every((row) => row.deliveryRunId === run.id && row.deliveredAt !== null)).toBe(true)
    const deliveries = await database.db
      .select()
      .from(schema.workInboxDeliveries)
      .where(eq(schema.workInboxDeliveries.runId, run.id))
    expect(deliveries).toHaveLength(2)
    expect(deliveries.every((row) => row.status === 'sent' && row.attempt === 1)).toBe(true)
    expect(deliveries.every((row) => row.manifestDigest === run.workInputManifestDigest)).toBe(true)

    const inbox = await apiInject(ctx, alice, {
      method: 'GET',
      url: `/api/v1/works/${workKey}/inbox`,
    })
    expect(inbox.statusCode, inbox.body).toBe(200)
    expect(inbox.json().data.watermarks).toMatchObject({
      pendingCount: 0,
      deliveredCount: 2,
      unconfirmedCount: 0,
      consumedCount: 0,
    })
    expect(inbox.json().data.items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: first.id,
          status: 'delivered',
          deliveryRunId: run.id,
          deliveredAt: expect.any(String),
        }),
      ]),
    )

    const replay = await startRun(
      ctx,
      alice,
      taskId,
      seed,
      [second.id as string, first.id as string],
      key,
    )
    expect(replay.statusCode, replay.body).toBe(201)
    expect(replay.json().data.id).toBe(run.id)
    expect(replay.json().data.workInputManifestDigest).toBe(run.workInputManifestDigest)

    // 任意已登录成员可读 Run 基础事实，但读面不携带清单条目身份/标题。
    const memberRead = await apiInject(ctx, bob, {
      method: 'GET',
      url: `/api/v1/runs/${run.id as string}`,
    })
    expect(memberRead.statusCode, memberRead.body).toBe(200)
    expect(memberRead.json().data).toMatchObject({
      workKey,
      workInputItemCount: 2,
      workInputManifestDigest: run.workInputManifestDigest,
    })
    expect(memberRead.json().data).not.toHaveProperty('workInputManifest')
    expect(memberRead.body).not.toContain(first.id)
    expect(memberRead.body).not.toContain(second.id)

    // #493：Node 现在会拿到清单（不含正文），正文仍走受控下载。
    const starts = await database.db
      .select()
      .from(schema.dispatchOutbox)
      .where(eq(schema.dispatchOutbox.type, 'run.start'))
    expect(starts).toHaveLength(1)
    const startPayload = starts[0]?.payload as {
      workInput?: { manifest: { entries: Array<Record<string, unknown>> } }
    }
    expect(startPayload.workInput?.manifest.entries).toHaveLength(2)
    expect(startPayload.workInput?.manifest.entries[0]).not.toHaveProperty('body')
    expect(JSON.stringify(startPayload)).not.toContain('场地候选缩为两个')

    // 创建后改来源不改 Run 的固定清单。
    await database.db
      .update(schema.taskMessages)
      .set({ body: '创建后又被编辑。', editedAt: new Date(Date.now() + 1000) })
      .where(eq(schema.taskMessages.id, firstMessage))
    const runRow = (
      await database.db.select().from(schema.runs).where(eq(schema.runs.id, run.id))
    )[0]
    expect(runRow?.workInputManifestDigest).toBe(run.workInputManifestDigest)
  })

  it('rejects cross-task, missing and non-pending work inputs', async () => {
    const otherTask = await createTask(ctx, alice, projectId, alice.userId)
    const otherWork = await createWork(ctx, alice, otherTask)
    const foreignMessage = await comment(ctx, alice, otherTask, '另一个任务的材料。')
    const foreignItem = await associate(ctx, alice, otherWork, foreignMessage)

    const foreign = await startRun(ctx, alice, taskId, seed, [foreignItem.id as string])
    expect(foreign.statusCode, foreign.body).toBe(409)
    expect(foreign.json().error.code).toBe('CONFLICT')

    const missing = await startRun(ctx, alice, taskId, seed, [randomUUID()])
    expect(missing.statusCode, missing.body).toBe(409)

    const ownMessage = await comment(ctx, alice, taskId, '本任务材料。')
    const ownItem = await associate(ctx, alice, workKey, ownMessage)
    const first = await startRun(ctx, alice, taskId, seed, [ownItem.id as string])
    expect(first.statusCode, first.body).toBe(201)

    const cancelled = await apiInject(ctx, alice, {
      method: 'POST',
      url: `/api/v1/runs/${first.json().data.id as string}/cancel`,
    })
    expect(cancelled.statusCode, cancelled.body).toBe(200)
    const second = await startRun(ctx, alice, taskId, seed, [ownItem.id as string])
    expect(second.statusCode, second.body).toBe(409)
    expect(second.json().error.code).toBe('CONFLICT')
  })

  it('rejects a stale source instead of freezing a changed input', async () => {
    const messageId = await comment(ctx, alice, taskId, '原始材料。')
    const item = await associate(ctx, alice, workKey, messageId)
    await database.db
      .update(schema.taskMessages)
      .set({ editedAt: new Date(Date.now() + 1000) })
      .where(eq(schema.taskMessages.id, messageId))

    const res = await startRun(ctx, alice, taskId, seed, [item.id as string])
    expect(res.statusCode, res.body).toBe(409)
    expect(res.json().error.code).toBe('CONFLICT')
    const rows = await database.db.select().from(schema.workInboxItems)
    expect(rows[0]).toMatchObject({ id: item.id, status: 'pending', deliveryRunId: null })
    expect(await database.db.select().from(schema.runs)).toHaveLength(0)
    expect(await database.db.select().from(schema.workInboxDeliveries)).toHaveLength(0)
  })

  it('withdraws an already-delivered input when its source is retracted', async () => {
    const messageId = await comment(ctx, alice, taskId, '即将被撤权的材料。')
    const item = await associate(ctx, alice, workKey, messageId)
    const created = await startRun(ctx, alice, taskId, seed, [item.id as string])
    expect(created.statusCode, created.body).toBe(201)
    const runId = created.json().data.id as string

    const retracted = await apiInject(ctx, alice, {
      method: 'POST',
      url: `/api/v1/works/${workKey}/inbox-items/${item.id as string}/retract`,
      payload: { reason: 'source_permission_revoked' },
      idempotencyKey: idemKey(),
    })
    expect(retracted.statusCode, retracted.body).toBe(200)
    const itemRow = (
      await database.db
        .select()
        .from(schema.workInboxItems)
        .where(eq(schema.workInboxItems.id, item.id as string))
    )[0]
    expect(itemRow).toMatchObject({
      status: 'retracted',
      deliveryRunId: null,
      deliveredAt: null,
      statusReason: 'source_permission_revoked',
    })
    const delivery = (
      await database.db
        .select()
        .from(schema.workInboxDeliveries)
        .where(eq(schema.workInboxDeliveries.runId, runId))
    )[0]
    expect(delivery).toMatchObject({
      status: 'withdrawn',
      failureReason: 'source_retracted',
    })
  })

  it('revokes a subscription and withdraws its delivered unread copy', async () => {
    await createMandate(ctx, alice, workKey)
    const subscription = await subscribeTask(ctx, alice, workKey, taskId)
    const messageId = await comment(ctx, bob, taskId, '订阅交付但尚未读取的材料。')
    const listed = await apiInject(ctx, alice, {
      method: 'GET',
      url: `/api/v1/works/${workKey}/inbox`,
    })
    expect(listed.statusCode, listed.body).toBe(200)
    const item = (listed.json().data.items as Array<Record<string, unknown>>).find(
      (row) => row.sourceId === messageId,
    )
    expect(item).toMatchObject({
      status: 'pending',
      subscriptionId: subscription.id,
    })

    const created = await startRun(ctx, alice, taskId, seed, [item?.id as string])
    expect(created.statusCode, created.body).toBe(201)
    const runId = created.json().data.id as string
    const delivered = (
      await database.db
        .select()
        .from(schema.workInboxItems)
        .where(eq(schema.workInboxItems.id, item?.id as string))
    )[0]
    expect(delivered).toMatchObject({ status: 'delivered', deliveryRunId: runId })

    await revokeSubscription(ctx, alice, workKey, subscription.id)
    const afterRevoke = (
      await database.db
        .select()
        .from(schema.workInboxItems)
        .where(eq(schema.workInboxItems.id, item?.id as string))
    )[0]
    expect(afterRevoke).toMatchObject({
      status: 'retracted',
      statusReason: '测试撤销',
      deliveryRunId: null,
      deliveredAt: null,
    })
    const delivery = (
      await database.db
        .select()
        .from(schema.workInboxDeliveries)
        .where(eq(schema.workInboxDeliveries.runId, runId))
    )[0]
    expect(delivery).toMatchObject({
      status: 'withdrawn',
      failureReason: 'subscription_ended',
    })
  })

  it('revokes a subscription and withdraws its unconfirmed copy', async () => {
    await createMandate(ctx, alice, workKey)
    const subscription = await subscribeTask(ctx, alice, workKey, taskId)
    const messageId = await comment(ctx, bob, taskId, 'Run 结束后仍未读取的材料。')
    const listed = await apiInject(ctx, alice, {
      method: 'GET',
      url: `/api/v1/works/${workKey}/inbox`,
    })
    const item = (listed.json().data.items as Array<Record<string, unknown>>).find(
      (row) => row.sourceId === messageId,
    )
    const created = await startRun(ctx, alice, taskId, seed, [item?.id as string])
    expect(created.statusCode, created.body).toBe(201)
    const runId = created.json().data.id as string
    await dispatchAndReady(harness, seed, alice.userId, runId)
    await completeRun(harness, seed, alice.userId, runId)
    expect(
      (
        await database.db
          .select()
          .from(schema.workInboxItems)
          .where(eq(schema.workInboxItems.id, item?.id as string))
      )[0],
    ).toMatchObject({ status: 'unconfirmed', deliveryRunId: runId })

    await revokeSubscription(ctx, alice, workKey, subscription.id)
    expect(
      (
        await database.db
          .select()
          .from(schema.workInboxItems)
          .where(eq(schema.workInboxItems.id, item?.id as string))
      )[0],
    ).toMatchObject({ status: 'retracted', deliveryRunId: null, unconfirmedAt: null })
    expect(
      (
        await database.db
          .select()
          .from(schema.workInboxDeliveries)
          .where(eq(schema.workInboxDeliveries.runId, runId))
      )[0],
    ).toMatchObject({ status: 'withdrawn', failureReason: 'subscription_ended' })
  })

  it('keeps a consumed copy when its subscription is revoked afterwards', async () => {
    await createMandate(ctx, alice, workKey)
    const subscription = await subscribeTask(ctx, alice, workKey, taskId)
    const messageId = await comment(ctx, bob, taskId, '订阅交付且已读取的材料。')
    const listed = await apiInject(ctx, alice, {
      method: 'GET',
      url: `/api/v1/works/${workKey}/inbox`,
    })
    const item = (listed.json().data.items as Array<Record<string, unknown>>).find(
      (row) => row.sourceId === messageId,
    )
    const created = await startRun(ctx, alice, taskId, seed, [item?.id as string])
    expect(created.statusCode, created.body).toBe(201)
    const runId = created.json().data.id as string
    await dispatchAndReady(harness, seed, alice.userId, runId)
    const manifest = await runWorkInputManifest(database, runId)
    const entry = manifest.entries.find((row) => row.inboxItemId === item?.id)
    expect(entry).toBeDefined()
    await harness.orchestrator.ingestNodeEvent(
      { deviceId: seed.deviceId, ownerUserId: alice.userId },
      workInputReceipt({
        runId,
        workKey: manifest.workKey,
        manifestDigest: manifest.manifestDigest,
        receiptSeq: 1,
        inboxItemId: item?.id as string,
        byteSize: entry?.byteSize as number,
        at: harness.clock.now().toISOString(),
      }),
    )
    expect(
      (
        await database.db
          .select()
          .from(schema.workInboxItems)
          .where(eq(schema.workInboxItems.id, item?.id as string))
      )[0],
    ).toMatchObject({ status: 'consumed', deliveryRunId: runId })

    await revokeSubscription(ctx, alice, workKey, subscription.id)
    expect(
      (
        await database.db
          .select()
          .from(schema.workInboxItems)
          .where(eq(schema.workInboxItems.id, item?.id as string))
      )[0],
    ).toMatchObject({ status: 'consumed', deliveryRunId: runId })
    expect(
      (
        await database.db
          .select()
          .from(schema.workInboxDeliveries)
          .where(eq(schema.workInboxDeliveries.runId, runId))
      )[0],
    ).toMatchObject({ status: 'consumed' })
    expect(
      await database.db
        .select()
        .from(schema.workInputConsumptions)
        .where(eq(schema.workInputConsumptions.runId, runId)),
    ).toHaveLength(1)
  })

  it('serializes terminal settlement with Work→item cleanup without deadlock', async () => {
    const messageId = await comment(ctx, alice, taskId, '终态与清理并发探针。')
    const item = await associate(ctx, alice, workKey, messageId)
    const created = await startRun(ctx, alice, taskId, seed, [item.id as string])
    expect(created.statusCode, created.body).toBe(201)
    const runId = created.json().data.id as string
    const work = (
      await database.db.select().from(schema.works).where(eq(schema.works.workKey, workKey))
    )[0]
    expect(work).toBeDefined()

    let releaseCleanup!: () => void
    const cleanupGate = new Promise<void>((resolve) => {
      releaseCleanup = resolve
    })
    let cleanupLocked!: () => void
    const cleanupReady = new Promise<void>((resolve) => {
      cleanupLocked = resolve
    })
    // A：模拟撤销/清理路径 Work→item。
    const cleanup = database.transaction(async (tx) => {
      await tx
        .select()
        .from(schema.works)
        .where(eq(schema.works.id, work?.id as string))
        .for('update')
      cleanupLocked()
      await cleanupGate
      await tx
        .select()
        .from(schema.workInboxItems)
        .where(eq(schema.workInboxItems.id, item.id as string))
        .for('update')
    })
    await cleanupReady
    // B：Run 终态。修复前它会先锁 item 再等 Work，与 A 形成环。
    const outbox = new Outbox(database)
    const terminal = database.transaction((tx) =>
      applyRunStatus(tx, outbox, runId, 'completed', { finishedAt: new Date() }),
    )
    await waitForValue(async () => {
      const rows = await database.sql<{ pid: number }[]>`
          select pid from pg_stat_activity
          where datname = current_database()
            and wait_event_type = 'Lock'
            and state = 'active'
            and query ilike '%"work"%'
        `
      return rows.length > 0 ? rows : undefined
    }, 'Run 终态事务未在锁等待中停住（锁序探针前置条件不成立）')
    releaseCleanup()
    await Promise.all([cleanup, terminal])

    expect(
      (
        await database.db
          .select()
          .from(schema.workInboxItems)
          .where(eq(schema.workInboxItems.id, item.id as string))
      )[0],
    ).toMatchObject({ status: 'unconfirmed', deliveryRunId: runId })
    expect(
      (await database.db.select().from(schema.runs).where(eq(schema.runs.id, runId)))[0],
    ).toMatchObject({ status: 'completed' })
  })

  it('rejects duplicate ids, retired work and tampered/foreign-work inputs', async () => {
    const messageId = await comment(ctx, alice, taskId, '边界材料。')
    const item = await associate(ctx, alice, workKey, messageId)

    const duplicate = await startRun(ctx, alice, taskId, seed, [
      item.id as string,
      item.id as string,
    ])
    expect(duplicate.statusCode, duplicate.body).toBe(400)
    expect(duplicate.json().error.code).toBe('VALIDATION_FAILED')

    const empty = await startRun(ctx, alice, taskId, seed, [])
    expect(empty.statusCode, empty.body).toBe(400)
    expect(empty.json().error.code).toBe('VALIDATION_FAILED')

    const oversized = await startRun(
      ctx,
      alice,
      taskId,
      seed,
      Array.from({ length: 33 }, () => randomUUID()),
    )
    expect(oversized.statusCode, oversized.body).toBe(400)
    expect(oversized.json().error.code).toBe('VALIDATION_FAILED')

    // removeWhen：now 可注入或仓储提供快照校验口后删除该直写。
    await database.db
      .update(schema.workInboxItems)
      .set({ body: '被篡改的正文' })
      .where(eq(schema.workInboxItems.id, item.id as string))
    const tampered = await startRun(ctx, alice, taskId, seed, [item.id as string])
    expect(tampered.statusCode, tampered.body).toBe(409)
    expect(await database.db.select().from(schema.runs)).toHaveLength(0)

    await database.db
      .update(schema.workInboxItems)
      .set({ body: '场地候选缩为两个。', bodyDigest: '0'.repeat(64) })
      .where(eq(schema.workInboxItems.id, item.id as string))
    const badDigest = await startRun(ctx, alice, taskId, seed, [item.id as string])
    expect(badDigest.statusCode, badDigest.body).toBe(409)
  })

  it('rejects an item whose stored task was corrupted away from its work task', async () => {
    const firstMessage = await comment(ctx, alice, taskId, '第一份正常材料。')
    const secondMessage = await comment(ctx, alice, taskId, '第二份归属损坏材料。')
    const first = await associate(ctx, alice, workKey, firstMessage)
    const second = await associate(ctx, alice, workKey, secondMessage)
    const otherTask = await createTask(ctx, alice, projectId, alice.userId)
    // removeWhen：仓储提供来源/归属一致性测试口后删除该直写。
    await database.db
      .update(schema.workInboxItems)
      .set({ taskId: otherTask })
      .where(eq(schema.workInboxItems.id, second.id as string))
    const res = await startRun(ctx, alice, taskId, seed, [first.id as string, second.id as string])
    expect(res.statusCode, res.body).toBe(409)
    expect(res.json().error.code).toBe('CONFLICT')
    expect(await database.db.select().from(schema.runs)).toHaveLength(0)
  })

  it('rejects input from a retired work', async () => {
    const messageId = await comment(ctx, alice, taskId, '退休工作材料。')
    const item = await associate(ctx, alice, workKey, messageId)
    const retired = await apiInject(ctx, alice, {
      method: 'POST',
      url: `/api/v1/works/${workKey}/retire`,
      payload: {},
      idempotencyKey: idemKey(),
    })
    expect(retired.statusCode, retired.body).toBe(200)
    const afterRetire = await startRun(ctx, alice, taskId, seed, [item.id as string])
    expect(afterRetire.statusCode, afterRetire.body).toBe(409)
    expect(afterRetire.json().error.code).toBe('CONFLICT')
  })

  it('rejects a work whose owner no longer matches the task assignee', async () => {
    const messageId = await comment(ctx, alice, taskId, '责任人不一致的材料。')
    const item = await associate(ctx, alice, workKey, messageId)
    // removeWhen：工作改派路径能产生 active 且 owner 不一致的故障态后删除。
    await database.db
      .update(schema.works)
      .set({ humanOwnerUserId: bob.userId })
      .where(eq(schema.works.workKey, workKey))
    const res = await startRun(ctx, alice, taskId, seed, [item.id as string])
    expect(res.statusCode, res.body).toBe(409)
    expect(await database.db.select().from(schema.runs)).toHaveLength(0)
  })

  it('marks unconsumed inputs unconfirmed on run end and returns them after 60s', async () => {
    const messageId = await comment(ctx, alice, taskId, '需要 Run 消费的材料。')
    const item = await associate(ctx, alice, workKey, messageId)
    const created = await startRun(ctx, alice, taskId, seed, [item.id as string])
    expect(created.statusCode, created.body).toBe(201)
    const runId = created.json().data.id as string
    await dispatchAndReady(harness, seed, alice.userId, runId)
    await completeRun(harness, seed, alice.userId, runId)

    const runRow = (
      await database.db.select().from(schema.runs).where(eq(schema.runs.id, runId))
    )[0]
    expect(runRow?.status).toBe('completed')
    const finishedAt = runRow?.finishedAt?.getTime() as number
    let itemRow = (
      await database.db
        .select()
        .from(schema.workInboxItems)
        .where(eq(schema.workInboxItems.id, item.id as string))
    )[0]
    expect(itemRow).toMatchObject({
      status: 'unconfirmed',
      deliveryRunId: runId,
      statusReason: 'run_ended_awaiting_receipt',
    })
    expect(itemRow?.unconfirmedAt).not.toBeNull()
    const delivery = (
      await database.db
        .select()
        .from(schema.workInboxDeliveries)
        .where(eq(schema.workInboxDeliveries.runId, runId))
    )[0]
    expect(delivery?.status).toBe('unconfirmed')

    const inbox = await apiInject(ctx, alice, {
      method: 'GET',
      url: `/api/v1/works/${workKey}/inbox`,
    })
    expect(inbox.statusCode, inbox.body).toBe(200)
    expect(inbox.json().data.watermarks).toMatchObject({
      pendingCount: 0,
      deliveredCount: 0,
      unconfirmedCount: 1,
      consumedCount: 0,
    })

    expect(await reconcileWorkInputs(database, new Date(finishedAt + 59_000))).toBe(0)
    expect(await reconcileWorkInputs(database, new Date(finishedAt + 61_000))).toBe(1)
    // 对账幂等：同一时间点重跑不应重复收口或再改状态。
    expect(await reconcileWorkInputs(database, new Date(finishedAt + 61_000))).toBe(0)
    itemRow = (
      await database.db
        .select()
        .from(schema.workInboxItems)
        .where(eq(schema.workInboxItems.id, item.id as string))
    )[0]
    expect(itemRow).toMatchObject({
      status: 'pending',
      statusReason: 'run_ended_unconsumed',
      deliveryRunId: null,
      deliveredAt: null,
      unconfirmedAt: null,
    })
    const returnedDelivery = (
      await database.db
        .select()
        .from(schema.workInboxDeliveries)
        .where(eq(schema.workInboxDeliveries.runId, runId))
    )[0]
    expect(returnedDelivery).toMatchObject({
      status: 'returned',
      failureReason: 'run_ended_unconsumed',
    })
    const runAfter = (
      await database.db.select().from(schema.runs).where(eq(schema.runs.id, runId))
    )[0]
    expect(runAfter?.status).toBe('completed')
  })

  it('supersedes an unconsumed old version when a newer version is already pending', async () => {
    const messageId = await comment(ctx, alice, taskId, '第一版材料。')
    const first = await associate(ctx, alice, workKey, messageId)
    const created = await startRun(ctx, alice, taskId, seed, [first.id as string])
    expect(created.statusCode, created.body).toBe(201)
    const runId = created.json().data.id as string

    await database.db
      .update(schema.taskMessages)
      .set({ body: '第二版材料。', editedAt: new Date(Date.now() + 1000) })
      .where(eq(schema.taskMessages.id, messageId))
    const second = await associate(ctx, alice, workKey, messageId)
    expect(second.status).toBe('pending')

    await dispatchAndReady(harness, seed, alice.userId, runId)
    await completeRun(harness, seed, alice.userId, runId)
    const runRow = (
      await database.db.select().from(schema.runs).where(eq(schema.runs.id, runId))
    )[0]
    const finishedAt = runRow?.finishedAt?.getTime() as number
    expect(await reconcileWorkInputs(database, new Date(finishedAt + 61_000))).toBe(1)

    const oldRow = (
      await database.db
        .select()
        .from(schema.workInboxItems)
        .where(eq(schema.workInboxItems.id, first.id as string))
    )[0]
    expect(oldRow).toMatchObject({
      status: 'superseded',
      statusReason: 'new_version',
      deliveryRunId: null,
    })
    const delivery = (
      await database.db
        .select()
        .from(schema.workInboxDeliveries)
        .where(eq(schema.workInboxDeliveries.runId, runId))
    )[0]
    expect(delivery).toMatchObject({
      status: 'returned',
      failureReason: 'superseded_by_new_version',
    })
    const newRow = (
      await database.db
        .select()
        .from(schema.workInboxItems)
        .where(eq(schema.workInboxItems.id, second.id as string))
    )[0]
    expect(newRow?.status).toBe('pending')
  })

  it('rejects work inputs from granted members and re-checks the assignee on replay', async () => {
    const messageId = await comment(ctx, alice, taskId, '责任人私有材料。')
    const item = await associate(ctx, alice, workKey, messageId)
    const granted = await apiInject(ctx, alice, {
      method: 'POST',
      url: `/api/v1/tasks/${taskId}/instruction-grants`,
      payload: { userId: bob.userId },
      idempotencyKey: idemKey(),
    })
    expect(granted.statusCode, granted.body).toBe(201)

    // 被授权成员可以驱动 Run，但收件箱材料是责任人私有快照，不能带入。
    const denied = await startRun(ctx, bob, taskId, seed, [item.id as string])
    expect(denied.statusCode, denied.body).toBe(403)
    expect(denied.json().error.code).toBe('FORBIDDEN')
    expect(await database.db.select().from(schema.runs)).toHaveLength(0)

    const key = idemKey()
    const created = await startRun(ctx, alice, taskId, seed, [item.id as string], key)
    expect(created.statusCode, created.body).toBe(201)
    const runId = created.json().data.id as string

    // 已知 idempotencyKey 也不能让被授权成员从缓存回执里读回清单摘要。
    const replayDenied = await startRun(ctx, bob, taskId, seed, [item.id as string], key)
    expect(replayDenied.statusCode, replayDenied.body).toBe(403)
    expect(JSON.stringify(replayDenied.json())).not.toContain(runId)

    // 省略 workInputItemIds 不能绕过复核：鉴权看回执里的 Run，不看本次请求字段。
    const omittedDenied = await startRun(ctx, bob, taskId, seed, undefined, key)
    expect(omittedDenied.statusCode, omittedDenied.body).toBe(403)
    expect(JSON.stringify(omittedDenied.json())).not.toContain(runId)

    // 更强的隔离：alice 也是第二个 Task 的责任人，若不校验回执 taskId，
    // workKey 的 assignee 复核会通过并取回原 Run。
    const aliceTaskRes = await apiInject(ctx, alice, {
      method: 'POST',
      url: `/api/v1/projects/${projectId}/tasks`,
      payload: { title: 'Alice 的第二个任务', assigneeUserId: alice.userId },
    })
    expect(aliceTaskRes.statusCode, aliceTaskRes.body).toBe(201)
    const aliceTaskId = aliceTaskRes.json().data.id as string
    const aliceAccepted = await apiInject(ctx, alice, {
      method: 'POST',
      url: `/api/v1/tasks/${aliceTaskId}/accept`,
    })
    expect(aliceAccepted.statusCode, aliceAccepted.body).toBe(200)
    const sameOwnerCrossTask = await startRun(ctx, alice, aliceTaskId, seed, undefined, key)
    expect(sameOwnerCrossTask.statusCode, sameOwnerCrossTask.body).toBe(404)
    expect(JSON.stringify(sameOwnerCrossTask.json())).not.toContain(runId)

    // 跨 Task 复用同一全局 key（即使 bob 是另一个 Task 的责任人）也不能取回这条 Run。
    const bobTaskRes = await apiInject(ctx, alice, {
      method: 'POST',
      url: `/api/v1/projects/${projectId}/tasks`,
      payload: { title: 'Bob 的另一个任务', assigneeUserId: bob.userId },
    })
    expect(bobTaskRes.statusCode, bobTaskRes.body).toBe(201)
    const bobTaskId = bobTaskRes.json().data.id as string
    const accepted = await apiInject(ctx, bob, {
      method: 'POST',
      url: `/api/v1/tasks/${bobTaskId}/accept`,
    })
    expect(accepted.statusCode, accepted.body).toBe(200)
    const crossTask = await startRun(ctx, bob, bobTaskId, seed, undefined, key)
    expect(crossTask.statusCode, crossTask.body).toBe(404)
    expect(crossTask.json().error.code).toBe('NOT_FOUND')
    expect(JSON.stringify(crossTask.json())).not.toContain(runId)

    const revoked = await apiInject(ctx, alice, {
      method: 'DELETE',
      url: `/api/v1/tasks/${taskId}/instruction-grants/${bob.userId}`,
      idempotencyKey: idemKey(),
    })
    expect(revoked.statusCode, revoked.body).toBe(200)
    const afterRevoke = await startRun(ctx, bob, taskId, seed, [item.id as string], key)
    expect(afterRevoke.statusCode, afterRevoke.body).toBe(403)

    const ownerReplay = await startRun(ctx, alice, taskId, seed, [item.id as string], key)
    expect(ownerReplay.statusCode, ownerReplay.body).toBe(201)
    expect(ownerReplay.json().data.id).toBe(runId)
  })

  it('marks cancelled and failed runs unconfirmed and retracts an unconfirmed input', async () => {
    const firstMessage = await comment(ctx, alice, taskId, '将被取消的材料。')
    const first = await associate(ctx, alice, workKey, firstMessage)
    const firstRun = await startRun(ctx, alice, taskId, seed, [first.id as string])
    expect(firstRun.statusCode, firstRun.body).toBe(201)
    const firstRunId = firstRun.json().data.id as string
    const cancelled = await apiInject(ctx, alice, {
      method: 'POST',
      url: `/api/v1/runs/${firstRunId}/cancel`,
    })
    expect(cancelled.statusCode, cancelled.body).toBe(200)

    const afterCancel = (
      await database.db
        .select()
        .from(schema.workInboxItems)
        .where(eq(schema.workInboxItems.id, first.id as string))
    )[0]
    expect(afterCancel).toMatchObject({
      status: 'unconfirmed',
      statusReason: 'run_ended_awaiting_receipt',
    })

    // unconfirmed 也能被来源级撤权收口；delivery 必须一起撤回。
    const retracted = await apiInject(ctx, alice, {
      method: 'POST',
      url: `/api/v1/works/${workKey}/inbox-items/${first.id as string}/retract`,
      payload: { reason: 'source_permission_revoked' },
      idempotencyKey: idemKey(),
    })
    expect(retracted.statusCode, retracted.body).toBe(200)
    expect(retracted.json().data).toMatchObject({
      id: first.id,
      status: 'retracted',
      statusReason: 'source_permission_revoked',
    })
    expect(
      (
        await database.db
          .select()
          .from(schema.workInboxDeliveries)
          .where(eq(schema.workInboxDeliveries.runId, firstRunId))
      )[0],
    ).toMatchObject({ status: 'withdrawn', failureReason: 'source_retracted' })

    const secondMessage = await comment(ctx, alice, taskId, '将失败的材料。')
    const second = await associate(ctx, alice, workKey, secondMessage)
    const secondRun = await startRun(ctx, alice, taskId, seed, [second.id as string])
    expect(secondRun.statusCode, secondRun.body).toBe(201)
    const secondRunId = secondRun.json().data.id as string
    await dispatchAndReady(harness, seed, alice.userId, secondRunId)
    await harness.orchestrator.ingestNodeEvent(
      { deviceId: seed.deviceId, ownerUserId: alice.userId },
      runEventFrame(secondRunId, 2, {
        type: 'run.failed',
        code: 'INTERNAL_ERROR',
        summary: 'boom',
      }),
    )
    const afterFailure = (
      await database.db
        .select()
        .from(schema.workInboxItems)
        .where(eq(schema.workInboxItems.id, second.id as string))
    )[0]
    expect(afterFailure).toMatchObject({
      status: 'unconfirmed',
      deliveryRunId: secondRunId,
    })
    expect(
      (
        await database.db
          .select()
          .from(schema.workInboxDeliveries)
          .where(eq(schema.workInboxDeliveries.runId, secondRunId))
      )[0],
    ).toMatchObject({ status: 'unconfirmed' })
  })

  it('keeps delivery attempts per run and only returns one of two unconfirmed versions', async () => {
    const messageId = await comment(ctx, alice, taskId, '第一版材料。')
    const first = await associate(ctx, alice, workKey, messageId)
    const firstRun = await startRun(ctx, alice, taskId, seed, [first.id as string])
    expect(firstRun.statusCode, firstRun.body).toBe(201)
    const firstRunId = firstRun.json().data.id as string
    await dispatchAndReady(harness, seed, alice.userId, firstRunId)
    await completeRun(harness, seed, alice.userId, firstRunId)
    const firstFinished = (
      await database.db.select().from(schema.runs).where(eq(schema.runs.id, firstRunId))
    )[0]?.finishedAt?.getTime() as number

    expect(await reconcileWorkInputs(database, new Date(firstFinished + 61_000))).toBe(1)
    // 回到 pending 后可以交付给下一个 Run；历史尝试保留而不是覆盖。
    const secondRun = await startRun(ctx, alice, taskId, seed, [first.id as string])
    expect(secondRun.statusCode, secondRun.body).toBe(201)
    const secondRunId = secondRun.json().data.id as string
    const attempts = await database.db
      .select()
      .from(schema.workInboxDeliveries)
      .where(eq(schema.workInboxDeliveries.inboxItemId, first.id as string))
    expect(attempts).toHaveLength(2)
    expect(attempts.map((row) => row.runId).sort()).toEqual([firstRunId, secondRunId].sort())
    expect(attempts.every((row) => row.attempt === 1)).toBe(true)
    expect(attempts.find((row) => row.runId === firstRunId)).toMatchObject({
      status: 'returned',
      failureReason: 'run_ended_unconsumed',
    })
    expect(attempts.find((row) => row.runId === secondRunId)).toMatchObject({ status: 'sent' })

    await dispatchAndReady(harness, seed, alice.userId, secondRunId)
    await completeRun(harness, seed, alice.userId, secondRunId)

    // 两个版本同时停在 unconfirmed：对账只能留下一个 pending，另一个转 superseded。
    await database.db
      .update(schema.taskMessages)
      .set({ body: '第二版材料。', editedAt: new Date(Date.now() + 1000) })
      .where(eq(schema.taskMessages.id, messageId))
    const second = await associate(ctx, alice, workKey, messageId)
    const thirdRun = await startRun(ctx, alice, taskId, seed, [second.id as string])
    expect(thirdRun.statusCode, thirdRun.body).toBe(201)
    const thirdRunId = thirdRun.json().data.id as string
    await dispatchAndReady(harness, seed, alice.userId, thirdRunId)
    await completeRun(harness, seed, alice.userId, thirdRunId)
    const thirdFinished = (
      await database.db.select().from(schema.runs).where(eq(schema.runs.id, thirdRunId))
    )[0]?.finishedAt?.getTime() as number

    expect(await reconcileWorkInputs(database, new Date(thirdFinished + 61_000))).toBe(2)
    const rows = await database.db
      .select()
      .from(schema.workInboxItems)
      .where(eq(schema.workInboxItems.sourceId, messageId))
    const pendingRows = rows.filter((row) => row.status === 'pending')
    expect(pendingRows).toHaveLength(1)
    // 存活必须是较新的 v2；旧 v1 不能因处理顺序先回 pending 把新版本顶掉。
    expect(pendingRows[0]?.id).toBe(second.id)
    expect(rows.find((row) => row.status === 'superseded')).toMatchObject({
      id: first.id,
      statusReason: 'new_version',
    })

    // 最新版本回到 pending 后仍能被下一次 Run 选中（没有 stale 顶掉输入槽）。
    const reusable = await startRun(ctx, alice, taskId, seed, [second.id as string])
    expect(reusable.statusCode, reusable.body).toBe(201)
  })

  it('keeps a newer delivered version from being superseded by an older unconfirmed one', async () => {
    const messageId = await comment(ctx, alice, taskId, '第一版材料。')
    const old = await associate(ctx, alice, workKey, messageId)
    const firstRun = await startRun(ctx, alice, taskId, seed, [old.id as string])
    expect(firstRun.statusCode, firstRun.body).toBe(201)
    const firstRunId = firstRun.json().data.id as string
    await dispatchAndReady(harness, seed, alice.userId, firstRunId)
    await completeRun(harness, seed, alice.userId, firstRunId)
    const firstFinished = (
      await database.db.select().from(schema.runs).where(eq(schema.runs.id, firstRunId))
    )[0]?.finishedAt?.getTime() as number

    await database.db
      .update(schema.taskMessages)
      .set({ body: '第二版材料。', editedAt: new Date(Date.now() + 1000) })
      .where(eq(schema.taskMessages.id, messageId))
    const newer = await associate(ctx, alice, workKey, messageId)
    const secondRun = await startRun(ctx, alice, taskId, seed, [newer.id as string])
    expect(secondRun.statusCode, secondRun.body).toBe(201)
    const secondRunId = secondRun.json().data.id as string
    await dispatchAndReady(harness, seed, alice.userId, secondRunId)

    // 旧版本 60s 到期时，新版本仍在运行（delivered）：旧版本只能 superseded，不能回 pending。
    expect(await reconcileWorkInputs(database, new Date(firstFinished + 61_000))).toBe(1)
    const rows = await database.db
      .select()
      .from(schema.workInboxItems)
      .where(eq(schema.workInboxItems.sourceId, messageId))
    expect(rows.find((row) => row.id === old.id)).toMatchObject({
      status: 'superseded',
      statusReason: 'new_version',
    })
    expect(rows.find((row) => row.id === newer.id)).toMatchObject({
      status: 'delivered',
      deliveryRunId: secondRunId,
    })
    expect(
      (
        await database.db
          .select()
          .from(schema.workInboxDeliveries)
          .where(eq(schema.workInboxDeliveries.runId, firstRunId))
      )[0],
    ).toMatchObject({ status: 'returned', failureReason: 'superseded_by_new_version' })

    // 新 Run 正常结束后未消费的新版本才回到 pending。
    await completeRun(harness, seed, alice.userId, secondRunId)
    const secondFinished = (
      await database.db.select().from(schema.runs).where(eq(schema.runs.id, secondRunId))
    )[0]?.finishedAt?.getTime() as number
    expect(await reconcileWorkInputs(database, new Date(secondFinished + 61_000))).toBe(1)
    expect(
      (
        await database.db
          .select()
          .from(schema.workInboxItems)
          .where(eq(schema.workInboxItems.id, newer.id as string))
      )[0],
    ).toMatchObject({ status: 'pending', statusReason: 'run_ended_unconsumed' })
  })

  it('freezes a context entry source without exposing it on the run face', async () => {
    await confirmAgreement(ctx, alice, taskId)
    const context = await apiInject(ctx, alice, {
      method: 'GET',
      url: `/api/v1/projects/${projectId}/context`,
    })
    expect(context.statusCode, context.body).toBe(200)
    const entry = (context.json().data.entries as Array<Record<string, unknown>>).find(
      (row) => row.kind === 'decision' && row.businessRef === `taskSpec:${taskId}`,
    )
    expect(entry).toBeDefined()
    const item = await associate(ctx, alice, workKey, entry?.id as string, 'context_entry')
    const created = await startRun(ctx, alice, taskId, seed, [item.id as string])
    expect(created.statusCode, created.body).toBe(201)
    expect(created.json().data).toMatchObject({ workInputItemCount: 1 })
    expect(created.json().data).not.toHaveProperty('workInputManifest')
    const manifest = (
      await database.db
        .select()
        .from(schema.runs)
        .where(eq(schema.runs.id, created.json().data.id as string))
    )[0]?.workInputManifest as { entries: Array<Record<string, unknown>> }
    expect(manifest.entries).toHaveLength(1)
    expect(manifest.entries[0]).toMatchObject({
      inboxItemId: item.id,
      sourceType: 'context_entry',
      sourceId: entry?.id,
    })
  })

  it('lists only due rows and rechecks the 60s window inside settlement', async () => {
    const messageId = await comment(ctx, alice, taskId, '窗口边界材料。')
    const item = await associate(ctx, alice, workKey, messageId)
    const created = await startRun(ctx, alice, taskId, seed, [item.id as string])
    expect(created.statusCode, created.body).toBe(201)
    const runId = created.json().data.id as string
    await dispatchAndReady(harness, seed, alice.userId, runId)
    await completeRun(harness, seed, alice.userId, runId)
    const finishedAt = (
      await database.db.select().from(schema.runs).where(eq(schema.runs.id, runId))
    )[0]?.finishedAt?.getTime() as number

    // 参数是 cutoff（now - 60s），不是 now。
    const before = new Date(finishedAt - 1_000)
    const after = new Date(finishedAt + 1_000)
    expect(await listDueUnconfirmedWorkInputIds(database.db, before)).toEqual([])
    expect(await listDueUnconfirmedWorkInputIds(database.db, after)).toEqual([item.id])

    // 即使绕过列表过滤直接收口，也必须复核 unconfirmed_at，避免多实例/竞态提前返回。
    const settled = await database.transaction((tx) =>
      settleUnconfirmedWorkInput(tx, item.id as string, before, before),
    )
    expect(settled).toBe(0)
    expect(
      (
        await database.db
          .select()
          .from(schema.workInboxItems)
          .where(eq(schema.workInboxItems.id, item.id as string))
      )[0]?.status,
    ).toBe('unconfirmed')
  })

  it('serializes concurrent starts that select the same input', async () => {
    const messageId = await comment(ctx, alice, taskId, '并发竞争的材料。')
    const item = await associate(ctx, alice, workKey, messageId)
    const [left, right] = await Promise.all([
      startRun(ctx, alice, taskId, seed, [item.id as string]),
      startRun(ctx, alice, taskId, seed, [item.id as string]),
    ])
    expect([left.statusCode, right.statusCode].sort()).toEqual([201, 409])
    expect(await database.db.select().from(schema.runs)).toHaveLength(1)
    const rows = await database.db.select().from(schema.workInboxDeliveries)
    expect(rows).toHaveLength(1)
  })

  it('serves the frozen bundle only to the run device', async () => {
    const messageId = await comment(ctx, alice, taskId, '需要下载的正文。')
    const item = await associate(ctx, alice, workKey, messageId)
    const created = await startRun(ctx, alice, taskId, seed, [item.id as string])
    expect(created.statusCode, created.body).toBe(201)
    const runId = created.json().data.id as string

    const bundle = await ctx.app.inject({
      method: 'GET',
      url: `/api/v1/node/runs/${runId}/work-input/bundle`,
      headers: { authorization: `Device ${DEVICE_TOKEN}` },
    })
    expect(bundle.statusCode, bundle.body).toBe(200)
    expect(bundle.json().data.entries).toHaveLength(1)
    expect(bundle.json().data.entries[0]).toMatchObject({ inboxItemId: item.id })
    expect(
      Buffer.from(bundle.json().data.entries[0].bodyBase64 as string, 'base64').toString('utf8'),
    ).toBe('需要下载的正文。')

    // removeWhen：生产提供多设备配对夹具后删除该直写；仅用于跨设备 404 判据。
    const foreignToken = `foreign-${randomUUID()}`
    await database.db.insert(schema.devices).values({
      id: randomUUID(),
      ownerUserId: alice.userId,
      name: 'foreign-device',
      platform: 'darwin',
      architecture: 'arm64',
      nodeVersion: '24.12.0',
      nodeAppVersion: '0.1.0',
      tokenHash: Buffer.from(hashToken(foreignToken)),
      capabilities: {},
      dshDistributionVersion: '0.1.0-rc.8',
      lastSeenAt: new Date(),
    })
    const foreign = await ctx.app.inject({
      method: 'GET',
      url: `/api/v1/node/runs/${runId}/work-input/bundle`,
      headers: { authorization: `Device ${foreignToken}` },
    })
    expect(foreign.statusCode, foreign.body).toBe(404)
  })

  it('marks an in-window read consumed and keeps duplicate reads idempotent', async () => {
    const body = '窗口内读取的材料。'
    const messageId = await comment(ctx, alice, taskId, body)
    const item = await associate(ctx, alice, workKey, messageId)
    const created = await startRun(ctx, alice, taskId, seed, [item.id as string])
    expect(created.statusCode, created.body).toBe(201)
    const runId = created.json().data.id as string
    await dispatchAndReady(harness, seed, alice.userId, runId)
    const manifest = await runWorkInputManifest(database, runId)
    const entry = manifest.entries.find((row) => row.inboxItemId === item.id)
    expect(entry).toBeDefined()

    const device = { deviceId: seed.deviceId, ownerUserId: alice.userId }
    await harness.orchestrator.ingestNodeEvent(
      device,
      workInputReceipt({
        runId,
        workKey: manifest.workKey,
        manifestDigest: manifest.manifestDigest,
        receiptSeq: 1,
        inboxItemId: item.id as string,
        byteSize: entry?.byteSize as number,
        at: harness.clock.now().toISOString(),
      }),
    )
    expect(
      (
        await database.db
          .select()
          .from(schema.workInboxItems)
          .where(eq(schema.workInboxItems.id, item.id as string))
      )[0],
    ).toMatchObject({ status: 'consumed', deliveryRunId: runId })
    expect(
      (
        await database.db
          .select()
          .from(schema.workInboxDeliveries)
          .where(eq(schema.workInboxDeliveries.runId, runId))
      )[0],
    ).toMatchObject({ status: 'consumed' })
    expect(
      await database.db
        .select()
        .from(schema.workInputConsumptions)
        .where(eq(schema.workInputConsumptions.runId, runId)),
    ).toHaveLength(1)

    // 同 seq 重放：幂等，不新增回执/消费行。
    await harness.orchestrator.ingestNodeEvent(
      device,
      workInputReceipt({
        runId,
        workKey: manifest.workKey,
        manifestDigest: manifest.manifestDigest,
        receiptSeq: 1,
        inboxItemId: item.id as string,
        byteSize: entry?.byteSize as number,
        at: harness.clock.now().toISOString(),
      }),
    )
    // 同 Run 重复读取：不新增第二条消费行。
    await harness.orchestrator.ingestNodeEvent(
      device,
      workInputReceipt({
        runId,
        workKey: manifest.workKey,
        manifestDigest: manifest.manifestDigest,
        receiptSeq: 2,
        inboxItemId: item.id as string,
        byteSize: entry?.byteSize as number,
        at: harness.clock.now().toISOString(),
      }),
    )
    expect(
      await database.db
        .select()
        .from(schema.workInputConsumptions)
        .where(eq(schema.workInputConsumptions.runId, runId)),
    ).toHaveLength(1)
    expect(await database.db.select().from(schema.runWorkInputReceipts)).toHaveLength(2)
    // 重复读取不得把已经消费的交付尝试改写成 duplicate。
    expect(
      (
        await database.db
          .select()
          .from(schema.workInboxDeliveries)
          .where(eq(schema.workInboxDeliveries.runId, runId))
      )[0],
    ).toMatchObject({ status: 'consumed' })
    // 回执到达即确认交付尝试（acked_at），与是否完成读取无关。
    expect(
      (
        await database.db
          .select()
          .from(schema.workInboxDeliveries)
          .where(eq(schema.workInboxDeliveries.runId, runId))
      )[0]?.ackedAt,
    ).not.toBeNull()

    // 已消费条目不再可下载：Node 只能在读取前取一次正文。
    const bundleAfterConsume = await ctx.app.inject({
      method: 'GET',
      url: `/api/v1/node/runs/${runId}/work-input/bundle`,
      headers: { authorization: `Device ${DEVICE_TOKEN}` },
    })
    expect(bundleAfterConsume.statusCode, bundleAfterConsume.body).toBe(409)
    expect(bundleAfterConsume.json().error.code).toBe('CONTEXT_UNAVAILABLE')

    await completeRun(harness, seed, alice.userId, runId)
    const finishedAt = (
      await database.db.select().from(schema.runs).where(eq(schema.runs.id, runId))
    )[0]?.finishedAt?.getTime() as number
    expect(await reconcileWorkInputs(database, new Date(finishedAt + 61_000))).toBe(0)
  })

  it('refuses the bundle when the stored body no longer matches the frozen digest', async () => {
    const messageId = await comment(ctx, alice, taskId, '原始正文。')
    const item = await associate(ctx, alice, workKey, messageId)
    const created = await startRun(ctx, alice, taskId, seed, [item.id as string])
    expect(created.statusCode, created.body).toBe(201)
    const runId = created.json().data.id as string
    // removeWhen：生产提供正文完整性修复/迁移夹具后删除该直写；只用于触发 fail-closed。
    // 篡改文本与原文等长，确保判红来自摘要而不是 byteSize。
    await database.db
      .update(schema.workInboxItems)
      .set({ body: '篡改正文。' })
      .where(eq(schema.workInboxItems.id, item.id as string))
    const bundle = await ctx.app.inject({
      method: 'GET',
      url: `/api/v1/node/runs/${runId}/work-input/bundle`,
      headers: { authorization: `Device ${DEVICE_TOKEN}` },
    })
    expect(bundle.statusCode, bundle.body).toBe(409)
    expect(bundle.json().error.code).toBe('CONTEXT_UNAVAILABLE')
  })

  it('drops a receipt that references items outside the frozen manifest', async () => {
    const messageId = await comment(ctx, alice, taskId, '清单外回执。')
    const item = await associate(ctx, alice, workKey, messageId)
    const created = await startRun(ctx, alice, taskId, seed, [item.id as string])
    expect(created.statusCode, created.body).toBe(201)
    const runId = created.json().data.id as string
    await dispatchAndReady(harness, seed, alice.userId, runId)
    const manifest = await runWorkInputManifest(database, runId)
    const entry = manifest.entries[0]
    await harness.orchestrator.ingestNodeEvent(
      { deviceId: seed.deviceId, ownerUserId: alice.userId },
      workInputReceipt({
        runId,
        workKey: manifest.workKey,
        manifestDigest: manifest.manifestDigest,
        receiptSeq: 1,
        inboxItemId: item.id as string,
        deliveredItemId: randomUUID(),
        byteSize: entry?.byteSize as number,
        at: harness.clock.now().toISOString(),
      }),
    )
    expect(await database.db.select().from(schema.runWorkInputReceipts)).toHaveLength(0)
  })

  it('drops receipts whose manifest identity does not match the run', async () => {
    const messageId = await comment(ctx, alice, taskId, '清单身份不符。')
    const item = await associate(ctx, alice, workKey, messageId)
    const created = await startRun(ctx, alice, taskId, seed, [item.id as string])
    expect(created.statusCode, created.body).toBe(201)
    const runId = created.json().data.id as string
    await dispatchAndReady(harness, seed, alice.userId, runId)
    const manifest = await runWorkInputManifest(database, runId)
    const entry = manifest.entries[0]
    await harness.orchestrator.ingestNodeEvent(
      { deviceId: seed.deviceId, ownerUserId: alice.userId },
      workInputReceipt({
        runId,
        workKey: manifest.workKey,
        manifestDigest: 'b'.repeat(64),
        receiptSeq: 1,
        inboxItemId: item.id as string,
        byteSize: entry?.byteSize as number,
        at: harness.clock.now().toISOString(),
      }),
    )
    expect(await database.db.select().from(schema.runWorkInputReceipts)).toHaveLength(0)
  })

  it('drops a read event that reports an unverified digest even when the envelope claims true', async () => {
    const messageId = await comment(ctx, alice, taskId, '逐条摘要未通过。')
    const item = await associate(ctx, alice, workKey, messageId)
    const created = await startRun(ctx, alice, taskId, seed, [item.id as string])
    expect(created.statusCode, created.body).toBe(201)
    const runId = created.json().data.id as string
    await dispatchAndReady(harness, seed, alice.userId, runId)
    const manifest = await runWorkInputManifest(database, runId)
    const entry = manifest.entries[0]
    await harness.orchestrator.ingestNodeEvent(
      { deviceId: seed.deviceId, ownerUserId: alice.userId },
      workInputReceipt({
        runId,
        workKey: manifest.workKey,
        manifestDigest: manifest.manifestDigest,
        receiptSeq: 1,
        inboxItemId: item.id as string,
        byteSize: entry?.byteSize as number,
        at: harness.clock.now().toISOString(),
        readDigestVerified: false,
      }),
    )
    expect(await database.db.select().from(schema.runWorkInputReceipts)).toHaveLength(0)
    expect(
      await database.db
        .select()
        .from(schema.workInputConsumptions)
        .where(eq(schema.workInputConsumptions.runId, runId)),
    ).toHaveLength(0)
  })

  it('acks the delivery attempt on a delivered-only receipt without consuming', async () => {
    const messageId = await comment(ctx, alice, taskId, '只交付未读取。')
    const item = await associate(ctx, alice, workKey, messageId)
    const created = await startRun(ctx, alice, taskId, seed, [item.id as string])
    expect(created.statusCode, created.body).toBe(201)
    const runId = created.json().data.id as string
    await dispatchAndReady(harness, seed, alice.userId, runId)
    const manifest = await runWorkInputManifest(database, runId)
    const at = harness.clock.now().toISOString()
    await harness.orchestrator.ingestNodeEvent(
      { deviceId: seed.deviceId, ownerUserId: alice.userId },
      {
        protocolVersion: 1,
        messageId: randomUUID(),
        sentAt: at,
        type: 'run.work_input_receipt',
        payload: {
          runId,
          workKey: manifest.workKey,
          manifestDigest: manifest.manifestDigest,
          receiptSeq: 1,
          entriesDelivered: [item.id as string],
          entriesRead: [],
          readEvents: [],
          missing: [],
          digestVerified: true,
          at,
        },
      },
    )
    const [delivery] = await database.db
      .select()
      .from(schema.workInboxDeliveries)
      .where(eq(schema.workInboxDeliveries.runId, runId))
    expect(delivery?.ackedAt).not.toBeNull()
    expect(
      (
        await database.db
          .select()
          .from(schema.workInboxItems)
          .where(eq(schema.workInboxItems.id, item.id as string))
      )[0],
    ).toMatchObject({ status: 'delivered' })
    expect(
      await database.db
        .select()
        .from(schema.workInputConsumptions)
        .where(eq(schema.workInputConsumptions.runId, runId)),
    ).toHaveLength(0)
  })

  it('records an unverified read without consuming, then consumes on the next verified read', async () => {
    const messageId = await comment(ctx, alice, taskId, '摘要校验失败的材料。')
    const item = await associate(ctx, alice, workKey, messageId)
    const created = await startRun(ctx, alice, taskId, seed, [item.id as string])
    expect(created.statusCode, created.body).toBe(201)
    const runId = created.json().data.id as string
    await dispatchAndReady(harness, seed, alice.userId, runId)
    const manifest = await runWorkInputManifest(database, runId)
    const entry = manifest.entries[0]
    const device = { deviceId: seed.deviceId, ownerUserId: alice.userId }
    await harness.orchestrator.ingestNodeEvent(
      device,
      workInputReceipt({
        runId,
        workKey: manifest.workKey,
        manifestDigest: manifest.manifestDigest,
        receiptSeq: 1,
        inboxItemId: item.id as string,
        byteSize: entry?.byteSize as number,
        at: harness.clock.now().toISOString(),
        digestVerified: false,
      }),
    )
    const [receipt] = await database.db
      .select()
      .from(schema.runWorkInputReceipts)
      .where(eq(schema.runWorkInputReceipts.runId, runId))
    expect(receipt?.digestVerified).toBe(false)
    expect(
      (
        await database.db
          .select()
          .from(schema.workInboxItems)
          .where(eq(schema.workInboxItems.id, item.id as string))
      )[0],
    ).toMatchObject({ status: 'delivered' })
    expect(
      await database.db
        .select()
        .from(schema.workInputConsumptions)
        .where(eq(schema.workInputConsumptions.runId, runId)),
    ).toHaveLength(0)

    await harness.orchestrator.ingestNodeEvent(
      device,
      workInputReceipt({
        runId,
        workKey: manifest.workKey,
        manifestDigest: manifest.manifestDigest,
        receiptSeq: 2,
        inboxItemId: item.id as string,
        byteSize: entry?.byteSize as number,
        at: harness.clock.now().toISOString(),
      }),
    )
    expect(
      (
        await database.db
          .select()
          .from(schema.workInboxItems)
          .where(eq(schema.workInboxItems.id, item.id as string))
      )[0],
    ).toMatchObject({ status: 'consumed' })
  })

  it('consumes an unconfirmed item when the terminal read receipt arrives exactly at the 60s window', async () => {
    const messageId = await comment(ctx, alice, taskId, '窗口边界内的终态读取。')
    const item = await associate(ctx, alice, workKey, messageId)
    const created = await startRun(ctx, alice, taskId, seed, [item.id as string])
    expect(created.statusCode, created.body).toBe(201)
    const runId = created.json().data.id as string
    await dispatchAndReady(harness, seed, alice.userId, runId)
    await completeRun(harness, seed, alice.userId, runId)
    const finishedAt = (
      await database.db.select().from(schema.runs).where(eq(schema.runs.id, runId))
    )[0]?.finishedAt?.getTime() as number
    harness.clock.advance(60_000)
    const manifest = await runWorkInputManifest(database, runId)
    const entry = manifest.entries[0]
    await harness.orchestrator.ingestNodeEvent(
      { deviceId: seed.deviceId, ownerUserId: alice.userId },
      workInputReceipt({
        runId,
        workKey: manifest.workKey,
        manifestDigest: manifest.manifestDigest,
        receiptSeq: 1,
        inboxItemId: item.id as string,
        byteSize: entry?.byteSize as number,
        at: harness.clock.now().toISOString(),
      }),
    )
    expect(
      (
        await database.db
          .select()
          .from(schema.workInboxItems)
          .where(eq(schema.workInboxItems.id, item.id as string))
      )[0],
    ).toMatchObject({ status: 'consumed', unconfirmedAt: null, deliveryRunId: runId })
    expect(
      (
        await database.db
          .select()
          .from(schema.workInboxDeliveries)
          .where(eq(schema.workInboxDeliveries.runId, runId))
      )[0],
    ).toMatchObject({ status: 'consumed' })
    expect(
      (await database.db.select().from(schema.runs).where(eq(schema.runs.id, runId)))[0],
    ).toMatchObject({ status: 'completed' })
    expect(await reconcileWorkInputs(database, new Date(finishedAt + 61_000))).toBe(0)
  })

  it('accepts a lower unseen receipt sequence after a newer one was recorded', async () => {
    const messageId = await comment(ctx, alice, taskId, '乱序回执。')
    const item = await associate(ctx, alice, workKey, messageId)
    const created = await startRun(ctx, alice, taskId, seed, [item.id as string])
    expect(created.statusCode, created.body).toBe(201)
    const runId = created.json().data.id as string
    await dispatchAndReady(harness, seed, alice.userId, runId)
    const manifest = await runWorkInputManifest(database, runId)
    const entry = manifest.entries[0]
    const at = harness.clock.now().toISOString()
    await harness.orchestrator.ingestNodeEvent(
      { deviceId: seed.deviceId, ownerUserId: alice.userId },
      workInputReceipt({
        runId,
        workKey: manifest.workKey,
        manifestDigest: manifest.manifestDigest,
        receiptSeq: 2,
        inboxItemId: item.id as string,
        byteSize: entry?.byteSize as number,
        at,
      }),
    )
    await harness.orchestrator.ingestNodeEvent(
      { deviceId: seed.deviceId, ownerUserId: alice.userId },
      {
        protocolVersion: 1,
        messageId: randomUUID(),
        sentAt: at,
        type: 'run.work_input_receipt',
        payload: {
          runId,
          workKey: manifest.workKey,
          manifestDigest: manifest.manifestDigest,
          receiptSeq: 1,
          entriesDelivered: [item.id as string],
          entriesRead: [],
          readEvents: [],
          missing: [],
          digestVerified: true,
          at,
        },
      },
    )
    expect(
      await database.db
        .select()
        .from(schema.runWorkInputReceipts)
        .where(eq(schema.runWorkInputReceipts.runId, runId)),
    ).toHaveLength(2)
    expect(
      await database.db
        .select()
        .from(schema.workInputConsumptions)
        .where(eq(schema.workInputConsumptions.runId, runId)),
    ).toHaveLength(1)
    expect(
      (
        await database.db
          .select()
          .from(schema.workInboxItems)
          .where(eq(schema.workInboxItems.id, item.id as string))
      )[0],
    ).toMatchObject({ status: 'consumed' })
  })

  it('withdraws the next delivery when an old run late-reads it before consumption', async () => {
    const messageId = await comment(ctx, alice, taskId, '迟到回执撤回下一交付。')
    const item = await associate(ctx, alice, workKey, messageId)
    const first = await startRun(ctx, alice, taskId, seed, [item.id as string])
    const firstRunId = first.json().data.id as string
    await dispatchAndReady(harness, seed, alice.userId, firstRunId)
    await completeRun(harness, seed, alice.userId, firstRunId)
    const firstFinished = (
      await database.db.select().from(schema.runs).where(eq(schema.runs.id, firstRunId))
    )[0]?.finishedAt?.getTime() as number
    expect(await reconcileWorkInputs(database, new Date(firstFinished + 61_000))).toBe(1)

    const second = await startRun(ctx, alice, taskId, seed, [item.id as string])
    expect(second.statusCode, second.body).toBe(201)
    const secondRunId = second.json().data.id as string
    await dispatchAndReady(harness, seed, alice.userId, secondRunId)

    const firstManifest = await runWorkInputManifest(database, firstRunId)
    const secondManifest = await runWorkInputManifest(database, secondRunId)
    const firstEntry = firstManifest.entries[0]
    const secondEntry = secondManifest.entries[0]
    await harness.orchestrator.ingestNodeEvent(
      { deviceId: seed.deviceId, ownerUserId: alice.userId },
      workInputReceipt({
        runId: firstRunId,
        workKey: firstManifest.workKey,
        manifestDigest: firstManifest.manifestDigest,
        receiptSeq: 1,
        inboxItemId: item.id as string,
        byteSize: firstEntry?.byteSize as number,
        at: harness.clock.now().toISOString(),
      }),
    )
    expect(
      (
        await database.db
          .select()
          .from(schema.workInboxItems)
          .where(eq(schema.workInboxItems.id, item.id as string))
      )[0],
    ).toMatchObject({
      status: 'superseded',
      statusReason: 'late_receipt_withdrawn',
      deliveryRunId: null,
    })
    const deliveryOf = async (runId: string) =>
      (
        await database.db
          .select()
          .from(schema.workInboxDeliveries)
          .where(eq(schema.workInboxDeliveries.runId, runId))
      )[0]
    expect(await deliveryOf(firstRunId)).toMatchObject({ status: 'returned' })
    expect(await deliveryOf(secondRunId)).toMatchObject({
      status: 'duplicate',
      failureReason: 'late_receipt_previous_run',
    })
    expect(
      (
        await database.db
          .select()
          .from(schema.workInputConsumptions)
          .where(eq(schema.workInputConsumptions.runId, firstRunId))
      )[0],
    ).toMatchObject({ kind: 'duplicate' })

    // 下一 Run 的读取回执晚到：只记 duplicate，不消费、不改写已撤回的交付。
    await harness.orchestrator.ingestNodeEvent(
      { deviceId: seed.deviceId, ownerUserId: alice.userId },
      workInputReceipt({
        runId: secondRunId,
        workKey: secondManifest.workKey,
        manifestDigest: secondManifest.manifestDigest,
        receiptSeq: 1,
        inboxItemId: item.id as string,
        byteSize: secondEntry?.byteSize as number,
        at: harness.clock.now().toISOString(),
      }),
    )
    expect(await deliveryOf(secondRunId)).toMatchObject({ status: 'duplicate' })
    expect(
      (
        await database.db
          .select()
          .from(schema.workInputConsumptions)
          .where(eq(schema.workInputConsumptions.runId, secondRunId))
      )[0],
    ).toMatchObject({ kind: 'duplicate' })

    // 撤回后条目不可再次领取：不存在第三次投递。
    const third = await startRun(ctx, alice, taskId, seed, [item.id as string])
    expect(third.statusCode, third.body).toBe(409)
  })

  it('withdraws an unconfirmed next delivery and keeps reconcile from returning it', async () => {
    const messageId = await comment(ctx, alice, taskId, '迟到回执撤回未确认交付。')
    const item = await associate(ctx, alice, workKey, messageId)
    const first = await startRun(ctx, alice, taskId, seed, [item.id as string])
    const firstRunId = first.json().data.id as string
    await dispatchAndReady(harness, seed, alice.userId, firstRunId)
    await completeRun(harness, seed, alice.userId, firstRunId)
    const firstFinished = (
      await database.db.select().from(schema.runs).where(eq(schema.runs.id, firstRunId))
    )[0]?.finishedAt?.getTime() as number
    expect(await reconcileWorkInputs(database, new Date(firstFinished + 61_000))).toBe(1)

    const second = await startRun(ctx, alice, taskId, seed, [item.id as string])
    const secondRunId = second.json().data.id as string
    await dispatchAndReady(harness, seed, alice.userId, secondRunId)
    await completeRun(harness, seed, alice.userId, secondRunId)
    const secondFinished = (
      await database.db.select().from(schema.runs).where(eq(schema.runs.id, secondRunId))
    )[0]?.finishedAt?.getTime() as number
    const firstManifest = await runWorkInputManifest(database, firstRunId)
    const firstEntry = firstManifest.entries[0]
    await harness.orchestrator.ingestNodeEvent(
      { deviceId: seed.deviceId, ownerUserId: alice.userId },
      workInputReceipt({
        runId: firstRunId,
        workKey: firstManifest.workKey,
        manifestDigest: firstManifest.manifestDigest,
        receiptSeq: 1,
        inboxItemId: item.id as string,
        byteSize: firstEntry?.byteSize as number,
        at: harness.clock.now().toISOString(),
      }),
    )
    expect(
      (
        await database.db
          .select()
          .from(schema.workInboxItems)
          .where(eq(schema.workInboxItems.id, item.id as string))
      )[0],
    ).toMatchObject({ status: 'superseded', statusReason: 'late_receipt_withdrawn' })
    expect(
      (
        await database.db
          .select()
          .from(schema.workInboxDeliveries)
          .where(eq(schema.workInboxDeliveries.runId, secondRunId))
      )[0],
    ).toMatchObject({ status: 'duplicate', failureReason: 'late_receipt_previous_run' })
    expect(await reconcileWorkInputs(database, new Date(secondFinished + 61_000))).toBe(0)
    const third = await startRun(ctx, alice, taskId, seed, [item.id as string])
    expect(third.statusCode, third.body).toBe(409)
  })

  it('drops a receipt from a device that does not own the run', async () => {
    const messageId = await comment(ctx, alice, taskId, '跨设备回执。')
    const item = await associate(ctx, alice, workKey, messageId)
    const created = await startRun(ctx, alice, taskId, seed, [item.id as string])
    const runId = created.json().data.id as string
    await dispatchAndReady(harness, seed, alice.userId, runId)
    const manifest = await runWorkInputManifest(database, runId)
    const entry = manifest.entries[0]
    const foreignDeviceId = randomUUID()
    // removeWhen：生产提供多设备配对夹具后删除该直写；只用于跨设备回执判据。
    await database.db.insert(schema.devices).values({
      id: foreignDeviceId,
      ownerUserId: alice.userId,
      name: 'foreign-device',
      platform: 'darwin',
      architecture: 'arm64',
      nodeVersion: '24.12.0',
      nodeAppVersion: '0.1.0',
      tokenHash: Buffer.from(hashToken(`foreign-${randomUUID()}`)),
      capabilities: {},
      dshDistributionVersion: '0.1.0-rc.8',
      lastSeenAt: new Date(),
    })
    await expect(
      harness.orchestrator.ingestNodeEvent(
        { deviceId: foreignDeviceId, ownerUserId: alice.userId },
        workInputReceipt({
          runId,
          workKey: manifest.workKey,
          manifestDigest: manifest.manifestDigest,
          receiptSeq: 1,
          inboxItemId: item.id as string,
          byteSize: entry?.byteSize as number,
          at: harness.clock.now().toISOString(),
        }),
      ),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' })
    expect(await database.db.select().from(schema.runWorkInputReceipts)).toHaveLength(0)
  })

  it('refuses the bundle after the source is retracted', async () => {
    const messageId = await comment(ctx, alice, taskId, '撤权后的正文。')
    const item = await associate(ctx, alice, workKey, messageId)
    const created = await startRun(ctx, alice, taskId, seed, [item.id as string])
    const runId = created.json().data.id as string
    const retracted = await apiInject(ctx, alice, {
      method: 'POST',
      url: `/api/v1/works/${workKey}/inbox-items/${item.id as string}/retract`,
      payload: { reason: 'source_permission_revoked' },
      idempotencyKey: idemKey(),
    })
    expect(retracted.statusCode, retracted.body).toBe(200)
    const bundle = await ctx.app.inject({
      method: 'GET',
      url: `/api/v1/node/runs/${runId}/work-input/bundle`,
      headers: { authorization: `Device ${DEVICE_TOKEN}` },
    })
    expect(bundle.statusCode, bundle.body).toBe(409)
    expect(bundle.json().error.code).toBe('CONTEXT_UNAVAILABLE')
  })

  it('refuses the bundle when stored entry metadata drifted from the frozen manifest', async () => {
    const messageId = await comment(ctx, alice, taskId, '元数据漂移。')
    const item = await associate(ctx, alice, workKey, messageId)
    const created = await startRun(ctx, alice, taskId, seed, [item.id as string])
    const runId = created.json().data.id as string
    // removeWhen：生产提供元数据修复夹具后删除该直写；只用于触发 fail-closed。
    await database.db
      .update(schema.workInboxItems)
      .set({ title: '被改写的标题' })
      .where(eq(schema.workInboxItems.id, item.id as string))
    const bundle = await ctx.app.inject({
      method: 'GET',
      url: `/api/v1/node/runs/${runId}/work-input/bundle`,
      headers: { authorization: `Device ${DEVICE_TOKEN}` },
    })
    expect(bundle.statusCode, bundle.body).toBe(409)
    expect(bundle.json().error.code).toBe('CONTEXT_UNAVAILABLE')
  })

  it('fails the run before dispatch when the underlying message revision drifted', async () => {
    const messageId = await comment(ctx, alice, taskId, '派发前来源修订。')
    const item = await associate(ctx, alice, workKey, messageId)
    const created = await startRun(ctx, alice, taskId, seed, [item.id as string])
    const runId = created.json().data.id as string
    // removeWhen：生产提供来源修订竞争夹具后删除该直写；item 快照本身未变，
    // 因此只会命中 dispatch 前 loadWorkSource 的版本/摘要复核。
    await database.db
      .update(schema.taskMessages)
      .set({ body: '编辑后的讨论正文。', editedAt: new Date() })
      .where(eq(schema.taskMessages.id, messageId))
    harness.clock.advance(Math.max(0, Date.now() - harness.clock.now().getTime()) + 1)
    await harness.worker.dispatchOnce()
    const run = (await database.db.select().from(schema.runs).where(eq(schema.runs.id, runId)))[0]
    expect(run).toMatchObject({ status: 'failed', failureCode: 'CONTEXT_UNAVAILABLE' })
    expect(String(run?.failureSummary)).toContain('source_stale')
    expect(harness.gateway.sent.filter((sent) => sent.frame.type === 'run.start')).toHaveLength(0)
  })

  it('fails the run before dispatch when the frozen source version drifted', async () => {
    const messageId = await comment(ctx, alice, taskId, '派发前版本漂移。')
    const item = await associate(ctx, alice, workKey, messageId)
    const created = await startRun(ctx, alice, taskId, seed, [item.id as string])
    const runId = created.json().data.id as string
    // removeWhen：生产提供来源版本竞争夹具后删除该直写；只用于触发 fail-closed。
    await database.db
      .update(schema.workInboxItems)
      .set({ sourceVersion: 'stale-version' })
      .where(eq(schema.workInboxItems.id, item.id as string))
    harness.clock.advance(Math.max(0, Date.now() - harness.clock.now().getTime()) + 1)
    await harness.worker.dispatchOnce()
    expect(
      (await database.db.select().from(schema.runs).where(eq(schema.runs.id, runId)))[0],
    ).toMatchObject({ status: 'failed', failureCode: 'CONTEXT_UNAVAILABLE' })
    expect(harness.gateway.sent.filter((sent) => sent.frame.type === 'run.start')).toHaveLength(0)
  })

  it('consumes only the read item when a run delivers two work inputs', async () => {
    const firstMessage = await comment(ctx, alice, taskId, '部分读取 A。')
    const secondMessage = await comment(ctx, alice, taskId, '部分读取 B。')
    const firstItem = await associate(ctx, alice, workKey, firstMessage)
    const secondItem = await associate(ctx, alice, workKey, secondMessage)
    const created = await startRun(ctx, alice, taskId, seed, [
      firstItem.id as string,
      secondItem.id as string,
    ])
    expect(created.statusCode, created.body).toBe(201)
    const runId = created.json().data.id as string
    await dispatchAndReady(harness, seed, alice.userId, runId)
    const manifest = await runWorkInputManifest(database, runId)
    const firstEntry = manifest.entries.find((row) => row.inboxItemId === firstItem.id)
    const at = harness.clock.now().toISOString()
    await harness.orchestrator.ingestNodeEvent(
      { deviceId: seed.deviceId, ownerUserId: alice.userId },
      {
        protocolVersion: 1,
        messageId: randomUUID(),
        sentAt: at,
        type: 'run.work_input_receipt',
        payload: {
          runId,
          workKey: manifest.workKey,
          manifestDigest: manifest.manifestDigest,
          receiptSeq: 1,
          entriesDelivered: [firstItem.id as string, secondItem.id as string],
          entriesRead: [firstItem.id as string],
          readEvents: [
            {
              inboxItemId: firstItem.id as string,
              digestVerified: true,
              byteSize: firstEntry?.byteSize as number,
              at,
            },
          ],
          missing: [],
          digestVerified: true,
          at,
        },
      },
    )
    const items = await database.db.select().from(schema.workInboxItems)
    expect(items.find((row) => row.id === firstItem.id)?.status).toBe('consumed')
    expect(items.find((row) => row.id === secondItem.id)?.status).toBe('delivered')
    expect(
      await database.db
        .select()
        .from(schema.workInputConsumptions)
        .where(eq(schema.workInputConsumptions.runId, runId)),
    ).toHaveLength(1)

    await completeRun(harness, seed, alice.userId, runId)
    const finishedAt = (
      await database.db.select().from(schema.runs).where(eq(schema.runs.id, runId))
    )[0]?.finishedAt?.getTime() as number
    expect(await reconcileWorkInputs(database, new Date(finishedAt + 61_000))).toBe(1)
    const after = await database.db.select().from(schema.workInboxItems)
    expect(after.find((row) => row.id === firstItem.id)?.status).toBe('consumed')
    expect(after.find((row) => row.id === secondItem.id)?.status).toBe('pending')
  })

  it('records a late read after the 60s window as duplicate without consuming', async () => {
    const messageId = await comment(ctx, alice, taskId, '迟到读取的材料。')
    const item = await associate(ctx, alice, workKey, messageId)
    const created = await startRun(ctx, alice, taskId, seed, [item.id as string])
    expect(created.statusCode, created.body).toBe(201)
    const runId = created.json().data.id as string
    await dispatchAndReady(harness, seed, alice.userId, runId)
    await completeRun(harness, seed, alice.userId, runId)
    const finishedAt = (
      await database.db.select().from(schema.runs).where(eq(schema.runs.id, runId))
    )[0]?.finishedAt?.getTime() as number
    const manifest = await runWorkInputManifest(database, runId)
    const entry = manifest.entries.find((row) => row.inboxItemId === item.id)
    harness.clock.advance(61_000)

    await harness.orchestrator.ingestNodeEvent(
      { deviceId: seed.deviceId, ownerUserId: alice.userId },
      workInputReceipt({
        runId,
        workKey: manifest.workKey,
        manifestDigest: manifest.manifestDigest,
        receiptSeq: 1,
        inboxItemId: item.id as string,
        byteSize: entry?.byteSize as number,
        at: harness.clock.now().toISOString(),
      }),
    )
    expect(
      (
        await database.db
          .select()
          .from(schema.workInboxItems)
          .where(eq(schema.workInboxItems.id, item.id as string))
      )[0],
    ).toMatchObject({ status: 'unconfirmed' })
    expect(
      (
        await database.db
          .select()
          .from(schema.workInputConsumptions)
          .where(eq(schema.workInputConsumptions.runId, runId))
      )[0],
    ).toMatchObject({ kind: 'duplicate' })
    expect(
      (
        await database.db
          .select()
          .from(schema.workInboxDeliveries)
          .where(eq(schema.workInboxDeliveries.runId, runId))
      )[0],
    ).toMatchObject({ status: 'duplicate', failureReason: 'receipt_after_window' })
    expect(await reconcileWorkInputs(database, new Date(finishedAt + 61_000))).toBe(1)
  })

  it('records duplicate_consumption when an old run receipt arrives after a later run consumed', async () => {
    const messageId = await comment(ctx, alice, taskId, '跨 Run 重复消费的材料。')
    const item = await associate(ctx, alice, workKey, messageId)
    const first = await startRun(ctx, alice, taskId, seed, [item.id as string])
    expect(first.statusCode, first.body).toBe(201)
    const firstRunId = first.json().data.id as string
    await dispatchAndReady(harness, seed, alice.userId, firstRunId)
    await completeRun(harness, seed, alice.userId, firstRunId)
    const firstFinished = (
      await database.db.select().from(schema.runs).where(eq(schema.runs.id, firstRunId))
    )[0]?.finishedAt?.getTime() as number
    expect(await reconcileWorkInputs(database, new Date(firstFinished + 61_000))).toBe(1)

    const second = await startRun(ctx, alice, taskId, seed, [item.id as string])
    expect(second.statusCode, second.body).toBe(201)
    const secondRunId = second.json().data.id as string
    await dispatchAndReady(harness, seed, alice.userId, secondRunId)
    const firstManifest = await runWorkInputManifest(database, firstRunId)
    const secondManifest = await runWorkInputManifest(database, secondRunId)
    const secondEntry = secondManifest.entries.find((row) => row.inboxItemId === item.id)
    await harness.orchestrator.ingestNodeEvent(
      { deviceId: seed.deviceId, ownerUserId: alice.userId },
      workInputReceipt({
        runId: secondRunId,
        workKey: secondManifest.workKey,
        manifestDigest: secondManifest.manifestDigest,
        receiptSeq: 1,
        inboxItemId: item.id as string,
        byteSize: secondEntry?.byteSize as number,
        at: harness.clock.now().toISOString(),
      }),
    )

    // 旧 Run 的迟到回执：条目已被后续 Run 消费 → duplicate_consumption。
    const firstEntry = firstManifest.entries.find((row) => row.inboxItemId === item.id)
    await harness.orchestrator.ingestNodeEvent(
      { deviceId: seed.deviceId, ownerUserId: alice.userId },
      workInputReceipt({
        runId: firstRunId,
        workKey: firstManifest.workKey,
        manifestDigest: firstManifest.manifestDigest,
        receiptSeq: 1,
        inboxItemId: item.id as string,
        byteSize: firstEntry?.byteSize as number,
        at: harness.clock.now().toISOString(),
      }),
    )
    expect(
      (
        await database.db
          .select()
          .from(schema.workInputConsumptions)
          .where(eq(schema.workInputConsumptions.runId, firstRunId))
      )[0],
    ).toMatchObject({ kind: 'duplicate_consumption' })
    // 迟到回执只追加对账记录：旧 Run 的 returned 与下一 Run 的 consumed
    // 都是已发生的事实，不能被迟到回执改写。
    expect(
      (
        await database.db
          .select()
          .from(schema.workInboxDeliveries)
          .where(eq(schema.workInboxDeliveries.runId, firstRunId))
      )[0]?.status,
    ).toBe('returned')
    expect(
      (
        await database.db
          .select()
          .from(schema.workInboxDeliveries)
          .where(eq(schema.workInboxDeliveries.runId, secondRunId))
      )[0]?.status,
    ).toBe('consumed')
  })

  it('rejects work inputs when the target node lacks work-input.v1', async () => {
    const messageId = await comment(ctx, alice, taskId, '能力门材料。')
    const item = await associate(ctx, alice, workKey, messageId)
    const runsBefore = await database.db.select().from(schema.runs)
    const outboxBefore = await database.db.select().from(schema.dispatchOutbox)
    // removeWhen：能力协商提供设备能力更新夹具后删除该直写。
    await database.db
      .update(schema.devices)
      .set({ capabilities: { contextCapabilities: ['project-context.v1'] } })
      .where(eq(schema.devices.id, seed.deviceId))
    const denied = await startRun(ctx, alice, taskId, seed, [item.id as string])
    expect(denied.statusCode, denied.body).toBe(409)
    expect(denied.json().error.code).toBe('CONTEXT_UNAVAILABLE')
    // 能力门在 Run/outbox 写入之前拒绝：不留下半建 Run 或待投命令。
    expect(await database.db.select().from(schema.runs)).toHaveLength(runsBefore.length)
    expect(await database.db.select().from(schema.dispatchOutbox)).toHaveLength(outboxBefore.length)
  })

  it('fails the run before dispatch when the input source is retracted', async () => {
    const messageId = await comment(ctx, alice, taskId, '派发前撤权的材料。')
    const item = await associate(ctx, alice, workKey, messageId)
    const created = await startRun(ctx, alice, taskId, seed, [item.id as string])
    expect(created.statusCode, created.body).toBe(201)
    const runId = created.json().data.id as string

    const retracted = await apiInject(ctx, alice, {
      method: 'POST',
      url: `/api/v1/works/${workKey}/inbox-items/${item.id as string}/retract`,
      payload: { reason: 'source_permission_revoked' },
      idempotencyKey: idemKey(),
    })
    expect(retracted.statusCode, retracted.body).toBe(200)
    harness.clock.advance(Math.max(0, Date.now() - harness.clock.now().getTime()) + 1)
    await harness.worker.dispatchOnce()

    const run = (await database.db.select().from(schema.runs).where(eq(schema.runs.id, runId)))[0]
    expect(run).toMatchObject({
      status: 'failed',
      failureCode: 'CONTEXT_UNAVAILABLE',
    })
    expect(harness.gateway.sent.filter((sent) => sent.frame.type === 'run.start')).toHaveLength(0)
  })
})
