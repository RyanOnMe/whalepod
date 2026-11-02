/**
 * ADR-0025（PC-03a）：项目事实账本的内部事件判据。
 *
 * 驱动走生产 HTTP（任务约定确认、纠正）与生产状态收口（applyRunStatus）；
 * 读面直接走成员 HTTP。来源修订、Thread/WorkLink 与外部正文不在本切片。
 */
import { randomBytes, randomUUID } from 'node:crypto'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { and, eq, sql } from 'drizzle-orm'
import type { Database } from '@whalepod/db'
import { getTeam, schema } from '@whalepod/db'
import {
  apiInject,
  createTestApp,
  createTestDatabase,
  driveInviteAndAccept,
  driveSetup,
  idemKey,
  insertRunRow,
  resetDatabase,
  runEventFrame,
  type Session,
  type TestApp,
} from './helpers.js'

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

async function confirmAgreement(
  ctx: TestApp,
  session: Session,
  taskId: string,
  content: typeof CONTENT,
): Promise<{ readonly revisionId: string; readonly revisionNumber: number }> {
  const draft = await apiInject(ctx, session, {
    method: 'POST',
    url: `/api/v1/tasks/${taskId}/agreement/draft`,
    payload: { content },
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
  return {
    revisionId: confirmed.json().data.id as string,
    revisionNumber: confirmed.json().data.revisionNumber as number,
  }
}

async function contextEntries(
  ctx: TestApp,
  session: Session,
  projectId: string,
): Promise<Array<Record<string, unknown>>> {
  const res = await apiInject(ctx, session, {
    method: 'GET',
    url: `/api/v1/projects/${projectId}/context`,
  })
  expect(res.statusCode).toBe(200)
  return res.json().data.entries as Array<Record<string, unknown>>
}

/**
 * Run 前置运行件：复用 driveSetup 已建的 singleton Team，不再 seedRunPrereqs
 * （后者会重复插入 Team 撞唯一约束）。只用于断言生产状态收口的投影。
 */
async function seedRunDependencies(
  database: Database,
  ownerUserId: string,
): Promise<{
  agentId: string
  revisionId: string
  deviceId: string
  workspaceId: string
}> {
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
    name: `pack-${suffix}`,
    installations: [],
    packDigest: 'a'.repeat(64),
    createdBy: ownerUserId,
  })
  await database.db.insert(schema.agents).values({
    id: agentId,
    name: `agent-${suffix}`,
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
    name: `dev-${suffix}`,
    platform: 'darwin',
    architecture: 'arm64',
    nodeVersion: '24.12.0',
    nodeAppVersion: '0.1.0',
    tokenHash: randomBytes(32),
    capabilities: {},
  })
  await database.db.insert(schema.workspaces).values({
    id: workspaceId,
    deviceId,
    ownerUserId,
    name: `ws-${suffix}`,
    kind: 'directory',
    capabilities: { read: true, write: true },
    available: true,
  })
  return { agentId, revisionId, deviceId, workspaceId }
}

describe('PC-03a project context ledger', () => {
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
    projectId = await createProject(ctx, alice, `pc03a-${Date.now()}`)
    taskId = await createTask(ctx, alice, projectId, alice.userId)
  })
  afterEach(async () => {
    await ctx.app.close()
  })
  afterAll(async () => {
    await database.close()
  })

  it('projects a confirmed agreement as a Decision and supersedes the prior version', async () => {
    const first = await confirmAgreement(ctx, alice, taskId, CONTENT)
    let entries = await contextEntries(ctx, bob, projectId)
    const decision = entries.find((entry) => entry.kind === 'decision')
    expect(decision).toMatchObject({
      kind: 'decision',
      status: 'active',
      businessRef: `taskSpec:${taskId}`,
      businessVersion: `${first.revisionId}:${first.revisionNumber}`,
      actorKind: 'member',
      createdBy: alice.userId,
      targetEntryId: null,
      correctedAt: null,
    })
    expect(decision?.body).toContain('把预算从 12 万改为 8 万')
    // ADR-0025 §9：提交后写 context.entry_recorded；字段只含不透明 id/类型/状态/时间。
    expect(
      ctx.contextEvents.find(
        (event) => event.action === 'context.entry_recorded' && event.kind === 'decision',
      ),
    ).toMatchObject({
      component: 'hub.context',
      projectId,
      entryId: decision?.id,
      status: 'active',
      businessRef: `taskSpec:${taskId}`,
    })
    expect((decision?.citations as unknown[])[0]).toMatchObject({
      kind: 'business',
      businessRef: `taskSpec:${taskId}`,
      businessVersion: `${first.revisionId}:${first.revisionNumber}`,
    })

    const second = await confirmAgreement(ctx, alice, taskId, { ...CONTENT, goal: '预算改为 6 万' })
    entries = await contextEntries(ctx, bob, projectId)
    const active = entries.filter((entry) => entry.kind === 'decision')
    expect(active).toHaveLength(1)
    expect(active[0]).toMatchObject({
      businessRef: `taskSpec:${taskId}`,
      businessVersion: `${second.revisionId}:${second.revisionNumber}`,
    })
    const old = await database.db
      .select()
      .from(schema.contextEntries)
      .where(
        and(
          eq(schema.contextEntries.kind, 'decision'),
          eq(schema.contextEntries.businessVersion, `${first.revisionId}:${first.revisionNumber}`),
        ),
      )
    expect(old[0]?.status).toBe('superseded')
  })

  it('emits entry_recorded only for the transaction that created the Decision', async () => {
    const draft = await apiInject(ctx, alice, {
      method: 'POST',
      url: `/api/v1/tasks/${taskId}/agreement/draft`,
      payload: { content: CONTENT },
      idempotencyKey: idemKey(),
    })
    expect(draft.statusCode).toBe(200)
    const key = idemKey()
    const request = {
      method: 'POST' as const,
      url: `/api/v1/tasks/${taskId}/agreement/confirm`,
      payload: { draftVersion: draft.json().data.draftVersion as number },
      idempotencyKey: key,
    }
    expect((await apiInject(ctx, alice, request)).statusCode).toBe(200)
    expect((await apiInject(ctx, alice, request)).statusCode).toBe(200)
    const events = ctx.contextEvents.filter(
      (event) => event.action === 'context.entry_recorded' && event.kind === 'decision',
    )
    expect(events).toHaveLength(1)
    // 观测行只含不透明字段：正文与任务标题都不能出现在日志载荷里。
    expect(JSON.stringify(events[0])).not.toContain(CONTENT.goal)
    expect(Object.keys(events[0] ?? {})).not.toContain('body')
    expect(Object.keys(events[0] ?? {})).not.toContain('title')

    // 失败的确认（空目标 400）整个事务回滚：不能留下指向不存在 entry 的观测。
    const failedTask = await createTask(ctx, alice, projectId, alice.userId)
    const failedDraft = await apiInject(ctx, alice, {
      method: 'POST',
      url: `/api/v1/tasks/${failedTask}/agreement/draft`,
      payload: { content: { ...CONTENT, goal: '   ' } },
      idempotencyKey: idemKey(),
    })
    expect(failedDraft.statusCode).toBe(200)
    const failed = await apiInject(ctx, alice, {
      method: 'POST',
      url: `/api/v1/tasks/${failedTask}/agreement/confirm`,
      payload: { draftVersion: failedDraft.json().data.draftVersion },
      idempotencyKey: idemKey(),
    })
    expect(failed.statusCode).toBe(400)
    expect(
      ctx.contextEvents.filter(
        (event) => event.action === 'context.entry_recorded' && event.kind === 'decision',
      ),
    ).toHaveLength(1)
  })

  it('clips a legitimate multi-byte agreement body instead of failing the confirmation', async () => {
    const long = '汉'.repeat(8_000)
    const confirmed = await confirmAgreement(ctx, alice, taskId, {
      goal: long,
      constraints: long,
      acceptance: long,
      openQuestions: '',
    })
    expect(confirmed.revisionNumber).toBe(1)
    const entries = await contextEntries(ctx, alice, projectId)
    const decision = entries.find((entry) => entry.kind === 'decision')
    expect(decision).toBeDefined()
    expect(Buffer.byteLength(String(decision?.body), 'utf8')).toBeLessThanOrEqual(65_536)
    expect(String(decision?.body).endsWith('…')).toBe(true)
  })

  it('appends one correction, hides the corrected entry, and is idempotent', async () => {
    const confirmed = await confirmAgreement(ctx, alice, taskId, CONTENT)
    const entries = await contextEntries(ctx, alice, projectId)
    const target = entries.find(
      (entry) =>
        entry.businessRef === `taskSpec:${taskId}` &&
        entry.businessVersion === `${confirmed.revisionId}:${confirmed.revisionNumber}`,
    )
    if (target === undefined) throw new Error('decision entry missing')

    const first = await apiInject(ctx, bob, {
      method: 'POST',
      url: `/api/v1/projects/${projectId}/context/${String(target.id)}/correction`,
      payload: { correctionKind: 'amend', note: '8 万只是建议，尚未批准' },
      idempotencyKey: idemKey(),
    })
    expect(first.statusCode).toBe(201)
    expect(first.json().data).toMatchObject({
      kind: 'correction',
      targetEntryId: target.id,
      actorKind: 'member',
      createdBy: bob.userId,
      citations: [],
    })

    const replay = await apiInject(ctx, bob, {
      method: 'POST',
      url: `/api/v1/projects/${projectId}/context/${String(target.id)}/correction`,
      payload: { correctionKind: 'negate', note: '第二次纠正不应覆盖第一次' },
      idempotencyKey: idemKey(),
    })
    expect(replay.statusCode).toBe(201)
    expect(replay.json().data.id).toBe(first.json().data.id)
    expect(replay.json().data.body).toBe('8 万只是建议，尚未批准')
    // 同 key/第二次纠正都不是新追加：hub.context 只记一次，且记录存储的 kind。
    const correctedEvents = ctx.contextEvents.filter(
      (event) => event.action === 'context.entry_corrected',
    )
    expect(correctedEvents).toHaveLength(1)
    expect(JSON.stringify(correctedEvents[0])).not.toContain('8 万只是建议')

    const visible = await contextEntries(ctx, alice, projectId)
    expect(visible.some((entry) => entry.id === target.id)).toBe(false)
    expect(visible.find((entry) => entry.id === first.json().data.id)).toMatchObject({
      kind: 'correction',
      targetEntryId: target.id,
    })

    const corrected = await apiInject(ctx, alice, {
      method: 'POST',
      url: `/api/v1/projects/${projectId}/context/${String(first.json().data.id)}/correction`,
      payload: { correctionKind: 'unrelated', note: '纠正不能再次纠正' },
      idempotencyKey: idemKey(),
    })
    expect(corrected.statusCode).toBe(409)
  })

  it('records a run terminal state as an idempotent Observation through the real event path', async () => {
    const seed = await seedRunDependencies(database, alice.userId)
    const runId = await insertRunRow(database.db, {
      taskId,
      ownerUserId: alice.userId,
      agentId: seed.agentId,
      profileRevisionId: seed.revisionId,
      deviceId: seed.deviceId,
      workspaceId: seed.workspaceId,
      status: 'running',
    })
    // 走生产事件路径（ingestNodeEvent → handleRunEvent → run-status 收口），
    // 不直调 applyRunStatus：评审 B1 曾用真实 run.completed 探针证明收口漏接。
    const frame = runEventFrame(runId, 1, { type: 'run.completed', finalText: 'done' })
    await ctx.app.runOrchestrator.ingestNodeEvent(
      { deviceId: seed.deviceId, ownerUserId: alice.userId },
      frame,
    )
    // 同一 seq 重放整帧跳过（幂等），不产生第二条 Observation。
    await ctx.app.runOrchestrator.ingestNodeEvent(
      { deviceId: seed.deviceId, ownerUserId: alice.userId },
      frame,
    )

    const entries = await contextEntries(ctx, alice, projectId)
    const observations = entries.filter(
      (entry) => entry.kind === 'observation' && entry.businessRef === `run:${runId}`,
    )
    expect(observations).toHaveLength(1)
    expect(observations[0]).toMatchObject({
      businessVersion: 'completed',
      actorKind: 'system',
      createdBy: null,
    })
    expect((observations[0]?.citations as unknown[])[0]).toMatchObject({
      kind: 'business',
      businessRef: `run:${runId}`,
      businessVersion: 'completed',
    })
    // ADR-0025 §9：提交后才写 context.entry_recorded，字段只含不透明 id/类型/状态/时间。
    const recordedEvents = ctx.contextEvents.filter(
      (event) => event.action === 'context.entry_recorded' && event.kind === 'observation',
    )
    expect(recordedEvents).toHaveLength(1)
    expect(recordedEvents[0]).toMatchObject({
      component: 'hub.context',
      projectId,
      entryId: observations[0]?.id,
      status: 'active',
      businessRef: `run:${runId}`,
      businessVersion: 'completed',
    })
  })

  it('pages by entry identity and exposes an explicit cursor instead of truncating', async () => {
    const secondTask = await createTask(ctx, alice, projectId, alice.userId)
    await confirmAgreement(ctx, alice, taskId, CONTENT)
    await confirmAgreement(ctx, alice, secondTask, CONTENT)

    const first = await apiInject(ctx, alice, {
      method: 'GET',
      url: `/api/v1/projects/${projectId}/context?limit=1`,
    })
    expect(first.statusCode).toBe(200)
    expect(first.json().data.entries).toHaveLength(1)
    const cursor = first.json().data.nextCursor as string | null
    expect(cursor).toEqual(expect.any(String))

    const second = await apiInject(ctx, alice, {
      method: 'GET',
      url: `/api/v1/projects/${projectId}/context?limit=1&cursor=${encodeURIComponent(String(cursor))}`,
    })
    expect(second.statusCode).toBe(200)
    expect(second.json().data.entries).toHaveLength(1)
    expect(second.json().data.nextCursor).toBeNull()
    expect(second.json().data.entries[0].id).not.toBe(first.json().data.entries[0].id)

    const invalid = await apiInject(ctx, alice, {
      method: 'GET',
      url: `/api/v1/projects/${projectId}/context?cursor=not-a-cursor`,
    })
    expect(invalid.statusCode).toBe(400)
  })

  it('does not lose entries that share the same millisecond (microsecond keyset)', async () => {
    const createdAt = new Date('2026-01-01T00:00:00.123Z')
    const ids = [randomUUID(), randomUUID()]
    // 故障注入式夹具（不是生产路径）：生产写入使用 DB now()，无法稳定制造同毫秒对。
    // 关键是把两条 created_at 钉在**同一毫秒内不同的微秒**（.123456/.123900）：
    // 旧游标只带 JS 毫秒（.123000），对这两行既不 < 也不 =，整组会被静默跳过。
    for (const id of ids) {
      await database.db.insert(schema.contextEntries).values({
        id,
        projectId,
        kind: 'observation',
        status: 'active',
        title: 'same-millisecond observation',
        body: 'fixture',
        payload: {},
        actorKind: 'system',
        businessRef: `fixture:${id}`,
        businessVersion: '1',
        createdAt,
        updatedAt: createdAt,
      })
      await database.db.insert(schema.contextCitations).values({
        entryId: id,
        kind: 'business',
        businessRef: `fixture:${id}`,
        businessVersion: '1',
        occurredAt: createdAt,
      })
    }
    await database.db.execute(
      sql`update context_entry set created_at = '2026-01-01 00:00:00.123456+00'::timestamptz where id = ${ids[0]}`,
    )
    await database.db.execute(
      sql`update context_entry set created_at = '2026-01-01 00:00:00.123900+00'::timestamptz where id = ${ids[1]}`,
    )

    const first = await apiInject(ctx, alice, {
      method: 'GET',
      url: `/api/v1/projects/${projectId}/context?limit=1`,
    })
    expect(first.statusCode).toBe(200)
    expect(first.json().data.entries).toHaveLength(1)
    const cursor = first.json().data.nextCursor as string | null
    expect(cursor).toEqual(expect.any(String))
    const second = await apiInject(ctx, alice, {
      method: 'GET',
      url: `/api/v1/projects/${projectId}/context?limit=1&cursor=${encodeURIComponent(String(cursor))}`,
    })
    expect(second.statusCode).toBe(200)
    expect(second.json().data.entries).toHaveLength(1)
    const seen = new Set([
      first.json().data.entries[0].id as string,
      second.json().data.entries[0].id as string,
    ])
    expect([...seen].sort()).toEqual([...ids].sort())
  })

  it('withholds entries without usable citations instead of showing an unreferenced fact', async () => {
    const bareId = randomUUID()
    // 故障注入（不是生产路径）：entry 与 citation 本应同事务写入，这里故意只写 entry。
    // 删除条件：DB 侧补上「非 Correction 必须有 citation」的延迟约束后，改为断言约束拒绝。
    await database.db.insert(schema.contextEntries).values({
      id: bareId,
      projectId,
      kind: 'observation',
      status: 'active',
      title: '没有引用的观察',
      body: '不应出现在读面',
      actorKind: 'system',
      businessRef: `bare:${bareId}`,
      businessVersion: '1',
    })

    const res = await apiInject(ctx, alice, {
      method: 'GET',
      url: `/api/v1/projects/${projectId}/context`,
    })
    expect(res.statusCode).toBe(200)
    expect(
      (res.json().data.entries as Array<{ id: string }>).some((entry) => entry.id === bareId),
    ).toBe(false)
    expect(
      ctx.warnEvents.some(
        (warning) =>
          warning.component === 'hub.context' && warning.msg.includes('without usable citations'),
      ),
    ).toBe(true)
  })

  it('emits entry_recorded when cancelling a Task with a queued Run', async () => {
    const accepted = await apiInject(ctx, alice, {
      method: 'POST',
      url: `/api/v1/tasks/${taskId}/accept`,
    })
    expect(accepted.statusCode).toBe(200)
    const seed = await seedRunDependencies(database, alice.userId)
    const runId = await insertRunRow(database.db, {
      taskId,
      ownerUserId: alice.userId,
      agentId: seed.agentId,
      profileRevisionId: seed.revisionId,
      deviceId: seed.deviceId,
      workspaceId: seed.workspaceId,
      status: 'queued',
    })

    const cancelled = await apiInject(ctx, alice, {
      method: 'POST',
      url: `/api/v1/tasks/${taskId}/cancel`,
    })
    expect(cancelled.statusCode).toBe(200)
    const entries = await contextEntries(ctx, alice, projectId)
    expect(
      entries.find((entry) => entry.kind === 'observation' && entry.businessRef === `run:${runId}`),
    ).toMatchObject({ businessVersion: 'cancelled' })
    expect(
      ctx.contextEvents.filter(
        (event) =>
          event.action === 'context.entry_recorded' && event.businessRef === `run:${runId}`,
      ),
    ).toHaveLength(1)
  })

  it('requires a session and scopes reads to the project', async () => {
    const anonymous = await ctx.app.inject({
      method: 'GET',
      url: `/api/v1/projects/${projectId}/context`,
    })
    expect(anonymous.statusCode).toBe(401)

    const missing = await apiInject(ctx, alice, {
      method: 'GET',
      url: `/api/v1/projects/00000000-0000-4000-8000-000000000000/context`,
    })
    expect(missing.statusCode).toBe(404)

    const malformed = await apiInject(ctx, alice, {
      method: 'GET',
      url: '/api/v1/projects/not-a-uuid/context',
    })
    expect(malformed.statusCode).toBe(400)

    // 跨项目不可见：另一个项目的 Decision 不混入本项目的当前有效集。
    const otherProject = await createProject(ctx, alice, 'pc03a-other')
    const otherTask = await createTask(ctx, alice, otherProject, alice.userId)
    await confirmAgreement(ctx, alice, otherTask, CONTENT)
    expect(await contextEntries(ctx, alice, projectId)).toHaveLength(0)
    const other = await contextEntries(ctx, alice, otherProject)
    expect(other).toHaveLength(1)
    expect(other[0]?.businessRef).toBe(`taskSpec:${otherTask}`)
  })
})
