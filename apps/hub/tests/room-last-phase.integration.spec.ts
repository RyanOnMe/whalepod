/**
 * 房间视图的运行阶段摘要（#261；P1-UX 三期刀二）。全部走真人 HTTP 路径建房读房，
 * 只有 run_event 行按 projector 的投影形状直插（node 侧投影链有自己的契约门）。
 *
 * 判定基线：
 * - `TaskRoomRun.lastPhase` = 该 Run **project 受众** `run.phase` 的最新一条
 *   （DISTINCT ON run_id, seq DESC）：无阶段事件 → null；
 * - 受众收缩是**安全判据**不是实现细节：owner-only 的高 seq `run.phase`
 *   绝不能进全员可见的房间视图——这条红了就是越权泄漏；
 * - 每 Run 各取各的最新（多 Run 不串档）；
 * - 读模型不信任写路径：phase 不是协议枚举（thinking/tool/finalizing）就当没有，
 *   不抛也不画未知值。
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

describe('room view last run phase (#261)', () => {
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
      payload: { name: 'last-phase-project' },
    })
    const projectId = (project.json() as { data: { id: string } }).data.id
    const task = await apiInject(ctx, bob, {
      method: 'POST',
      url: `/api/v1/projects/${projectId}/tasks`,
      payload: { title: 'last phase task', assigneeUserId: bob.userId },
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

  /**
   * 按 projector 的投影形状插一条 run.phase。projector 对阶段是**双受众**
   * （apps/node/src/projection/projector.ts:296 `both(...)` thinking；352/427
   * owner+project 成对 tool/finalizing）——两行 phase 相同、seq 各算各的
   * （唯一键 (run_id, seq) 不含 audience）。
   */
  async function insertRunPhase(
    runId: string,
    seq: number,
    phase: string,
    audience: 'owner' | 'project',
  ): Promise<void> {
    const { appended } = await appendRunEvent(database.db, {
      id: crypto.randomUUID(),
      runId,
      seq,
      type: 'run.phase',
      audience,
      payload: { type: 'run.phase', phase },
      occurredAt: new Date(),
    })
    expect(appended).toBe(true)
  }

  async function roomRuns(): Promise<
    { id: string; lastPhase: { phase: string; at: string } | null }[]
  > {
    const room = await apiInject(ctx, bob, { method: 'GET', url: `/api/v1/tasks/${taskId}` })
    expect(room.statusCode).toBe(200)
    return (
      room.json() as {
        data: { runs: { id: string; lastPhase: { phase: string; at: string } | null }[] }
      }
    ).data.runs
  }

  it('无阶段事件 → null；有 project 行 → 取 seq 最大的那一条（含 ISO 时间）', async () => {
    await seedWorld()
    const runId = await createRun('go')
    // ① 一条阶段事件都没有：null，不编造。
    expect((await roomRuns())[0]?.lastPhase).toBeNull()

    // ② 双受众成对（真实形态）：thinking → tool → finalizing。
    await insertRunPhase(runId, 1, 'thinking', 'owner')
    await insertRunPhase(runId, 2, 'thinking', 'project')
    await insertRunPhase(runId, 3, 'tool', 'owner')
    await insertRunPhase(runId, 4, 'tool', 'project')
    // 取**最新**一条（project 行里 seq 最大的），不是第一条。
    const last = (await roomRuns())[0]?.lastPhase
    expect(last).toMatchObject({ phase: 'tool' })
    expect(Number.isFinite(Date.parse(last!.at))).toBe(true)
  })

  it('受众收缩（安全判据）：owner-only 的高 seq run.phase 不进全员房间视图', async () => {
    await seedWorld()
    const runId = await createRun('go')
    await insertRunPhase(runId, 1, 'thinking', 'project')
    // 越权构造：一条只有 owner 受众的更新事件（seq 更高、阶段不同）。
    // 若摘要查询漏了 audience 过滤，这里会读到 owner 行的 finalizing——判据必红。
    await insertRunPhase(runId, 2, 'finalizing', 'owner')
    expect((await roomRuns())[0]?.lastPhase).toMatchObject({ phase: 'thinking' })
  })

  it('多 Run 各取各的最新（DISTINCT ON 不串档）', async () => {
    await seedWorld()
    const runA = await createRun('a')
    const runB = await createRun('b')
    await insertRunPhase(runA, 1, 'thinking', 'project')
    await insertRunPhase(runA, 2, 'tool', 'project')
    await insertRunPhase(runB, 1, 'finalizing', 'project')
    const runs = await roomRuns()
    const byId = new Map(runs.map((run) => [run.id, run.lastPhase?.phase ?? null]))
    expect(byId.get(runA)).toBe('tool') // A 的最新是第 2 条
    expect(byId.get(runB)).toBe('finalizing')
  })

  it('非协议枚举的 phase 当没有（读模型不信任写路径，同 #246 口径）', async () => {
    await seedWorld()
    const runId = await createRun('go')
    await insertRunPhase(runId, 1, 'thinking', 'project')
    // 越权/脏数据构造：**最新**那条的 phase 不在协议枚举里 → 整个摘要当没有，
    // 不为了「有东西可画」回退到更旧的行——旧阶段挂在现在这一刻上同样是撒谎。
    await insertRunPhase(runId, 2, 'daydreaming', 'project')
    expect((await roomRuns())[0]?.lastPhase).toBeNull()
  })
})
