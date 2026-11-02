/**
 * ADR-0028（RD-02a-1）：工作收件箱条目与显式关联的集成判据。
 *
 * 驱动走生产 HTTP（成员建工作、从真实 Task 消息/context entry 关联来源、退回/撤权/过期），
 * 断言只读协调表与业务计数。收件箱条目只存来源私有快照，不建 Run、不写 outbox/team_event、
 * 不调模型；RD-02a-2 的交付/消费字段不在本切片。
 */
import { randomUUID } from 'node:crypto'
import { eq } from 'drizzle-orm'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { Database } from '@whalepod/db'
import { insertAgent, insertMessage, schema } from '@whalepod/db'
import {
  apiInject,
  createTestApp,
  createTestDatabase,
  driveInviteAndAccept,
  driveSetup,
  idemKey,
  resetDatabase,
  type Session,
  type TestApp,
} from './helpers.js'

const GOAL = '持续整理场地比较与预算变化，产出可审阅草稿'

async function createProject(ctx: TestApp, session: Session): Promise<string> {
  const res = await apiInject(ctx, session, {
    method: 'POST',
    url: '/api/v1/projects',
    payload: { name: `rd02a-${Date.now()}-${randomUUID().slice(0, 6)}` },
  })
  expect(res.statusCode).toBe(201)
  return res.json().data.id as string
}

async function createTask(
  ctx: TestApp,
  session: Session,
  projectId: string,
  assigneeUserId: string,
  title = '场地与预算持续工作',
): Promise<string> {
  const res = await apiInject(ctx, session, {
    method: 'POST',
    url: `/api/v1/projects/${projectId}/tasks`,
    payload: { title, assigneeUserId },
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

async function comment(ctx: TestApp, session: Session, taskId: string): Promise<string> {
  const res = await apiInject(ctx, session, {
    method: 'POST',
    url: `/api/v1/tasks/${taskId}/comments`,
    payload: { body: '场地新增了一个候选，预算需要重算。' },
    idempotencyKey: idemKey(),
  })
  expect(res.statusCode).toBe(201)
  return res.json().data.id as string
}

async function associate(
  ctx: TestApp,
  session: Session,
  workKey: string,
  sourceType: 'task_message' | 'context_entry',
  sourceId: string,
  expectedStatus = 201,
  key = idemKey(),
) {
  const res = await apiInject(ctx, session, {
    method: 'POST',
    url: `/api/v1/works/${workKey}/inbox-items`,
    payload: { sourceType, sourceId },
    idempotencyKey: key,
  })
  expect(res.statusCode).toBe(expectedStatus)
  return res
}

async function inbox(ctx: TestApp, session: Session, workKey: string, query = '') {
  const res = await apiInject(ctx, session, {
    method: 'GET',
    url: `/api/v1/works/${workKey}/inbox${query}`,
  })
  expect(res.statusCode).toBe(200)
  return res.json().data as {
    items: Array<Record<string, unknown>>
    watermarks: { lastItemAt: string | null; pendingCount: number }
  }
}

async function act(
  ctx: TestApp,
  session: Session,
  workKey: string,
  itemId: string,
  action: 'return' | 'retract' | 'expire',
  payload: Record<string, unknown>,
  expectedStatus = 200,
) {
  const res = await apiInject(ctx, session, {
    method: 'POST',
    url: `/api/v1/works/${workKey}/inbox-items/${itemId}/${action}`,
    payload,
    idempotencyKey: idemKey(),
  })
  expect(res.statusCode).toBe(expectedStatus)
  return res
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
  expect(draft.statusCode).toBe(200)
  const confirmed = await apiInject(ctx, session, {
    method: 'POST',
    url: `/api/v1/tasks/${task}/agreement/confirm`,
    payload: { draftVersion: draft.json().data.draftVersion },
    idempotencyKey: idemKey(),
  })
  expect(confirmed.statusCode).toBe(200)
}

async function countRows(database: Database): Promise<{
  runs: number
  outbox: number
  teamEvents: number
  contextEntries: number
  artifacts: number
  specRevisions: number
}> {
  const [runs, outbox, teamEvents, contextEntries, artifacts, specRevisions] = await Promise.all([
    database.db.select().from(schema.runs),
    database.db.select().from(schema.dispatchOutbox),
    database.db.select().from(schema.teamEvents),
    database.db.select().from(schema.contextEntries),
    database.db.select().from(schema.artifacts),
    database.db.select().from(schema.taskSpecRevisions),
  ])
  return {
    runs: runs.length,
    outbox: outbox.length,
    teamEvents: teamEvents.length,
    contextEntries: contextEntries.length,
    artifacts: artifacts.length,
    specRevisions: specRevisions.length,
  }
}

describe('RD-02a-1 work inbox items (ADR-0028)', () => {
  let database: Database
  let ctx: TestApp
  let alice: Session
  let bob: Session
  let projectId: string
  let taskId: string
  let workKey: string

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
  })

  afterEach(async () => {
    await ctx.app.close()
  })

  afterAll(async () => {
    await database.close()
  })

  it('is assignee-only for association, listing and lifecycle actions', async () => {
    const messageId = await comment(ctx, alice, taskId)

    const bobAssociate = await associate(ctx, bob, workKey, 'task_message', messageId, 403)
    expect(bobAssociate.json().error.code).toBe('FORBIDDEN')

    const item = (await associate(ctx, alice, workKey, 'task_message', messageId)).json().data

    const bobList = await apiInject(ctx, bob, {
      method: 'GET',
      url: `/api/v1/works/${workKey}/inbox`,
    })
    expect(bobList.statusCode).toBe(403)
    await act(ctx, bob, workKey, item.id, 'return', { reason: 'irrelevant' }, 403)
    await act(ctx, bob, workKey, item.id, 'retract', {}, 403)
    await act(ctx, bob, workKey, item.id, 'expire', {}, 403)

    const stillPending = await inbox(ctx, alice, workKey)
    expect(stillPending.items).toHaveLength(1)
    expect(stillPending.items[0]).toMatchObject({ id: item.id, status: 'pending' })

    const otherTask = await createTask(ctx, alice, projectId, alice.userId)
    await acceptTask(ctx, alice, otherTask)
    const otherWork = await createWork(ctx, alice, otherTask)
    const wrongWork = await act(
      ctx,
      alice,
      otherWork,
      item.id,
      'return',
      { reason: 'irrelevant' },
      404,
    )
    expect(wrongWork.json().error.code).toBe('NOT_FOUND')
  })

  it('associates an explicit source with a private snapshot and is idempotent by identity', async () => {
    const empty = await inbox(ctx, alice, workKey)
    expect(empty.items).toHaveLength(0)
    expect(empty.watermarks).toEqual({ lastItemAt: null, pendingCount: 0 })

    const messageId = await comment(ctx, alice, taskId)
    const before = await countRows(database)

    const first = await associate(ctx, alice, workKey, 'task_message', messageId)
    expect(first.headers['cache-control']).toBe('private, no-store')
    const item = first.json().data
    expect(item).toMatchObject({
      workKey,
      sourceType: 'task_message',
      sourceId: messageId,
      status: 'pending',
      title: 'Task 讨论消息',
      body: '场地新增了一个候选，预算需要重算。',
      authorizationGeneration: 'member',
      supersedesId: null,
      returnReason: null,
      returnNote: null,
    })
    expect(item.sourceDigest).toMatch(/^[a-f0-9]{64}$/)
    expect(item.bodyDigest).toMatch(/^[a-f0-9]{64}$/)
    expect(item.bodyDigest).not.toBe(item.sourceDigest)

    const replay = await associate(ctx, alice, workKey, 'task_message', messageId)
    expect(replay.json().data.id).toBe(item.id)
    const rows = await database.db.select().from(schema.workInboxItems)
    expect(rows).toHaveLength(1)

    const listedResponse = await apiInject(ctx, alice, {
      method: 'GET',
      url: `/api/v1/works/${workKey}/inbox`,
    })
    expect(listedResponse.statusCode).toBe(200)
    expect(listedResponse.headers['cache-control']).toBe('private, no-store')
    const listed = listedResponse.json().data
    expect(listed.items).toHaveLength(1)
    expect(listed.watermarks.pendingCount).toBe(1)
    expect(listed.watermarks.lastItemAt).toBe(item.createdAt)

    const onlyPending = await inbox(ctx, alice, workKey, '?status=pending&limit=10')
    expect(onlyPending.items).toHaveLength(1)
    const onlyReturned = await inbox(ctx, alice, workKey, '?status=returned')
    expect(onlyReturned.items).toHaveLength(0)
    expect(onlyReturned.watermarks.pendingCount).toBe(1)
    expect(onlyReturned.watermarks.lastItemAt).toBe(item.createdAt)

    const limited = await inbox(ctx, alice, workKey, '?limit=1')
    expect(limited.items).toHaveLength(1)
    const badFilter = await apiInject(ctx, alice, {
      method: 'GET',
      url: `/api/v1/works/${workKey}/inbox?status=unknown`,
    })
    expect(badFilter.statusCode).toBe(400)
    const badLimit = await apiInject(ctx, alice, {
      method: 'GET',
      url: `/api/v1/works/${workKey}/inbox?limit=0`,
    })
    expect(badLimit.statusCode).toBe(400)

    expect(await countRows(database)).toEqual(before)
  })

  it('serializes concurrent association of the same source into one item', async () => {
    const messageId = await comment(ctx, alice, taskId)
    const [first, second] = await Promise.all([
      associate(ctx, alice, workKey, 'task_message', messageId),
      associate(ctx, alice, workKey, 'task_message', messageId),
    ])
    expect(first.json().data.id).toBe(second.json().data.id)
    const rows = await database.db.select().from(schema.workInboxItems)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ status: 'pending' })
  })

  it('supersedes the pending item when the same source gains a new version', async () => {
    const messageId = await comment(ctx, alice, taskId)
    const first = (await associate(ctx, alice, workKey, 'task_message', messageId)).json().data

    // 生产面在本切片还没有“编辑消息”的 HTTP 路径；这条 fixture 只改业务消息本身来
    // 制造同一来源的新版本，不写任何运行时投影。消息编辑落地后删除该直写。
    const editedAt = new Date(Date.now() + 1000)
    await database.db
      .update(schema.taskMessages)
      .set({ body: '场地候选缩减为两个，预算需要按新口径重算。', editedAt })
      .where(eq(schema.taskMessages.id, messageId))

    const second = (await associate(ctx, alice, workKey, 'task_message', messageId)).json().data
    expect(second.id).not.toBe(first.id)
    expect(second.supersedesId).toBe(first.id)
    expect(second.status).toBe('pending')
    expect(second.sourceDigest).not.toBe(first.sourceDigest)
    expect(second.body).toContain('候选缩减为两个')

    const rows = await database.db.select().from(schema.workInboxItems)
    expect(rows).toHaveLength(2)
    const old = rows.find((row) => row.id === first.id)
    expect(old).toMatchObject({ status: 'superseded', statusReason: 'new_version' })

    const pending = await inbox(ctx, alice, workKey, '?status=pending')
    expect(pending.items.map((row) => row.id)).toEqual([second.id])
    expect(pending.watermarks.pendingCount).toBe(1)
    const all = await inbox(ctx, alice, workKey)
    expect(all.items).toHaveLength(2)
    await act(ctx, alice, workKey, first.id, 'return', { reason: 'irrelevant' }, 409)
    await act(ctx, alice, workKey, first.id, 'retract', {}, 409)
    await act(ctx, alice, workKey, first.id, 'expire', {}, 409)
  })

  it('returns an item with a reason and only re-enters through a new version', async () => {
    const messageId = await comment(ctx, alice, taskId)
    const item = (await associate(ctx, alice, workKey, 'task_message', messageId)).json().data

    const returned = await act(ctx, alice, workKey, item.id, 'return', {
      reason: 'incomplete',
      note: '缺少预算版本与供应商候选',
    })
    expect(returned.json().data).toMatchObject({
      id: item.id,
      status: 'returned',
      returnReason: 'incomplete',
      returnNote: '缺少预算版本与供应商候选',
      statusReason: 'returned_by_assignee',
    })

    const sameReturn = await act(ctx, alice, workKey, item.id, 'return', {
      reason: 'incomplete',
      note: '缺少预算版本与供应商候选',
    })
    expect(sameReturn.json().data.id).toBe(item.id)
    await act(
      ctx,
      alice,
      workKey,
      item.id,
      'return',
      { reason: 'incomplete', note: '另一条理由' },
      409,
    )
    await act(ctx, alice, workKey, item.id, 'expire', {}, 409)

    // 同一身份重放关联不复活已退回条目。
    const replay = await associate(ctx, alice, workKey, 'task_message', messageId)
    expect(replay.json().data).toMatchObject({ id: item.id, status: 'returned' })

    // 新版本进入新 pending，旧退回条目保留原判定。
    const editedAt = new Date(Date.now() + 1000)
    await database.db
      .update(schema.taskMessages)
      .set({ body: '补充：预算 8 万，候选为 A/B。', editedAt })
      .where(eq(schema.taskMessages.id, messageId))
    const next = (await associate(ctx, alice, workKey, 'task_message', messageId)).json().data
    expect(next.status).toBe('pending')
    expect(next.supersedesId).toBeNull()

    const rows = await database.db.select().from(schema.workInboxItems)
    expect(rows.find((row) => row.id === item.id)).toMatchObject({ status: 'returned' })

    const pending = await inbox(ctx, alice, workKey, '?status=pending')
    expect(pending.items.map((row) => row.id)).toEqual([next.id])

    // 关联命令的幂等回执不能把已撤权条目显示成仍 pending。
    const replayKey = idemKey()
    const replayMessage = await comment(ctx, alice, taskId)
    const firstAssociation = await associate(
      ctx,
      alice,
      workKey,
      'task_message',
      replayMessage,
      201,
      replayKey,
    )
    expect(firstAssociation.json().data.id).toBeDefined()
    await act(ctx, alice, workKey, firstAssociation.json().data.id, 'retract', {
      reason: 'source_permission_revoked',
    })
    const refreshedReplay = await apiInject(ctx, alice, {
      method: 'POST',
      url: `/api/v1/works/${workKey}/inbox-items`,
      payload: { sourceType: 'task_message', sourceId: replayMessage },
      idempotencyKey: replayKey,
    })
    expect(refreshedReplay.statusCode).toBe(201)
    expect(refreshedReplay.json().data).toMatchObject({
      id: firstAssociation.json().data.id,
      status: 'retracted',
    })
  })

  it('retracts and expires items explicitly and idempotently', async () => {
    const retainedMessage = await comment(ctx, alice, taskId)
    const retractedItem = (
      await associate(ctx, alice, workKey, 'task_message', retainedMessage)
    ).json().data
    const retracted = await act(ctx, alice, workKey, retractedItem.id, 'retract', {
      reason: 'source_permission_revoked',
    })
    expect(retracted.json().data).toMatchObject({
      status: 'retracted',
      statusReason: 'source_permission_revoked',
      returnReason: null,
    })
    const retractedAgain = await act(ctx, alice, workKey, retractedItem.id, 'retract', {})
    expect(retractedAgain.json().data).toMatchObject({ id: retractedItem.id, status: 'retracted' })
    await act(ctx, alice, workKey, retractedItem.id, 'return', { reason: 'irrelevant' }, 409)
    await act(ctx, alice, workKey, retractedItem.id, 'expire', {}, 409)

    const expiringMessage = await comment(ctx, alice, taskId)
    const expiringItem = (
      await associate(ctx, alice, workKey, 'task_message', expiringMessage)
    ).json().data
    const expired = await act(ctx, alice, workKey, expiringItem.id, 'expire', {
      reason: 'deadline_passed',
    })
    expect(expired.json().data).toMatchObject({
      status: 'expired',
      statusReason: 'deadline_passed',
    })
    const expiredAgain = await act(ctx, alice, workKey, expiringItem.id, 'expire', {})
    expect(expiredAgain.json().data).toMatchObject({ id: expiringItem.id, status: 'expired' })
    await act(ctx, alice, workKey, expiringItem.id, 'return', { reason: 'irrelevant' }, 409)
    await act(ctx, alice, workKey, expiringItem.id, 'retract', {}, 409)

    // returned 也能撤权：撤权必须清掉退回原因，避免 DB 的 return 字段约束被绕过。
    const returnedMessage = await comment(ctx, alice, taskId)
    const returnedItem = (
      await associate(ctx, alice, workKey, 'task_message', returnedMessage)
    ).json().data
    await act(ctx, alice, workKey, returnedItem.id, 'return', { reason: 'conflict' })
    const retractedReturned = await act(ctx, alice, workKey, returnedItem.id, 'retract', {
      reason: 'source_permission_revoked',
    })
    expect(retractedReturned.json().data).toMatchObject({
      id: returnedItem.id,
      status: 'retracted',
      returnReason: null,
      returnNote: null,
    })

    const listed = await inbox(ctx, alice, workKey)
    expect(listed.items.map((row) => row.status).sort()).toEqual([
      'expired',
      'retracted',
      'retracted',
    ])
    expect(listed.watermarks.pendingCount).toBe(0)
  })

  it('keeps a retracted source from re-entering through a new version', async () => {
    const messageId = await comment(ctx, alice, taskId)
    const item = (await associate(ctx, alice, workKey, 'task_message', messageId)).json().data
    await act(ctx, alice, workKey, item.id, 'retract', { reason: 'source_permission_revoked' })

    const editedAt = new Date(Date.now() + 1000)
    await database.db
      .update(schema.taskMessages)
      .set({ body: '撤权后供应商仍试图提供新版本。', editedAt })
      .where(eq(schema.taskMessages.id, messageId))
    const blocked = await associate(ctx, alice, workKey, 'task_message', messageId, 409)
    expect(blocked.json().error).toMatchObject({
      code: 'CONFLICT',
      details: { reason: 'source_retracted', sourceId: messageId },
    })

    const rows = await database.db.select().from(schema.workInboxItems)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ id: item.id, status: 'retracted' })
    const listed = await inbox(ctx, alice, workKey)
    expect(listed.watermarks.pendingCount).toBe(0)
  })

  it('rejects idempotent replay by the former assignee after reassignment', async () => {
    const messageId = await comment(ctx, alice, taskId)
    const associateKey = idemKey()
    const item = (
      await associate(ctx, alice, workKey, 'task_message', messageId, 201, associateKey)
    ).json().data
    const returnKey = idemKey()
    const returned = await apiInject(ctx, alice, {
      method: 'POST',
      url: `/api/v1/works/${workKey}/inbox-items/${item.id}/return`,
      payload: { reason: 'incomplete' },
      idempotencyKey: returnKey,
    })
    expect(returned.statusCode).toBe(200)

    const reassign = await apiInject(ctx, alice, {
      method: 'POST',
      url: `/api/v1/tasks/${taskId}/reassign`,
      payload: { assigneeUserId: bob.userId },
      idempotencyKey: idemKey(),
    })
    expect(reassign.statusCode).toBe(200)

    // 回执命中不会执行命令体里的 assignee 校验；重放回读必须重新授权。
    const associateReplay = await apiInject(ctx, alice, {
      method: 'POST',
      url: `/api/v1/works/${workKey}/inbox-items`,
      payload: { sourceType: 'task_message', sourceId: messageId },
      idempotencyKey: associateKey,
    })
    expect(associateReplay.statusCode).toBe(403)
    expect(associateReplay.json().error.code).toBe('FORBIDDEN')

    const returnReplay = await apiInject(ctx, alice, {
      method: 'POST',
      url: `/api/v1/works/${workKey}/inbox-items/${item.id}/return`,
      payload: { reason: 'incomplete' },
      idempotencyKey: returnKey,
    })
    expect(returnReplay.statusCode).toBe(403)

    const bobInbox = await inbox(ctx, bob, workKey)
    expect(bobInbox.items).toHaveLength(1)
    expect(bobInbox.items[0]).toMatchObject({ id: item.id, status: 'returned' })
    const bobRetract = await act(ctx, bob, workKey, item.id, 'retract', {})
    expect(bobRetract.json().data).toMatchObject({ id: item.id, status: 'retracted' })
  })

  it('clamps a long emoji title instead of rejecting a valid context entry', async () => {
    const emojiTask = await createTask(ctx, alice, projectId, alice.userId, '😀'.repeat(100))
    await acceptTask(ctx, alice, emojiTask)
    const emojiWork = await createWork(ctx, alice, emojiTask)
    await confirmAgreement(ctx, alice, emojiTask)
    const context = await apiInject(ctx, alice, {
      method: 'GET',
      url: `/api/v1/projects/${projectId}/context`,
    })
    const entry = (context.json().data.entries as Array<Record<string, unknown>>).find(
      (row) => row.kind === 'decision' && row.businessRef === `taskSpec:${emojiTask}`,
    )
    expect(entry).toBeDefined()
    const res = await associate(ctx, alice, emojiWork, 'context_entry', entry?.id as string)
    const view = res.json().data
    expect(view.title.length).toBeLessThanOrEqual(200)
    expect(view.title.endsWith('😀')).toBe(true)
  })

  it('rejects already-directed, foreign and terminal sources instead of dropping them silently', async () => {
    const agent = await insertAgent(database.db, {
      id: randomUUID(),
      name: `inbox-agent-${randomUUID().slice(0, 8)}`,
      createdBy: alice.userId,
    })
    const instruction = await insertMessage(database.db, {
      id: randomUUID(),
      taskId,
      authorUserId: alice.userId,
      body: '按现有约定再跑一次',
      kind: 'instruction',
      origin: 'human',
      targetAgentId: agent.id,
      instructionState: 'pending',
    })
    const instructionResult = await associate(
      ctx,
      alice,
      workKey,
      'task_message',
      instruction.id,
      409,
    )
    expect(instructionResult.json().error).toMatchObject({
      code: 'CONFLICT',
      details: { reason: 'already_directed' },
    })

    const secondTask = await createTask(ctx, alice, projectId, alice.userId)
    await acceptTask(ctx, alice, secondTask)
    const foreignMessage = await comment(ctx, alice, secondTask)
    const foreignResult = await associate(ctx, alice, workKey, 'task_message', foreignMessage, 409)
    expect(foreignResult.json().error.code).toBe('CONFLICT')

    const unknown = await associate(ctx, alice, workKey, 'task_message', randomUUID(), 404)
    expect(unknown.json().error.code).toBe('NOT_FOUND')

    const cancelled = await apiInject(ctx, alice, {
      method: 'POST',
      url: `/api/v1/tasks/${taskId}/cancel`,
    })
    expect(cancelled.statusCode).toBe(200)
    const terminalMessage = await comment(ctx, alice, taskId)
    const terminal = await associate(ctx, alice, workKey, 'task_message', terminalMessage, 409)
    expect(terminal.json().error.code).toBe('TASK_TERMINAL')

    expect(await database.db.select().from(schema.workInboxItems)).toHaveLength(0)
  })

  it('rejects association on a retired work but still allows closing pending items', async () => {
    const pendingMessage = await comment(ctx, alice, taskId)
    const pending = (await associate(ctx, alice, workKey, 'task_message', pendingMessage)).json()
      .data

    const retired = await apiInject(ctx, alice, {
      method: 'POST',
      url: `/api/v1/works/${workKey}/retire`,
      payload: {},
      idempotencyKey: idemKey(),
    })
    expect(retired.statusCode).toBe(200)

    // 工作退休后不能再收新条目，但人工仍必须能把遗留 pending 收口。
    const messageId = await comment(ctx, alice, taskId)
    const res = await associate(ctx, alice, workKey, 'task_message', messageId, 409)
    expect(res.json().error.code).toBe('CONFLICT')
    const closed = await act(ctx, alice, workKey, pending.id, 'expire', {})
    expect(closed.json().data).toMatchObject({ id: pending.id, status: 'expired' })
  })

  it('applies the same source rules to context entries', async () => {
    await confirmAgreement(ctx, alice, taskId)
    const context = await apiInject(ctx, alice, {
      method: 'GET',
      url: `/api/v1/projects/${projectId}/context`,
    })
    const entry = (context.json().data.entries as Array<Record<string, unknown>>).find(
      (row) => row.kind === 'decision' && row.businessRef === `taskSpec:${taskId}`,
    )
    expect(entry).toBeDefined()
    const entryId = entry?.id as string

    const item = (await associate(ctx, alice, workKey, 'context_entry', entryId)).json().data
    expect(item).toMatchObject({
      sourceType: 'context_entry',
      sourceId: entryId,
      title: expect.any(String),
      status: 'pending',
    })
    expect(item.sourceDigest).toMatch(/^[a-f0-9]{64}$/)
    expect(item.refs).toMatchObject({ entryKind: 'decision' })

    const correction = await apiInject(ctx, alice, {
      method: 'POST',
      url: `/api/v1/projects/${projectId}/context/${entryId}/correction`,
      payload: { correctionKind: 'amend', note: '预算口径改为含税价' },
      idempotencyKey: idemKey(),
    })
    expect(correction.statusCode).toBe(201)
    // 关联是快照：来源后来被纠正不会自动改写既有 pending；由人工 retract 或 #490 交付前重验收口。
    const afterCorrection = await inbox(ctx, alice, workKey, '?status=pending')
    expect(afterCorrection.items).toHaveLength(1)
    expect(afterCorrection.items[0]).toMatchObject({ id: item.id, status: 'pending' })
    const corrected = await associate(ctx, alice, workKey, 'context_entry', entryId, 409)
    expect(corrected.json().error).toMatchObject({
      code: 'CONFLICT',
      details: { reason: 'source_inactive', detail: 'corrected' },
    })
    const closed = await act(ctx, alice, workKey, item.id, 'retract', {
      reason: 'source_corrected',
    })
    expect(closed.json().data).toMatchObject({ id: item.id, status: 'retracted' })

    const correctedContext = await apiInject(ctx, alice, {
      method: 'GET',
      url: `/api/v1/projects/${projectId}/context`,
    })
    const correctionEntry = (
      correctedContext.json().data.entries as Array<Record<string, unknown>>
    ).find((row) => row.kind === 'correction' && row.targetEntryId === entryId)
    expect(correctionEntry).toBeDefined()
    const correctionItem = (
      await associate(ctx, alice, workKey, 'context_entry', correctionEntry?.id as string)
    ).json().data
    expect(correctionItem).toMatchObject({
      sourceType: 'context_entry',
      refs: { entryKind: 'correction' },
      status: 'pending',
    })

    const secondTask = await createTask(ctx, alice, projectId, alice.userId)
    await acceptTask(ctx, alice, secondTask)
    await confirmAgreement(ctx, alice, secondTask)
    const evaluated = await apiInject(ctx, alice, {
      method: 'POST',
      url: `/api/v1/projects/${projectId}/coordination/evaluate`,
      payload: {},
      idempotencyKey: idemKey(),
    })
    expect(evaluated.statusCode).toBe(200)
    const after = await apiInject(ctx, alice, {
      method: 'GET',
      url: `/api/v1/projects/${projectId}/context`,
    })
    const entries = after.json().data.entries as Array<Record<string, unknown>>
    const inference = entries.find((row) => row.kind === 'inference')
    expect(inference).toBeDefined()
    const inferenceResult = await associate(
      ctx,
      alice,
      workKey,
      'context_entry',
      inference?.id as string,
      409,
    )
    expect(inferenceResult.json().error).toMatchObject({
      code: 'CONFLICT',
      details: { reason: 'system_produced' },
    })

    const foreign = entries.find(
      (row) => row.kind === 'decision' && row.businessRef === `taskSpec:${secondTask}`,
    )
    expect(foreign).toBeDefined()
    const foreignResult = await associate(
      ctx,
      alice,
      workKey,
      'context_entry',
      foreign?.id as string,
      409,
    )
    expect(foreignResult.json().error).toMatchObject({
      code: 'CONFLICT',
      details: { reason: 'source_out_of_scope' },
    })
  })
})
