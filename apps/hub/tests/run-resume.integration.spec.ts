/**
 * resume 续跑血缘 HTTP 面（ADR-0009 切片⑤；#237；03 §2.6 resume_from_run_id）。
 *
 * 判定基线（全部走真人 HTTP 路径）：
 * - 终态且有会话的来源 Run 之上带 resumeFromRunId 新建 → 201，响应与 Task Room
 *   聚合视图都携带 resume 血缘；outbox 的 run.start payload 成对携带
 *   resumeOfRunId + resumeSessionId（Node 复用来源 home 的依据）；
 * - 守卫（全部 409 CONFLICT，除同形 404）：非终态来源 / 来源无会话（从未到过
 *   running）/ 换 device / 换 workspace（「同 Workspace」是机器判据，ADR-0009
 *   决策 3 约束：ResumeAgentOptions 不收 cwd，工作目录来自持久化 header）；
 * - 跨 Task 来源 / 未知来源 → 404（不可枚举，与 rerun 同口径）；
 * - rerunOfRunId 与 resumeFromRunId 同请求双带 → 400（协议 superRefine fail-closed）；
 * - 重复点击（同 Idempotency-Key）→ 同一 Run。
 */
import { eq, sql } from 'drizzle-orm'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { Database } from '@whalepod/db'
import { getRun, schema } from '@whalepod/db'
import {
  apiInject,
  createTestApp,
  createTestDatabase,
  driveInviteAndAccept,
  driveSetup,
  idemKey,
  insertRunRow,
  makeHarness,
  resetDatabase,
  runEventFrame,
  seedRunChainForUser,
  type Session,
  type TestApp,
  TEST_DSH_VERSION,
} from './helpers.js'

describe('resume lineage (ADR-0009 slice 5)', () => {
  let database: Database
  let ctx: TestApp
  let alice: Session
  let bob: Session
  let bobChain: Awaited<ReturnType<typeof seedRunChainForUser>>
  let taskId: string
  let projectId: string
  let bobUserId: string

  beforeAll(async () => {
    database = await createTestDatabase()
  })
  beforeEach(async () => {
    await resetDatabase(database)
  })
  afterEach(async () => {
    if (ctx !== undefined) await ctx.close()
  })
  afterAll(async () => {
    await database.close()
  })

  async function seedWorld(): Promise<void> {
    ctx = await createTestApp(database)
    alice = await driveSetup(ctx, 'alice')
    const bobInvite = await driveInviteAndAccept(ctx, alice, {
      username: 'bob',
      displayName: 'Bob',
      password: 'correct horse battery staple',
    })
    bob = bobInvite.session

    const project = await apiInject(ctx, bob, {
      method: 'POST',
      url: '/api/v1/projects',
      payload: { name: 'resume-project' },
    })
    projectId = (project.json() as { data: { id: string } }).data.id
    const session = await apiInject(ctx, bob, { method: 'GET', url: '/api/v1/auth/session' })
    bobUserId = (session.json() as { data: { userId: string } }).data.userId
    const task = await apiInject(ctx, alice, {
      method: 'POST',
      url: `/api/v1/projects/${projectId}/tasks`,
      payload: { title: 'resume me', assigneeUserId: bobUserId },
    })
    taskId = (task.json() as { data: { id: string } }).data.id
    await apiInject(ctx, bob, { method: 'POST', url: `/api/v1/tasks/${taskId}/accept` })

    bobChain = await seedRunChainForUser(database.db, bobUserId)
    await database.db
      .update(schema.devices)
      .set({ dshDistributionVersion: TEST_DSH_VERSION, lastSeenAt: new Date() })
      .where(eq(schema.devices.id, bobChain.deviceId))
  }

  /** 种一个终态、有会话的来源 Run（resume 的正常前提）。 */
  async function seedTerminalSourceRun(
    overrides: { status?: string; dshSessionId?: string | null; legacy?: boolean } = {},
  ): Promise<string> {
    return insertRunRow(database.db, {
      taskId,
      ownerUserId: bobUserId,
      agentId: bobChain.agentId,
      profileRevisionId: bobChain.profileRevisionId,
      deviceId: bobChain.deviceId,
      workspaceId: bobChain.workspaceId,
      artifactInputManifest: overrides.legacy ? null : { taskId, artifacts: [] },
      status: (overrides.status ?? 'completed') as 'completed',
      dshSessionId:
        overrides.dshSessionId === undefined ? 'whalepod-run-source' : overrides.dshSessionId,
    })
  }

  interface RunBody {
    artifactInputIds?: string[]
    resumeFromRunId?: string
    rerunOfRunId?: string
    deviceId?: string
    workspaceId?: string
    idempotencyKey?: string
  }

  async function createRun(body: RunBody): Promise<{
    status: number
    data?: { id: string; resumeFromRunId: string | null; rerunOfRunId: string | null }
    error?: { code: string; message: string }
  }> {
    const response = await apiInject(ctx, bob, {
      method: 'POST',
      url: `/api/v1/tasks/${taskId}/runs`,
      payload: {
        agentId: bobChain.agentId,
        ...(body.artifactInputIds === undefined ? {} : { artifactInputIds: body.artifactInputIds }),
        deviceId: body.deviceId ?? bobChain.deviceId,
        workspaceId: body.workspaceId ?? bobChain.workspaceId,
        prompt: 'continue where we left off',
        ...(body.resumeFromRunId !== undefined ? { resumeFromRunId: body.resumeFromRunId } : {}),
        ...(body.rerunOfRunId !== undefined ? { rerunOfRunId: body.rerunOfRunId } : {}),
      },
      ...(body.idempotencyKey !== undefined ? { idempotencyKey: body.idempotencyKey } : {}),
    })
    const json = response.json() as
      | {
          ok: true
          data: { id: string; resumeFromRunId: string | null; rerunOfRunId: string | null }
        }
      | { ok: false; error: { code: string; message: string } }
    return response.statusCode === 201
      ? {
          status: response.statusCode,
          data: (
            json as {
              data: { id: string; resumeFromRunId: string | null; rerunOfRunId: string | null }
            }
          ).data,
        }
      : {
          status: response.statusCode,
          error: (json as { error: { code: string; message: string } }).error,
        }
  }

  it('#394 来源设备已掉线（lastSeenAt 超窗）→ 续跑/重跑都 409 DEVICE_OFFLINE，且不建新 Run', async () => {
    await seedWorld()
    const resumeSource = await seedTerminalSourceRun()
    const rerunSource = await seedTerminalSourceRun()
    await database.db
      .update(schema.devices)
      .set({ lastSeenAt: new Date(Date.now() - 31_000) })
      .where(eq(schema.devices.id, bobChain.deviceId))
    const before = await database.db
      .select({ id: schema.runs.id })
      .from(schema.runs)
      .where(eq(schema.runs.taskId, taskId))

    const resumed = await createRun({ resumeFromRunId: resumeSource, idempotencyKey: idemKey() })
    expect(resumed.status).toBe(409)
    expect(resumed.error?.code).toBe('DEVICE_OFFLINE')
    const rerun = await createRun({ rerunOfRunId: rerunSource, idempotencyKey: idemKey() })
    expect(rerun.status).toBe(409)
    expect(rerun.error?.code).toBe('DEVICE_OFFLINE')

    const after = await database.db
      .select({ id: schema.runs.id })
      .from(schema.runs)
      .where(eq(schema.runs.taskId, taskId))
    expect(after.map((row) => row.id).sort()).toEqual(before.map((row) => row.id).sort())
  })

  it('#394 来源设备已撤销 → 续跑 409 DEVICE_REVOKED（不降级成离线），且不建新 Run', async () => {
    await seedWorld()
    const sourceId = await seedTerminalSourceRun()
    await database.db
      .update(schema.devices)
      .set({ revokedAt: new Date() })
      .where(eq(schema.devices.id, bobChain.deviceId))
    const before = await database.db
      .select({ id: schema.runs.id })
      .from(schema.runs)
      .where(eq(schema.runs.taskId, taskId))

    const created = await createRun({ resumeFromRunId: sourceId, idempotencyKey: idemKey() })
    expect(created.status).toBe(409)
    expect(created.error?.code).toBe('DEVICE_REVOKED')

    const after = await database.db
      .select({ id: schema.runs.id })
      .from(schema.runs)
      .where(eq(schema.runs.taskId, taskId))
    expect(after.map((row) => row.id).sort()).toEqual(before.map((row) => row.id).sort())
  })

  it('creates a resume run: 201 + lineage in response/DB/task room + paired run.start payload', async () => {
    await seedWorld()
    const sourceId = await seedTerminalSourceRun()
    const created = await createRun({ resumeFromRunId: sourceId, idempotencyKey: idemKey() })
    expect(created.status).toBe(201)
    expect(created.data?.resumeFromRunId).toBe(sourceId)
    expect(created.data?.rerunOfRunId).toBeNull()

    // DB 血缘（与 rerun 列互不混用）。
    const row = await getRun(database.db, created.data!.id)
    expect(row?.resumeFromRunId).toBe(sourceId)
    expect(row?.rerunOfRunId).toBeNull()

    // run.start payload 成对携带 resume 字段（Node 复用来源 home 的依据）。
    // outbox 无 runId 列（锚点是 commandId/payload），按 payload->>'runId' 查。
    const outboxRow = await database.db
      .select()
      .from(schema.dispatchOutbox)
      .where(sql`${schema.dispatchOutbox.payload}->>'runId' = ${created.data!.id}`)
      .limit(1)
    const payload = outboxRow[0]?.payload as Record<string, unknown> | undefined
    expect(payload?.resumeOfRunId).toBe(sourceId)
    expect(payload?.resumeSessionId).toBe('whalepod-run-source')

    // Task Room 聚合带血缘（UI 血缘的数据源）。
    const room = await apiInject(ctx, bob, { method: 'GET', url: `/api/v1/tasks/${taskId}` })
    const runs = (
      room.json() as { data: { runs: Array<{ id: string; resumeFromRunId: string | null }> } }
    ).data.runs
    expect(runs.find((run) => run.id === created.data!.id)?.resumeFromRunId).toBe(sourceId)
  })

  it('guards: non-terminal source → 409; source without session → 409; cross-task → 404', async () => {
    await seedWorld()
    const runningSource = await seedTerminalSourceRun({ status: 'running' })
    const noSessionSource = await seedTerminalSourceRun({ dshSessionId: null })
    const active = await createRun({ resumeFromRunId: runningSource, idempotencyKey: idemKey() })
    expect(active.status).toBe(409)
    expect(active.error?.code).toBe('CONFLICT')
    expect(active.error?.message).toContain('terminal')

    // 来源无会话（从未到过 running）：409，文案点名「没有会话可续」。
    const noSession = await createRun({
      resumeFromRunId: noSessionSource,
      idempotencyKey: idemKey(),
    })
    expect(noSession.status).toBe(409)
    expect(noSession.error?.message).toContain('no session')

    // 跨 Task：404 同形（不可枚举）。seedRunChainForUser 不暴露它自己的 task，
    // 这里真建第二个 task 种来源 Run。
    const task2 = await apiInject(ctx, alice, {
      method: 'POST',
      url: `/api/v1/projects/${projectId}/tasks`,
      payload: { title: 'other task', assigneeUserId: bobUserId },
    })
    const task2Id = (task2.json() as { data: { id: string } }).data.id
    const otherTaskRun = await insertRunRow(database.db, {
      taskId: task2Id,
      ownerUserId: bobUserId,
      agentId: bobChain.agentId,
      profileRevisionId: bobChain.profileRevisionId,
      deviceId: bobChain.deviceId,
      workspaceId: bobChain.workspaceId,
      status: 'completed',
      dshSessionId: 'whalepod-run-other',
    })
    const cross = await createRun({ resumeFromRunId: otherTaskRun, idempotencyKey: idemKey() })
    expect(cross.status).toBe(404)
  })

  it('same-workspace is a machine guard: different device or workspace → 409, never silent fallback', async () => {
    await seedWorld()
    const sourceId = await seedTerminalSourceRun()
    // 换 workspace（同 device）：静默错位面（cwd 来自持久化 header）→ 拒绝。
    const otherWorkspace = await database.db
      .insert(schema.workspaces)
      .values({
        id: crypto.randomUUID(),
        deviceId: bobChain.deviceId,
        ownerUserId: bobUserId,
        name: 'other-ws',
        kind: 'directory',
        capabilities: { read: true, write: true },
        available: true,
      })
      .returning({ id: schema.workspaces.id })
    const wrongWs = await createRun({
      resumeFromRunId: sourceId,
      workspaceId: otherWorkspace[0]!.id,
      idempotencyKey: idemKey(),
    })
    expect(wrongWs.status).toBe(409)
    expect(wrongWs.error?.message).toContain('same device and workspace')
  })

  it('rerun + resume in one request → 400 (protocol superRefine fail-closed)', async () => {
    await seedWorld()
    const sourceId = await seedTerminalSourceRun()
    const both = await createRun({
      resumeFromRunId: sourceId,
      rerunOfRunId: sourceId,
      idempotencyKey: idemKey(),
    })
    expect(both.status).toBe(400)
  })

  it('same idempotency key → same run (double click is one intent)', async () => {
    await seedWorld()
    const sourceId = await seedTerminalSourceRun()
    const key = idemKey()
    const first = await createRun({ resumeFromRunId: sourceId, idempotencyKey: key })
    const second = await createRun({ resumeFromRunId: sourceId, idempotencyKey: key })
    expect(first.status).toBe(201)
    expect(second.status).toBe(201)
    expect(second.data?.id).toBe(first.data?.id)
  })
  it('legacy source inputs remain unknown; explicit material confirmation permits a new resume record', async () => {
    await seedWorld()
    const sourceId = await seedTerminalSourceRun({ legacy: true })
    const unknown = await apiInject(ctx, bob, {
      method: 'GET',
      url: `/api/v1/runs/${sourceId}/input-manifest`,
    })
    expect(unknown.statusCode).toBe(200)
    expect(unknown.json().data).toBeNull()
    expect((await createRun({ resumeFromRunId: sourceId })).status).toBe(409)
    expect((await createRun({ resumeFromRunId: sourceId, artifactInputIds: [] })).status).toBe(201)
    expect(
      (
        await apiInject(ctx, bob, { method: 'GET', url: `/api/v1/runs/${sourceId}/input-manifest` })
      ).json().data,
    ).toBeNull()
  })

  it('resume 子 Run 的非空上下文终态 → 同一 home 血缘（来源 + 兄弟）一并 blocked', async () => {
    await seedWorld()
    const harness = makeHarness(database)
    harness.clock.advance(Date.now() - harness.clock.now().getTime())

    async function driveTerminal(runId: string): Promise<void> {
      await harness.worker.dispatchOnce()
      const device = { deviceId: bobChain.deviceId, ownerUserId: bobUserId }
      for (const ack of harness.gateway.drainUpstream()) {
        await harness.orchestrator.ingestNodeEvent(device, ack)
      }
      await harness.orchestrator.ingestNodeEvent(
        device,
        runEventFrame(runId, 1, { type: 'runtime.ready', dshSessionId: `resume-${runId}` }),
      )
      await harness.orchestrator.ingestNodeEvent(
        device,
        runEventFrame(runId, 2, { type: 'run.completed', finalText: 'done' }),
      )
    }

    const source = await createRun({ idempotencyKey: idemKey() })
    expect(source.status, JSON.stringify(source)).toBe(201)
    const sourceId = source.data!.id
    await driveTerminal(sourceId)
    expect((await getRun(database.db, sourceId))?.resumeContext).toBe('full')

    // 来源终态后，新的 resume Run 会拿到非空上下文（来源 Run Observation 等）。
    const child = await createRun({ resumeFromRunId: sourceId, idempotencyKey: idemKey() })
    expect(child.status, JSON.stringify(child)).toBe(201)
    const childId = child.data!.id
    const [childContext] = await database.db
      .select({ entryCount: schema.runProjectContexts.entryCount })
      .from(schema.runProjectContexts)
      .where(eq(schema.runProjectContexts.runId, childId))
    expect(childContext?.entryCount ?? 0).toBeGreaterThan(0)

    await driveTerminal(childId)
    // 共享 home 的 session 会被 child 的 blocked 清理删除；来源不能仍宣称 full。
    expect((await getRun(database.db, childId))?.resumeContext).toBe('blocked')
    expect((await getRun(database.db, sourceId))?.resumeContext).toBe('blocked')

    const blocked = await createRun({ resumeFromRunId: sourceId, idempotencyKey: idemKey() })
    expect(blocked.status).toBe(409)
    expect(blocked.error?.message).toContain('blocked')
  })

  it('租约过期 lost：非空上下文 resume 子 Run 尚无 session id 也阻断来源血缘', async () => {
    await seedWorld()
    const harness = makeHarness(database)
    harness.clock.advance(Date.now() - harness.clock.now().getTime())
    const rootId = await insertRunRow(database.db, {
      taskId,
      ownerUserId: bobUserId,
      agentId: bobChain.agentId,
      profileRevisionId: bobChain.profileRevisionId,
      deviceId: bobChain.deviceId,
      workspaceId: bobChain.workspaceId,
      status: 'completed',
      dshSessionId: 'whalepod-run-root',
    })
    const childId = await insertRunRow(database.db, {
      taskId,
      ownerUserId: bobUserId,
      agentId: bobChain.agentId,
      profileRevisionId: bobChain.profileRevisionId,
      deviceId: bobChain.deviceId,
      workspaceId: bobChain.workspaceId,
      status: 'running',
      dshSessionId: null,
    })
    await database.db
      .update(schema.runs)
      .set({ resumeFromRunId: rootId })
      .where(eq(schema.runs.id, childId))
    await database.db.insert(schema.runProjectContexts).values({
      id: crypto.randomUUID(),
      runId: childId,
      projectId,
      selectionRuleVersion: 'test',
      snapshotDigest: 'e'.repeat(64),
      headerText: '[project-context:0123456789abcdef]',
      headerDigest: 'f'.repeat(64),
      entryCount: 1,
      totalBytes: 0,
    })

    // 设备租约过期：Hub 先判 lost，此时 dshSessionId 仍为 null。
    harness.clock.advance(31_000)
    expect(await harness.orchestrator.reconcileLeases(harness.clock.now())).toBeGreaterThan(0)
    expect((await getRun(database.db, childId))?.status).toBe('lost')
    expect((await getRun(database.db, childId))?.resumeContext).toBe('blocked')
    expect((await getRun(database.db, rootId))?.resumeContext).toBe('blocked')
  })

  it('空项目上下文快照终态仍是 full：resumeContext 暴露且 resume 正常创建', async () => {
    await seedWorld()
    // queued 状态 + 会话：取消走 HTTP 终态收敛，同时满足 resume 的「有会话」前提。
    const sourceId = await seedTerminalSourceRun({ status: 'queued' })
    await database.db.insert(schema.runProjectContexts).values({
      id: crypto.randomUUID(),
      runId: sourceId,
      projectId,
      selectionRuleVersion: 'test',
      snapshotDigest: 'c'.repeat(64),
      headerText: '[project-context:0123456789abcdef]',
      headerDigest: 'd'.repeat(64),
      entryCount: 0,
      totalBytes: 0,
    })
    const cancelled = await apiInject(ctx, bob, {
      method: 'POST',
      url: `/api/v1/runs/${sourceId}/cancel`,
    })
    expect(cancelled.statusCode, cancelled.body).toBe(200)

    const source = await getRun(database.db, sourceId)
    expect(source?.status).toBe('cancelled')
    expect(source?.resumeContext).toBe('full')
    const view = await apiInject(ctx, bob, {
      method: 'GET',
      url: `/api/v1/runs/${sourceId}`,
    })
    expect(view.json().data.resumeContext).toBe('full')

    const resumed = await createRun({ resumeFromRunId: sourceId, idempotencyKey: idemKey() })
    expect(resumed.status).toBe(201)
    expect(resumed.data?.resumeFromRunId).toBe(sourceId)
  })
})
