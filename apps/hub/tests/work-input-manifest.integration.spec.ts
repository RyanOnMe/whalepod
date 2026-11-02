/**
 * ADR-0028（RD-02a-2a）：Run 工作输入清单冻结与交付/对账状态。
 *
 * 驱动走生产 HTTP（建工作、关联收件箱条目、带 workInputItemIds 建 Run）与真实
 * PostgreSQL；Node/Runtime 消费回执不在本切片（#493）。
 */
import { randomUUID } from 'node:crypto'
import { eq } from 'drizzle-orm'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { Database } from '@whalepod/db'
import { getTeam, schema } from '@whalepod/db'
import { hashToken } from '../src/modules/auth/token.js'
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
    capabilities: { contextCapabilities: ['project-context.v1'] },
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
  messageId: string,
): Promise<Record<string, unknown>> {
  const res = await apiInject(ctx, session, {
    method: 'POST',
    url: `/api/v1/works/${workKey}/inbox-items`,
    payload: { sourceType: 'task_message', sourceId: messageId },
    idempotencyKey: idemKey(),
  })
  expect(res.statusCode, res.body).toBe(201)
  return res.json().data as Record<string, unknown>
}

async function startRun(
  ctx: TestApp,
  session: Session,
  taskId: string,
  seed: Seed,
  itemIds: string[],
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
      workInputItemIds: itemIds,
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
      workInputManifestDigest: expect.stringMatching(/^[a-f0-9]{64}$/),
    })
    expect(run.workInputManifest.version).toBe('rd02a2.v1')
    expect(run.workInputManifest.workKey).toBe(workKey)
    expect(run.workInputManifest.entries).toHaveLength(2)
    expect(
      run.workInputManifest.entries.map((entry: { inboxItemId: string }) => entry.inboxItemId),
    ).toEqual([first.id, second.id].sort())
    expect(run.workInputManifest.entries[0]).not.toHaveProperty('body')
    expect(run.workInputManifest.entries[0]).toMatchObject({
      sourceType: 'task_message',
      byteSize: expect.any(Number),
      bodyDigest: expect.stringMatching(/^[a-f0-9]{64}$/),
    })

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

  it('rejects duplicate ids, retired work and tampered/foreign-work inputs', async () => {
    const messageId = await comment(ctx, alice, taskId, '边界材料。')
    const item = await associate(ctx, alice, workKey, messageId)

    const duplicate = await startRun(ctx, alice, taskId, seed, [
      item.id as string,
      item.id as string,
    ])
    expect(duplicate.statusCode, duplicate.body).toBe(400)
    expect(duplicate.json().error.code).toBe('VALIDATION_FAILED')

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

    expect(await reconcileWorkInputs(database, new Date(finishedAt + 59_000))).toBe(0)
    expect(await reconcileWorkInputs(database, new Date(finishedAt + 61_000))).toBe(1)
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
})
