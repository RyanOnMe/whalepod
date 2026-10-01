/**
 * 房间视图的工具轨迹摘要（#246；#243 第 2 条）。全部走真人 HTTP 路径建房读房，
 * 只有 run_event 行按 projector 的投影形状直插（node 侧的投影链有自己的契约门）。
 *
 * 判定基线：
 * - `TaskRoomRun.lastToolCall` = 该 Run **project 受众** `tool.started` 的最新一条
 *   （DISTINCT ON run_id, seq DESC）：无事件 → null；
 * - 受众收缩是**安全判据**不是实现细节：owner-only 的高 seq `tool.started`
 *   绝不能进全员可见的房间视图摘要——这条红了就是越权泄漏；
 * - 每 Run 各取各的最新（多 Run 不串档）。
 */
import { eq } from 'drizzle-orm'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { Database } from '@whalepod/db'
import { appendRunEvent, schema } from '@whalepod/db'
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

describe('room view tool trace preview (#246)', () => {
  let database: Database
  let ctx: TestApp
  let bob: Session
  let bobChain: Awaited<ReturnType<typeof seedRunChainForUser>>
  let taskId: string

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
    const alice = await driveSetup(ctx, 'alice')
    const bobInvite = await driveInviteAndAccept(ctx, alice, {
      username: 'bob',
      displayName: 'Bob',
      password: 'correct horse battery staple',
    })
    bob = bobInvite.session
    bobChain = await seedRunChainForUser(database.db, bob.userId)
    await database.db
      .update(schema.devices)
      .set({ dshDistributionVersion: TEST_DSH_VERSION })
      .where(eq(schema.devices.id, bobChain.deviceId))
    const project = await apiInject(ctx, bob, {
      method: 'POST',
      url: '/api/v1/projects',
      payload: { name: 'tool-preview-project' },
    })
    const projectId = (project.json() as { data: { id: string } }).data.id
    const task = await apiInject(ctx, bob, {
      method: 'POST',
      url: `/api/v1/projects/${projectId}/tasks`,
      payload: { title: 'tool preview task', assigneeUserId: bob.userId },
      idempotencyKey: idemKey(),
    })
    taskId = (task.json() as { data: { id: string } }).data.id
    const accept = await apiInject(ctx, bob, {
      method: 'POST',
      url: `/api/v1/tasks/${taskId}/accept`,
    })
    expect(accept.statusCode).toBe(200)
  }

  /** 建 Run（真人 HTTP）并置 completed（一任务一活跃，连续建 Run 前先终态化）。 */
  async function createRun(prompt: string): Promise<string> {
    const res = await apiInject(ctx, bob, {
      method: 'POST',
      url: `/api/v1/tasks/${taskId}/runs`,
      payload: {
        agentId: bobChain.agentId,
        deviceId: bobChain.deviceId,
        workspaceId: bobChain.workspaceId,
        prompt,
      },
      idempotencyKey: idemKey(),
    })
    expect(res.statusCode).toBe(201)
    const runId = (res.json() as { data: { id: string } }).data.id
    await database.db
      .update(schema.runs)
      .set({ status: 'completed', finishedAt: new Date() })
      .where(eq(schema.runs.id, runId))
    return runId
  }

  /** 按 projector 的投影形状插一条 tool.started（双受众=真实形态；单受众=构造越权场景）。 */
  async function insertToolStarted(
    runId: string,
    seq: number,
    toolName: string,
    audience: 'owner' | 'project',
  ): Promise<void> {
    const { appended } = await appendRunEvent(database.db, {
      id: crypto.randomUUID(),
      runId,
      seq,
      type: 'tool.started',
      audience,
      payload:
        audience === 'owner'
          ? {
              type: 'tool.started',
              callId: `c-${seq}`,
              toolName,
              preview: { command: 'rm -rf /tmp/x' },
            }
          : { type: 'tool.started', callId: `c-${seq}`, toolName, preview: { category: 'shell' } },
      occurredAt: new Date(),
    })
    expect(appended).toBe(true)
  }

  async function roomRuns(): Promise<
    { id: string; lastToolCall: { tool: string; at: string } | null }[]
  > {
    const room = await apiInject(ctx, bob, { method: 'GET', url: `/api/v1/tasks/${taskId}` })
    expect(room.statusCode).toBe(200)
    return (
      room.json() as {
        data: { runs: { id: string; lastToolCall: { tool: string; at: string } | null }[] }
      }
    ).data.runs
  }

  it('无工具事件 → lastToolCall=null；有 project 受众事件 → 最新 toolName 进摘要', async () => {
    await seedWorld()
    const runId = await createRun('go')
    // ① 没有任何工具事件：null，不编造。
    expect((await roomRuns())[0]?.lastToolCall).toBeNull()

    // ② projector 真实形态：双受众成对（owner preview 带命令正文，project 只剩类别）。
    await insertToolStarted(runId, 1, 'bash', 'owner')
    await insertToolStarted(runId, 1, 'bash', 'project')
    await insertToolStarted(runId, 2, 'edit_file', 'owner')
    await insertToolStarted(runId, 2, 'edit_file', 'project')
    // 取**最新**一条（seq 2），不是第一条。
    expect((await roomRuns())[0]?.lastToolCall).toMatchObject({ tool: 'edit_file' })
  })

  it('受众收缩（安全判据）：owner-only 的高 seq tool.started 不进全员房间摘要', async () => {
    await seedWorld()
    const runId = await createRun('go')
    await insertToolStarted(runId, 1, 'bash', 'project')
    // 越权构造：一条只有 owner 受众的更新事件（seq 更高、工具名不同）。
    // 若摘要查询漏了 audience 过滤，这里会读到 owner 行的 secret_tool——判据必红。
    await insertToolStarted(runId, 2, 'secret_owner_tool', 'owner')
    expect((await roomRuns())[0]?.lastToolCall).toMatchObject({ tool: 'bash' })
  })

  it('多 Run 各取各的最新（DISTINCT ON 不串档）', async () => {
    await seedWorld()
    const runA = await createRun('a')
    const runB = await createRun('b')
    await insertToolStarted(runA, 1, 'bash', 'project')
    await insertToolStarted(runA, 2, 'grep', 'project')
    await insertToolStarted(runB, 1, 'edit_file', 'project')
    const runs = await roomRuns()
    const byId = new Map(runs.map((run) => [run.id, run.lastToolCall?.tool ?? null]))
    expect(byId.get(runA)).toBe('grep') // A 的最新是第 2 条
    expect(byId.get(runB)).toBe('edit_file')
  })
})
