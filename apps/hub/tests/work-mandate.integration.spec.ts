/**
 * ADR-0028（RD-01）：持续工作、Mandate、影子准入的集成判据。
 *
 * 驱动走生产 HTTP（成员创建/退休工作、创建/暂停/恢复/撤销 Mandate、显式触发准入）
 * 与既有 Task/约定/纠正路径；断言只读协调表与业务计数。
 *
 * 唯一的数据夹具是「已定向的 instruction 消息」：它只作为准入来源存在，生产路径
 * 创建该消息会同时建 Run/outbox，反而污染本切片「准入不建 Run」的判据；消息本身
 * 不是运行时投影，也不由本测试写入任何运行时状态。
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
    payload: { name: `rd01-${Date.now()}-${randomUUID().slice(0, 6)}` },
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

async function createAgentWithPolicy(
  database: Database,
  createdBy: string,
  approvalPolicy: 'approval_required' | 'full_access',
): Promise<string> {
  const suffix = randomUUID().slice(0, 8)
  const packId = randomUUID()
  const agentId = randomUUID()
  const revisionId = randomUUID()
  await database.db.insert(schema.pluginPacks).values({
    id: packId,
    name: `rd01-pack-${suffix}`,
    installations: [],
    packDigest: 'a'.repeat(64),
    createdBy,
  })
  await database.db.insert(schema.agents).values({
    id: agentId,
    name: `rd01-agent-${suffix}`,
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
  return agentId
}

async function createWork(
  ctx: TestApp,
  session: Session,
  taskId: string,
): Promise<{ workKey: string; taskId: string; humanOwnerUserId: string; state: string }> {
  const res = await apiInject(ctx, session, {
    method: 'POST',
    url: `/api/v1/tasks/${taskId}/works`,
    payload: { goal: GOAL },
    idempotencyKey: idemKey(),
  })
  expect(res.statusCode).toBe(201)
  return res.json().data
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

async function mandateStatus(
  ctx: TestApp,
  session: Session,
  mandateId: string,
  action: 'pause' | 'resume' | 'revoke',
  expectedStatus = 200,
) {
  const res = await apiInject(ctx, session, {
    method: 'POST',
    url: `/api/v1/mandates/${mandateId}/${action}`,
    payload: {},
    idempotencyKey: idemKey(),
  })
  expect(res.statusCode).toBe(expectedStatus)
  return res.json()
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

async function checkAdmission(
  ctx: TestApp,
  session: Session,
  workKey: string,
  sourceType: 'task_message' | 'context_entry',
  sourceId: string,
) {
  const res = await apiInject(ctx, session, {
    method: 'POST',
    url: `/api/v1/works/${workKey}/admission-checks`,
    payload: { sourceType, sourceId },
    idempotencyKey: idemKey(),
  })
  expect(res.statusCode).toBe(200)
  return res.json().data as {
    decision: Record<string, unknown>
    proposedIntent: Record<string, unknown> | null
    duplicate: boolean
  }
}

async function countRows(database: Database): Promise<{
  runs: number
  outbox: number
  teamEvents: number
}> {
  const [runs, outbox, teamEvents] = await Promise.all([
    database.db.select().from(schema.runs),
    database.db.select().from(schema.dispatchOutbox),
    database.db.select().from(schema.teamEvents),
  ])
  return { runs: runs.length, outbox: outbox.length, teamEvents: teamEvents.length }
}

describe('RD-01 work, mandate and shadow admission (ADR-0028)', () => {
  let database: Database
  let ctx: TestApp
  let alice: Session
  let bob: Session
  let projectId: string
  let taskId: string

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
  })

  afterEach(async () => {
    await ctx.app.close()
  })

  afterAll(async () => {
    await database.close()
  })

  it('creates and retires work only for the assignee; duplicate current work is rejected', async () => {
    const denied = await apiInject(ctx, bob, {
      method: 'POST',
      url: `/api/v1/tasks/${taskId}/works`,
      payload: { goal: GOAL },
      idempotencyKey: idemKey(),
    })
    expect(denied.statusCode).toBe(403)
    expect(denied.json().error.code).toBe('FORBIDDEN')

    const work = await createWork(ctx, alice, taskId)
    expect(work).toMatchObject({
      taskId,
      humanOwnerUserId: alice.userId,
      state: 'active',
    })
    expect(work.workKey).toMatch(/^[0-9a-f-]{36}$/)

    const duplicate = await apiInject(ctx, alice, {
      method: 'POST',
      url: `/api/v1/tasks/${taskId}/works`,
      payload: { goal: '另一份工作' },
      idempotencyKey: idemKey(),
    })
    expect(duplicate.statusCode).toBe(409)
    expect(duplicate.json().error.code).toBe('CONFLICT')

    const pendingTask = await createTask(ctx, alice, projectId, alice.userId)
    const pendingWork = await apiInject(ctx, alice, {
      method: 'POST',
      url: `/api/v1/tasks/${pendingTask}/works`,
      payload: { goal: GOAL },
      idempotencyKey: idemKey(),
    })
    expect(pendingWork.statusCode).toBe(409)
    expect(pendingWork.json().error.code).toBe('ASSIGNMENT_NOT_ACCEPTED')

    const bobRetire = await apiInject(ctx, bob, {
      method: 'POST',
      url: `/api/v1/works/${work.workKey}/retire`,
      payload: {},
      idempotencyKey: idemKey(),
    })
    expect(bobRetire.statusCode).toBe(403)

    const retired = await apiInject(ctx, alice, {
      method: 'POST',
      url: `/api/v1/works/${work.workKey}/retire`,
      payload: {},
      idempotencyKey: idemKey(),
    })
    expect(retired.statusCode).toBe(200)
    expect(retired.json().data.state).toBe('retired')
    expect(retired.json().data.retiredAt).toEqual(expect.any(String))

    const successor = await createWork(ctx, alice, taskId)
    expect(successor.workKey).not.toBe(work.workKey)

    const listed = await apiInject(ctx, alice, {
      method: 'GET',
      url: `/api/v1/tasks/${taskId}/works`,
    })
    expect(listed.statusCode).toBe(200)
    expect(listed.json().data).toHaveLength(2)

    const bobList = await apiInject(ctx, bob, {
      method: 'GET',
      url: `/api/v1/tasks/${taskId}/works`,
    })
    expect(bobList.statusCode).toBe(403)
  })

  it('scopes idempotency keys to the acting member and task', async () => {
    const sharedKey = idemKey()
    const first = await apiInject(ctx, alice, {
      method: 'POST',
      url: `/api/v1/tasks/${taskId}/works`,
      payload: { goal: GOAL },
      idempotencyKey: sharedKey,
    })
    expect(first.statusCode).toBe(201)

    const bobTask = await createTask(ctx, alice, projectId, bob.userId)
    await acceptTask(ctx, bob, bobTask)
    const second = await apiInject(ctx, bob, {
      method: 'POST',
      url: `/api/v1/tasks/${bobTask}/works`,
      payload: { goal: GOAL },
      idempotencyKey: sharedKey,
    })
    expect(second.statusCode).toBe(201)
    expect(second.json().data.taskId).toBe(bobTask)
    expect(second.json().data.humanOwnerUserId).toBe(bob.userId)
  })

  it('versions mandates and enforces pause/resume/revoke by the assignee', async () => {
    const work = await createWork(ctx, alice, taskId)
    const bobCreate = await apiInject(ctx, bob, {
      method: 'POST',
      url: `/api/v1/works/${work.workKey}/mandates`,
      payload: { expiresAt: futureIso() },
      idempotencyKey: idemKey(),
    })
    expect(bobCreate.statusCode).toBe(403)

    const v1 = await createMandate(ctx, alice, work.workKey)
    expect(v1).toMatchObject({
      version: 1,
      current: true,
      status: 'active',
      autoDispatch: 'off',
      principalUserId: alice.userId,
      onBehalfOfUserId: alice.userId,
      humanOwnerUserId: alice.userId,
      draftRecipientUserId: alice.userId,
    })
    expect(v1.allowedToolNames).toEqual(['read', 'glob'])

    const v2 = await createMandate(ctx, alice, work.workKey, { autoDispatch: 'existing_task' })
    expect(v2).toMatchObject({ version: 2, status: 'active', autoDispatch: 'existing_task' })

    const paused = await mandateStatus(ctx, alice, v2.id, 'pause')
    expect(paused.data).toMatchObject({ version: 3, status: 'paused' })
    expect(paused.data.pausedAt).toEqual(expect.any(String))

    const resumed = await mandateStatus(ctx, alice, paused.data.id, 'resume')
    expect(resumed.data).toMatchObject({ version: 4, status: 'active' })
    expect(resumed.data.pausedAt).toBeNull()

    const revoked = await mandateStatus(ctx, alice, resumed.data.id, 'revoke')
    expect(revoked.data).toMatchObject({ version: 5, status: 'revoked' })
    expect(revoked.data.revokedAt).toEqual(expect.any(String))

    await mandateStatus(ctx, alice, revoked.data.id, 'pause', 409)

    const bobRevoke = await apiInject(ctx, bob, {
      method: 'POST',
      url: `/api/v1/mandates/${revoked.data.id}/revoke`,
      payload: {},
      idempotencyKey: idemKey(),
    })
    expect(bobRevoke.statusCode).toBe(403)

    const versions = await apiInject(ctx, alice, {
      method: 'GET',
      url: `/api/v1/works/${work.workKey}/mandates`,
    })
    expect(versions.statusCode).toBe(200)
    expect(versions.json().data.map((row: { version: number }) => row.version)).toEqual([
      5, 4, 3, 2, 1,
    ])
    expect(versions.json().data.map((row: { current: boolean }) => row.current)).toEqual([
      true,
      false,
      false,
      false,
      false,
    ])

    const detail = await apiInject(ctx, alice, {
      method: 'GET',
      url: `/api/v1/works/${work.workKey}`,
    })
    expect(detail.statusCode).toBe(200)
    expect(detail.json().data.currentMandate).toMatchObject({
      version: 5,
      status: 'revoked',
    })
  })

  it('rejects unsafe mandate contracts: draft recipient, forbidden tool, past expiry', async () => {
    const work = await createWork(ctx, alice, taskId)
    const cases: Array<{ payload: Record<string, unknown>; code: string }> = [
      { payload: { draftRecipientUserId: bob.userId }, code: 'VALIDATION_FAILED' },
      { payload: { allowedToolNames: ['bash'] }, code: 'VALIDATION_FAILED' },
      {
        payload: { expiresAt: new Date(Date.now() - 60_000).toISOString() },
        code: 'VALIDATION_FAILED',
      },
      {
        payload: { allowedActionClasses: ['research', 'publish'] },
        code: 'VALIDATION_FAILED',
      },
    ]
    for (const testCase of cases) {
      const res = await apiInject(ctx, alice, {
        method: 'POST',
        url: `/api/v1/works/${work.workKey}/mandates`,
        payload: { expiresAt: futureIso(), ...testCase.payload },
        idempotencyKey: idemKey(),
      })
      expect(res.statusCode).toBe(400)
      expect(res.json().error.code).toBe(testCase.code)
    }
    const rows = await database.db.select().from(schema.workMandates)
    expect(rows).toHaveLength(0)
  })

  it('rejects a full_access agent as a mandate candidate', async () => {
    const work = await createWork(ctx, alice, taskId)
    const fullAccess = await createAgentWithPolicy(database, alice.userId, 'full_access')
    const res = await apiInject(ctx, alice, {
      method: 'POST',
      url: `/api/v1/works/${work.workKey}/mandates`,
      payload: {
        expiresAt: futureIso(),
        allowedAgentIds: [fullAccess],
      },
      idempotencyKey: idemKey(),
    })
    expect(res.statusCode).toBe(400)
    expect(res.json().error.code).toBe('VALIDATION_FAILED')
  })

  it('records ignore(no_mandate) without creating a Run, outbox or team event', async () => {
    const work = await createWork(ctx, alice, taskId)
    const messageId = await comment(ctx, alice, taskId)
    const before = await countRows(database)
    const result = await checkAdmission(ctx, alice, work.workKey, 'task_message', messageId)
    expect(result).toMatchObject({
      duplicate: false,
      proposedIntent: null,
      decision: {
        decision: 'ignore',
        reason: 'no_mandate',
        sourceType: 'task_message',
        sourceId: messageId,
        mandateId: null,
        mandateVersion: null,
      },
    })
    expect(result.decision.inputDigest).toMatch(/^[a-f0-9]{64}$/)
    expect(await countRows(database)).toEqual(before)
    expect(await database.db.select().from(schema.dispatchIntents)).toHaveLength(0)
  })

  it('proposes a shadow intent, deduplicates the same source version, and writes no business facts', async () => {
    const work = await createWork(ctx, alice, taskId)
    const mandate = await createMandate(ctx, alice, work.workKey)
    const messageId = await comment(ctx, alice, taskId)
    const before = await countRows(database)

    const first = await checkAdmission(ctx, alice, work.workKey, 'task_message', messageId)
    expect(first.duplicate).toBe(false)
    expect(first.decision).toMatchObject({
      decision: 'propose',
      reason: 'needs_semantic',
      mandateId: mandate.id,
      mandateVersion: 1,
      sourceType: 'task_message',
      sourceId: messageId,
    })
    expect(first.proposedIntent).toMatchObject({
      status: 'proposed',
      approvalBasis: null,
      mandateId: mandate.id,
      mandateVersion: 1,
      authorizedByUserId: alice.userId,
      onBehalfOfUserId: alice.userId,
      runId: null,
      candidates: [],
      exclusionReasons: [],
    })
    expect(first.proposedIntent?.triggerRefs).toHaveLength(1)

    const second = await checkAdmission(ctx, alice, work.workKey, 'task_message', messageId)
    expect(second.duplicate).toBe(true)
    expect(second.decision.id).toBe(first.decision.id)
    expect(second.proposedIntent?.id).toBe(first.proposedIntent?.id)

    expect(await countRows(database)).toEqual(before)
    expect(await database.db.select().from(schema.routerDecisions)).toHaveLength(1)
    expect(await database.db.select().from(schema.dispatchIntents)).toHaveLength(1)

    const detail = await apiInject(ctx, alice, {
      method: 'GET',
      url: `/api/v1/works/${work.workKey}`,
    })
    expect(detail.json().data).toMatchObject({
      work: { workKey: work.workKey, state: 'active' },
      currentMandate: { id: mandate.id, version: 1 },
      watermarks: { proposedIntentCount: 1 },
    })
    expect(detail.json().data.recentDecisions).toHaveLength(1)
  })

  it('ignores a source type outside the mandate allowlist', async () => {
    const work = await createWork(ctx, alice, taskId)
    await createMandate(ctx, alice, work.workKey, {
      allowedSourceTypes: ['context_entry'],
    })
    const source = await comment(ctx, alice, taskId)
    const result = await checkAdmission(ctx, alice, work.workKey, 'task_message', source)
    expect(result.decision).toMatchObject({ decision: 'ignore', reason: 'source_not_allowed' })
    expect(result.proposedIntent).toBeNull()
  })

  it('cancels proposed intents when the work is retired', async () => {
    const work = await createWork(ctx, alice, taskId)
    await createMandate(ctx, alice, work.workKey)
    const source = await comment(ctx, alice, taskId)
    const proposed = await checkAdmission(ctx, alice, work.workKey, 'task_message', source)
    expect(proposed.proposedIntent?.status).toBe('proposed')

    const retired = await apiInject(ctx, alice, {
      method: 'POST',
      url: `/api/v1/works/${work.workKey}/retire`,
      payload: {},
      idempotencyKey: idemKey(),
    })
    expect(retired.statusCode).toBe(200)
    const intents = await database.db.select().from(schema.dispatchIntents)
    expect(intents).toHaveLength(1)
    expect(intents[0]).toMatchObject({ status: 'cancelled', cancelledAt: expect.any(Date) })
  })

  it('uses real context entries and marks corrected sources inactive', async () => {
    const work = await createWork(ctx, alice, taskId)
    await createMandate(ctx, alice, work.workKey)
    const draft = await apiInject(ctx, alice, {
      method: 'POST',
      url: `/api/v1/tasks/${taskId}/agreement/draft`,
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
    const confirmed = await apiInject(ctx, alice, {
      method: 'POST',
      url: `/api/v1/tasks/${taskId}/agreement/confirm`,
      payload: { draftVersion: draft.json().data.draftVersion },
      idempotencyKey: idemKey(),
    })
    expect(confirmed.statusCode).toBe(200)

    const context = await apiInject(ctx, alice, {
      method: 'GET',
      url: `/api/v1/projects/${projectId}/context`,
    })
    const entry = (context.json().data.entries as Array<Record<string, unknown>>).find(
      (row) => row.kind === 'decision' && row.businessRef === `taskSpec:${taskId}`,
    )
    expect(entry).toBeDefined()
    const entryId = entry?.id as string

    const proposed = await checkAdmission(ctx, alice, work.workKey, 'context_entry', entryId)
    expect(proposed.decision).toMatchObject({
      decision: 'propose',
      sourceType: 'context_entry',
      sourceId: entryId,
    })

    const correction = await apiInject(ctx, alice, {
      method: 'POST',
      url: `/api/v1/projects/${projectId}/context/${entryId}/correction`,
      payload: { correctionKind: 'amend', note: '预算口径改为含税价' },
      idempotencyKey: idemKey(),
    })
    expect(correction.statusCode).toBe(201)

    const inactive = await checkAdmission(ctx, alice, work.workKey, 'context_entry', entryId)
    expect(inactive.decision).toMatchObject({
      decision: 'ignore',
      reason: 'source_inactive',
      refs: { detail: 'corrected' },
    })
  })

  it('ignores an already-directed instruction message as a work candidate', async () => {
    const work = await createWork(ctx, alice, taskId)
    await createMandate(ctx, alice, work.workKey)
    const agent = await insertAgent(database.db, {
      id: randomUUID(),
      name: `instruction-agent-${randomUUID().slice(0, 8)}`,
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
    const before = await countRows(database)
    const result = await checkAdmission(ctx, alice, work.workKey, 'task_message', instruction.id)
    expect(result.decision).toMatchObject({
      decision: 'ignore',
      reason: 'already_directed',
    })
    expect(result.proposedIntent).toBeNull()
    expect(await countRows(database)).toEqual(before)
  })

  it('waits when the work is retired or the task assignee changed', async () => {
    const work = await createWork(ctx, alice, taskId)
    const mandate = await createMandate(ctx, alice, work.workKey)

    await apiInject(ctx, alice, {
      method: 'POST',
      url: `/api/v1/works/${work.workKey}/retire`,
      payload: {},
      idempotencyKey: idemKey(),
    })
    const retiredSource = await comment(ctx, alice, taskId)
    const retired = await checkAdmission(ctx, alice, work.workKey, 'task_message', retiredSource)
    expect(retired.decision).toMatchObject({ decision: 'wait', reason: 'work_state' })

    const successor = await createWork(ctx, alice, taskId)
    const successorMandate = await createMandate(ctx, alice, successor.workKey)
    const reassign = await apiInject(ctx, alice, {
      method: 'POST',
      url: `/api/v1/tasks/${taskId}/reassign`,
      payload: { assigneeUserId: bob.userId },
      idempotencyKey: idemKey(),
    })
    expect(reassign.statusCode).toBe(200)
    await acceptTask(ctx, bob, taskId)
    const bobMandate = await apiInject(ctx, bob, {
      method: 'POST',
      url: `/api/v1/works/${successor.workKey}/mandates`,
      payload: { expiresAt: futureIso() },
      idempotencyKey: idemKey(),
    })
    expect(bobMandate.statusCode).toBe(409)
    expect(bobMandate.json().error.code).toBe('CONFLICT')
    const changedSource = await comment(ctx, bob, taskId)
    const changed = await checkAdmission(ctx, bob, successor.workKey, 'task_message', changedSource)
    expect(changed.decision).toMatchObject({ decision: 'wait', reason: 'owner_changed' })
    expect(mandate.id).not.toBe(successorMandate.id)
  })

  it('cancels proposed intents on revoke and ignores new sources without an active mandate', async () => {
    const work = await createWork(ctx, alice, taskId)
    const mandate = await createMandate(ctx, alice, work.workKey)
    const firstSource = await comment(ctx, alice, taskId)
    const proposed = await checkAdmission(ctx, alice, work.workKey, 'task_message', firstSource)
    expect(proposed.proposedIntent?.status).toBe('proposed')

    const revoked = await mandateStatus(ctx, alice, mandate.id, 'revoke')
    const intents = await database.db.select().from(schema.dispatchIntents)
    expect(intents).toHaveLength(1)
    expect(intents[0]).toMatchObject({ status: 'cancelled' })

    const secondSource = await comment(ctx, alice, taskId)
    const ignored = await checkAdmission(ctx, alice, work.workKey, 'task_message', secondSource)
    expect(ignored.decision).toMatchObject({ decision: 'ignore', reason: 'no_mandate' })
    expect(ignored.decision.mandateVersion).toBe(revoked.data.version)
    expect(ignored.proposedIntent).toBeNull()
  })

  it('waits instead of proposing when the task is already terminal', async () => {
    const work = await createWork(ctx, alice, taskId)
    await createMandate(ctx, alice, work.workKey)
    const source = await comment(ctx, alice, taskId)
    const cancelled = await apiInject(ctx, alice, {
      method: 'POST',
      url: `/api/v1/tasks/${taskId}/cancel`,
    })
    expect(cancelled.statusCode).toBe(200)
    const result = await checkAdmission(ctx, alice, work.workKey, 'task_message', source)
    expect(result.decision).toMatchObject({
      decision: 'wait',
      reason: 'work_state',
      refs: { detail: 'task_terminal' },
    })
    expect(result.proposedIntent).toBeNull()
  })

  it('treats an expired active mandate as expired without dispatching', async () => {
    const work = await createWork(ctx, alice, taskId)
    const mandate = await createMandate(ctx, alice, work.workKey, {
      expiresAt: new Date(Date.now() + 1000).toISOString(),
    })
    await new Promise((resolve) => setTimeout(resolve, 1100))
    const source = await comment(ctx, alice, taskId)
    const result = await checkAdmission(ctx, alice, work.workKey, 'task_message', source)
    expect(result.decision).toMatchObject({
      decision: 'ignore',
      reason: 'mandate_expired',
      mandateId: mandate.id,
    })
    expect(result.proposedIntent).toBeNull()

    const detail = await apiInject(ctx, alice, {
      method: 'GET',
      url: `/api/v1/works/${work.workKey}`,
    })
    expect(detail.json().data.currentMandate.status).toBe('expired')
  })
})
