/**
 * Agent 可被指派（ADR-0009 决策 6，切片⑦；#239）。全部走真人 HTTP 路径。
 *
 * 判定基线：
 * - 带 `assigneeAgentId` 建 Task → 201：assignment 出生 accepted、assignee_user_id =
 *   指派人（真人责任人）、`assignee_agent_id` 落列；**自动驱动**产生一条
 *   `origin='auto_assignment'` 的指令消息（正文 = 标题+描述），经真实受理链锚定
 *   Run（runs.trigger_message_id ↔ task_message.run_id），Run 的 owner/device 都是
 *   责任人的——不是直插，是 sendInstruction 同一条生产路径；
 * - 幂等：同一 idempotency key 重放 → 同一 Task、同一 Run、指令消息只有一条；
 * - 守卫：双带/双空 → 400（协议 superRefine）；未知/已归档 Agent → 400；
 *   Agent-task 上 accept/reject → 409（Agent 不走人的受理）；
 * - reassign 给 Agent：Owner/Admin 才行（403），成功后责任人转为 reassigner、
 *   显式 instruction 成为自动指令正文；
 * - 设备离线（责任人没有可用设备）：Task 照常创建（201），drive 如实报
 *   DEVICE_OFFLINE，不落指令消息（与人发指令同口径：解析失败不落账）。
 */
import { eq, sql } from 'drizzle-orm'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
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
  seedRunChainForUser,
  type Session,
  type TestApp,
  TEST_DSH_VERSION,
} from './helpers.js'

describe('agent-assignable tasks (ADR-0009 slice 7, #239)', () => {
  let database: Database
  let ctx: TestApp
  let alice: Session
  let bob: Session
  let bobChain: Awaited<ReturnType<typeof seedRunChainForUser>>
  let aliceUserId: string
  let bobUserId: string
  let projectId: string

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
    aliceUserId = alice.userId
    const bobInvite = await driveInviteAndAccept(ctx, alice, {
      username: 'bob',
      displayName: 'Bob',
      password: 'correct horse battery staple',
    })
    bob = bobInvite.session
    bobUserId = bob.userId
    const project = await apiInject(ctx, bob, {
      method: 'POST',
      url: '/api/v1/projects',
      payload: { name: 'agent-assign-project' },
    })
    projectId = (project.json() as { data: { id: string } }).data.id
    // Agent + 设备链挂在 bob 名下（创建 Agent 指派任务的人 = 责任人 = bob）。
    bobChain = await seedRunChainForUser(database.db, bobUserId)
    await database.db
      .update(schema.devices)
      .set({ dshDistributionVersion: TEST_DSH_VERSION })
      .where(eq(schema.devices.id, bobChain.deviceId))
  }

  interface CreateTaskResponse {
    status: number
    data?: {
      id: string
      assigneeUserId: string
      assigneeAgentId: string | null
      assignmentStatus: string
    }
    drive?: { outcome: string; runId?: string; error?: { code: string; message: string } }
    error?: { code: string; message: string }
  }

  async function createAgentTask(
    overrides: {
      assigneeAgentId?: string
      assigneeUserId?: string
      title?: string
      description?: string
      idempotencyKey?: string
      as?: Session
    } = {},
  ): Promise<CreateTaskResponse> {
    const response = await apiInject(ctx, overrides.as ?? bob, {
      method: 'POST',
      url: `/api/v1/projects/${projectId}/tasks`,
      payload: {
        title: overrides.title ?? '把登录页改成深色',
        ...(overrides.description !== undefined
          ? { description: overrides.description }
          : { description: '优先跟随系统偏好' }),
        ...(overrides.assigneeAgentId !== undefined
          ? { assigneeAgentId: overrides.assigneeAgentId }
          : {}),
        ...(overrides.assigneeUserId !== undefined
          ? { assigneeUserId: overrides.assigneeUserId }
          : {}),
      },
      ...(overrides.idempotencyKey !== undefined
        ? { idempotencyKey: overrides.idempotencyKey }
        : {}),
    })
    const json = response.json() as Record<string, unknown>
    if (response.statusCode === 201) {
      return {
        status: response.statusCode,
        data: json.data as CreateTaskResponse['data'],
        drive: json.drive as CreateTaskResponse['drive'],
      }
    }
    return {
      status: response.statusCode,
      error: json.error as CreateTaskResponse['error'],
    }
  }

  it('creates an agent-assigned task: born accepted, responsible = assigner, auto-driven through the real instruction path', async () => {
    await seedWorld()
    const key = idemKey()
    const created = await createAgentTask({
      assigneeAgentId: bobChain.agentId,
      idempotencyKey: key,
    })
    expect(created.status).toBe(201)
    expect(created.data?.assigneeAgentId).toBe(bobChain.agentId)
    expect(created.data?.assigneeUserId).toBe(bobUserId)
    expect(created.data?.assignmentStatus).toBe('accepted')
    expect(created.drive?.outcome).toBe('started_run')

    // 自动驱动走的是真实受理链：指令消息（auto_assignment）↔ Run 双向锚定。
    const runId = created.drive?.runId
    expect(runId).toBeTypeOf('string')
    const [run] = await database.db.select().from(schema.runs).where(eq(schema.runs.id, runId!))
    expect(run?.taskId).toBe(created.data?.id)
    expect(run?.ownerUserId).toBe(bobUserId)
    expect(run?.deviceId).toBe(bobChain.deviceId)
    expect(run?.agentId).toBe(bobChain.agentId)

    const [message] = await database.db
      .select()
      .from(schema.taskMessages)
      .where(eq(schema.taskMessages.taskId, created.data!.id))
    expect(message?.kind).toBe('instruction')
    expect(message?.origin).toBe('auto_assignment')
    expect(message?.authorUserId).toBe(bobUserId)
    expect(message?.targetAgentId).toBe(bobChain.agentId)
    expect(message?.runId).toBe(runId)
    expect(message?.instructionState).toBe('pending') // run.start ack 之前
    // 正文 = 标题 + 空行 + 描述（缺省派生，不猜别的）。
    expect(message?.body).toBe('把登录页改成深色\n\n优先跟随系统偏好')
    expect(run?.triggerMessageId).toBe(message?.id)

    // outbox 里有那条 run.start（Node 派发的依据）。
    const outboxRows = await database.db
      .select()
      .from(schema.dispatchOutbox)
      .where(sql`${schema.dispatchOutbox.payload}->>'runId' = ${runId}`)
    expect(outboxRows.length).toBeGreaterThanOrEqual(1)
  })

  it('idempotent create: same key replays the same task/run and exactly one auto instruction', async () => {
    await seedWorld()
    const key = idemKey()
    const first = await createAgentTask({ assigneeAgentId: bobChain.agentId, idempotencyKey: key })
    const second = await createAgentTask({ assigneeAgentId: bobChain.agentId, idempotencyKey: key })
    expect(first.status).toBe(201)
    expect(second.status).toBe(201)
    expect(second.data?.id).toBe(first.data?.id)
    expect(second.drive?.runId).toBe(first.drive?.runId)
    const messages = await database.db
      .select()
      .from(schema.taskMessages)
      .where(eq(schema.taskMessages.taskId, first.data!.id))
    expect(messages).toHaveLength(1)
  })

  it('guards: both/neither assignee fields → 400; unknown or archived agent → 400; accept/reject on agent task → 409', async () => {
    await seedWorld()
    const both = await createAgentTask({
      assigneeAgentId: bobChain.agentId,
      assigneeUserId: bobUserId,
    })
    expect(both.status).toBe(400)

    const neither = await createAgentTask({ assigneeAgentId: undefined })
    expect(neither.status).toBe(400)

    const unknown = await createAgentTask({ assigneeAgentId: randomUuid() })
    expect(unknown.status).toBe(400)
    expect(unknown.error?.code).toBe('VALIDATION_FAILED')
    expect(unknown.error?.message).toContain('agent')

    await database.db
      .update(schema.agents)
      .set({ archivedAt: new Date() })
      .where(eq(schema.agents.id, bobChain.agentId))
    const archived = await createAgentTask({ assigneeAgentId: bobChain.agentId })
    expect(archived.status).toBe(400)
    expect(archived.error?.message).toContain('archived')

    // Agent-task 不走人的受理：accept/reject 一律 409。
    await database.db
      .update(schema.agents)
      .set({ archivedAt: null })
      .where(eq(schema.agents.id, bobChain.agentId))
    const created = await createAgentTask({ assigneeAgentId: bobChain.agentId })
    expect(created.status).toBe(201)
    const accept = await apiInject(ctx, bob, {
      method: 'POST',
      url: `/api/v1/tasks/${created.data!.id}/accept`,
    })
    expect(accept.statusCode).toBe(409)
    const reject = await apiInject(ctx, bob, {
      method: 'POST',
      url: `/api/v1/tasks/${created.data!.id}/reject`,
    })
    expect(reject.statusCode).toBe(409)
  })

  it('reassign to agent: owner-only, responsible moves to reassigner, explicit instruction becomes the auto message body', async () => {
    await seedWorld()
    // 先建一个 member 任务（bob 是 assignee），bob 受理后才能 reassign（pending 无 reassign 边）。
    const memberTask = await createAgentTask({
      assigneeUserId: bobUserId,
      title: 'member task',
      description: '',
    })
    expect(memberTask.status).toBe(201)
    const taskId = memberTask.data!.id
    const accept = await apiInject(ctx, bob, {
      method: 'POST',
      url: `/api/v1/tasks/${taskId}/accept`,
    })
    expect(accept.statusCode).toBe(200)

    // bob（member）不能 reassign → 403。
    const forbidden = await apiInject(ctx, bob, {
      method: 'POST',
      url: `/api/v1/tasks/${taskId}/reassign`,
      payload: { assigneeAgentId: bobChain.agentId },
    })
    expect(forbidden.statusCode).toBe(403)

    // alice（owner）reassign 给 Agent，带显式 instruction；reassigner 自己要有可用设备
    // （责任人换成了 alice，目标解析按 alice 找）。
    const aliceChain = await seedRunChainForUser(database.db, aliceUserId)
    await database.db
      .update(schema.devices)
      .set({ dshDistributionVersion: TEST_DSH_VERSION })
      .where(eq(schema.devices.id, aliceChain.deviceId))
    const reassigned = await apiInject(ctx, alice, {
      method: 'POST',
      url: `/api/v1/tasks/${taskId}/reassign`,
      payload: { assigneeAgentId: bobChain.agentId, instruction: '接手：先梳理现状' },
      idempotencyKey: idemKey(),
    })
    expect(reassigned.statusCode).toBe(200)
    const body = reassigned.json() as {
      data: { assigneeUserId: string; assigneeAgentId: string | null; assignmentStatus: string }
      drive: { outcome: string; runId?: string }
    }
    expect(body.data.assigneeAgentId).toBe(bobChain.agentId)
    expect(body.data.assigneeUserId).toBe(aliceUserId) // 责任人 = reassigner
    expect(body.data.assignmentStatus).toBe('accepted')
    expect(body.drive.outcome).toBe('started_run')

    const [message] = await database.db
      .select()
      .from(schema.taskMessages)
      .where(eq(schema.taskMessages.taskId, taskId))
    expect(message?.origin).toBe('auto_assignment')
    expect(message?.authorUserId).toBe(aliceUserId)
    expect(message?.body).toBe('接手：先梳理现状')
    const [run] = await database.db
      .select()
      .from(schema.runs)
      .where(eq(schema.runs.id, body.drive.runId!))
    expect(run?.deviceId).toBe(aliceChain.deviceId) // 执行落在（新）责任人的设备上
    expect(run?.ownerUserId).toBe(aliceUserId)
  })

  it('reassign to agent without a usable device for the reassigner: task still reassigned, drive fails honestly with DEVICE_OFFLINE', async () => {
    await seedWorld()
    const memberTask = await createAgentTask({
      assigneeUserId: bobUserId,
      title: 't',
      description: '',
    })
    const taskId = memberTask.data!.id
    const accept = await apiInject(ctx, bob, {
      method: 'POST',
      url: `/api/v1/tasks/${taskId}/accept`,
    })
    expect(accept.statusCode).toBe(200)
    // alice 没有设备：reassign 本身成功，自动驱动解析不到目标 → 如实失败、不落消息。
    const reassigned = await apiInject(ctx, alice, {
      method: 'POST',
      url: `/api/v1/tasks/${taskId}/reassign`,
      payload: { assigneeAgentId: bobChain.agentId },
      idempotencyKey: idemKey(),
    })
    expect(reassigned.statusCode).toBe(200)
    const body = reassigned.json() as {
      data: { assignmentStatus: string }
      drive: { outcome: string; error?: { code: string } }
    }
    expect(body.data.assignmentStatus).toBe('accepted')
    expect(body.drive.outcome).toBe('failed')
    expect(body.drive.error?.code).toBe('DEVICE_OFFLINE')
    const messages = await database.db
      .select()
      .from(schema.taskMessages)
      .where(eq(schema.taskMessages.taskId, taskId))
    expect(messages).toHaveLength(0) // 解析失败不落指令（与人发同口径）
  })

  it('device-offline at creation: task is created (201), drive reports the failure, no instruction message', async () => {
    await seedWorld()
    // 第三位成员 carol：没有任何设备链。她创建指派任务 → 责任人 = carol，
    // 目标解析按 carol 找 → DEVICE_OFFLINE（Agent 本身有效，失败在执行落点）。
    const carolInvite = await driveInviteAndAccept(ctx, alice, {
      username: 'carol',
      displayName: 'Carol',
      password: 'correct horse battery staple',
    })
    const created = await createAgentTask({
      assigneeAgentId: bobChain.agentId,
      as: carolInvite.session,
    })
    expect(created.status).toBe(201)
    expect(created.data?.assignmentStatus).toBe('accepted')
    expect(created.drive?.outcome).toBe('failed')
    expect(created.drive?.error?.code).toBe('DEVICE_OFFLINE')
    const messages = await database.db
      .select()
      .from(schema.taskMessages)
      .where(eq(schema.taskMessages.taskId, created.data!.id))
    expect(messages).toHaveLength(0)
  })
})

function randomUuid(): string {
  return crypto.randomUUID()
}
