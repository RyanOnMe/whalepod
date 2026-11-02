/**
 * ADR-0027（PC-05a）：新 Run 项目上下文快照的正向链与负控。
 *
 * 驱动走生产路径：任务约定确认 → 前序 Run 执行/成果发布/终态 Observation →
 * 协调评估产生 Inference → 新 Run 创建事务冻结快照 → outbox 派发 → Node 归属
 * 下载 → 两级回执。负控覆盖 Inference 选入、旧 Node 未声明能力、派发前条目变化、
 * 回执谓词与重复 receiptSeq。
 */
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { and, eq, sql } from 'drizzle-orm'
import type { Database } from '@whalepod/db'
import { getTeam, schema } from '@whalepod/db'
import { hashToken } from '../src/modules/auth/token.js'
import { projectContextNonce } from '../src/modules/context/run-snapshot.js'
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

const AGREEMENT = {
  goal: '把预算从 12 万改为 8 万',
  constraints: '不新增审批步骤',
  acceptance: '新预算出现在下一次场地比较',
  openQuestions: '待确认：最终供应商与预算上限',
}

const DEVICE_TOKEN = `context-device-${randomUUID()}`

interface Seed {
  agentId: string
  revisionId: string
  deviceId: string
  workspaceId: string
}

async function seedRunDependencies(
  database: Database,
  ownerUserId: string,
  capabilities: Record<string, unknown> = { contextCapabilities: ['project-context.v1'] },
): Promise<Seed> {
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
    name: `ctx-pack-${suffix}`,
    installations: [],
    packDigest: 'a'.repeat(64),
    createdBy: ownerUserId,
  })
  await database.db.insert(schema.agents).values({
    id: agentId,
    name: `ctx-agent-${suffix}`,
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
    name: `ctx-dev-${suffix}`,
    platform: 'darwin',
    architecture: 'arm64',
    nodeVersion: '24.12.0',
    nodeAppVersion: '0.1.0',
    tokenHash: Buffer.from(hashToken(DEVICE_TOKEN)),
    capabilities,
    dshDistributionVersion: '0.1.0-rc.8',
    lastSeenAt: new Date(),
  })
  await database.db.insert(schema.workspaces).values({
    id: workspaceId,
    deviceId,
    ownerUserId,
    name: `ctx-ws-${suffix}`,
    kind: 'directory',
    capabilities: { read: true, write: true },
    available: true,
  })
  return { agentId, revisionId, deviceId, workspaceId }
}

async function seedForeignDevice(database: Database, ownerUserId: string): Promise<string> {
  const token = `foreign-device-${randomUUID()}`
  await database.db.insert(schema.devices).values({
    id: randomUUID(),
    ownerUserId,
    name: `foreign-${randomUUID().slice(0, 8)}`,
    platform: 'darwin',
    architecture: 'arm64',
    nodeVersion: '24.12.0',
    nodeAppVersion: '0.1.0',
    tokenHash: Buffer.from(hashToken(token)),
    capabilities: { contextCapabilities: ['project-context.v1'] },
    lastSeenAt: new Date(),
  })
  return token
}

async function createProject(ctx: TestApp, session: Session, name: string): Promise<string> {
  const res = await apiInject(ctx, session, {
    method: 'POST',
    url: '/api/v1/projects',
    payload: { name },
  })
  expect(res.statusCode, res.body).toBe(201)
  return res.json().data.id as string
}

async function createTask(
  ctx: TestApp,
  session: Session,
  projectId: string,
  title: string,
): Promise<string> {
  const res = await apiInject(ctx, session, {
    method: 'POST',
    url: `/api/v1/projects/${projectId}/tasks`,
    payload: { title, assigneeUserId: session.userId },
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

async function confirmAgreement(
  ctx: TestApp,
  session: Session,
  taskId: string,
  content = AGREEMENT,
): Promise<{ revisionId: string; revisionNumber: number }> {
  const draft = await apiInject(ctx, session, {
    method: 'POST',
    url: `/api/v1/tasks/${taskId}/agreement/draft`,
    payload: { content },
    idempotencyKey: idemKey(),
  })
  expect(draft.statusCode, draft.body).toBe(200)
  const confirmed = await apiInject(ctx, session, {
    method: 'POST',
    url: `/api/v1/tasks/${taskId}/agreement/confirm`,
    payload: { draftVersion: draft.json().data.draftVersion as number },
    idempotencyKey: idemKey(),
  })
  expect(confirmed.statusCode, confirmed.body).toBe(200)
  return {
    revisionId: confirmed.json().data.id as string,
    revisionNumber: confirmed.json().data.revisionNumber as number,
  }
}

async function startRun(
  ctx: TestApp,
  session: Session,
  taskId: string,
  seed: Seed,
  prompt = '执行任务',
  key = idemKey(),
): Promise<{ statusCode: number; body: string; json: () => any }> {
  return apiInject(ctx, session, {
    method: 'POST',
    url: `/api/v1/tasks/${taskId}/runs`,
    payload: {
      agentId: seed.agentId,
      deviceId: seed.deviceId,
      workspaceId: seed.workspaceId,
      prompt,
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
    runEventFrame(runId, 1, { type: 'runtime.ready', dshSessionId: `ctx-${runId}` }),
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

/**
 * 直接把 Run 停在终态（queued → cancelled），不经过派发。终态会投影
 * `run:<id>` Observation，这是本套测试里唯一不依赖网关就能批量造候选条目的路径。
 */
async function cancelQueuedRun(
  ctx: TestApp,
  session: Session,
  taskId: string,
  seed: Seed,
): Promise<string> {
  const created = await startRun(ctx, session, taskId, seed, '容量候选')
  expect(created.statusCode, created.body).toBe(201)
  const runId = created.json().data.id as string
  const cancelled = await apiInject(ctx, session, {
    method: 'POST',
    url: `/api/v1/runs/${runId}/cancel`,
  })
  expect(cancelled.statusCode, cancelled.body).toBe(200)
  return runId
}

async function uploadAndPublish(
  ctx: TestApp,
  session: Session,
  runId: string,
  title: string,
): Promise<{ artifactId: string; body: string }> {
  const bytes = Buffer.from(`# ${title}\n内容：场地比较结论\n`)
  const query = new URLSearchParams({
    title,
    mediaType: 'text/markdown',
    byteSize: String(bytes.length),
    sha256: createHash('sha256').update(bytes).digest('hex'),
    sourceRelativePath: 'report.md',
  })
  const uploaded = await ctx.app.inject({
    method: 'POST',
    url: `/api/v1/node/runs/${runId}/artifacts?${query}`,
    headers: {
      authorization: `Device ${DEVICE_TOKEN}`,
      'content-type': 'application/octet-stream',
      'idempotency-key': idemKey(),
    },
    payload: bytes,
  })
  expect(uploaded.statusCode, uploaded.body).toBe(201)
  const artifactId = uploaded.json().data.id as string
  const published = await apiInject(ctx, session, {
    method: 'POST',
    url: `/api/v1/artifacts/${artifactId}/publish`,
  })
  expect(published.statusCode, published.body).toBe(200)
  return { artifactId, body: bytes.toString('utf8') }
}

function receiptFrame(payload: Record<string, unknown>): unknown {
  return {
    protocolVersion: 1,
    messageId: randomUUID(),
    sentAt: new Date().toISOString(),
    type: 'run.context_receipt',
    payload,
  }
}

describe('PC-05a run project context snapshot', () => {
  let database: Database
  let ctx: TestApp
  let alice: Session
  let bob: Session
  let projectId: string
  let seed: Seed
  let harness: Harness
  let notes: { action: string; fields: Record<string, unknown> }[]

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
    projectId = await createProject(ctx, alice, `pc05a-${Date.now()}-${randomUUID().slice(0, 6)}`)
    seed = await seedRunDependencies(database, alice.userId)
    notes = []
    harness = makeHarness(
      database,
      {},
      {
        contextLog: (action, fields) => notes.push({ action, fields }),
      },
    )
    // harness 的假时钟默认停在 2026-08-25；设备租约/outbox 都按真实墙钟写入，
    // 先对齐到当前时刻，避免「派发成功但 ack 把 lastSeenAt 写回过去」。
    harness.clock.advance(Date.now() - harness.clock.now().getTime())
  })
  afterEach(async () => {
    await harness.gateway.drainUpstream()
    await ctx.app.close()
  })
  afterAll(async () => {
    await database.close()
  })

  it('freezes current decisions and task observations, excludes Inference, and serves the same snapshot on replay', async () => {
    const taskId = await createTask(ctx, alice, projectId, '活动预算与场地')
    await confirmAgreement(ctx, alice, taskId)
    const producer = await startRun(ctx, alice, taskId, seed, '发布成果', idemKey())
    expect(producer.statusCode, producer.body).toBe(201)
    const producerRunId = producer.json().data.id as string
    await dispatchAndReady(harness, seed, alice.userId, producerRunId)
    const artifact = await uploadAndPublish(ctx, alice, producerRunId, '场地比较')
    await completeRun(harness, seed, alice.userId, producerRunId)
    const evaluation = await apiInject(ctx, alice, {
      method: 'POST',
      url: `/api/v1/projects/${projectId}/coordination/evaluate`,
      payload: {},
      idempotencyKey: idemKey(),
    })
    expect(evaluation.json().data.inferenceEntryId).not.toBeNull()

    const key = idemKey()
    const first = await startRun(ctx, alice, taskId, seed, '使用项目上下文', key)
    expect(first.statusCode, first.body).toBe(201)
    const runId = first.json().data.id as string
    const replay = await startRun(ctx, alice, taskId, seed, '使用项目上下文', key)
    expect(replay.statusCode, replay.body).toBe(201)
    expect(replay.json().data.id).toBe(runId)
    const snapshots = await database.db
      .select()
      .from(schema.runProjectContexts)
      .where(eq(schema.runProjectContexts.runId, runId))
    expect(snapshots).toHaveLength(1)
    const snapshot = snapshots[0]!
    const entries = await database.db
      .select()
      .from(schema.runProjectContextEntries)
      .where(eq(schema.runProjectContextEntries.snapshotId, snapshot.id))
    expect(entries).toHaveLength(3)
    expect(entries.map((entry) => entry.kind).sort()).toEqual([
      'decision',
      'decision',
      'observation',
    ])
    expect(entries.some((entry) => entry.businessRef === `artifact:${artifact.artifactId}`)).toBe(
      true,
    )
    expect(entries.some((entry) => entry.businessRef === `run:${producerRunId}`)).toBe(true)
    expect(entries.some((entry) => entry.businessRef === `taskSpec:${taskId}`)).toBe(true)
    expect(entries.every((entry) => entry.citation === 'business')).toBe(true)
    expect(entries.every((entry) => entry.snapshotId === snapshot.id)).toBe(true)
    expect(
      entries.every(
        (entry) =>
          entry.digest === createHash('sha256').update(entry.body).digest('hex') &&
          entry.byteSize === Buffer.byteLength(entry.body, 'utf8'),
      ),
    ).toBe(true)
    expect(snapshot.entryCount).toBe(3)
    expect(snapshot.totalBytes).toBe(entries.reduce((sum, entry) => sum + entry.byteSize, 0))
    expect(createHash('sha256').update(snapshot.headerText).digest('hex')).toBe(
      snapshot.headerDigest,
    )
    const nonce = projectContextNonce(snapshot.snapshotDigest, runId)
    expect(snapshot.headerText).toContain(`[project-context:${nonce}]`)
    for (const entry of entries) expect(snapshot.headerText).toContain(entry.entryId)

    // run.start 清单与快照同源；正文不在 wire 上。
    const [command] = await database.db
      .select()
      .from(schema.dispatchOutbox)
      .where(
        and(
          eq(schema.dispatchOutbox.type, 'run.start'),
          sql`${schema.dispatchOutbox.payload}->>'runId' = ${runId}`,
        ),
      )
    const projectContext = (command?.payload as { projectContext?: any } | undefined)
      ?.projectContext
    expect(projectContext.snapshotId).toBe(snapshot.id)
    expect(projectContext.digest).toBe(snapshot.snapshotDigest)
    expect(projectContext.headerDigest).toBe(snapshot.headerDigest)
    expect(projectContext.manifest.map((entry: any) => entry.entryId).sort()).toEqual(
      entries.map((entry) => entry.entryId).sort(),
    )
    const startJson = JSON.stringify(projectContext)
    for (const entry of entries) expect(startJson).not.toContain(entry.body)

    // Node 受控下载：正文与 digest 一致；其他设备不可枚举。
    const bundle = await ctx.app.inject({
      method: 'GET',
      url: `/api/v1/node/runs/${runId}/project-context/bundle`,
      headers: { authorization: `Device ${DEVICE_TOKEN}` },
    })
    expect(bundle.statusCode, bundle.body).toBe(200)
    const bundleData = bundle.json().data
    expect(bundleData.snapshotId).toBe(snapshot.id)
    expect(bundleData.entries).toHaveLength(3)
    for (const entry of bundleData.entries) {
      const stored = entries.find((item) => item.entryId === entry.entryId)!
      expect(Buffer.from(entry.bodyBase64, 'base64').toString('utf8')).toBe(stored.body)
      expect(entry.digest).toBe(stored.digest)
    }
    const foreignToken = await seedForeignDevice(database, bob.userId)
    const foreign = await ctx.app.inject({
      method: 'GET',
      url: `/api/v1/node/runs/${runId}/project-context/bundle`,
      headers: { authorization: `Device ${foreignToken}` },
    })
    expect(foreign.statusCode).toBe(404)

    // 成员读面返回冻结正文。
    const member = await apiInject(ctx, bob, {
      method: 'GET',
      url: `/api/v1/runs/${runId}/project-context`,
    })
    expect(member.statusCode, member.body).toBe(200)
    expect(member.json().data.entries).toHaveLength(3)
    expect(member.json().data.entries.every((entry: any) => typeof entry.body === 'string')).toBe(
      true,
    )
    expect(JSON.stringify(member.json().data)).not.toContain('storageKey')
  })

  it('keeps an old snapshot stable when a new agreement revision lands, and gives a new Run a new snapshot', async () => {
    const taskId = await createTask(ctx, alice, projectId, '预算版本')
    const firstAgreement = await confirmAgreement(ctx, alice, taskId)
    const first = await startRun(ctx, alice, taskId, seed, '第一轮')
    expect(first.statusCode, first.body).toBe(201)
    const firstRunId = first.json().data.id as string
    await dispatchAndReady(harness, seed, alice.userId, firstRunId)
    const [firstSnapshot] = await database.db
      .select()
      .from(schema.runProjectContexts)
      .where(eq(schema.runProjectContexts.runId, firstRunId))
    const [firstEntry] = await database.db
      .select()
      .from(schema.runProjectContextEntries)
      .where(eq(schema.runProjectContextEntries.snapshotId, firstSnapshot!.id))
    expect(firstEntry?.businessRef).toBe(`taskSpec:${taskId}`)

    const secondAgreement = await confirmAgreement(ctx, alice, taskId, {
      ...AGREEMENT,
      goal: '预算最终定为 6 万',
    })
    const [afterUpdate] = await database.db
      .select()
      .from(schema.runProjectContexts)
      .where(eq(schema.runProjectContexts.runId, firstRunId))
    expect(afterUpdate).toEqual(firstSnapshot)
    const [frozenEntry] = await database.db
      .select()
      .from(schema.runProjectContextEntries)
      .where(eq(schema.runProjectContextEntries.snapshotId, firstSnapshot!.id))
    expect(frozenEntry).toEqual(firstEntry)

    await completeRun(harness, seed, alice.userId, firstRunId)
    const second = await startRun(ctx, alice, taskId, seed, '第二轮')
    expect(second.statusCode, second.body).toBe(201)
    const secondRunId = second.json().data.id as string
    const [secondSnapshot] = await database.db
      .select()
      .from(schema.runProjectContexts)
      .where(eq(schema.runProjectContexts.runId, secondRunId))
    expect(secondSnapshot?.id).not.toBe(firstSnapshot?.id)
    const [secondEntry] = await database.db
      .select()
      .from(schema.runProjectContextEntries)
      .where(
        and(
          eq(schema.runProjectContextEntries.snapshotId, secondSnapshot!.id),
          eq(schema.runProjectContextEntries.kind, 'decision'),
          eq(schema.runProjectContextEntries.businessRef, `taskSpec:${taskId}`),
        ),
      )
    expect(secondEntry?.entryVersion).toBe(
      `${secondAgreement.revisionId}:${secondAgreement.revisionNumber}`,
    )
    expect(secondEntry?.entryVersion).not.toBe(
      `${firstAgreement.revisionId}:${firstAgreement.revisionNumber}`,
    )
  })

  it('blocks a non-empty snapshot for a Node that does not declare project-context.v1', async () => {
    const taskId = await createTask(ctx, alice, projectId, '旧 Node')
    await confirmAgreement(ctx, alice, taskId)
    await database.db
      .update(schema.devices)
      .set({ capabilities: {} })
      .where(eq(schema.devices.id, seed.deviceId))
    const response = await startRun(ctx, alice, taskId, seed, '不应派发')
    expect(response.statusCode, response.body).toBe(409)
    expect(response.json().error.code).toBe('CONTEXT_UNAVAILABLE')
    const runs = await database.db.select().from(schema.runs).where(eq(schema.runs.taskId, taskId))
    expect(runs).toHaveLength(0)
  })

  it('fails the Run before dispatch when a frozen decision is corrected after creation', async () => {
    const taskId = await createTask(ctx, alice, projectId, '派发前复核')
    await confirmAgreement(ctx, alice, taskId)
    const created = await startRun(ctx, alice, taskId, seed, '等待派发')
    expect(created.statusCode, created.body).toBe(201)
    const runId = created.json().data.id as string
    const [snapshot] = await database.db
      .select()
      .from(schema.runProjectContexts)
      .where(eq(schema.runProjectContexts.runId, runId))
    const [decision] = await database.db
      .select()
      .from(schema.runProjectContextEntries)
      .where(eq(schema.runProjectContextEntries.snapshotId, snapshot!.id))
    const corrected = await apiInject(ctx, bob, {
      method: 'POST',
      url: `/api/v1/projects/${projectId}/context/${decision!.entryId}/correction`,
      payload: { correctionKind: 'amend', note: '预算尚未批准' },
      idempotencyKey: idemKey(),
    })
    expect(corrected.statusCode, corrected.body).toBe(201)

    harness.clock.advance(Math.max(0, Date.now() - harness.clock.now().getTime()) + 1)
    await harness.worker.dispatchOnce()
    const [failed] = await database.db.select().from(schema.runs).where(eq(schema.runs.id, runId))
    expect(failed?.status).toBe('failed')
    expect(failed?.failureCode).toBe('CONTEXT_UNAVAILABLE')
    const [command] = await database.db
      .select()
      .from(schema.dispatchOutbox)
      .where(
        and(
          eq(schema.dispatchOutbox.type, 'run.start'),
          sql`${schema.dispatchOutbox.payload}->>'runId' = ${runId}`,
        ),
      )
    expect(command?.failedAt).not.toBeNull()
    expect(harness.gateway.drainUpstream()).toEqual([])
    expect(notes.some((note) => note.action === 'context.dispatch_blocked')).toBe(true)
  })

  it('accepts delivered/read receipts, writes consumption, and rejects duplicate sequences', async () => {
    const taskId = await createTask(ctx, alice, projectId, '回执')
    await confirmAgreement(ctx, alice, taskId)
    const created = await startRun(ctx, alice, taskId, seed, '读取上下文')
    expect(created.statusCode, created.body).toBe(201)
    const runId = created.json().data.id as string
    await dispatchAndReady(harness, seed, alice.userId, runId)
    const [snapshot] = await database.db
      .select()
      .from(schema.runProjectContexts)
      .where(eq(schema.runProjectContexts.runId, runId))
    const entries = await database.db
      .select()
      .from(schema.runProjectContextEntries)
      .where(eq(schema.runProjectContextEntries.snapshotId, snapshot!.id))
    const nonce = projectContextNonce(snapshot!.snapshotDigest, runId)
    expect(nonce).toHaveLength(16)
    const device = { deviceId: seed.deviceId, ownerUserId: alice.userId }

    const delivered = receiptFrame({
      runId,
      snapshotId: snapshot!.id,
      receiptSeq: 1,
      headerDigest: snapshot!.headerDigest,
      nonceMatched: true,
      entriesDelivered: entries.map((entry) => entry.entryId),
      entriesRead: [],
      readEvents: [],
      missing: [],
      digestVerified: true,
      at: new Date().toISOString(),
    })
    await harness.orchestrator.ingestNodeEvent(device, delivered)
    const receiptsAfterDelivered = await database.db
      .select()
      .from(schema.runContextReceipts)
      .where(eq(schema.runContextReceipts.runId, runId))
    expect(receiptsAfterDelivered).toHaveLength(1)
    const [afterDelivery] = await database.db
      .select()
      .from(schema.runProjectContextEntries)
      .where(eq(schema.runProjectContextEntries.snapshotId, snapshot!.id))
    expect(afterDelivery?.deliveredAt).not.toBeNull()
    expect(afterDelivery?.readAt).toBeNull()

    const readAt = new Date().toISOString()
    const read = receiptFrame({
      runId,
      snapshotId: snapshot!.id,
      receiptSeq: 2,
      headerDigest: snapshot!.headerDigest,
      nonceMatched: true,
      entriesDelivered: entries.map((entry) => entry.entryId),
      entriesRead: entries.map((entry) => entry.entryId),
      readEvents: entries.map((entry) => ({
        entryId: entry.entryId,
        digestVerified: true,
        byteSize: entry.byteSize,
        at: readAt,
      })),
      missing: [],
      digestVerified: true,
      at: readAt,
    })
    await harness.orchestrator.ingestNodeEvent(device, read)
    const [afterRead] = await database.db
      .select()
      .from(schema.runProjectContexts)
      .where(eq(schema.runProjectContexts.id, snapshot!.id))
    expect(afterRead?.consumedAt).not.toBeNull()
    expect(afterRead?.consumedAllAt).not.toBeNull()
    const consumption = await database.db
      .select()
      .from(schema.runContextConsumptions)
      .where(eq(schema.runContextConsumptions.snapshotId, snapshot!.id))
    expect(consumption).toHaveLength(entries.length)
    expect(new Set(consumption.map((row) => row.entryId))).toEqual(
      new Set(entries.map((entry) => entry.entryId)),
    )

    // 重复 receiptSeq：拒绝且不新增行。
    await harness.orchestrator.ingestNodeEvent(device, read)
    const receipts = await database.db
      .select()
      .from(schema.runContextReceipts)
      .where(eq(schema.runContextReceipts.runId, runId))
    expect(receipts).toHaveLength(2)
    expect(
      notes.some(
        (note) =>
          note.action === 'context.receipt_invalid' &&
          note.fields['reason'] === 'receipt_seq_not_monotonic',
      ),
    ).toBe(true)

    // 终态后迟到：不复活 Run、不写回执。
    await completeRun(harness, seed, alice.userId, runId)
    await harness.orchestrator.ingestNodeEvent(
      device,
      receiptFrame({
        runId,
        snapshotId: snapshot!.id,
        receiptSeq: 3,
        headerDigest: snapshot!.headerDigest,
        nonceMatched: true,
        entriesDelivered: entries.map((entry) => entry.entryId),
        entriesRead: [],
        readEvents: [],
        missing: [],
        digestVerified: true,
        at: new Date().toISOString(),
      }),
    )
    const receiptsAfterLate = await database.db
      .select()
      .from(schema.runContextReceipts)
      .where(eq(schema.runContextReceipts.runId, runId))
    expect(receiptsAfterLate).toHaveLength(2)
    expect(notes.some((note) => note.action === 'context.receipt_late')).toBe(true)
  })

  it('rejects a receipt whose header digest or nonce does not match', async () => {
    const taskId = await createTask(ctx, alice, projectId, '回执负控')
    await confirmAgreement(ctx, alice, taskId)
    const created = await startRun(ctx, alice, taskId, seed, '读取上下文')
    const runId = created.json().data.id as string
    await dispatchAndReady(harness, seed, alice.userId, runId)
    const [snapshot] = await database.db
      .select()
      .from(schema.runProjectContexts)
      .where(eq(schema.runProjectContexts.runId, runId))
    const entries = await database.db
      .select()
      .from(schema.runProjectContextEntries)
      .where(eq(schema.runProjectContextEntries.snapshotId, snapshot!.id))
    const device = { deviceId: seed.deviceId, ownerUserId: alice.userId }
    const base = {
      runId,
      snapshotId: snapshot!.id,
      receiptSeq: 1,
      entriesDelivered: entries.map((entry) => entry.entryId),
      entriesRead: [],
      readEvents: [],
      missing: [],
      digestVerified: true,
      at: new Date().toISOString(),
    }
    await harness.orchestrator.ingestNodeEvent(
      device,
      receiptFrame({ ...base, headerDigest: '0'.repeat(64), nonceMatched: true }),
    )
    await harness.orchestrator.ingestNodeEvent(
      device,
      receiptFrame({
        ...base,
        receiptSeq: 2,
        headerDigest: snapshot!.headerDigest,
        nonceMatched: false,
      }),
    )
    await harness.orchestrator.ingestNodeEvent(
      device,
      receiptFrame({
        ...base,
        receiptSeq: 3,
        headerDigest: snapshot!.headerDigest,
        nonceMatched: true,
        readEvents: [],
        entriesRead: [entries[0]!.entryId],
        digestVerified: true,
      }),
    )
    const receipts = await database.db
      .select()
      .from(schema.runContextReceipts)
      .where(eq(schema.runContextReceipts.runId, runId))
    expect(receipts).toHaveLength(0)
    const invalid = notes.filter((note) => note.action === 'context.receipt_invalid')
    expect(invalid.map((note) => note.fields['reason'])).toEqual(
      expect.arrayContaining(['header_digest_mismatch', 'nonce_mismatch', 'read_events_mismatch']),
    )
  })

  it('accepts sequential single-entry reads and keeps first-read facts stable on repeats', async () => {
    const taskId = await createTask(ctx, alice, projectId, '增量回执')
    await confirmAgreement(ctx, alice, taskId)
    const producer = await startRun(ctx, alice, taskId, seed, '发布成果')
    expect(producer.statusCode, producer.body).toBe(201)
    const producerRunId = producer.json().data.id as string
    await dispatchAndReady(harness, seed, alice.userId, producerRunId)
    await uploadAndPublish(ctx, alice, producerRunId, '场地比较')
    await completeRun(harness, seed, alice.userId, producerRunId)

    const created = await startRun(ctx, alice, taskId, seed, '逐条读取')
    expect(created.statusCode, created.body).toBe(201)
    const runId = created.json().data.id as string
    await dispatchAndReady(harness, seed, alice.userId, runId)
    const [snapshot] = await database.db
      .select()
      .from(schema.runProjectContexts)
      .where(eq(schema.runProjectContexts.runId, runId))
    const entries = await database.db
      .select()
      .from(schema.runProjectContextEntries)
      .where(eq(schema.runProjectContextEntries.snapshotId, snapshot!.id))
    expect(entries).toHaveLength(3)
    const device = { deviceId: seed.deviceId, ownerUserId: alice.userId }
    const allIds = entries.map((entry) => entry.entryId)
    const base = {
      runId,
      snapshotId: snapshot!.id,
      headerDigest: snapshot!.headerDigest,
      nonceMatched: true,
      digestVerified: true,
    }

    await harness.orchestrator.ingestNodeEvent(
      device,
      receiptFrame({
        ...base,
        receiptSeq: 1,
        entriesDelivered: allIds,
        entriesRead: [],
        readEvents: [],
        missing: [],
        at: new Date().toISOString(),
      }),
    )

    const readTimes: string[] = []
    for (const [index, entry] of entries.entries()) {
      const at = new Date(Date.now() + index * 1000).toISOString()
      readTimes.push(at)
      // 每条回执只带本批读事件；已读集合按批上报，服务端不得要求累计。
      await harness.orchestrator.ingestNodeEvent(
        device,
        receiptFrame({
          ...base,
          receiptSeq: index + 2,
          entriesDelivered: allIds,
          entriesRead: [entry.entryId],
          readEvents: [
            { entryId: entry.entryId, digestVerified: true, byteSize: entry.byteSize, at },
          ],
          missing: [],
          at,
        }),
      )
      const [row] = await database.db
        .select()
        .from(schema.runProjectContextEntries)
        .where(
          and(
            eq(schema.runProjectContextEntries.snapshotId, snapshot!.id),
            eq(schema.runProjectContextEntries.entryId, entry.entryId),
          ),
        )
      expect(row?.readAt?.toISOString()).toBe(at)
      const [head] = await database.db
        .select()
        .from(schema.runProjectContexts)
        .where(eq(schema.runProjectContexts.id, snapshot!.id))
      expect(head?.consumedAt).not.toBeNull()
      if (index === entries.length - 1) {
        expect(head?.consumedAllAt).not.toBeNull()
      } else {
        expect(head?.consumedAllAt).toBeNull()
      }
    }
    let consumption = await database.db
      .select()
      .from(schema.runContextConsumptions)
      .where(eq(schema.runContextConsumptions.snapshotId, snapshot!.id))
    expect(consumption).toHaveLength(3)

    // 全字段已写后重复读第一条：谓词仍接受，但不新增消费行、不推迟首次 readAt。
    // （这条路径曾因 updateRunProjectContext 收到空 patch 在第二次增量回执时 500。）
    const first = entries[0]!
    await harness.orchestrator.ingestNodeEvent(
      device,
      receiptFrame({
        ...base,
        receiptSeq: entries.length + 2,
        entriesDelivered: allIds,
        entriesRead: [first.entryId],
        readEvents: [
          {
            entryId: first.entryId,
            digestVerified: true,
            byteSize: first.byteSize,
            at: new Date(Date.now() + 60_000).toISOString(),
          },
        ],
        missing: [],
        at: new Date(Date.now() + 60_000).toISOString(),
      }),
    )
    const receipts = await database.db
      .select()
      .from(schema.runContextReceipts)
      .where(eq(schema.runContextReceipts.runId, runId))
    expect(receipts).toHaveLength(entries.length + 2)
    const [repeatRow] = await database.db
      .select()
      .from(schema.runProjectContextEntries)
      .where(
        and(
          eq(schema.runProjectContextEntries.snapshotId, snapshot!.id),
          eq(schema.runProjectContextEntries.entryId, first.entryId),
        ),
      )
    expect(repeatRow?.readAt?.toISOString()).toBe(readTimes[0])
    consumption = await database.db
      .select()
      .from(schema.runContextConsumptions)
      .where(eq(schema.runContextConsumptions.snapshotId, snapshot!.id))
    expect(consumption).toHaveLength(3)

    // 部分交付可以接受，但必须把未交付项写进 missing：delivered ∪ missing = 快照全集。
    // 这里只报 1/3 条却声称 missing 为空，必须拒绝且不落行。
    await harness.orchestrator.ingestNodeEvent(
      device,
      receiptFrame({
        ...base,
        receiptSeq: entries.length + 3,
        entriesDelivered: [first.entryId],
        entriesRead: [],
        readEvents: [],
        missing: [],
        at: new Date(Date.now() + 90_000).toISOString(),
      }),
    )
    const afterPartial = await database.db
      .select()
      .from(schema.runContextReceipts)
      .where(eq(schema.runContextReceipts.runId, runId))
    expect(afterPartial).toHaveLength(entries.length + 2)
    expect(
      notes.some(
        (note) =>
          note.action === 'context.receipt_invalid' &&
          note.fields['reason'] === 'missing_set_mismatch',
      ),
    ).toBe(true)

    // 自报矛盾：同一条目同时算已交付与未交付（并集刚好覆盖全集）也必须拒绝。
    await harness.orchestrator.ingestNodeEvent(
      device,
      receiptFrame({
        ...base,
        receiptSeq: entries.length + 4,
        entriesDelivered: [entries[0]!.entryId, entries[1]!.entryId],
        entriesRead: [],
        readEvents: [],
        missing: [entries[1]!.entryId, entries[2]!.entryId],
        at: new Date(Date.now() + 100_000).toISOString(),
      }),
    )
    expect(
      notes.some(
        (note) =>
          note.action === 'context.receipt_invalid' &&
          note.fields['reason'] === 'missing_overlaps_delivered',
      ),
    ).toBe(true)

    // 集合语义：同一批里同一条目读两次仍算一次已读，逐事件 digest/byteSize 照验。
    await harness.orchestrator.ingestNodeEvent(
      device,
      receiptFrame({
        ...base,
        receiptSeq: entries.length + 5,
        entriesDelivered: allIds,
        entriesRead: [first.entryId],
        readEvents: [
          {
            entryId: first.entryId,
            digestVerified: true,
            byteSize: first.byteSize,
            at: new Date(Date.now() + 110_000).toISOString(),
          },
          {
            entryId: first.entryId,
            digestVerified: true,
            byteSize: first.byteSize,
            at: new Date(Date.now() + 111_000).toISOString(),
          },
        ],
        missing: [],
        at: new Date(Date.now() + 111_000).toISOString(),
      }),
    )
    const afterDuplicateEvents = await database.db
      .select()
      .from(schema.runContextReceipts)
      .where(eq(schema.runContextReceipts.runId, runId))
    expect(afterDuplicateEvents).toHaveLength(entries.length + 3)
    consumption = await database.db
      .select()
      .from(schema.runContextConsumptions)
      .where(eq(schema.runContextConsumptions.snapshotId, snapshot!.id))
    expect(consumption).toHaveLength(3)
  })

  it('settles the triggering instruction as rejected when pre-dispatch verification fails', async () => {
    const taskId = await createTask(ctx, alice, projectId, '派发前复核与指令结算')
    await confirmAgreement(ctx, alice, taskId)
    const key = idemKey()
    const send = () =>
      apiInject(ctx, alice, {
        method: 'POST',
        url: `/api/v1/tasks/${taskId}/instructions`,
        payload: {
          text: '等待派发',
          deviceId: seed.deviceId,
          workspaceId: seed.workspaceId,
          agentId: seed.agentId,
        },
        idempotencyKey: key,
      })
    const first = await send()
    expect(first.statusCode, first.body).toBe(201)
    expect(first.json().data.outcome).toBe('started_run')
    const runId = first.json().data.runId as string
    const [run] = await database.db.select().from(schema.runs).where(eq(schema.runs.id, runId))
    expect(run?.triggerMessageId).not.toBeNull()
    const [snapshot] = await database.db
      .select()
      .from(schema.runProjectContexts)
      .where(eq(schema.runProjectContexts.runId, runId))
    const [decision] = await database.db
      .select()
      .from(schema.runProjectContextEntries)
      .where(eq(schema.runProjectContextEntries.snapshotId, snapshot!.id))
    const corrected = await apiInject(ctx, bob, {
      method: 'POST',
      url: `/api/v1/projects/${projectId}/context/${decision!.entryId}/correction`,
      payload: { correctionKind: 'amend', note: '派发前又变了' },
      idempotencyKey: idemKey(),
    })
    expect(corrected.statusCode, corrected.body).toBe(201)

    harness.clock.advance(Math.max(0, Date.now() - harness.clock.now().getTime()) + 1)
    await harness.worker.dispatchOnce()
    const [message] = await database.db
      .select()
      .from(schema.taskMessages)
      .where(eq(schema.taskMessages.id, run!.triggerMessageId!))
    expect(message?.instructionState).toBe('rejected')
    expect(message?.instructionErrorCode).toBe('CONTEXT_UNAVAILABLE')

    // 同幂等键重发：回放必须如实说 rejected，不能把从未受理的指令报成 started_run。
    const replay = await send()
    expect(replay.statusCode, replay.body).toBe(201)
    expect(replay.json().data.outcome).toBe('rejected')
    expect(replay.json().data.id).toBe(message!.id)

    // 崩溃窗口兜底：Run 已终态但指令仍停在 pending（结算漏在半路）时，
    // 回放读路径按 Run 的终态理由补结算，而不是继续报 started_run。
    await database.db
      .update(schema.taskMessages)
      .set({
        instructionState: 'pending',
        instructionErrorCode: null,
        instructionErrorMessage: null,
      })
      .where(eq(schema.taskMessages.id, message!.id))
    const afterCrash = await send()
    expect(afterCrash.statusCode, afterCrash.body).toBe(201)
    expect(afterCrash.json().data.outcome).toBe('rejected')
    const [resettled] = await database.db
      .select()
      .from(schema.taskMessages)
      .where(eq(schema.taskMessages.id, message!.id))
    expect(resettled?.instructionState).toBe('rejected')
    expect(resettled?.instructionErrorCode).toBe('CONTEXT_UNAVAILABLE')
  })

  it('does not fail an already-sent Run on an ack-loss retry after a frozen entry changes', async () => {
    const taskId = await createTask(ctx, alice, projectId, 'ack 丢失重投')
    await confirmAgreement(ctx, alice, taskId)
    const created = await startRun(ctx, alice, taskId, seed, '首次派发')
    expect(created.statusCode, created.body).toBe(201)
    const runId = created.json().data.id as string
    harness.clock.advance(Math.max(0, Date.now() - harness.clock.now().getTime()) + 1)
    await harness.worker.dispatchOnce()
    const sentStarts = () =>
      harness.gateway.sent.filter(
        (item) =>
          item.frame.type === 'run.start' &&
          (item.frame.payload as { runId?: string }).runId === runId,
      )
    expect(sentStarts()).toHaveLength(1)
    // 模拟 R7：Node 已收到命令（写 runtime-context/启动 Runtime），ack 丢在回程。
    harness.gateway.drainUpstream()
    const [snapshot] = await database.db
      .select()
      .from(schema.runProjectContexts)
      .where(eq(schema.runProjectContexts.runId, runId))
    const [decision] = await database.db
      .select()
      .from(schema.runProjectContextEntries)
      .where(eq(schema.runProjectContextEntries.snapshotId, snapshot!.id))
    const corrected = await apiInject(ctx, bob, {
      method: 'POST',
      url: `/api/v1/projects/${projectId}/context/${decision!.entryId}/correction`,
      payload: { correctionKind: 'amend', note: 'ack 丢失期间的变化' },
      idempotencyKey: idemKey(),
    })
    expect(corrected.statusCode, corrected.body).toBe(201)

    harness.clock.advance(60_000)
    await harness.worker.dispatchOnce()
    // 重投仍是同一冻结快照的那条命令：不因来源变化把已在执行的 Run 判失败。
    expect(sentStarts()).toHaveLength(2)
    const [afterRetry] = await database.db
      .select()
      .from(schema.runs)
      .where(eq(schema.runs.id, runId))
    expect(afterRetry?.status).toBe('queued')
    expect(afterRetry?.failureCode).toBeNull()
    const [command] = await database.db
      .select()
      .from(schema.dispatchOutbox)
      .where(
        and(
          eq(schema.dispatchOutbox.type, 'run.start'),
          sql`${schema.dispatchOutbox.payload}->>'runId' = ${runId}`,
        ),
      )
    expect(command?.sentAt).not.toBeNull()
    expect(command?.failedAt).toBeNull()
    expect(command?.attemptCount).toBeGreaterThanOrEqual(2)
  })

  it('creates an empty snapshot without a capability and omits projectContext from run.start', async () => {
    const taskId = await createTask(ctx, alice, projectId, '空快照')
    await database.db
      .update(schema.devices)
      .set({ capabilities: {} })
      .where(eq(schema.devices.id, seed.deviceId))
    const created = await startRun(ctx, alice, taskId, seed, '旧 Node 普通 Run')
    expect(created.statusCode, created.body).toBe(201)
    const runId = created.json().data.id as string
    const [snapshot] = await database.db
      .select()
      .from(schema.runProjectContexts)
      .where(eq(schema.runProjectContexts.runId, runId))
    expect(snapshot?.entryCount).toBe(0)
    expect(snapshot?.totalBytes).toBe(0)
    expect(snapshot?.unselected).toEqual([])
    expect(snapshot?.unselectedOmitted).toEqual({})
    expect(snapshot === undefined ? '' : snapshot.headerText).toContain('[project-context:')
    const [command] = await database.db
      .select()
      .from(schema.dispatchOutbox)
      .where(
        and(
          eq(schema.dispatchOutbox.type, 'run.start'),
          sql`${schema.dispatchOutbox.payload}->>'runId' = ${runId}`,
        ),
      )
    expect(command).toBeDefined()
    expect('projectContext' in (command!.payload as Record<string, unknown>)).toBe(false)
  })

  it('fails Run creation with CONTEXT_UNAVAILABLE when the snapshot header would exceed 4000 chars', async () => {
    // 标题上限 200；header 每行标题截到 60 码位，条目 id/版本仍占位。
    // 1 条约定 + 30 条终态 Observation 时，快照头已越过 4000（4000 是 zod 与列约束的同一道闸）。
    const longTitle = '预算长标题'.padEnd(196, '项')
    const taskId = await createTask(ctx, alice, projectId, longTitle)
    await confirmAgreement(ctx, alice, taskId)
    for (let index = 0; index < 30; index += 1) {
      await cancelQueuedRun(ctx, alice, taskId, seed)
    }
    const [lastRun] = await database.db
      .select({ id: schema.runs.id })
      .from(schema.runs)
      .where(eq(schema.runs.taskId, taskId))
      .orderBy(sql`${schema.runs.createdAt} desc, ${schema.runs.id} desc`)
      .limit(1)
    const [lastSnapshot] = await database.db
      .select()
      .from(schema.runProjectContexts)
      .where(eq(schema.runProjectContexts.runId, lastRun!.id))
    // 第 30 次创建（29 条观察）必须仍在 4000 内；再加一条就应拒绝。
    expect(lastSnapshot!.headerText.length).toBeLessThanOrEqual(4000)
    expect(lastSnapshot!.headerText.length).toBeGreaterThan(4000 - 200)

    const runsBefore = await database.db
      .select({ id: schema.runs.id })
      .from(schema.runs)
      .where(eq(schema.runs.taskId, taskId))
    const response = await startRun(ctx, alice, taskId, seed, '头部溢出')
    expect(response.statusCode, response.body).toBe(409)
    expect(response.json().error.code).toBe('CONTEXT_UNAVAILABLE')
    expect(response.json().error.message).toContain('4000')
    const runsAfter = await database.db
      .select({ id: schema.runs.id })
      .from(schema.runs)
      .where(eq(schema.runs.taskId, taskId))
    expect(runsAfter).toHaveLength(runsBefore.length)
    const snapshots = await database.db
      .select({ id: schema.runProjectContexts.id })
      .from(schema.runProjectContexts)
      .where(eq(schema.runProjectContexts.projectId, projectId))
    expect(snapshots).toHaveLength(runsBefore.length)
  })

  it(
    'keeps Run creation below the unselected detail cap while preserving aggregate counts',
    { timeout: 60_000 },
    async () => {
      const taskId = await createTask(ctx, alice, projectId, '容量与未纳入聚合')
      await confirmAgreement(ctx, alice, taskId)
      for (let index = 0; index < 32; index += 1) {
        await cancelQueuedRun(ctx, alice, taskId, seed)
      }
      // 33 个候选（1 条约定 + 32 条 Run 终态 Observation）：选 32，逐条明细恰好 1 条。
      const first = await startRun(ctx, alice, taskId, seed, '容量边界')
      expect(first.statusCode, first.body).toBe(201)
      const firstRunId = first.json().data.id as string
      const [small] = await database.db
        .select()
        .from(schema.runProjectContexts)
        .where(eq(schema.runProjectContexts.runId, firstRunId))
      expect(small?.entryCount).toBe(32)
      expect(small?.unselected).toHaveLength(1)
      expect((small!.unselected as { reason: string }[])[0]?.reason).toBe('capacity_exceeded')
      expect(small?.unselectedOmitted).toEqual({})
      const cancelledFirst = await apiInject(ctx, alice, {
        method: 'POST',
        url: `/api/v1/runs/${firstRunId}/cancel`,
      })
      expect(cancelledFirst.statusCode, cancelledFirst.body).toBe(200)

      // 再加 171 条终态 Observation → 205 个候选、173 条未纳入：明细封顶 128、
      // 其余 45 条按原因聚合。Run 创建必须 201（曾因 16KiB JSON 列约束 500）。
      for (let index = 0; index < 171; index += 1) {
        await cancelQueuedRun(ctx, alice, taskId, seed)
      }
      const second = await startRun(ctx, alice, taskId, seed, '容量上限')
      expect(second.statusCode, second.body).toBe(201)
      const secondRunId = second.json().data.id as string
      const [large] = await database.db
        .select()
        .from(schema.runProjectContexts)
        .where(eq(schema.runProjectContexts.runId, secondRunId))
      expect(large?.entryCount).toBe(32)
      expect(large?.unselected).toHaveLength(128)
      expect(large?.unselectedOmitted).toEqual({ capacity_exceeded: 45 })
      expect(large?.headerText).toContain('另有 173 条未纳入')
      expect(Buffer.byteLength(JSON.stringify(large!.unselected), 'utf8')).toBeLessThanOrEqual(
        16384,
      )

      // 读面同时返回明细与聚合，总数可复原：128 + 45 = 173。
      const member = await apiInject(ctx, alice, {
        method: 'GET',
        url: `/api/v1/runs/${secondRunId}/project-context`,
      })
      expect(member.statusCode, member.body).toBe(200)
      expect(member.json().data.unselected).toHaveLength(128)
      expect(member.json().data.unselectedOmitted).toEqual({ capacity_exceeded: 45 })
    },
  )
})
