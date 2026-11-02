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

async function checkAdmission(
  ctx: TestApp,
  session: Session,
  workKey: string,
  sourceType: 'task_message' | 'context_entry',
  sourceId: string,
  key = idemKey(),
) {
  const res = await apiInject(ctx, session, {
    method: 'POST',
    url: `/api/v1/works/${workKey}/admission-checks`,
    payload: { sourceType, sourceId },
    idempotencyKey: key,
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
    // UUIDv7：第三个分组首位是版本号 7。
    expect(work.workKey[14]).toBe('7')

    const bobDetail = await apiInject(ctx, bob, {
      method: 'GET',
      url: `/api/v1/works/${work.workKey}`,
    })
    expect(bobDetail.statusCode).toBe(403)
    const bobAdmission = await apiInject(ctx, bob, {
      method: 'POST',
      url: `/api/v1/works/${work.workKey}/admission-checks`,
      payload: { sourceType: 'task_message', sourceId: randomUUID() },
      idempotencyKey: idemKey(),
    })
    expect(bobAdmission.statusCode).toBe(403)

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

    const sameTaskReplay = await apiInject(ctx, bob, {
      method: 'POST',
      url: `/api/v1/tasks/${taskId}/works`,
      payload: { goal: GOAL },
      idempotencyKey: sharedKey,
    })
    expect(sameTaskReplay.statusCode).toBe(403)

    const differentBody = await apiInject(ctx, alice, {
      method: 'POST',
      url: `/api/v1/tasks/${taskId}/works`,
      payload: { goal: '不同的工作' },
      idempotencyKey: sharedKey,
    })
    expect(differentBody.statusCode).toBe(409)

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

    const source = await comment(ctx, alice, taskId)
    const proposed = await checkAdmission(ctx, alice, work.workKey, 'task_message', source)
    expect(proposed.proposedIntent?.status).toBe('proposed')

    const v2 = await createMandate(ctx, alice, work.workKey, { autoDispatch: 'existing_task' })
    expect(v2).toMatchObject({ version: 2, status: 'active', autoDispatch: 'existing_task' })
    const cancelledByNewVersion = await database.db.select().from(schema.dispatchIntents)
    expect(cancelledByNewVersion).toHaveLength(1)
    expect(cancelledByNewVersion[0]).toMatchObject({ status: 'cancelled' })

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
      {
        payload: { allowedActionClasses: ['research', 'research'] },
        code: 'VALIDATION_FAILED',
      },
      {
        payload: { allowedAgentIds: ['00000000-0000-4000-8000-000000000000'] },
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

  it('rejects a mandate when stored work ownership is inconsistent', async () => {
    const work = await createWork(ctx, alice, taskId)
    // 故障注入：正常路径不会产生「stored work owner ≠ assignee」；这里直接改协调表，
    // 让 owner 检查成为唯一拒绝判据。删除条件：RD-02 迁移归一化旧行，或生产路径
    // 能真实产生/核对不一致工作后删除。tests/ 不在 checkHarnessDbSeeds 的 scripts/ 扫描面内。
    await database.db
      .update(schema.works)
      .set({ humanOwnerUserId: bob.userId })
      .where(eq(schema.works.workKey, work.workKey))
    const res = await apiInject(ctx, alice, {
      method: 'POST',
      url: `/api/v1/works/${work.workKey}/mandates`,
      payload: { expiresAt: futureIso() },
      idempotencyKey: idemKey(),
    })
    expect(res.statusCode).toBe(409)
    expect(res.json().error.code).toBe('CONFLICT')
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
    expect(Date.parse(first.proposedIntent?.expiresAt as string)).toBeGreaterThan(Date.now())
    expect(Date.parse(first.proposedIntent?.expiresAt as string)).toBeLessThanOrEqual(
      Date.now() + 900_000,
    )

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

  it('rejects work creation on a terminal task', async () => {
    const cancelled = await apiInject(ctx, alice, {
      method: 'POST',
      url: `/api/v1/tasks/${taskId}/cancel`,
    })
    expect(cancelled.statusCode).toBe(200)
    const res = await apiInject(ctx, alice, {
      method: 'POST',
      url: `/api/v1/tasks/${taskId}/works`,
      payload: { goal: GOAL },
      idempotencyKey: idemKey(),
    })
    expect(res.statusCode).toBe(409)
    expect(res.json().error.code).toBe('TASK_TERMINAL')
  })

  it('ignores new sources while a mandate is paused and repeats pause idempotently', async () => {
    const work = await createWork(ctx, alice, taskId)
    const v1 = await createMandate(ctx, alice, work.workKey)
    const firstSource = await comment(ctx, alice, taskId)
    const proposed = await checkAdmission(ctx, alice, work.workKey, 'task_message', firstSource)
    expect(proposed.proposedIntent?.status).toBe('proposed')
    const paused = await mandateStatus(ctx, alice, v1.id, 'pause')
    expect(paused.data).toMatchObject({ version: 2, status: 'paused' })
    const pausedAgain = await mandateStatus(ctx, alice, paused.data.id, 'pause')
    expect(pausedAgain.data).toMatchObject({ version: 2, status: 'paused', current: true })
    const pausedIntents = await database.db.select().from(schema.dispatchIntents)
    expect(pausedIntents).toHaveLength(1)
    expect(pausedIntents[0]).toMatchObject({ status: 'cancelled' })

    const source = await comment(ctx, alice, taskId)
    const result = await checkAdmission(ctx, alice, work.workKey, 'task_message', source)
    expect(result.decision).toMatchObject({
      decision: 'ignore',
      reason: 'no_mandate',
      mandateVersion: 2,
      refs: { mandateStatus: 'paused' },
    })
    expect(result.proposedIntent).toBeNull()
  })

  it('rejects an archived author as an inactive source', async () => {
    const work = await createWork(ctx, alice, taskId)
    await createMandate(ctx, alice, work.workKey)
    const source = await comment(ctx, bob, taskId)
    const disabled = await apiInject(ctx, alice, {
      method: 'POST',
      url: `/api/v1/team/members/${bob.userId}/disable`,
    })
    expect(disabled.statusCode).toBe(200)
    const result = await checkAdmission(ctx, alice, work.workKey, 'task_message', source)
    expect(result.decision).toMatchObject({
      decision: 'ignore',
      reason: 'source_inactive',
      refs: { detail: 'author_not_member' },
    })
    expect(result.proposedIntent).toBeNull()
  })

  it('keeps inference and cross-task context entries out of the work candidate set', async () => {
    const work = await createWork(ctx, alice, taskId)
    await createMandate(ctx, alice, work.workKey)
    const secondTask = await createTask(ctx, alice, projectId, alice.userId)
    await acceptTask(ctx, alice, secondTask)
    await confirmAgreement(ctx, alice, taskId)
    await confirmAgreement(ctx, alice, secondTask)
    const evaluated = await apiInject(ctx, alice, {
      method: 'POST',
      url: `/api/v1/projects/${projectId}/coordination/evaluate`,
      payload: {},
      idempotencyKey: idemKey(),
    })
    expect(evaluated.statusCode).toBe(200)

    const context = await apiInject(ctx, alice, {
      method: 'GET',
      url: `/api/v1/projects/${projectId}/context`,
    })
    const entries = context.json().data.entries as Array<Record<string, unknown>>
    const inference = entries.find((entry) => entry.kind === 'inference')
    expect(inference).toBeDefined()
    const inferenceResult = await checkAdmission(
      ctx,
      alice,
      work.workKey,
      'context_entry',
      inference?.id as string,
    )
    expect(inferenceResult.decision).toMatchObject({
      decision: 'ignore',
      reason: 'system_produced',
    })

    const foreign = entries.find(
      (entry) => entry.kind === 'decision' && entry.businessRef === `taskSpec:${secondTask}`,
    )
    expect(foreign).toBeDefined()
    const foreignResult = await checkAdmission(
      ctx,
      alice,
      work.workKey,
      'context_entry',
      foreign?.id as string,
    )
    expect(foreignResult.decision).toMatchObject({
      decision: 'ignore',
      reason: 'source_out_of_scope',
    })
  })

  it('accepts a valid approval_required agent in the mandate allowlist', async () => {
    const work = await createWork(ctx, alice, taskId)
    const agentId = await createAgentWithPolicy(database, alice.userId, 'approval_required')
    const mandate = await createMandate(ctx, alice, work.workKey, {
      allowedAgentIds: [agentId],
    })
    expect(mandate.allowedAgentIds).toEqual([agentId])
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

    const detail = await apiInject(ctx, alice, {
      method: 'GET',
      url: `/api/v1/works/${work.workKey}`,
    })
    expect(detail.json().data.currentMandate).toBeNull()
    const mandates = await apiInject(ctx, alice, {
      method: 'GET',
      url: `/api/v1/works/${work.workKey}/mandates`,
    })
    expect((mandates.json().data as Array<{ current: boolean }>).every((row) => !row.current)).toBe(
      true,
    )
    const mandateRows = await database.db.select().from(schema.workMandates)
    const pauseRetired = await apiInject(ctx, alice, {
      method: 'POST',
      url: `/api/v1/mandates/${mandateRows[0]?.id}/pause`,
      payload: {},
      idempotencyKey: idemKey(),
    })
    expect(pauseRetired.statusCode).toBe(409)
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
    expect(inactive.proposedIntent).toBeNull()
  })

  it('marks a superseded context decision inactive', async () => {
    const work = await createWork(ctx, alice, taskId)
    await createMandate(ctx, alice, work.workKey)
    await confirmAgreement(ctx, alice, taskId)
    const before = await apiInject(ctx, alice, {
      method: 'GET',
      url: `/api/v1/projects/${projectId}/context`,
    })
    const entry = (before.json().data.entries as Array<Record<string, unknown>>).find(
      (row) => row.kind === 'decision' && row.businessRef === `taskSpec:${taskId}`,
    )
    expect(entry).toBeDefined()
    const entryId = entry?.id as string
    const proposed = await checkAdmission(ctx, alice, work.workKey, 'context_entry', entryId)
    expect(proposed.decision).toMatchObject({ decision: 'propose' })

    await confirmAgreement(ctx, alice, taskId)
    const inactive = await checkAdmission(ctx, alice, work.workKey, 'context_entry', entryId)
    expect(inactive.decision).toMatchObject({
      decision: 'ignore',
      reason: 'source_inactive',
      refs: { detail: 'inactive' },
    })
    expect(inactive.proposedIntent).toBeNull()
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

  it('waits when the work is retired or reassigned, without auto-revival', async () => {
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
    expect(retired.proposedIntent).toBeNull()
    expect(retired.decision.refs).toMatchObject({ deadlineAt: expect.any(String) })

    const successor = await createWork(ctx, alice, taskId)
    const successorMandate = await createMandate(ctx, alice, successor.workKey)
    const beforeReassign = await comment(ctx, alice, taskId)
    const proposedBefore = await checkAdmission(
      ctx,
      alice,
      successor.workKey,
      'task_message',
      beforeReassign,
    )
    expect(proposedBefore.proposedIntent?.status).toBe('proposed')
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
    await mandateStatus(ctx, bob, successorMandate.id, 'pause', 409)
    const bobRevoke = await mandateStatus(ctx, bob, successorMandate.id, 'revoke')
    expect(bobRevoke.data).toMatchObject({ status: 'revoked', current: false })
    const afterRevoke = await apiInject(ctx, bob, {
      method: 'GET',
      url: `/api/v1/works/${successor.workKey}`,
    })
    expect(afterRevoke.json().data.currentMandate).toBeNull()
    const reassignedIntents = await database.db.select().from(schema.dispatchIntents)
    expect(reassignedIntents).toHaveLength(1)
    expect(reassignedIntents[0]).toMatchObject({ status: 'cancelled' })
    const waiting = await apiInject(ctx, bob, {
      method: 'GET',
      url: `/api/v1/works/${successor.workKey}`,
    })
    expect(waiting.json().data.work).toMatchObject({
      state: 'waiting',
      resumeMode: 'owner_confirmation',
      resumeCondition: 'task_assignee_changed',
    })
    expect(waiting.json().data.currentMandate).toBeNull()
    const changedSource = await comment(ctx, bob, taskId)
    const changed = await checkAdmission(ctx, bob, successor.workKey, 'task_message', changedSource)
    expect(changed.decision).toMatchObject({
      decision: 'wait',
      reason: 'owner_changed',
      refs: { detail: 'task assignee changed; new assignee must confirm work' },
    })
    expect(changed.proposedIntent).toBeNull()
    expect(mandate.id).not.toBe(successorMandate.id)

    // 新 assignee 可以退休旧工作；退休后不再有当前 Mandate。
    const retiredByNewAssignee = await apiInject(ctx, bob, {
      method: 'POST',
      url: `/api/v1/works/${successor.workKey}/retire`,
      payload: {},
      idempotencyKey: idemKey(),
    })
    expect(retiredByNewAssignee.statusCode).toBe(200)
    expect(retiredByNewAssignee.json().data.state).toBe('retired')

    // 改派回来也不自动复活旧工作/旧 Mandate。
    const reassignBack = await apiInject(ctx, alice, {
      method: 'POST',
      url: `/api/v1/tasks/${taskId}/reassign`,
      payload: { assigneeUserId: alice.userId },
      idempotencyKey: idemKey(),
    })
    expect(reassignBack.statusCode).toBe(200)
    await acceptTask(ctx, alice, taskId)
    const stillWaiting = await apiInject(ctx, alice, {
      method: 'GET',
      url: `/api/v1/works/${successor.workKey}`,
    })
    expect(stillWaiting.json().data.work.state).toBe('retired')
    const afterBackSource = await comment(ctx, alice, taskId)
    const afterBack = await checkAdmission(
      ctx,
      alice,
      successor.workKey,
      'task_message',
      afterBackSource,
    )
    expect(afterBack.decision).toMatchObject({ decision: 'wait', reason: 'work_state' })
    expect(afterBack.proposedIntent).toBeNull()
  })

  it('does not revive a waiting work when reassigned back to its original owner', async () => {
    const work = await createWork(ctx, alice, taskId)
    await createMandate(ctx, alice, work.workKey)
    const toBob = await apiInject(ctx, alice, {
      method: 'POST',
      url: `/api/v1/tasks/${taskId}/reassign`,
      payload: { assigneeUserId: bob.userId },
      idempotencyKey: idemKey(),
    })
    expect(toBob.statusCode).toBe(200)
    await acceptTask(ctx, bob, taskId)
    const backToAlice = await apiInject(ctx, alice, {
      method: 'POST',
      url: `/api/v1/tasks/${taskId}/reassign`,
      payload: { assigneeUserId: alice.userId },
      idempotencyKey: idemKey(),
    })
    expect(backToAlice.statusCode).toBe(200)
    await acceptTask(ctx, alice, taskId)
    const detail = await apiInject(ctx, alice, {
      method: 'GET',
      url: `/api/v1/works/${work.workKey}`,
    })
    expect(detail.json().data.work.state).toBe('waiting')
    expect(detail.json().data.currentMandate).toBeNull()
    const source = await comment(ctx, alice, taskId)
    const result = await checkAdmission(ctx, alice, work.workKey, 'task_message', source)
    expect(result.decision).toMatchObject({ decision: 'wait', reason: 'work_state' })
    expect(result.proposedIntent).toBeNull()
  })

  it('cancels proposed intents on revoke and ignores new sources without an active mandate', async () => {
    const work = await createWork(ctx, alice, taskId)
    const mandate = await createMandate(ctx, alice, work.workKey)
    const firstSource = await comment(ctx, alice, taskId)
    const admissionKey = idemKey()
    const proposed = await checkAdmission(
      ctx,
      alice,
      work.workKey,
      'task_message',
      firstSource,
      admissionKey,
    )
    expect(proposed.proposedIntent?.status).toBe('proposed')

    const revoked = await mandateStatus(ctx, alice, mandate.id, 'revoke')
    const intents = await database.db.select().from(schema.dispatchIntents)
    expect(intents).toHaveLength(1)
    expect(intents[0]).toMatchObject({ status: 'cancelled' })

    const replayed = await checkAdmission(
      ctx,
      alice,
      work.workKey,
      'task_message',
      firstSource,
      admissionKey,
    )
    expect(replayed.duplicate).toBe(true)
    expect(replayed.proposedIntent?.status).toBe('cancelled')

    const secondSource = await comment(ctx, alice, taskId)
    const ignored = await checkAdmission(ctx, alice, work.workKey, 'task_message', secondSource)
    expect(ignored.decision).toMatchObject({ decision: 'ignore', reason: 'no_mandate' })
    expect(ignored.decision.mandateVersion).toBe(revoked.data.version)
    expect(ignored.proposedIntent).toBeNull()
  })

  it('waits instead of proposing for a full_access task and cancels prior proposals', async () => {
    const work = await createWork(ctx, alice, taskId)
    await createMandate(ctx, alice, work.workKey)
    const before = await comment(ctx, alice, taskId)
    const proposed = await checkAdmission(ctx, alice, work.workKey, 'task_message', before)
    expect(proposed.proposedIntent?.status).toBe('proposed')

    const updated = await apiInject(ctx, alice, {
      method: 'PATCH',
      url: `/api/v1/tasks/${taskId}`,
      payload: { approvalPolicy: 'full_access' },
      idempotencyKey: idemKey(),
    })
    expect(updated.statusCode).toBe(200)
    expect(updated.json().data.approvalPolicy).toBe('full_access')
    const intents = await database.db.select().from(schema.dispatchIntents)
    expect(intents).toHaveLength(1)
    expect(intents[0]).toMatchObject({ status: 'cancelled' })

    const source = await comment(ctx, alice, taskId)
    const result = await checkAdmission(ctx, alice, work.workKey, 'task_message', source)
    expect(result.decision).toMatchObject({
      decision: 'wait',
      reason: 'full_access_task',
      refs: { detail: 'task_approval_policy_full_access' },
    })
    expect(result.proposedIntent).toBeNull()

    const newMandate = await apiInject(ctx, alice, {
      method: 'POST',
      url: `/api/v1/works/${work.workKey}/mandates`,
      payload: { expiresAt: futureIso() },
      idempotencyKey: idemKey(),
    })
    expect(newMandate.statusCode).toBe(409)
  })

  it('waits while the task assignment is pending after a same-assignee reassign', async () => {
    const work = await createWork(ctx, alice, taskId)
    await createMandate(ctx, alice, work.workKey)
    const reassigned = await apiInject(ctx, alice, {
      method: 'POST',
      url: `/api/v1/tasks/${taskId}/reassign`,
      payload: { assigneeUserId: alice.userId },
      idempotencyKey: idemKey(),
    })
    expect(reassigned.statusCode).toBe(200)
    const source = await comment(ctx, alice, taskId)
    const pending = await checkAdmission(ctx, alice, work.workKey, 'task_message', source)
    expect(pending.decision).toMatchObject({
      decision: 'wait',
      reason: 'assignment_pending',
      refs: { detail: 'task_assignment_not_accepted' },
    })
    expect(pending.proposedIntent).toBeNull()
    await acceptTask(ctx, alice, taskId)
    const acceptedSource = await comment(ctx, alice, taskId)
    const accepted = await checkAdmission(ctx, alice, work.workKey, 'task_message', acceptedSource)
    expect(accepted.decision).toMatchObject({ decision: 'propose', reason: 'needs_semantic' })
  })

  it('retires work and cancels proposals when the task becomes terminal', async () => {
    const work = await createWork(ctx, alice, taskId)
    await createMandate(ctx, alice, work.workKey)
    const before = await comment(ctx, alice, taskId)
    const proposed = await checkAdmission(ctx, alice, work.workKey, 'task_message', before)
    expect(proposed.proposedIntent?.status).toBe('proposed')
    const cancelled = await apiInject(ctx, alice, {
      method: 'POST',
      url: `/api/v1/tasks/${taskId}/cancel`,
    })
    expect(cancelled.statusCode).toBe(200)
    const intents = await database.db.select().from(schema.dispatchIntents)
    expect(intents).toHaveLength(1)
    expect(intents[0]).toMatchObject({ status: 'cancelled' })
    const after = await apiInject(ctx, alice, {
      method: 'GET',
      url: `/api/v1/works/${work.workKey}`,
    })
    expect(after.json().data.work.state).toBe('retired')
    expect(after.json().data.currentMandate).toBeNull()
    const source = await comment(ctx, alice, taskId)
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
    await mandateStatus(ctx, alice, mandate.id, 'pause', 409)
  })
})
