/**
 * ADR-0026（PC-04a）：确定性内部协调的集成判据。
 *
 * 驱动走生产 HTTP（约定确认 → 自动合并 queued；成员显式触发 → 求值）与生产 tick；
 * 断言只读 DB/读面。除显式标注的故障注入夹具（already_completed/stale_queue/输入前进/
 * 长开放问题）外不直插业务表；模型/Node/额度路径不在本切片。
 */
import { randomUUID } from 'node:crypto'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { eq } from 'drizzle-orm'
import type { Database } from '@whalepod/db'
import { schema } from '@whalepod/db'
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
import { runCoordinationTick } from '../src/modules/coordination/tick.js'

const CONTENT = {
  goal: '把预算从 12 万改为 8 万',
  constraints: '不新增审批步骤',
  acceptance: '新预算出现在下一次场地比较',
  openQuestions: '最终供应商待定',
}

async function createProject(ctx: TestApp, session: Session, name: string): Promise<string> {
  const res = await apiInject(ctx, session, {
    method: 'POST',
    url: '/api/v1/projects',
    payload: { name },
  })
  if (res.statusCode !== 201)
    throw new Error(`create project failed: ${res.statusCode} ${res.body}`)
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
    payload: { title: '活动预算与场地', assigneeUserId },
  })
  if (res.statusCode !== 201) throw new Error(`create task failed: ${res.statusCode} ${res.body}`)
  return res.json().data.id as string
}

async function saveDraft(
  ctx: TestApp,
  session: Session,
  taskId: string,
  content: typeof CONTENT,
): Promise<number> {
  const draft = await apiInject(ctx, session, {
    method: 'POST',
    url: `/api/v1/tasks/${taskId}/agreement/draft`,
    payload: { content },
    idempotencyKey: idemKey(),
  })
  expect(draft.statusCode).toBe(200)
  return draft.json().data.draftVersion as number
}

async function confirmAgreement(
  ctx: TestApp,
  session: Session,
  taskId: string,
  content: typeof CONTENT = CONTENT,
): Promise<void> {
  const draftVersion = await saveDraft(ctx, session, taskId, content)
  const confirmed = await apiInject(ctx, session, {
    method: 'POST',
    url: `/api/v1/tasks/${taskId}/agreement/confirm`,
    payload: { draftVersion },
    idempotencyKey: idemKey(),
  })
  expect(confirmed.statusCode).toBe(200)
}

async function coordination(ctx: TestApp, session: Session, projectId: string) {
  const res = await apiInject(ctx, session, {
    method: 'GET',
    url: `/api/v1/projects/${projectId}/coordination`,
  })
  expect(res.statusCode).toBe(200)
  return res.json().data
}

async function evaluate(ctx: TestApp, session: Session, projectId: string, key = idemKey()) {
  const res = await apiInject(ctx, session, {
    method: 'POST',
    url: `/api/v1/projects/${projectId}/coordination/evaluate`,
    payload: {},
    idempotencyKey: key,
  })
  expect(res.statusCode).toBe(200)
  return res.json().data as {
    evaluation: Record<string, unknown>
    queuedEvaluationId: string | null
    queuedChanged: boolean
    inferenceEntryId: string | null
  }
}

describe('PC-04a deterministic coordination', () => {
  let database: Database
  let ctx: TestApp
  let alice: Session
  let bob: Session
  let projectId: string
  let taskId: string
  let secondTaskId: string

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
    projectId = await createProject(ctx, alice, `pc04a-${Date.now()}`)
    taskId = await createTask(ctx, alice, projectId, alice.userId)
    secondTaskId = await createTask(ctx, alice, projectId, alice.userId)
  })
  afterEach(async () => {
    await ctx.app.close()
  })
  afterAll(async () => {
    await database.close()
  })

  it('coalesces business changes into one queued evaluation and produces a cited Inference', async () => {
    await confirmAgreement(ctx, alice, taskId)
    let view = await coordination(ctx, bob, projectId)
    expect(view.latestEvaluation).toMatchObject({
      status: 'queued',
      attempt: 1,
      manifestVersion: 1,
      rulesVersion: 'pc04a.v1',
    })
    const queuedRows = await database.db
      .select()
      .from(schema.coordinationEvaluations)
      .where(eq(schema.coordinationEvaluations.projectId, projectId))
    expect(queuedRows).toHaveLength(1)

    // 第二次业务变化（同一 Task 新版本）只合并到同一条 queued。
    await confirmAgreement(ctx, alice, taskId, { ...CONTENT, goal: '预算改为 6 万' })
    view = await coordination(ctx, bob, projectId)
    expect(view.latestEvaluation).toMatchObject({ status: 'queued', manifestVersion: 2 })
    const stillQueued = await database.db
      .select()
      .from(schema.coordinationEvaluations)
      .where(eq(schema.coordinationEvaluations.projectId, projectId))
    expect(stillQueued).toHaveLength(1)

    const result = await evaluate(ctx, bob, projectId)
    expect(result.evaluation).toMatchObject({
      status: 'completed',
      inferenceEntryId: expect.any(String),
    })
    view = await coordination(ctx, bob, projectId)
    expect(view.state.lastSuccessfulEvaluationId).toBe(result.evaluation.id)
    expect(view.latestInference).toMatchObject({
      kind: 'inference',
      actorKind: 'coordinator',
      evaluationId: result.evaluation.id,
      inputDigest: result.evaluation.inputDigest,
    })
    expect(view.latestInference.citations.length).toBeGreaterThan(0)
    expect(view.latestInference.citations[0]).toMatchObject({ kind: 'business' })
    expect(view.latestInference.payload.summary).toMatchObject({ decision: 1 })
    expect(view.openQuestions).toEqual([
      expect.objectContaining({ text: '最终供应商待定', businessRef: `taskSpec:${taskId}` }),
    ])
    // 协调只写 Inference：不新增当前有效的 Decision/Correction（旧版保留但已 superseded）。
    const entries = await database.db
      .select()
      .from(schema.contextEntries)
      .where(eq(schema.contextEntries.projectId, projectId))
    expect(
      entries.filter(
        (entry) =>
          entry.kind === 'decision' && entry.status === 'active' && entry.correctedAt === null,
      ),
    ).toHaveLength(1)
    expect(entries.filter((entry) => entry.kind === 'correction')).toHaveLength(0)
    expect(entries.filter((entry) => entry.kind === 'inference')).toHaveLength(1)
    expect(
      ctx.contextEvents.some(
        (event) =>
          event.action === 'coordination.evaluation_completed' &&
          event.evaluationId === result.evaluation.id,
      ),
    ).toBe(true)
  })

  it('serializes concurrent business changes into one queued evaluation', async () => {
    // 两个不同 Task 的确认并发提交：coordinator state 行锁必须让后来者合并而不是
    // 撞 queued 部分唯一索引把业务命令回滚。
    await Promise.all([
      confirmAgreement(ctx, alice, taskId),
      confirmAgreement(ctx, alice, secondTaskId),
    ])
    const rows = await database.db
      .select()
      .from(schema.coordinationEvaluations)
      .where(eq(schema.coordinationEvaluations.projectId, projectId))
    expect(rows).toHaveLength(1)
    expect(rows[0]?.status).toBe('queued')
    const view = await coordination(ctx, alice, projectId)
    expect(view.latestEvaluation).toMatchObject({ status: 'queued', manifestVersion: 2 })
  })

  it('is idempotent per idempotency key and reports no_relevant_change on a second explicit run', async () => {
    await confirmAgreement(ctx, alice, taskId)
    const key = idemKey()
    const first = await evaluate(ctx, bob, projectId, key)
    const replay = await evaluate(ctx, bob, projectId, key)
    expect(replay.evaluation.id).toBe(first.evaluation.id)
    expect(first.evaluation.status).toBe('completed')
    expect(first.inferenceEntryId).not.toBeNull()

    const noChange = await evaluate(ctx, bob, projectId)
    expect(noChange.evaluation).toMatchObject({
      status: 'skipped',
      failureCode: 'no_relevant_change',
    })
    expect(noChange.inferenceEntryId).toBeNull()
    const view = await coordination(ctx, bob, projectId)
    expect(view.latestEvaluation).toMatchObject({
      status: 'skipped',
      failureCode: 'no_relevant_change',
    })
    // 最近一次评估可以是 skipped，但「最近成功」的 Inference 仍按状态指针返回。
    expect(view.latestInference.id).toBe(first.inferenceEntryId)
    const evaluations = await database.db
      .select()
      .from(schema.coordinationEvaluations)
      .where(eq(schema.coordinationEvaluations.projectId, projectId))
    expect(evaluations.filter((row) => row.status === 'completed')).toHaveLength(1)
    const inferences = await database.db
      .select()
      .from(schema.contextEntries)
      .where(eq(schema.contextEntries.projectId, projectId))
    expect(inferences.filter((entry) => entry.kind === 'inference')).toHaveLength(1)
    expect(
      ctx.contextEvents.some(
        (event) =>
          event.action === 'coordination.evaluation_skipped' &&
          event.reason === 'no_relevant_change',
      ),
    ).toBe(true)
  })

  it('changes input digest after a correction and keeps citing the remaining facts', async () => {
    await confirmAgreement(ctx, alice, taskId)
    await confirmAgreement(ctx, alice, secondTaskId)
    const before = await evaluate(ctx, bob, projectId)
    expect(before.evaluation.status).toBe('completed')

    const entry = (
      await database.db
        .select()
        .from(schema.contextEntries)
        .where(eq(schema.contextEntries.businessRef, `taskSpec:${taskId}`))
    ).find((row) => row.status === 'active')
    if (entry === undefined) throw new Error('decision missing')
    const corrected = await apiInject(ctx, bob, {
      method: 'POST',
      url: `/api/v1/projects/${projectId}/context/${entry.id}/correction`,
      payload: { correctionKind: 'amend', note: '8 万只是建议' },
      idempotencyKey: idemKey(),
    })
    expect(corrected.statusCode).toBe(201)

    const after = await evaluate(ctx, bob, projectId)
    expect(after.evaluation.status).toBe('completed')
    expect(after.evaluation.inputDigest).not.toBe(before.evaluation.inputDigest)
    expect(after.evaluation.id).not.toBe(before.evaluation.id)
    const view = await coordination(ctx, bob, projectId)
    expect(view.latestInference.id).toBe(after.inferenceEntryId)
    expect(view.latestInference.citations).toHaveLength(1)
    expect(view.latestInference.citations[0]?.businessRef).toBe(`taskSpec:${secondTaskId}`)
    expect(view.latestInference.payload.summary).toMatchObject({ decision: 1, correction: 1 })
  })

  it('tick evaluates queued work once and does not wake on unchanged input', async () => {
    await confirmAgreement(ctx, alice, taskId)
    const events: Array<Record<string, unknown>> = []
    const firstTick = await runCoordinationTick({
      database,
      now: new Date(),
      log: (event) => events.push(event),
    })
    expect(firstTick.completed).toBe(1)
    expect(events).toContainEqual(
      expect.objectContaining({ action: 'coordination.evaluation_queued' }),
    )
    expect(events).toContainEqual(
      expect.objectContaining({ action: 'coordination.evaluation_completed' }),
    )
    const evaluationsAfterFirst = await database.db
      .select()
      .from(schema.coordinationEvaluations)
      .where(eq(schema.coordinationEvaluations.projectId, projectId))
    const inferencesAfterFirst = await database.db
      .select()
      .from(schema.contextEntries)
      .where(eq(schema.contextEntries.projectId, projectId))
    const secondTick = await runCoordinationTick({
      database,
      now: new Date(),
      log: (event) => events.push(event),
    })
    expect(secondTick).toEqual({ completed: 0, skipped: 0, failed: 0, expired: 0 })
    expect(
      await database.db
        .select()
        .from(schema.coordinationEvaluations)
        .where(eq(schema.coordinationEvaluations.projectId, projectId)),
    ).toHaveLength(evaluationsAfterFirst.length)
    const inferencesAfterSecond = await database.db
      .select()
      .from(schema.contextEntries)
      .where(eq(schema.contextEntries.projectId, projectId))
    expect(inferencesAfterSecond.filter((entry) => entry.kind === 'inference')).toHaveLength(
      inferencesAfterFirst.filter((entry) => entry.kind === 'inference').length,
    )
  })

  it('skips a queued evaluation whose input already completed (A→B→A style)', async () => {
    await confirmAgreement(ctx, alice, taskId)
    const first = await evaluate(ctx, bob, projectId)
    expect(first.evaluation.status).toBe('completed')
    const completed = (
      await database.db
        .select()
        .from(schema.coordinationEvaluations)
        .where(eq(schema.coordinationEvaluations.status, 'completed'))
    )[0]
    if (completed === undefined) throw new Error('completed evaluation missing')

    // 故障注入式夹具：生产路径不会把 queued 的 digest 造回已完成的输入；
    // 这里直接插一条同 digest 的 queued，验证求值时走 skipped(already_completed)。
    await database.db.insert(schema.coordinationEvaluations).values({
      id: randomUUID(),
      projectId,
      status: 'queued',
      attempt: completed.attempt + 1,
      inputDigest: completed.inputDigest,
      inputManifest: {},
      manifestVersion: 1,
      rulesVersion: 'pc04a.v1',
      processorVersion: 'deterministic.v1',
      queuedAt: new Date(),
      queueExpiresAt: new Date(Date.now() + 60_000),
    })
    const tick = await runCoordinationTick({ database, now: new Date() })
    expect(tick.skipped).toBe(1)
    const skipped = (
      await database.db
        .select()
        .from(schema.coordinationEvaluations)
        .where(eq(schema.coordinationEvaluations.status, 'skipped'))
    )[0]
    expect(skipped?.failureCode).toBe('already_completed')
    const inferences = await database.db
      .select()
      .from(schema.contextEntries)
      .where(eq(schema.contextEntries.projectId, projectId))
    expect(inferences.filter((entry) => entry.kind === 'inference')).toHaveLength(1)
  })

  it('expires queued work instead of evaluating it after the queue TTL', async () => {
    // 夹具：过期 queued（生产路径由 10 分钟 TTL 产生）。
    await database.db.insert(schema.coordinationEvaluations).values({
      id: randomUUID(),
      projectId,
      status: 'queued',
      attempt: 1,
      inputDigest: 'f'.repeat(64),
      inputManifest: {},
      manifestVersion: 1,
      rulesVersion: 'pc04a.v1',
      processorVersion: 'deterministic.v1',
      queuedAt: new Date(Date.now() - 20 * 60_000),
      queueExpiresAt: new Date(Date.now() - 10 * 60_000),
    })
    const tick = await runCoordinationTick({ database, now: new Date() })
    expect(tick.expired).toBe(1)
    const rows = await database.db
      .select()
      .from(schema.coordinationEvaluations)
      .where(eq(schema.coordinationEvaluations.projectId, projectId))
    expect(rows[0]).toMatchObject({ status: 'skipped', failureCode: 'stale_queue' })
  })

  it('keeps Inference payload within the DB budget for long open questions', async () => {
    const longQuestion = '供应商还没有最终确认'.repeat(200)
    const tasks: string[] = []
    for (let index = 0; index < 10; index += 1) {
      const id = await createTask(ctx, alice, projectId, alice.userId)
      tasks.push(id)
      await confirmAgreement(ctx, alice, id, { ...CONTENT, openQuestions: longQuestion })
    }
    const result = await evaluate(ctx, bob, projectId)
    expect(result.evaluation.status).toBe('completed')
    const inference = await database.db
      .select()
      .from(schema.contextEntries)
      .where(eq(schema.contextEntries.id, result.inferenceEntryId ?? ''))
    expect(inference).toHaveLength(1)
    const payload = inference[0]?.payload as Record<string, unknown>
    expect(Buffer.byteLength(JSON.stringify(payload), 'utf8')).toBeLessThanOrEqual(16_384)
    expect(Buffer.byteLength(inference[0]?.body ?? '', 'utf8')).toBeLessThanOrEqual(65_536)
    expect(Array.isArray(payload.openQuestions)).toBe(true)
    expect(Number(payload.openQuestionsOmitted)).toBeGreaterThan(0)
    expect(tasks).toHaveLength(10)
  })

  it('merges an input that advanced after enqueue and keeps digest linkage', async () => {
    await confirmAgreement(ctx, alice, taskId)
    const queued = (
      await database.db
        .select()
        .from(schema.coordinationEvaluations)
        .where(eq(schema.coordinationEvaluations.projectId, projectId))
    )[0]
    if (queued === undefined) throw new Error('queued evaluation missing')
    // 故障注入：模拟 enqueue 之后、求值之前输入前进（正常路径由 enqueue 合并）。
    await database.db
      .update(schema.coordinationEvaluations)
      .set({ inputDigest: '0'.repeat(64) })
      .where(eq(schema.coordinationEvaluations.id, queued.id))

    // 走 tick 直接进入 evaluator 的「输入前进」分支（显式触发会先被 enqueue 合并，
    // 覆盖不到该分支）。
    const tick = await runCoordinationTick({ database, now: new Date() })
    expect(tick.completed).toBe(1)
    const evaluations = await database.db
      .select()
      .from(schema.coordinationEvaluations)
      .where(eq(schema.coordinationEvaluations.projectId, projectId))
    const completed = evaluations.find((row) => row.status === 'completed')
    if (completed === undefined) throw new Error('completed evaluation missing')
    expect(completed.manifestVersion).toBe(2)
    const inference = await database.db
      .select()
      .from(schema.contextEntries)
      .where(eq(schema.contextEntries.id, completed.inferenceEntryId ?? ''))
    expect(inference[0]?.inputDigest).toBe(completed.inputDigest)
    expect(evaluations[0]?.inputDigest).toBe(completed.inputDigest)
  })

  it('hides an Inference when its output or cited facts are corrected', async () => {
    await confirmAgreement(ctx, alice, taskId)
    await confirmAgreement(ctx, alice, secondTaskId)
    const result = await evaluate(ctx, bob, projectId)
    expect(result.inferenceEntryId).not.toBeNull()

    // 纠正被引用的一条 Decision：不重新评估，读面也不能继续显示旧结论。
    const citedDecision = (
      await database.db
        .select()
        .from(schema.contextEntries)
        .where(eq(schema.contextEntries.businessRef, `taskSpec:${taskId}`))
    ).find((row) => row.status === 'active')
    if (citedDecision === undefined) throw new Error('decision missing')
    const corrected = await apiInject(ctx, bob, {
      method: 'POST',
      url: `/api/v1/projects/${projectId}/context/${citedDecision.id}/correction`,
      payload: { correctionKind: 'amend', note: '这条不再适用' },
      idempotencyKey: idemKey(),
    })
    expect(corrected.statusCode).toBe(201)
    expect((await coordination(ctx, bob, projectId)).latestInference).toBeNull()

    // 重新评估后，纠正 Inference 本身也会让它退出读面。
    const reEvaluated = await evaluate(ctx, bob, projectId)
    expect(reEvaluated.evaluation.status).toBe('completed')
    const correctedInference = await apiInject(ctx, bob, {
      method: 'POST',
      url: `/api/v1/projects/${projectId}/context/${String(reEvaluated.inferenceEntryId)}/correction`,
      payload: { correctionKind: 'negate', note: '摘要不准确' },
      idempotencyKey: idemKey(),
    })
    expect(correctedInference.statusCode).toBe(201)
    expect((await coordination(ctx, bob, projectId)).latestInference).toBeNull()
  })

  it('requires a session and a real project for coordination reads', async () => {
    const anonymous = await ctx.app.inject({
      method: 'GET',
      url: `/api/v1/projects/${projectId}/coordination`,
    })
    expect(anonymous.statusCode).toBe(401)
    const empty = await coordination(ctx, alice, projectId)
    expect(empty.state).toMatchObject({
      enabled: true,
      rulesVersion: 'pc04a.v1',
      processorVersion: 'deterministic.v1',
      lastSuccessfulEvaluationId: null,
    })
    expect(empty.latestEvaluation).toBeNull()
    expect(empty.latestInference).toBeNull()
    const missing = await apiInject(ctx, alice, {
      method: 'GET',
      url: '/api/v1/projects/00000000-0000-4000-8000-000000000000/coordination',
    })
    expect(missing.statusCode).toBe(404)
    const malformed = await apiInject(ctx, alice, {
      method: 'GET',
      url: '/api/v1/projects/not-a-uuid/coordination',
    })
    expect(malformed.statusCode).toBe(400)
  })
})
