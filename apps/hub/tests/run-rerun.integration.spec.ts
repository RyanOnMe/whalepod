/**
 * 显式重跑血缘 HTTP 面（P1-16 G7-04；03 §2.6 rerun_of_run_id、§4 POST /tasks/:taskId/runs）。
 *
 * 判定基线（全部走真人 HTTP 路径）：
 * - 终态 Run 之上带 rerunOfRunId 新建 → 201，响应与 Task Room 聚合视图都携带血缘
 *   （UI 血缘的数据源）；DB FK 由 schema 约束兜底；
 * - 非终态来源 → 409 CONFLICT；跨 Task 来源 / 未知来源 → 404（不可枚举）；
 * - 畸形 uuid → 400 VALIDATION_FAILED；重复点击（同 Idempotency-Key）→ 同一 Run。
 */
import { eq } from 'drizzle-orm'
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

describe('rerun lineage (G7-04)', () => {
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
      payload: { name: 'rerun-project' },
    })
    const projectId = (project.json() as { data: { id: string } }).data.id
    const session = await apiInject(ctx, bob, { method: 'GET', url: '/api/v1/auth/session' })
    bobUserId = (session.json() as { data: { userId: string } }).data.userId
    const task = await apiInject(ctx, alice, {
      method: 'POST',
      url: `/api/v1/projects/${projectId}/tasks`,
      payload: { title: 'rerun me', assigneeUserId: bobUserId },
    })
    taskId = (task.json() as { data: { id: string } }).data.id
    await apiInject(ctx, bob, { method: 'POST', url: `/api/v1/tasks/${taskId}/accept` })

    bobChain = await seedRunChainForUser(database.db, bobUserId)
    await database.db
      .update(schema.devices)
      .set({ dshDistributionVersion: TEST_DSH_VERSION })
      .where(eq(schema.devices.id, bobChain.deviceId))
  }

  interface RunBody {
    rerunOfRunId?: string
    idempotencyKey?: string
  }

  async function createRun(body: RunBody): Promise<{
    status: number
    data?: { id: string; status: string; rerunOfRunId: string | null }
    error?: { code: string }
  }> {
    const response = await apiInject(ctx, bob, {
      method: 'POST',
      url: `/api/v1/tasks/${taskId}/runs`,
      payload: {
        agentId: bobChain.agentId,
        deviceId: bobChain.deviceId,
        workspaceId: bobChain.workspaceId,
        prompt: 'do the thing',
        ...(body.rerunOfRunId !== undefined ? { rerunOfRunId: body.rerunOfRunId } : {}),
      },
      ...(body.idempotencyKey !== undefined ? { idempotencyKey: body.idempotencyKey } : {}),
    })
    const json = response.json() as
      | { ok: true; data: { id: string; status: string; rerunOfRunId: string | null } }
      | { ok: false; error: { code: string } }
    return response.statusCode === 201
      ? {
          status: response.statusCode,
          data: (json as { data: { id: string; status: string; rerunOfRunId: string | null } })
            .data,
        }
      : { status: response.statusCode, error: (json as { error: { code: string } }).error }
  }

  it('creates a new run whose rerunOfRunId points at the terminal source (DB + task room lineage)', async () => {
    await seedWorld()
    const first = await createRun({})
    expect(first.status).toBe(201)
    const firstId = first.data!.id
    // 取消使其成为终态来源。
    const cancel = await apiInject(ctx, bob, {
      method: 'POST',
      url: `/api/v1/runs/${firstId}/cancel`,
    })
    expect(cancel.statusCode).toBe(200)

    const second = await createRun({ rerunOfRunId: firstId })
    expect(second.status).toBe(201)
    expect(second.data!.rerunOfRunId).toBe(firstId)
    expect(second.data!.id).not.toBe(firstId)
    expect(second.data!.status).toBe('queued')

    // 源 Run 不复活，仍是 cancelled（终态禁迁移）。
    expect((await getRun(database.db, firstId))?.status).toBe('cancelled')

    // UI 血缘的数据源：Task Room 聚合视图携带 rerunOfRunId。
    const room = await apiInject(ctx, bob, { method: 'GET', url: `/api/v1/tasks/${taskId}` })
    const runs = (
      room.json() as { data: { runs: Array<{ id: string; rerunOfRunId: string | null }> } }
    ).data.runs
    const rerun = runs.find((run) => run.id === second.data!.id)
    expect(rerun?.rerunOfRunId).toBe(firstId)

    // DB FK 兜底：指向不存在 Run 的血缘在数据库层就被拒绝（23503）。
    let fkRejected = false
    try {
      await database.db.insert(schema.runs).values({
        id: '00000000-0000-4000-8000-0000000000aa',
        taskId,
        ownerUserId: bobUserId,
        agentId: bobChain.agentId,
        profileRevisionId: bobChain.profileRevisionId,
        deviceId: bobChain.deviceId,
        workspaceId: bobChain.workspaceId,
        status: 'queued',
        profileDigest: 'b'.repeat(64),
        pluginPackDigest: 'a'.repeat(64),
        dshDistributionVersion: TEST_DSH_VERSION,
        rerunOfRunId: '00000000-0000-4000-8000-0000000000bb',
      })
    } catch {
      fkRejected = true
    }
    expect(fkRejected).toBe(true)
  })

  it('rejects a non-terminal source with 409 CONFLICT', async () => {
    await seedWorld()
    const runningId = await insertRunRow(database.db, {
      taskId,
      ownerUserId: bobUserId,
      agentId: bobChain.agentId,
      profileRevisionId: bobChain.profileRevisionId,
      deviceId: bobChain.deviceId,
      workspaceId: bobChain.workspaceId,
      status: 'running',
    })
    const result = await createRun({ rerunOfRunId: runningId })
    expect(result.status).toBe(409)
    expect(result.error?.code).toBe('CONFLICT')
  })

  it('rejects a cross-task source and an unknown source with the same 404 shape', async () => {
    await seedWorld()
    // 跨 Task 来源：另建一个 Task 并把来源 Run 挂上去（终态）。
    const project = await apiInject(ctx, alice, {
      method: 'POST',
      url: '/api/v1/projects',
      payload: { name: 'other-project' },
    })
    const otherProjectId = (project.json() as { data: { id: string } }).data.id
    const otherTask = await apiInject(ctx, alice, {
      method: 'POST',
      url: `/api/v1/projects/${otherProjectId}/tasks`,
      payload: { title: 'other task', assigneeUserId: bobUserId },
    })
    const otherTaskId = (otherTask.json() as { data: { id: string } }).data.id
    const foreignSourceId = await insertRunRow(database.db, {
      taskId: otherTaskId,
      ownerUserId: bobUserId,
      agentId: bobChain.agentId,
      profileRevisionId: bobChain.profileRevisionId,
      deviceId: bobChain.deviceId,
      workspaceId: bobChain.workspaceId,
      status: 'failed',
    })

    const crossTask = await createRun({ rerunOfRunId: foreignSourceId })
    expect(crossTask.status).toBe(404)
    expect(crossTask.error?.code).toBe('NOT_FOUND')

    const unknown = await createRun({
      rerunOfRunId: '00000000-0000-4000-8000-00000000000e',
    })
    expect(unknown.status).toBe(404)
    expect(unknown.error?.code).toBe('NOT_FOUND')
  })

  it('rejects a malformed rerunOfRunId with 400 VALIDATION_FAILED', async () => {
    await seedWorld()
    const result = await createRun({ rerunOfRunId: 'not-a-uuid' })
    expect(result.status).toBe(400)
    expect(result.error?.code).toBe('VALIDATION_FAILED')
  })

  it('repeated clicks with the same Idempotency-Key return the same rerun (no second run)', async () => {
    await seedWorld()
    const first = await createRun({})
    const firstId = first.data!.id
    await apiInject(ctx, bob, { method: 'POST', url: `/api/v1/runs/${firstId}/cancel` })

    const key = idemKey()
    const a = await createRun({ rerunOfRunId: firstId, idempotencyKey: key })
    const b = await createRun({ rerunOfRunId: firstId, idempotencyKey: key })
    expect(a.status).toBe(201)
    expect(b.status).toBe(201)
    expect(b.data!.id).toBe(a.data!.id)
    expect(b.data!.rerunOfRunId).toBe(firstId)
  })
})
