/**
 * Run 取消 HTTP 面（P1-16 G7-01/G7-06；03 §4 POST /runs/:runId/cancel）。
 *
 * 判定基线（全部走真人 HTTP 路径，Fastify inject）：
 * - owner 取消 queued Run → 200 cancelled（ack 前取消不联系 Node）；
 * - Owner/Admin 可紧急取消 Bob 的 Run（G7-06a：cause=admin，run.cancel 入队）；
 * - 无关 Member 取消 → 403；未知 Run → 404；终态 Run → 409 INVALID_RUN_TRANSITION；
 * - 重复取消幂等返回同一状态；
 * - G7-06b 的「不能替 Bob 批准」在两处既有事实源成立（decide_approval 仅 owner）：
 *   packages/domain/tests/policy.spec.ts + orchestrator approval.decided 的
 *   decided_by=owner 强制；HTTP 决定路由属 P1-14（并行交付），此处不断言其线协议。
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
  insertRunRow,
  resetDatabase,
  seedRunChainForUser,
  type Session,
  type TestApp,
  TEST_DSH_VERSION,
} from './helpers.js'

describe('POST /runs/:runId/cancel (G7-01/G7-06)', () => {
  let database: Database
  let ctx: TestApp
  let alice: Session
  let bob: Session
  let carol: Session
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

  /** 每个用例的独立世界：Alice(owner) 邀请 Bob/Carol；Task 指派给 Bob；Bob 有设备链。 */
  async function seedWorld(): Promise<void> {
    ctx = await createTestApp(database)
    alice = await driveSetup(ctx, 'alice')
    const bobInvite = await driveInviteAndAccept(ctx, alice, {
      username: 'bob',
      displayName: 'Bob',
      password: 'correct horse battery staple',
    })
    bob = bobInvite.session
    const carolInvite = await driveInviteAndAccept(ctx, alice, {
      username: 'carol',
      displayName: 'Carol',
      password: 'correct horse battery staple',
    })
    carol = carolInvite.session

    // Project + Task（assignee=bob；assignment 走 accept 驱动）。
    const project = await apiInject(ctx, bob, {
      method: 'POST',
      url: '/api/v1/projects',
      payload: { name: 'run-cancel-project' },
    })
    const projectId = (project.json() as { data: { id: string } }).data.id
    const session = await apiInject(ctx, bob, { method: 'GET', url: '/api/v1/auth/session' })
    bobUserId = (session.json() as { data: { userId: string } }).data.userId
    const task = await apiInject(ctx, alice, {
      method: 'POST',
      url: `/api/v1/projects/${projectId}/tasks`,
      payload: { title: 'cancel me', assigneeUserId: bobUserId },
    })
    taskId = (task.json() as { data: { id: string } }).data.id
    await apiInject(ctx, bob, { method: 'POST', url: `/api/v1/tasks/${taskId}/accept` })

    bobChain = await seedRunChainForUser(database.db, bobUserId)
    await database.db
      .update(schema.devices)
      .set({ dshDistributionVersion: TEST_DSH_VERSION })
      .where(eq(schema.devices.id, bobChain.deviceId))
  }

  async function createRunAsBob(): Promise<string> {
    const response = await apiInject(ctx, bob, {
      method: 'POST',
      url: `/api/v1/tasks/${taskId}/runs`,
      payload: {
        agentId: bobChain.agentId,
        deviceId: bobChain.deviceId,
        workspaceId: bobChain.workspaceId,
        prompt: 'do the thing',
      },
    })
    expect(response.statusCode).toBe(201)
    return (response.json() as { data: { id: string } }).data.id
  }

  it('owner cancels a queued run: 200 cancelled, no Node contact needed', async () => {
    await seedWorld()
    const runId = await createRunAsBob()

    const response = await apiInject(ctx, bob, {
      method: 'POST',
      url: `/api/v1/runs/${runId}/cancel`,
    })
    expect(response.statusCode).toBe(200)
    const body = response.json() as {
      ok: boolean
      data: { status: string; finishedAt: string | null }
    }
    expect(body.ok).toBe(true)
    expect(body.data.status).toBe('cancelled')
    expect(body.data.finishedAt).not.toBeNull()
    expect((await getRun(database.db, runId))?.status).toBe('cancelled')
  })

  it("G7-06a: team owner (Alice) can cancel Bob's running run; command carries cause=admin", async () => {
    await seedWorld()
    const runId = await insertRunRow(database.db, {
      taskId,
      ownerUserId: bobUserId,
      agentId: bobChain.agentId,
      profileRevisionId: bobChain.profileRevisionId,
      deviceId: bobChain.deviceId,
      workspaceId: bobChain.workspaceId,
      status: 'running',
    })

    const response = await apiInject(ctx, alice, {
      method: 'POST',
      url: `/api/v1/runs/${runId}/cancel`,
    })
    expect(response.statusCode).toBe(200)
    expect((response.json() as { data: { status: string } }).data.status).toBe('cancel_requested')

    const outboxRows = await database.db.select().from(schema.dispatchOutbox)
    const cancelCommand = outboxRows.find((row) => row.type === 'run.cancel')
    expect(cancelCommand).toBeDefined()
    expect(cancelCommand?.payload).toMatchObject({ runId, cause: 'admin' })
  })

  it('non-owner member gets 403; unknown run gets 404', async () => {
    await seedWorld()
    const runId = await insertRunRow(database.db, {
      taskId,
      ownerUserId: bobUserId,
      agentId: bobChain.agentId,
      profileRevisionId: bobChain.profileRevisionId,
      deviceId: bobChain.deviceId,
      workspaceId: bobChain.workspaceId,
      status: 'running',
    })

    const forbidden = await apiInject(ctx, carol, {
      method: 'POST',
      url: `/api/v1/runs/${runId}/cancel`,
    })
    expect(forbidden.statusCode).toBe(403)
    expect((forbidden.json() as { error: { code: string } }).error.code).toBe('FORBIDDEN')

    const missing = await apiInject(ctx, alice, {
      method: 'POST',
      url: `/api/v1/runs/00000000-0000-4000-8000-00000000000f/cancel`,
    })
    expect(missing.statusCode).toBe(404)
  })

  it('cancelling a terminal run is rejected (409 INVALID_RUN_TRANSITION); repeat cancel is idempotent', async () => {
    await seedWorld()
    const runId = await createRunAsBob()
    await apiInject(ctx, bob, { method: 'POST', url: `/api/v1/runs/${runId}/cancel` })

    const again = await apiInject(ctx, bob, {
      method: 'POST',
      url: `/api/v1/runs/${runId}/cancel`,
    })
    expect(again.statusCode).toBe(200)
    expect((again.json() as { data: { status: string } }).data.status).toBe('cancelled')

    // 终态（completed）不可再取消：直接落一个 completed Run 行。
    const doneId = await insertRunRow(database.db, {
      taskId,
      ownerUserId: bobUserId,
      agentId: bobChain.agentId,
      profileRevisionId: bobChain.profileRevisionId,
      deviceId: bobChain.deviceId,
      workspaceId: bobChain.workspaceId,
      status: 'completed',
    })
    const terminal = await apiInject(ctx, bob, {
      method: 'POST',
      url: `/api/v1/runs/${doneId}/cancel`,
    })
    expect(terminal.statusCode).toBe(409)
    expect((terminal.json() as { error: { code: string } }).error.code).toBe(
      'INVALID_RUN_TRANSITION',
    )
  })
})
