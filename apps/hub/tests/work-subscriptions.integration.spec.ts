/**
 * ADR-0028（RD-02b）：显式工作订阅与入口快/慢路径的集成判据。
 *
 * 驱动全部走生产 HTTP（建工作/Mandate、订阅、Task 讨论、业务事实投影、人工纠正、
 * 退回、撤权、改派），断言只读协调表与业务计数。快路径的「Router 未调用」以
 * `work_entry_admission.router_invoked=false` 且 `router_decision` 零行为证据；
 * 慢路径必须留下独立的 Router 调用记录，不能只写一个布尔标记。
 */
import { createHash, randomUUID } from 'node:crypto'
import { mkdir, rm } from 'node:fs/promises'
import { eq } from 'drizzle-orm'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { Database } from '@whalepod/db'
import { getTaskMessage, Outbox, schema } from '@whalepod/db'
import { applyRunStatus } from '../src/modules/run/run-status.js'
import { admitTaskMessageEntry, workEntryDeps } from '../src/modules/work/entry.js'
import {
  apiInject,
  createTestApp,
  createTestDatabase,
  driveInviteAndAccept,
  driveSetup,
  idemKey,
  insertRunRow,
  resetDatabase,
  seedRunChainForUser,
  type Session,
  type TestApp,
} from './helpers.js'

const GOAL = '持续整理场地比较与预算变化，产出可审阅草稿'
const artifactDirs: string[] = []

async function createProject(ctx: TestApp, session: Session): Promise<string> {
  const res = await apiInject(ctx, session, {
    method: 'POST',
    url: '/api/v1/projects',
    payload: { name: `rd02b-${Date.now()}-${randomUUID().slice(0, 6)}` },
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
    payload: { title: '场地与预算持续工作', assigneeUserId },
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

async function createWork(ctx: TestApp, session: Session, taskId: string): Promise<string> {
  const res = await apiInject(ctx, session, {
    method: 'POST',
    url: `/api/v1/tasks/${taskId}/works`,
    payload: { goal: GOAL },
    idempotencyKey: idemKey(),
  })
  expect(res.statusCode).toBe(201)
  return res.json().data.workKey as string
}

function futureIso(ms = 60 * 60 * 1000): string {
  return new Date(Date.now() + ms).toISOString()
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
      expiresAt: futureIso(),
      allowedSourceTypes: ['task_message', 'context_entry'],
      ...overrides,
    },
    idempotencyKey: idemKey(),
  })
  expect(res.statusCode).toBe(201)
  return res.json().data as {
    id: string
    version: number
    status: string
    allowedSourceTypes: string[]
  }
}

async function subscribe(
  ctx: TestApp,
  session: Session,
  workKey: string,
  targetType: 'task' | 'business_ref',
  targetRef: string,
  expectedStatus = 201,
) {
  const res = await apiInject(ctx, session, {
    method: 'POST',
    url: `/api/v1/works/${workKey}/subscriptions`,
    payload: { targetType, targetRef },
    idempotencyKey: idemKey(),
  })
  expect(res.statusCode).toBe(expectedStatus)
  return res
}

async function comment(
  ctx: TestApp,
  session: Session,
  taskId: string,
  body = '客户确认有轮椅使用者，场地无障碍需要重算。',
  key = idemKey(),
) {
  const res = await apiInject(ctx, session, {
    method: 'POST',
    url: `/api/v1/tasks/${taskId}/comments`,
    payload: { body },
    idempotencyKey: key,
  })
  expect(res.statusCode).toBe(201)
  return res.json().data as { id: string; createdAt: string }
}

async function listSubscriptions(ctx: TestApp, session: Session, workKey: string) {
  const res = await apiInject(ctx, session, {
    method: 'GET',
    url: `/api/v1/works/${workKey}/subscriptions`,
  })
  expect(res.statusCode).toBe(200)
  expect(res.headers['cache-control']).toBe('private, no-store')
  return res.json().data as Array<Record<string, unknown>>
}

async function admissions(ctx: TestApp, session: Session, workKey: string) {
  const res = await apiInject(ctx, session, {
    method: 'GET',
    url: `/api/v1/works/${workKey}/entry-admissions?limit=100`,
  })
  expect(res.statusCode).toBe(200)
  expect(res.headers['cache-control']).toBe('private, no-store')
  return res.json().data as Array<{
    id: string
    trigger: string
    outcome: string
    reason: string
    sourceId: string
    subscriptionId: string | null
    inboxItemId: string | null
    routerInvoked: boolean
    routerCallId: string | null
    deadlineAt: string | null
  }>
}

async function inbox(ctx: TestApp, session: Session, workKey: string) {
  const res = await apiInject(ctx, session, {
    method: 'GET',
    url: `/api/v1/works/${workKey}/inbox`,
  })
  expect(res.statusCode).toBe(200)
  return res.json().data as {
    items: Array<Record<string, unknown>>
    watermarks: Record<string, number | string | null>
  }
}

async function revokeSubscription(
  ctx: TestApp,
  session: Session,
  workKey: string,
  subscriptionId: string,
  key = idemKey(),
) {
  const res = await apiInject(ctx, session, {
    method: 'POST',
    url: `/api/v1/works/${workKey}/subscriptions/${subscriptionId}/revoke`,
    payload: { reason: '职责范围调整' },
    idempotencyKey: key,
  })
  expect(res.statusCode).toBe(200)
  return res.json().data as Record<string, unknown>
}

async function confirmAgreement(ctx: TestApp, session: Session, taskId: string): Promise<void> {
  const draft = await apiInject(ctx, session, {
    method: 'POST',
    url: `/api/v1/tasks/${taskId}/agreement/draft`,
    payload: {
      content: {
        goal: '场地与预算持续比较',
        constraints: '不新增审批步骤',
        acceptance: '变化出现在下一次比较',
        openQuestions: '供应商待定',
      },
    },
    idempotencyKey: idemKey(),
  })
  expect(draft.statusCode).toBe(200)
  const confirmed = await apiInject(ctx, session, {
    method: 'POST',
    url: `/api/v1/tasks/${taskId}/agreement/confirm`,
    payload: { draftVersion: draft.json().data.draftVersion },
    idempotencyKey: idemKey(),
  })
  expect(confirmed.statusCode).toBe(200)
}

async function associateContext(ctx: TestApp, session: Session, workKey: string, entryId: string) {
  const res = await apiInject(ctx, session, {
    method: 'POST',
    url: `/api/v1/works/${workKey}/inbox-items`,
    payload: { sourceType: 'context_entry', sourceId: entryId },
    idempotencyKey: idemKey(),
  })
  expect(res.statusCode).toBe(201)
  return res.json().data as Record<string, unknown>
}

async function correctContext(
  ctx: TestApp,
  session: Session,
  projectId: string,
  entryId: string,
  note: string,
) {
  const res = await apiInject(ctx, session, {
    method: 'POST',
    url: `/api/v1/projects/${projectId}/context/${entryId}/correction`,
    payload: { correctionKind: 'amend', note },
    idempotencyKey: idemKey(),
  })
  expect(res.statusCode).toBe(201)
  return res.json().data as { id: string }
}

async function pairDevice(
  ctx: TestApp,
  session: Session,
): Promise<{ deviceId: string; token: string }> {
  const codeRes = await apiInject(ctx, session, {
    method: 'POST',
    url: '/api/v1/devices/pairing-codes',
    payload: {},
    idempotencyKey: idemKey(),
  })
  expect(codeRes.statusCode).toBe(201)
  const claim = await ctx.app.inject({
    method: 'POST',
    url: '/api/v1/devices/pairing-claims',
    headers: { origin: ctx.origin, 'idempotency-key': idemKey() },
    payload: {
      code: codeRes.json().data.code,
      name: 'rd02b-node',
      platform: 'darwin',
      architecture: 'arm64',
      nodeVersion: '24.12.0',
      nodeAppVersion: '0.1.0',
    },
  })
  expect(claim.statusCode).toBe(201)
  const data = claim.json().data as { deviceId: string; deviceToken: string }
  return { deviceId: data.deviceId, token: data.deviceToken }
}

function uploadArtifact(ctx: TestApp, token: string, runId: string, content: Buffer) {
  const query = new URLSearchParams({
    title: 'RD-02b artifact',
    mediaType: 'text/plain',
    byteSize: String(content.byteLength),
    sha256: createHash('sha256').update(content).digest('hex'),
    sourceRelativePath: 'rd02b/artifact.txt',
  })
  return ctx.app.inject({
    method: 'POST',
    url: `/api/v1/node/runs/${runId}/artifacts?${query.toString()}`,
    headers: {
      authorization: `Device ${token}`,
      'idempotency-key': idemKey(),
      'content-type': 'application/octet-stream',
    },
    payload: content,
  })
}

async function findContextEntry(
  ctx: TestApp,
  session: Session,
  projectId: string,
  businessRef: string,
): Promise<{ id: string; title: string }> {
  const res = await apiInject(ctx, session, {
    method: 'GET',
    url: `/api/v1/projects/${projectId}/context?limit=100`,
  })
  expect(res.statusCode).toBe(200)
  const entry = (res.json().data.entries as Array<Record<string, unknown>>).find(
    (candidate) => candidate.businessRef === businessRef,
  )
  expect(entry).toBeDefined()
  return entry as { id: string; title: string }
}

async function counts(database: Database) {
  const [routerCalls, routerDecisions, dispatchIntents, items, subscriptionRows, admissionRows] =
    await Promise.all([
      database.db.select().from(schema.workEntryRouterCalls),
      database.db.select().from(schema.routerDecisions),
      database.db.select().from(schema.dispatchIntents),
      database.db.select().from(schema.workInboxItems),
      database.db.select().from(schema.workSubscriptions),
      database.db.select().from(schema.workEntryAdmissions),
    ])
  return {
    routerCalls: routerCalls.length,
    routerDecisions: routerDecisions.length,
    dispatchIntents: dispatchIntents.length,
    items: items.length,
    subscriptions: subscriptionRows.length,
    admissions: admissionRows.length,
  }
}

describe('RD-02b work subscriptions and entry admission (ADR-0028)', () => {
  let database: Database
  let ctx: TestApp
  let alice: Session
  let bob: Session
  let projectId: string
  let taskId: string
  let workKey: string
  let mandate: { id: string; version: number }
  let subscriptionId: string

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
    workKey = await createWork(ctx, alice, taskId)
    mandate = await createMandate(ctx, alice, workKey)
    subscriptionId = (await subscribe(ctx, alice, workKey, 'task', taskId)).json().data.id
  })

  afterEach(async () => {
    await ctx.app.close()
  })

  afterAll(async () => {
    await database.close()
    for (const dir of artifactDirs.splice(0)) await rm(dir, { recursive: true, force: true })
  })

  it('delivers a known Task supplement without invoking Router', async () => {
    const duplicate = await subscribe(ctx, alice, workKey, 'task', taskId)
    expect(duplicate.json().data.id).toBe(subscriptionId)
    const upper = await subscribe(ctx, alice, workKey, 'task', taskId.toUpperCase())
    expect(upper.json().data.id).toBe(subscriptionId)
    expect(upper.json().data.targetRef).toBe(taskId)
    expect(await listSubscriptions(ctx, alice, workKey)).toHaveLength(1)

    const added = await comment(ctx, bob, taskId)
    const entries = await admissions(ctx, alice, workKey)
    expect(entries).toHaveLength(1)
    expect(entries[0]).toMatchObject({
      trigger: 'source',
      outcome: 'deliver',
      reason: 'subscription_match',
      sourceId: added.id,
      subscriptionId,
      routerInvoked: false,
      routerCallId: null,
    })

    const listed = await inbox(ctx, alice, workKey)
    expect(listed.items).toHaveLength(1)
    expect(listed.items[0]).toMatchObject({
      sourceId: added.id,
      status: 'pending',
      subscriptionId,
      authorizationGeneration: 'member',
    })
    expect(listed.watermarks.pendingCount).toBe(1)

    // 快路径的机器证据：没有 Router 决定，也没有 RD-03 的派工意图。
    const after = await counts(database)
    expect(after.routerCalls).toBe(0)
    expect(after.routerDecisions).toBe(0)
    expect(after.dispatchIntents).toBe(0)
    expect(after.admissions).toBe(1)
  })

  it('routes an unsubscribed supplement to Router with zero inbox copies', async () => {
    const noSubWork = await createTask(ctx, alice, projectId, alice.userId)
    await acceptTask(ctx, alice, noSubWork)
    const noSubKey = await createWork(ctx, alice, noSubWork)
    await createMandate(ctx, alice, noSubKey)
    const added = await comment(ctx, bob, noSubWork)

    const listed = await inbox(ctx, alice, noSubKey)
    expect(listed.items).toHaveLength(0)
    const entries = await admissions(ctx, alice, noSubKey)
    expect(entries).toHaveLength(1)
    expect(entries[0]).toMatchObject({
      sourceId: added.id,
      outcome: 'route_router',
      reason: 'no_valid_subscription',
      routerInvoked: true,
      subscriptionId: null,
      inboxItemId: null,
    })
    expect(entries[0]?.routerCallId).toMatch(/^[0-9a-f-]{36}$/)

    const after = await counts(database)
    expect(after.routerCalls).toBe(1)
    expect(after.dispatchIntents).toBe(0)
    expect(after.items).toBe(0)
  })

  it('converges concurrent entry admissions to one Router call', async () => {
    const lateTask = await createTask(ctx, alice, projectId, alice.userId)
    await acceptTask(ctx, alice, lateTask)
    // 消息到达时还没有工作 → 不自动准入；随后建工作/Mandate，再并发重放同一事件。
    const message = await comment(ctx, bob, lateTask, '工作建立前的补充')
    const lateWork = await createWork(ctx, alice, lateTask)
    await createMandate(ctx, alice, lateWork)
    const row = await getTaskMessage(database.db, message.id)
    expect(row).toBeDefined()
    const [first, second] = await Promise.all([
      database.transaction((tx) => admitTaskMessageEntry(tx, row!, workEntryDeps(tx))),
      database.transaction((tx) => admitTaskMessageEntry(tx, row!, workEntryDeps(tx))),
    ])
    expect(first?.id).toBe(second?.id)
    expect(first).toMatchObject({
      outcome: 'route_router',
      routerInvoked: true,
      sourceId: message.id,
    })
    const after = await counts(database)
    expect(after.admissions).toBe(1)
    expect(after.routerCalls).toBe(1)
  })

  it('serializes Task→Work commands with entry inserts without deadlock', async () => {
    const raceTask = await createTask(ctx, alice, projectId, alice.userId)
    await acceptTask(ctx, alice, raceTask)
    // 工作未建立时留下消息，之后建工作/授权/订阅，再并发重放准入。
    const message = await comment(ctx, bob, raceTask, '并发锁序探针的补充')
    const raceWork = await createWork(ctx, alice, raceTask)
    await createMandate(ctx, alice, raceWork)
    await subscribe(ctx, alice, raceWork, 'task', raceTask)
    const [workRow] = await database.db
      .select()
      .from(schema.works)
      .where(eq(schema.works.workKey, raceWork))
    expect(workRow).toBeDefined()
    const messageRow = await getTaskMessage(database.db, message.id)
    expect(messageRow).toBeDefined()

    let releaseTask!: () => void
    const taskGate = new Promise<void>((resolve) => {
      releaseTask = resolve
    })
    let taskLocked!: () => void
    const taskReady = new Promise<void>((resolve) => {
      taskLocked = resolve
    })
    // 模拟 Task 命令的固定锁序：Task FOR UPDATE → Work FOR UPDATE。
    const taskCommand = database.transaction(async (tx) => {
      await tx.select().from(schema.tasks).where(eq(schema.tasks.id, raceTask)).for('update')
      taskLocked()
      await taskGate
      await tx
        .select()
        .from(schema.works)
        .where(eq(schema.works.id, workRow?.id as string))
        .for('update')
    })
    await taskReady
    // 入口准入只锁 Work；若插入再对 Task 取 FK KEY SHARE，会与上面的 Task 锁互等。
    const admissionPromise = database.transaction((tx) =>
      admitTaskMessageEntry(tx, messageRow!, workEntryDeps(tx)),
    )
    let admission: Awaited<typeof admissionPromise> | undefined
    let admissionError: unknown
    try {
      admission = await admissionPromise
    } catch (error) {
      admissionError = error
    } finally {
      releaseTask()
    }
    await taskCommand
    if (admissionError !== undefined) throw admissionError
    expect(admission).toMatchObject({
      outcome: 'deliver',
      routerInvoked: false,
    })
    expect(
      (await inbox(ctx, alice, raceWork)).items.find((item) => item.sourceId === message.id),
    ).toMatchObject({ status: 'pending' })
  })

  it('revocation stops delivery and retracts unread copies', async () => {
    const first = await comment(ctx, bob, taskId, '第一条补充')
    const pending = (await inbox(ctx, alice, workKey)).items[0]
    expect(pending).toMatchObject({ sourceId: first.id, status: 'pending', subscriptionId })

    const revoked = await revokeSubscription(ctx, alice, workKey, subscriptionId)
    expect(revoked).toMatchObject({
      id: subscriptionId,
      status: 'revoked',
      statusReason: '职责范围调整',
      endedByUserId: alice.userId,
    })

    const afterRevoke = await inbox(ctx, alice, workKey)
    expect(afterRevoke.items[0]).toMatchObject({
      id: pending?.id,
      status: 'retracted',
      statusReason: '职责范围调整',
      subscriptionId,
    })

    const second = await comment(ctx, bob, taskId, '第二条补充')
    const entries = (await admissions(ctx, alice, workKey)).filter(
      (entry) => entry.sourceId === second.id,
    )
    expect(entries).toHaveLength(1)
    expect(entries[0]).toMatchObject({
      outcome: 'route_router',
      routerInvoked: true,
      subscriptionId: null,
    })
    expect((await inbox(ctx, alice, workKey)).items).toHaveLength(1)

    const replay = await revokeSubscription(ctx, alice, workKey, subscriptionId)
    expect(replay.status).toBe('revoked')
    const subscriptions = await listSubscriptions(ctx, alice, workKey)
    expect(subscriptions).toHaveLength(1)
    expect(subscriptions[0]?.status).toBe('revoked')

    const renewed = await subscribe(ctx, alice, workKey, 'task', taskId)
    expect(renewed.json().data.id).not.toBe(subscriptionId)
    expect(renewed.json().data.status).toBe('active')
    const third = await comment(ctx, bob, taskId, '重新订阅后的补充')
    const thirdEntry = (await admissions(ctx, alice, workKey)).find(
      (entry) => entry.sourceId === third.id,
    )
    expect(thirdEntry).toMatchObject({
      outcome: 'deliver',
      routerInvoked: false,
      subscriptionId: renewed.json().data.id,
    })
  })

  it('does not treat a subscription retraction as a source-level tombstone', async () => {
    const first = await comment(ctx, bob, taskId, '撤销订阅前的补充')
    const item = (await inbox(ctx, alice, workKey)).items.find(
      (candidate) => candidate.sourceId === first.id,
    )
    await revokeSubscription(ctx, alice, workKey, subscriptionId)
    const [retracted] = await database.db
      .select()
      .from(schema.workInboxItems)
      .where(eq(schema.workInboxItems.id, item?.id as string))
    expect(retracted).toMatchObject({ status: 'retracted', retractionScope: 'subscription' })

    // 故障注入：内部来源还没有消息编辑 HTTP 入口；直接改消息正文模拟同 sourceId
    // 的新版本，验证订阅撤回不是来源级 tombstone，不能永久拦截显式关联。
    // removeWhen：消息编辑入口落地后改为真实 HTTP 更新。
    await database.db
      .update(schema.taskMessages)
      .set({ body: '撤销订阅后修订的补充', editedAt: new Date() })
      .where(eq(schema.taskMessages.id, first.id))
    const reassociated = await apiInject(ctx, alice, {
      method: 'POST',
      url: `/api/v1/works/${workKey}/inbox-items`,
      payload: { sourceType: 'task_message', sourceId: first.id },
      idempotencyKey: idemKey(),
    })
    expect(reassociated.statusCode, reassociated.body).toBe(201)
    expect(reassociated.json().data).toMatchObject({
      sourceId: first.id,
      status: 'pending',
      subscriptionId: null,
      body: '撤销订阅后修订的补充',
    })
  })

  it('stales subscriptions and retracts unread copies when the Mandate advances', async () => {
    const first = await comment(ctx, bob, taskId, '旧 Mandate 下的补充')
    const pending = (await inbox(ctx, alice, workKey)).items[0]
    expect(pending).toMatchObject({ sourceId: first.id, status: 'pending' })

    const next = await createMandate(ctx, alice, workKey)
    expect(next.version).toBe(mandate.version + 1)

    const subscriptions = await listSubscriptions(ctx, alice, workKey)
    expect(subscriptions[0]).toMatchObject({
      id: subscriptionId,
      status: 'stale',
      statusReason: 'mandate_superseded',
      endedAt: expect.any(String),
    })
    const afterAdvance = await inbox(ctx, alice, workKey)
    expect(afterAdvance.items[0]).toMatchObject({
      id: pending?.id,
      status: 'retracted',
      statusReason: 'mandate_superseded',
    })

    const second = await comment(ctx, bob, taskId, '新 Mandate 下未重新订阅的补充')
    const entries = (await admissions(ctx, alice, workKey)).filter(
      (entry) => entry.sourceId === second.id,
    )
    expect(entries[0]).toMatchObject({
      outcome: 'route_router',
      reason: 'no_valid_subscription',
      routerInvoked: true,
    })
    const after = await counts(database)
    expect(after.routerCalls).toBe(1)
    expect(after.items).toBe(1)
  })

  it('stales a subscription when the source authorization generation changes', async () => {
    await comment(ctx, bob, taskId, '代次变化前的补充')
    const pending = (await inbox(ctx, alice, workKey)).items[0]
    // 故障注入：内部来源在 PC-03b 前只有常量代次；直接改协调表模拟外部来源
    // 权限代次推进，验证入口准入逐来源比较而不是只看一个汇总 digest。
    // removeWhen：PC-03b 提供真实来源代次推进后删除该直写。
    await database.db
      .update(schema.workSubscriptions)
      .set({ authorizationGeneration: 'source:next-generation' })
      .where(eq(schema.workSubscriptions.id, subscriptionId))

    const second = await comment(ctx, bob, taskId, '代次变化后的补充')
    const subscriptions = await listSubscriptions(ctx, alice, workKey)
    expect(subscriptions[0]).toMatchObject({
      status: 'stale',
      statusReason: 'source_generation_changed',
    })
    expect((await inbox(ctx, alice, workKey)).items[0]).toMatchObject({
      id: pending?.id,
      status: 'retracted',
      statusReason: 'source_generation_changed',
    })
    const entries = (await admissions(ctx, alice, workKey)).filter(
      (entry) => entry.sourceId === second.id,
    )
    expect(entries[0]).toMatchObject({
      outcome: 'route_router',
      reason: 'source_generation_changed',
      routerInvoked: true,
    })
    expect((await counts(database)).routerCalls).toBe(1)
  })

  it('stales a subscription when its pinned Mandate version no longer matches', async () => {
    await comment(ctx, bob, taskId, '版本指针变化前的补充')
    const pending = (await inbox(ctx, alice, workKey)).items[0]
    // 故障注入：模拟漏跑 Mandate 变更清理时的防御分支（正常路径由
    // expireWorkSubscriptionsAndRetract 收口）。
    // removeWhen：防御分支有独立故障注入口后删除该直写。
    await database.db
      .update(schema.workSubscriptions)
      .set({ mandateVersion: 2 })
      .where(eq(schema.workSubscriptions.id, subscriptionId))

    const second = await comment(ctx, bob, taskId, '版本指针变化后的补充')
    expect((await listSubscriptions(ctx, alice, workKey))[0]).toMatchObject({
      status: 'stale',
      statusReason: 'mandate_version_changed',
    })
    expect((await inbox(ctx, alice, workKey)).items[0]).toMatchObject({
      id: pending?.id,
      status: 'retracted',
      statusReason: 'mandate_version_changed',
    })
    const entries = (await admissions(ctx, alice, workKey)).filter(
      (entry) => entry.sourceId === second.id,
    )
    expect(entries[0]).toMatchObject({
      outcome: 'route_router',
      reason: 'mandate_version_changed',
      routerInvoked: true,
    })
    expect((await counts(database)).routerCalls).toBe(1)
  })

  it('waits without invoking Router when the Mandate is paused', async () => {
    await comment(ctx, bob, taskId, '暂停前的补充')
    const pending = (await inbox(ctx, alice, workKey)).items[0]
    const paused = await apiInject(ctx, alice, {
      method: 'POST',
      url: `/api/v1/mandates/${mandate.id}/pause`,
      payload: { reason: '短暂暂停' },
      idempotencyKey: idemKey(),
    })
    expect(paused.statusCode).toBe(200)
    const pausedMandateId = paused.json().data.id as string

    const subscriptions = await listSubscriptions(ctx, alice, workKey)
    expect(subscriptions[0]).toMatchObject({
      status: 'stale',
      statusReason: 'mandate_pause',
    })
    expect((await inbox(ctx, alice, workKey)).items[0]).toMatchObject({
      id: pending?.id,
      status: 'retracted',
    })

    const second = await comment(ctx, bob, taskId, '暂停期间的补充')
    const entries = (await admissions(ctx, alice, workKey)).filter(
      (entry) => entry.sourceId === second.id,
    )
    expect(entries[0]).toMatchObject({
      outcome: 'wait',
      reason: 'mandate_inactive',
      routerInvoked: false,
      routerCallId: null,
      deadlineAt: expect.any(String),
      inboxItemId: expect.any(String),
    })
    const waiting = (await inbox(ctx, alice, workKey)).items.find(
      (item) => item.sourceId === second.id,
    )
    expect(waiting).toMatchObject({ status: 'pending', subscriptionId: null })

    // 故障注入：内部来源还没有消息编辑入口；直接改正文/editedAt 模拟同 sourceId
    // 新版本，验证 wait 路径会先 supersede 旧 pending，而不是撞唯一索引回滚。
    // removeWhen：消息编辑入口落地后改为真实 HTTP 更新。
    await database.db
      .update(schema.taskMessages)
      .set({ body: '暂停期间修订的补充', editedAt: new Date() })
      .where(eq(schema.taskMessages.id, second.id))
    const editedRow = await getTaskMessage(database.db, second.id)
    expect(editedRow).toBeDefined()
    const readmitted = await database.transaction((tx) =>
      admitTaskMessageEntry(tx, editedRow!, workEntryDeps(tx)),
    )
    expect(readmitted).toMatchObject({ outcome: 'wait', reason: 'mandate_inactive' })
    const afterEdit = (await inbox(ctx, alice, workKey)).items.filter(
      (item) => item.sourceId === second.id,
    )
    expect(afterEdit.find((item) => item.id === waiting?.id)).toMatchObject({
      status: 'superseded',
    })
    const revised = afterEdit.find((item) => item.status === 'pending')
    expect(revised).toMatchObject({
      status: 'pending',
      subscriptionId: null,
      supersedesId: waiting?.id,
    })

    const resumed = await apiInject(ctx, alice, {
      method: 'POST',
      url: `/api/v1/mandates/${pausedMandateId}/resume`,
      payload: { reason: '恢复职责' },
      idempotencyKey: idemKey(),
    })
    expect(resumed.statusCode).toBe(200)
    // Mandate 变更只收口订阅，不撤回已保留的 wait 副本；它仍可被下一次 Run 选择。
    expect(
      (await inbox(ctx, alice, workKey)).items.find((item) => item.id === revised?.id),
    ).toMatchObject({ status: 'pending', subscriptionId: null })
    const revoked = await apiInject(ctx, alice, {
      method: 'POST',
      url: `/api/v1/mandates/${resumed.json().data.id}/revoke`,
      payload: { reason: '结束职责' },
      idempotencyKey: idemKey(),
    })
    expect(revoked.statusCode).toBe(200)
    expect(
      (await inbox(ctx, alice, workKey)).items.find((item) => item.id === revised?.id),
    ).toMatchObject({ status: 'pending', subscriptionId: null })
    const after = await counts(database)
    expect(after.routerCalls).toBe(0)
  })

  it('keeps wait copies when a Mandate is created later', async () => {
    const laterTask = await createTask(ctx, alice, projectId, alice.userId)
    await acceptTask(ctx, alice, laterTask)
    const laterWork = await createWork(ctx, alice, laterTask)
    const message = await comment(ctx, bob, laterTask, '授权建立前的补充')
    const waiting = (await inbox(ctx, alice, laterWork)).items.find(
      (item) => item.sourceId === message.id,
    )
    expect(waiting).toMatchObject({ status: 'pending', subscriptionId: null })
    await createMandate(ctx, alice, laterWork)
    expect(
      (await inbox(ctx, alice, laterWork)).items.find((item) => item.id === waiting?.id),
    ).toMatchObject({ status: 'pending', subscriptionId: null })
  })

  it('supersedes the previous pending version of a subscribed business reference', async () => {
    const businessSub = (
      await subscribe(ctx, alice, workKey, 'business_ref', `taskSpec:${taskId}`)
    ).json().data
    await confirmAgreement(ctx, alice, taskId)
    const firstItems = (await inbox(ctx, alice, workKey)).items
    expect(firstItems).toHaveLength(1)
    expect(firstItems[0]).toMatchObject({
      status: 'pending',
      subscriptionId: businessSub.id,
      supersedesId: null,
    })

    await confirmAgreement(ctx, alice, taskId)
    const items = (await inbox(ctx, alice, workKey)).items
    const pending = items.filter((item) => item.status === 'pending')
    const superseded = items.filter((item) => item.status === 'superseded')
    expect(pending).toHaveLength(1)
    expect(superseded).toHaveLength(1)
    expect(superseded[0]).toMatchObject({
      id: firstItems[0]?.id,
      statusReason: 'new_version',
    })
    expect(pending[0]).toMatchObject({
      subscriptionId: businessSub.id,
      supersedesId: firstItems[0]?.id,
    })
    expect((await counts(database)).routerCalls).toBe(0)
  })

  it('stales a subscription and retains a wait copy when the Mandate expires', async () => {
    await comment(ctx, bob, taskId, '过期前的补充')
    const pending = (await inbox(ctx, alice, workKey)).items[0]
    // removeWhen：时间可注入后改为真实时钟推进；当前用协调表故障注入模拟到期。
    await database.db
      .update(schema.workMandates)
      .set({
        createdAt: new Date(Date.now() - 1000),
        expiresAt: new Date(Date.now() - 1),
      })
      .where(eq(schema.workMandates.id, mandate.id))

    const second = await comment(ctx, bob, taskId, '过期后的补充')
    expect((await listSubscriptions(ctx, alice, workKey))[0]).toMatchObject({
      status: 'stale',
      statusReason: 'mandate_expired',
    })
    const expiredItems = (await inbox(ctx, alice, workKey)).items
    expect(expiredItems.find((item) => item.id === pending?.id)).toMatchObject({
      id: pending?.id,
      status: 'retracted',
      statusReason: 'mandate_expired',
    })
    const entries = (await admissions(ctx, alice, workKey)).filter(
      (entry) => entry.sourceId === second.id,
    )
    expect(entries[0]).toMatchObject({
      outcome: 'wait',
      reason: 'mandate_expired',
      routerInvoked: false,
      deadlineAt: expect.any(String),
    })
    const waiting = (await inbox(ctx, alice, workKey)).items.find(
      (item) => item.sourceId === second.id,
    )
    expect(waiting).toMatchObject({ status: 'pending', subscriptionId: null })
    expect((await counts(database)).routerCalls).toBe(0)
  })

  it('rejects subscriptions when the work cannot receive them', async () => {
    // full_access：先在正常 Task 上订阅，再切换到 full_access；清理必须失效订阅。
    const fullTask = await createTask(ctx, alice, projectId, alice.userId)
    await acceptTask(ctx, alice, fullTask)
    const fullWork = await createWork(ctx, alice, fullTask)
    await createMandate(ctx, alice, fullWork)
    await subscribe(ctx, alice, fullWork, 'task', fullTask)
    const beforeSwitch = await comment(ctx, bob, fullTask, 'full_access 切换前的补充')
    const beforeItem = (await inbox(ctx, alice, fullWork)).items.find(
      (item) => item.sourceId === beforeSwitch.id,
    )
    expect(beforeItem).toMatchObject({ status: 'pending', subscriptionId: expect.any(String) })
    const patched = await apiInject(ctx, alice, {
      method: 'PATCH',
      url: `/api/v1/tasks/${fullTask}`,
      payload: { approvalPolicy: 'full_access' },
      idempotencyKey: idemKey(),
    })
    expect(patched.statusCode).toBe(200)
    expect((await listSubscriptions(ctx, alice, fullWork))[0]).toMatchObject({
      status: 'stale',
      statusReason: 'full_access_task',
    })
    expect(
      (await inbox(ctx, alice, fullWork)).items.find((item) => item.id === beforeItem?.id),
    ).toMatchObject({ status: 'retracted', statusReason: 'full_access_task' })
    const fullComment = await comment(ctx, bob, fullTask, 'full_access 下的补充')
    const fullEntry = (await admissions(ctx, alice, fullWork)).find(
      (entry) => entry.sourceId === fullComment.id,
    )
    expect(fullEntry).toMatchObject({
      outcome: 'wait',
      reason: 'full_access_task',
      routerInvoked: false,
    })
    expect((await subscribe(ctx, alice, fullWork, 'task', fullTask, 409)).json().error.code).toBe(
      'CONFLICT',
    )

    // waiting(owner_confirmation)：改派并接受后，新责任人能看到工作但不能订阅。
    const waitTask = await createTask(ctx, alice, projectId, alice.userId)
    await acceptTask(ctx, alice, waitTask)
    const waitWork = await createWork(ctx, alice, waitTask)
    await createMandate(ctx, alice, waitWork)
    await apiInject(ctx, alice, {
      method: 'POST',
      url: `/api/v1/tasks/${waitTask}/reassign`,
      payload: { assigneeUserId: bob.userId },
      idempotencyKey: idemKey(),
    })
    const accepted = await apiInject(ctx, bob, {
      method: 'POST',
      url: `/api/v1/tasks/${waitTask}/accept`,
    })
    expect(accepted.statusCode).toBe(200)
    expect((await subscribe(ctx, bob, waitWork, 'task', waitTask, 409)).json().error.code).toBe(
      'CONFLICT',
    )

    // retired 与 terminal。
    const retiredTask = await createTask(ctx, alice, projectId, alice.userId)
    await acceptTask(ctx, alice, retiredTask)
    const retiredWork = await createWork(ctx, alice, retiredTask)
    await createMandate(ctx, alice, retiredWork)
    await apiInject(ctx, alice, {
      method: 'POST',
      url: `/api/v1/works/${retiredWork}/retire`,
      payload: {},
      idempotencyKey: idemKey(),
    })
    expect(
      (await subscribe(ctx, alice, retiredWork, 'task', retiredTask, 409)).json().error.code,
    ).toBe('CONFLICT')

    const terminalTask = await createTask(ctx, alice, projectId, alice.userId)
    await acceptTask(ctx, alice, terminalTask)
    const terminalWork = await createWork(ctx, alice, terminalTask)
    await createMandate(ctx, alice, terminalWork)
    await apiInject(ctx, alice, {
      method: 'POST',
      url: `/api/v1/tasks/${terminalTask}/cancel`,
      idempotencyKey: idemKey(),
    })
    expect(
      (await subscribe(ctx, alice, terminalWork, 'task', terminalTask, 409)).json().error.code,
    ).toBe('TASK_TERMINAL')
  })

  it('cleans unread copies when the work is retired or the task reaches a terminal state', async () => {
    const retiredTask = await createTask(ctx, alice, projectId, alice.userId)
    await acceptTask(ctx, alice, retiredTask)
    const retiredWork = await createWork(ctx, alice, retiredTask)
    await createMandate(ctx, alice, retiredWork)
    const retiredSub = (await subscribe(ctx, alice, retiredWork, 'task', retiredTask)).json().data
    const retiredMessage = await comment(ctx, bob, retiredTask, '退休前补充')
    const retiredItem = (await inbox(ctx, alice, retiredWork)).items.find(
      (item) => item.sourceId === retiredMessage.id,
    )
    await apiInject(ctx, alice, {
      method: 'POST',
      url: `/api/v1/works/${retiredWork}/retire`,
      payload: {},
      idempotencyKey: idemKey(),
    })
    expect((await listSubscriptions(ctx, alice, retiredWork))[0]).toMatchObject({
      id: retiredSub.id,
      status: 'stale',
      statusReason: 'work_retired',
    })
    expect(
      (await inbox(ctx, alice, retiredWork)).items.find((item) => item.id === retiredItem?.id),
    ).toMatchObject({ status: 'retracted', statusReason: 'work_retired' })

    const terminalTask = await createTask(ctx, alice, projectId, alice.userId)
    await acceptTask(ctx, alice, terminalTask)
    const terminalWork = await createWork(ctx, alice, terminalTask)
    await createMandate(ctx, alice, terminalWork)
    await subscribe(ctx, alice, terminalWork, 'task', terminalTask)
    const terminalMessage = await comment(ctx, bob, terminalTask, '取消前补充')
    const terminalItem = (await inbox(ctx, alice, terminalWork)).items.find(
      (item) => item.sourceId === terminalMessage.id,
    )
    await apiInject(ctx, alice, {
      method: 'POST',
      url: `/api/v1/tasks/${terminalTask}/cancel`,
      idempotencyKey: idemKey(),
    })
    expect((await listSubscriptions(ctx, alice, terminalWork))[0]).toMatchObject({
      status: 'stale',
      statusReason: 'task_terminal',
    })
    expect(
      (await inbox(ctx, alice, terminalWork)).items.find((item) => item.id === terminalItem?.id),
    ).toMatchObject({ status: 'retracted', statusReason: 'task_terminal' })
  })

  it('retracts wait copies when the work lifecycle ends', async () => {
    async function waitCopy(reason: 'work_retired' | 'task_terminal' | 'full_access_task') {
      const task = await createTask(ctx, alice, projectId, alice.userId)
      await acceptTask(ctx, alice, task)
      const work = await createWork(ctx, alice, task)
      const mandate = await createMandate(ctx, alice, work)
      await subscribe(ctx, alice, work, 'task', task)
      const paused = await apiInject(ctx, alice, {
        method: 'POST',
        url: `/api/v1/mandates/${mandate.id}/pause`,
        payload: { reason: '等待期间暂停' },
        idempotencyKey: idemKey(),
      })
      expect(paused.statusCode).toBe(200)
      const message = await comment(ctx, bob, task, '等待期间的自动保留副本')
      const pending = (await inbox(ctx, alice, work)).items.find(
        (item) => item.sourceId === message.id,
      )
      expect(pending).toMatchObject({ status: 'pending', subscriptionId: null })

      if (reason === 'work_retired') {
        const retired = await apiInject(ctx, alice, {
          method: 'POST',
          url: `/api/v1/works/${work}/retire`,
          payload: {},
          idempotencyKey: idemKey(),
        })
        expect(retired.statusCode).toBe(200)
      } else if (reason === 'task_terminal') {
        const cancelled = await apiInject(ctx, alice, {
          method: 'POST',
          url: `/api/v1/tasks/${task}/cancel`,
          idempotencyKey: idemKey(),
        })
        expect(cancelled.statusCode).toBe(200)
      } else {
        const patched = await apiInject(ctx, alice, {
          method: 'PATCH',
          url: `/api/v1/tasks/${task}`,
          payload: { approvalPolicy: 'full_access' },
          idempotencyKey: idemKey(),
        })
        expect(patched.statusCode).toBe(200)
      }

      const after = (await inbox(ctx, alice, work)).items.find(
        (item) => item.sourceId === message.id,
      )
      expect(after).toMatchObject({ status: 'retracted', statusReason: reason })
    }

    await waitCopy('work_retired')
    await waitCopy('task_terminal')
    await waitCopy('full_access_task')
  })

  it('waits without Router while the assignment is pending', async () => {
    const pendingTask = await createTask(ctx, alice, projectId, alice.userId)
    await acceptTask(ctx, alice, pendingTask)
    const pendingWork = await createWork(ctx, alice, pendingTask)
    await createMandate(ctx, alice, pendingWork)
    await subscribe(ctx, alice, pendingWork, 'task', pendingTask)
    const reassigned = await apiInject(ctx, alice, {
      method: 'POST',
      url: `/api/v1/tasks/${pendingTask}/reassign`,
      payload: { assigneeUserId: alice.userId },
      idempotencyKey: idemKey(),
    })
    expect(reassigned.statusCode).toBe(200)
    const message = await comment(ctx, bob, pendingTask, '待接受期间的补充')
    const entry = (await admissions(ctx, alice, pendingWork)).find(
      (row) => row.sourceId === message.id,
    )
    expect(entry).toMatchObject({
      outcome: 'wait',
      reason: 'assignment_pending',
      routerInvoked: false,
      deadlineAt: expect.any(String),
    })
    const waiting = (await inbox(ctx, alice, pendingWork)).items.find(
      (item) => item.sourceId === message.id,
    )
    expect(waiting).toMatchObject({ status: 'pending', subscriptionId: null })
    expect((await counts(database)).routerCalls).toBe(0)
  })

  it('drops sources excluded by the active Mandate instead of routing them', async () => {
    const narrowTask = await createTask(ctx, alice, projectId, alice.userId)
    await acceptTask(ctx, alice, narrowTask)
    const narrowWork = await createWork(ctx, alice, narrowTask)
    await createMandate(ctx, alice, narrowWork, { allowedSourceTypes: ['context_entry'] })
    const message = await comment(ctx, bob, narrowTask, 'Mandate 不允许的 Task 消息')
    const entry = (await admissions(ctx, alice, narrowWork)).find(
      (row) => row.sourceId === message.id,
    )
    expect(entry).toMatchObject({
      outcome: 'drop',
      reason: 'source_not_allowed',
      subscriptionId: null,
      inboxItemId: null,
      routerInvoked: false,
      routerCallId: null,
    })
    expect((await inbox(ctx, alice, narrowWork)).items).toHaveLength(0)
    expect((await counts(database)).routerCalls).toBe(0)
  })

  it('is assignee-only and rejects targets outside the work task', async () => {
    const bobCreate = await apiInject(ctx, bob, {
      method: 'POST',
      url: `/api/v1/works/${workKey}/subscriptions`,
      payload: { targetType: 'task', targetRef: taskId },
      idempotencyKey: idemKey(),
    })
    expect(bobCreate.statusCode).toBe(403)
    const bobList = await apiInject(ctx, bob, {
      method: 'GET',
      url: `/api/v1/works/${workKey}/subscriptions`,
    })
    expect(bobList.statusCode).toBe(403)
    const bobAdmissions = await apiInject(ctx, bob, {
      method: 'GET',
      url: `/api/v1/works/${workKey}/entry-admissions`,
    })
    expect(bobAdmissions.statusCode).toBe(403)
    const bobRevoke = await apiInject(ctx, bob, {
      method: 'POST',
      url: `/api/v1/works/${workKey}/subscriptions/${subscriptionId}/revoke`,
      payload: {},
      idempotencyKey: idemKey(),
    })
    expect(bobRevoke.statusCode).toBe(403)

    const otherTask = await createTask(ctx, alice, projectId, alice.userId)
    await acceptTask(ctx, alice, otherTask)
    await subscribe(ctx, alice, workKey, 'task', otherTask, 409)
    await subscribe(ctx, alice, workKey, 'business_ref', `taskSpec:${otherTask}`, 409)
    await subscribe(
      ctx,
      alice,
      workKey,
      'business_ref',
      'run:01930e00-0000-7000-8000-000000000099',
      400,
    )
    await subscribe(
      ctx,
      alice,
      workKey,
      'business_ref',
      'run:01930e00-0000-7000-8000-000000000099:01930e00-0000-7000-8000-000000000098',
      400,
    )

    const noMandateTask = await createTask(ctx, alice, projectId, alice.userId)
    await acceptTask(ctx, alice, noMandateTask)
    const noMandateWork = await createWork(ctx, alice, noMandateTask)
    const noMandate = await subscribe(ctx, alice, noMandateWork, 'task', noMandateTask, 409)
    expect(noMandate.json().error.message).toContain('no active mandate')

    const narrowTask = await createTask(ctx, alice, projectId, alice.userId)
    await acceptTask(ctx, alice, narrowTask)
    const narrowWork = await createWork(ctx, alice, narrowTask)
    await createMandate(ctx, alice, narrowWork, { allowedSourceTypes: ['context_entry'] })
    const narrow = await subscribe(ctx, alice, narrowWork, 'task', narrowTask, 409)
    expect(narrow.json().error.message).toContain('task messages')
  })

  it('delivers projected business-reference changes and corrections on the fast path', async () => {
    await confirmAgreement(ctx, alice, taskId)
    const spec = await findContextEntry(ctx, alice, projectId, `taskSpec:${taskId}`)
    const businessSub = (
      await subscribe(ctx, alice, workKey, 'business_ref', `taskSpec:${taskId}`)
    ).json().data
    expect(businessSub).toMatchObject({
      targetType: 'business_ref',
      targetRef: `taskSpec:${taskId}`,
      authorizationGeneration: 'internal',
      status: 'active',
    })

    const corrected = await apiInject(ctx, alice, {
      method: 'POST',
      url: `/api/v1/projects/${projectId}/context/${spec.id}/correction`,
      payload: { correctionKind: 'amend', note: '预算改为八万，保留无障碍要求' },
      idempotencyKey: idemKey(),
    })
    expect(corrected.statusCode).toBe(201)
    const correctionId = corrected.json().data.id as string

    const entries = (await admissions(ctx, alice, workKey)).filter(
      (entry) => entry.sourceId === correctionId,
    )
    expect(entries).toHaveLength(1)
    expect(entries[0]).toMatchObject({
      outcome: 'deliver',
      routerInvoked: false,
      subscriptionId: businessSub.id,
    })
    const listed = await inbox(ctx, alice, workKey)
    const correction = listed.items.find((item) => item.sourceId === correctionId)
    expect(correction).toMatchObject({
      sourceType: 'context_entry',
      status: 'pending',
      body: '预算改为八万，保留无障碍要求',
      subscriptionId: businessSub.id,
    })

    const after = await counts(database)
    // 订阅前投影出的 taskSpec Decision 走了一次慢路径；纠正本身必须走快路径。
    expect(after.routerCalls).toBe(1)
    expect(after.routerDecisions).toBe(0)
    expect(entries[0]?.routerCallId).toBeNull()
    expect(after.items).toBe(1)
  })

  it('keeps duplicate submissions idempotent without a second admission or Router call', async () => {
    const key = idemKey()
    const first = await comment(ctx, bob, taskId, '重复提交的同一补充', key)
    const replay = await comment(ctx, bob, taskId, '重复提交的同一补充', key)
    expect(replay.id).toBe(first.id)

    const entries = await admissions(ctx, alice, workKey)
    expect(entries).toHaveLength(1)
    expect(entries[0]).toMatchObject({
      outcome: 'deliver',
      routerInvoked: false,
      inboxItemId: expect.any(String),
    })
    expect((await inbox(ctx, alice, workKey)).items).toHaveLength(1)
    const after = await counts(database)
    expect(after.admissions).toBe(1)
    expect(after.routerCalls).toBe(0)
  })

  it('routes returned inputs to Router while preserving the inbox watermark', async () => {
    const added = await comment(ctx, bob, taskId, '需要退回的新缺口')
    const item = (await inbox(ctx, alice, workKey)).items[0]
    const returned = await apiInject(ctx, alice, {
      method: 'POST',
      url: `/api/v1/works/${workKey}/inbox-items/${item?.id}/return`,
      payload: { reason: 'new_gap', note: '属于另一项工作' },
      idempotencyKey: idemKey(),
    })
    expect(returned.statusCode).toBe(200)
    expect(returned.json().data).toMatchObject({
      id: item?.id,
      status: 'returned',
      returnReason: 'new_gap',
    })

    const entries = await admissions(ctx, alice, workKey)
    const returnAdmission = entries.find((entry) => entry.trigger === 'return')
    expect(returnAdmission).toMatchObject({
      outcome: 'route_router',
      reason: 'returned_new_gap',
      sourceId: added.id,
      inboxItemId: item?.id,
      routerInvoked: true,
    })
    expect(returnAdmission?.routerCallId).toMatch(/^[0-9a-f-]{36}$/)
    expect((await inbox(ctx, alice, workKey)).watermarks.pendingCount).toBe(0)
    const after = await counts(database)
    expect(after.routerCalls).toBe(1)
  })

  it('waits on owner change and retracts copies delivered to the old owner', async () => {
    const paused = await apiInject(ctx, alice, {
      method: 'POST',
      url: `/api/v1/mandates/${mandate.id}/pause`,
      payload: { reason: '改派前暂停' },
      idempotencyKey: idemKey(),
    })
    expect(paused.statusCode).toBe(200)
    const waitMessage = await comment(ctx, bob, taskId, '暂停期间的等待补充')
    const waitCopy = (await inbox(ctx, alice, workKey)).items.find(
      (item) => item.sourceId === waitMessage.id,
    )
    expect(waitCopy).toMatchObject({ status: 'pending', subscriptionId: null })
    const resumed = await apiInject(ctx, alice, {
      method: 'POST',
      url: `/api/v1/mandates/${paused.json().data.id}/resume`,
      payload: { reason: '恢复后重新订阅' },
      idempotencyKey: idemKey(),
    })
    expect(resumed.statusCode).toBe(200)
    await subscribe(ctx, alice, workKey, 'task', taskId)
    const delivered = await comment(ctx, bob, taskId, '改派前的订阅副本')
    const deliveredItem = (await inbox(ctx, alice, workKey)).items.find(
      (item) => item.sourceId === delivered.id,
    )
    expect(deliveredItem).toMatchObject({ status: 'pending', subscriptionId: expect.any(String) })

    const reassigned = await apiInject(ctx, alice, {
      method: 'POST',
      url: `/api/v1/tasks/${taskId}/reassign`,
      payload: { assigneeUserId: bob.userId },
      idempotencyKey: idemKey(),
    })
    expect(reassigned.statusCode).toBe(200)

    const subscriptions = await listSubscriptions(ctx, bob, workKey)
    expect(subscriptions[0]).toMatchObject({
      status: 'stale',
      statusReason: 'owner_changed',
    })
    const afterReassign = (await inbox(ctx, bob, workKey)).items
    expect(afterReassign.find((item) => item.id === deliveredItem?.id)).toMatchObject({
      status: 'retracted',
      statusReason: 'owner_changed',
    })
    expect(afterReassign.find((item) => item.id === waitCopy?.id)).toMatchObject({
      status: 'retracted',
      statusReason: 'owner_changed',
    })

    const second = await comment(ctx, bob, taskId, '改派后的补充')
    const entries = (await admissions(ctx, bob, workKey)).filter(
      (entry) => entry.sourceId === second.id,
    )
    expect(entries[0]).toMatchObject({
      outcome: 'wait',
      reason: 'owner_changed',
      routerInvoked: false,
      deadlineAt: expect.any(String),
      inboxItemId: expect.any(String),
    })
    const waiting = (await inbox(ctx, bob, workKey)).items.find(
      (item) => item.sourceId === second.id,
    )
    expect(waiting).toMatchObject({ status: 'pending', subscriptionId: null })
    const after = await counts(database)
    expect(after.routerCalls).toBe(0)
  })

  it('merges business-reference versions across channels without swallowing corrections', async () => {
    // 先在没有 business_ref 订阅时投影 v1，再显式关联：这是「同一 identity 的旧版本
    // 经由另一通道进入」的混合场景。
    await confirmAgreement(ctx, alice, taskId)
    const v1 = await findContextEntry(ctx, alice, projectId, `taskSpec:${taskId}`)
    const explicit = await associateContext(ctx, alice, workKey, v1.id)
    expect(explicit).toMatchObject({ status: 'pending', subscriptionId: null, supersedesId: null })

    const businessSub = (
      await subscribe(ctx, alice, workKey, 'business_ref', `taskSpec:${taskId}`)
    ).json().data as { id: string }
    await confirmAgreement(ctx, alice, taskId)
    const v2 = await findContextEntry(ctx, alice, projectId, `taskSpec:${taskId}`)
    expect(v2.id).not.toBe(v1.id)
    let items = (await inbox(ctx, alice, workKey)).items
    const explicitAfter = items.find((item) => item.id === explicit.id)
    expect(explicitAfter).toMatchObject({ status: 'superseded', statusReason: 'new_version' })
    const v2Item = items.find((item) => item.sourceId === v2.id)
    expect(v2Item).toMatchObject({
      status: 'pending',
      subscriptionId: businessSub.id,
      supersedesId: explicit.id,
    })

    const correction = await correctContext(
      ctx,
      alice,
      projectId,
      v2.id,
      '预算改为八万，保留无障碍要求',
    )
    items = (await inbox(ctx, alice, workKey)).items
    expect(items.find((item) => item.id === v2Item?.id)).toMatchObject({ status: 'superseded' })
    const correctionItem = items.find((item) => item.sourceId === correction.id)
    expect(correctionItem).toMatchObject({
      status: 'pending',
      subscriptionId: businessSub.id,
      supersedesId: v2Item?.id,
    })

    // v3 不能把人工纠正当成「旧版本」吞掉。
    await confirmAgreement(ctx, alice, taskId)
    const v3 = await findContextEntry(ctx, alice, projectId, `taskSpec:${taskId}`)
    expect(v3.id).not.toBe(v2.id)
    items = (await inbox(ctx, alice, workKey)).items
    expect(items.find((item) => item.id === correctionItem?.id)).toMatchObject({
      status: 'pending',
    })
    const v3Item = items.find((item) => item.sourceId === v3.id)
    expect(v3Item).toMatchObject({ status: 'pending', supersedesId: null })

    // 第二条纠正也只替换它自己的目标版本，不与第一条纠正互相吞并。
    const correction2 = await correctContext(ctx, alice, projectId, v3.id, '补充预算口径')
    items = (await inbox(ctx, alice, workKey)).items
    expect(items.find((item) => item.id === correctionItem?.id)).toMatchObject({
      status: 'pending',
    })
    expect(items.find((item) => item.id === v3Item?.id)).toMatchObject({ status: 'superseded' })
    expect(items.find((item) => item.sourceId === correction2.id)).toMatchObject({
      status: 'pending',
      supersedesId: v3Item?.id,
    })
    expect((await counts(database)).routerCalls).toBe(1)
  })

  it('delivers a Run terminal observation for a subscribed run business reference', async () => {
    const chain = await seedRunChainForUser(database.db, alice.userId)
    const runId = await insertRunRow(database.db, {
      taskId,
      ownerUserId: alice.userId,
      agentId: chain.agentId,
      profileRevisionId: chain.profileRevisionId,
      deviceId: chain.deviceId,
      workspaceId: chain.workspaceId,
    })
    const businessSub = (
      await subscribe(ctx, alice, workKey, 'business_ref', `run:${runId}`)
    ).json().data as { id: string }
    const outbox = new Outbox(database)
    await database.transaction((tx) =>
      applyRunStatus(tx, outbox, runId, 'completed', { finishedAt: new Date() }),
    )

    const observation = await findContextEntry(ctx, alice, projectId, `run:${runId}`)
    const entries = await admissions(ctx, alice, workKey)
    const entry = entries.find((row) => row.sourceId === observation.id)
    expect(entry).toMatchObject({
      outcome: 'deliver',
      subscriptionId: businessSub.id,
      routerInvoked: false,
      routerCallId: null,
    })
    expect(
      (await inbox(ctx, alice, workKey)).items.find((item) => item.sourceId === observation.id),
    ).toMatchObject({ status: 'pending', subscriptionId: businessSub.id })
    expect((await counts(database)).routerCalls).toBe(0)
  })

  it('delivers a published artifact decision for a subscribed artifact business reference', async () => {
    const paired = await pairDevice(ctx, alice)
    const chain = await seedRunChainForUser(database.db, alice.userId)
    const runId = await insertRunRow(database.db, {
      taskId,
      ownerUserId: alice.userId,
      agentId: chain.agentId,
      profileRevisionId: chain.profileRevisionId,
      deviceId: paired.deviceId,
      workspaceId: chain.workspaceId,
    })
    await mkdir(ctx.config.artifactStoreDir, { recursive: true })
    artifactDirs.push(ctx.config.artifactStoreDir)
    const uploaded = await uploadArtifact(ctx, paired.token, runId, Buffer.from('rd02b artifact\n'))
    expect(uploaded.statusCode, uploaded.body).toBe(201)
    const artifactId = uploaded.json().data.id as string
    const businessSub = (
      await subscribe(ctx, alice, workKey, 'business_ref', `artifact:${artifactId}`)
    ).json().data as { id: string }
    const published = await apiInject(ctx, alice, {
      method: 'POST',
      url: `/api/v1/artifacts/${artifactId}/publish`,
      payload: {},
      idempotencyKey: idemKey(),
    })
    expect(published.statusCode, published.body).toBe(200)

    const decision = await findContextEntry(ctx, alice, projectId, `artifact:${artifactId}`)
    const entry = (await admissions(ctx, alice, workKey)).find(
      (row) => row.sourceId === decision.id,
    )
    expect(entry).toMatchObject({
      outcome: 'deliver',
      subscriptionId: businessSub.id,
      routerInvoked: false,
      routerCallId: null,
    })
    expect(
      (await inbox(ctx, alice, workKey)).items.find((item) => item.sourceId === decision.id),
    ).toMatchObject({ status: 'pending', subscriptionId: businessSub.id })
    expect((await counts(database)).routerCalls).toBe(0)
  })

  it('stops delivery and stales the subscription when the assignee is disabled', async () => {
    const disabledTask = await createTask(ctx, alice, projectId, bob.userId)
    await acceptTask(ctx, bob, disabledTask)
    const disabledWork = await createWork(ctx, bob, disabledTask)
    const disabledMandate = await createMandate(ctx, bob, disabledWork)
    const paused = await apiInject(ctx, bob, {
      method: 'POST',
      url: `/api/v1/mandates/${disabledMandate.id}/pause`,
      payload: { reason: '停用前暂停' },
      idempotencyKey: idemKey(),
    })
    expect(paused.statusCode).toBe(200)
    const beforeDisable = await comment(ctx, alice, disabledTask, '停用前的等待补充')
    const waitCopy = (await inbox(ctx, bob, disabledWork)).items.find(
      (item) => item.sourceId === beforeDisable.id,
    )
    expect(waitCopy).toMatchObject({ status: 'pending', subscriptionId: null })
    const resumed = await apiInject(ctx, bob, {
      method: 'POST',
      url: `/api/v1/mandates/${paused.json().data.id}/resume`,
      payload: { reason: '恢复后重新订阅' },
      idempotencyKey: idemKey(),
    })
    expect(resumed.statusCode).toBe(200)
    const disabledSub = (await subscribe(ctx, bob, disabledWork, 'task', disabledTask)).json()
      .data as { id: string }

    const disabled = await apiInject(ctx, alice, {
      method: 'POST',
      url: `/api/v1/team/members/${bob.userId}/disable`,
      payload: {},
      idempotencyKey: idemKey(),
    })
    expect(disabled.statusCode).toBe(200)
    const message = await comment(ctx, alice, disabledTask, '停用责任人后的补充')

    const [entry] = await database.db
      .select()
      .from(schema.workEntryAdmissions)
      .where(eq(schema.workEntryAdmissions.sourceId, message.id))
    expect(entry).toMatchObject({
      outcome: 'wait',
      reason: 'assignee_inactive',
      subscriptionId: null,
      routerInvoked: false,
    })
    const [subscription] = await database.db
      .select()
      .from(schema.workSubscriptions)
      .where(eq(schema.workSubscriptions.id, disabledSub.id))
    expect(subscription).toMatchObject({
      status: 'stale',
      statusReason: 'assignee_inactive',
    })
    const items = await database.db
      .select()
      .from(schema.workInboxItems)
      .where(eq(schema.workInboxItems.sourceId, message.id))
    expect(items).toHaveLength(0)
    const oldItems = await database.db
      .select()
      .from(schema.workInboxItems)
      .where(eq(schema.workInboxItems.sourceId, beforeDisable.id))
    expect(oldItems).toHaveLength(1)
    expect(oldItems[0]).toMatchObject({
      status: 'retracted',
      statusReason: 'assignee_inactive',
    })
    expect((await counts(database)).routerCalls).toBe(0)
  })

  it('records drop instead of delivering a message whose author was disabled', async () => {
    const dropTask = await createTask(ctx, alice, projectId, alice.userId)
    await acceptTask(ctx, alice, dropTask)
    // 工作尚未建立时留下消息；建立工作后再撤掉作者资格。
    // removeWhen：来源生命周期的准入钩子能直接产出 source_inactive 后删除该故障注入。
    const message = await comment(ctx, bob, dropTask, '作者随后被停用的补充')
    const dropWork = await createWork(ctx, alice, dropTask)
    const disabled = await apiInject(ctx, alice, {
      method: 'POST',
      url: `/api/v1/team/members/${bob.userId}/disable`,
      payload: {},
      idempotencyKey: idemKey(),
    })
    expect(disabled.statusCode).toBe(200)
    const row = await getTaskMessage(database.db, message.id)
    expect(row).toBeDefined()
    const admission = await database.transaction((tx) =>
      admitTaskMessageEntry(tx, row!, workEntryDeps(tx)),
    )
    expect(admission).toMatchObject({
      outcome: 'drop',
      reason: 'source_inactive',
      subscriptionId: null,
      inboxItemId: null,
      routerInvoked: false,
    })
    expect((await inbox(ctx, alice, dropWork)).items).toHaveLength(0)
    expect((await counts(database)).routerCalls).toBe(0)
  })

  it('routes a returned copy on its own retired work, not the task current work', async () => {
    const returnTask = await createTask(ctx, alice, projectId, alice.userId)
    await acceptTask(ctx, alice, returnTask)
    const oldWork = await createWork(ctx, alice, returnTask)
    const message = await comment(ctx, alice, returnTask, '退休后退回的旧工作补充')
    const autoItem = (await inbox(ctx, alice, oldWork)).items.find(
      (item) => item.sourceId === message.id,
    )
    expect(autoItem).toBeDefined()
    const adopted = await apiInject(ctx, alice, {
      method: 'POST',
      url: `/api/v1/works/${oldWork}/inbox-items`,
      payload: { sourceType: 'task_message', sourceId: message.id },
      idempotencyKey: idemKey(),
    })
    expect(adopted.statusCode).toBe(201)
    expect(adopted.json().data).toMatchObject({ id: autoItem?.id, status: 'pending' })

    const retired = await apiInject(ctx, alice, {
      method: 'POST',
      url: `/api/v1/works/${oldWork}/retire`,
      payload: {},
      idempotencyKey: idemKey(),
    })
    expect(retired.statusCode).toBe(200)
    const nextWork = await createWork(ctx, alice, returnTask)

    const returned = await apiInject(ctx, alice, {
      method: 'POST',
      url: `/api/v1/works/${oldWork}/inbox-items/${autoItem?.id}/return`,
      payload: { reason: 'new_gap', note: '归属旧工作' },
      idempotencyKey: idemKey(),
    })
    expect(returned.statusCode, returned.body).toBe(200)
    const returnAdmission = (await admissions(ctx, alice, oldWork)).find(
      (entry) => entry.trigger === 'return',
    )
    expect(returnAdmission).toMatchObject({
      outcome: 'route_router',
      inboxItemId: autoItem?.id,
      routerInvoked: true,
    })
    expect(
      (await admissions(ctx, alice, nextWork)).some((entry) => entry.trigger === 'return'),
    ).toBe(false)
    const [oldWorkRow] = await database.db
      .select()
      .from(schema.works)
      .where(eq(schema.works.workKey, oldWork))
    const [call] = await database.db
      .select()
      .from(schema.workEntryRouterCalls)
      .where(eq(schema.workEntryRouterCalls.sourceId, message.id))
    expect(call?.workId).toBe(oldWorkRow?.id)
    expect((await counts(database)).routerCalls).toBe(1)
  })
})
