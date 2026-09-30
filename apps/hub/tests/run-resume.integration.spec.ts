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
  resetDatabase,
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
    const projectId = (project.json() as { data: { id: string } }).data.id
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
      .set({ dshDistributionVersion: TEST_DSH_VERSION })
      .where(eq(schema.devices.id, bobChain.deviceId))
  }

  /** 种一个终态、有会话的来源 Run（resume 的正常前提）。 */
  async function seedTerminalSourceRun(
    overrides: { status?: string; dshSessionId?: string | null } = {},
  ): Promise<string> {
    return insertRunRow(database.db, {
      taskId,
      ownerUserId: bobUserId,
      agentId: bobChain.agentId,
      profileRevisionId: bobChain.profileRevisionId,
      deviceId: bobChain.deviceId,
      workspaceId: bobChain.workspaceId,
      status: (overrides.status ?? 'completed') as 'completed',
      dshSessionId:
        overrides.dshSessionId === undefined ? 'whalepod-run-source' : overrides.dshSessionId,
    })
  }

  interface RunBody {
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

    // 跨 Task：404 同形（不可枚举）。
    const otherTaskRun = await insertRunRow(database.db, {
      taskId: bobChain.taskId,
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
})
