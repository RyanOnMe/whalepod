import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { Database } from '@whalepod/db'
import { insertAgent, insertMessage, listMessages, schema, setRunStatus } from '@whalepod/db'
import { sendRunFollowup } from '../src/modules/run/followup.js'
import { getTaskRoom } from '../src/modules/task/view.js'
import {
  apiInject,
  createTestApp,
  createTestDatabase,
  driveSetup,
  idemKey,
  type TestApp,
  makeActor,
  makeCreateInput,
  makeHarness,
  resetDatabase,
  seedRunPrereqs,
} from './helpers.js'

/**
 * P1-194 切片③c-2a：讨论流与执行流的**读模型隔离**（ADR-0010，取代 ADR-0009 的 O3-a）。
 *
 * 用户当场否决了「讨论 + 指令 + Run 合并进一条线程」：评论区应当单纯是人与人的交流。
 * 混乱是结构性的——讨论消息「落了就算送达」，而指令消息带着
 * `pending` / `accepted` / `rejected` 三种命运、还要权限、还会牵出运行卡；两者混在一列里，
 * 「我这句话被 Agent 拒了」和「我的讨论没发出去」长得一模一样。
 *
 * 本文件钉住的是**读模型**约束（不是前端过滤）：讨论流只返回 `kind='discussion'`，
 * 指令与追问走执行流。库里仍是一张 `task_message`（审计链不变，ADR-0010 决策 3）。
 */
describe('discussion/execution separation (P1-194)', () => {
  let database: Database
  beforeAll(async () => {
    database = await createTestDatabase()
  })
  beforeEach(async () => {
    await resetDatabase(database)
  })
  afterAll(async () => {
    await database.close()
  })

  /** 建一个「有指令、有讨论」的任务：讨论 3 条 + 指令/追问各 1 条（含一条被拒的）。 */
  async function seedMixedTask() {
    const ids = await seedRunPrereqs(database.db)
    const harness = makeHarness(database)
    const actor = makeActor(ids.userId)

    // 讨论消息（走 db 层，避免依赖评论路由的权限面；本片验的是读模型隔离）
    const discussion = await insertMessage(database.db, {
      id: randomUUID(),
      taskId: ids.taskId,
      authorUserId: ids.userId,
      body: '这段我建议先跑 macOS 冒烟',
      kind: 'discussion',
      origin: 'human',
      createdAt: new Date('2026-08-25T00:00:01.000Z'),
    })

    // 先建 Run，才能产生「挂在这个 Run 上的追问」
    const run = await harness.orchestrator.create(actor, ids.taskId, makeCreateInput(ids))
    await harness.outbox.claim()
    await setRunStatus(database.db, run.id, 'running')

    // 指令（人让 Agent 干活）：accepted 的一条
    const instruction = await insertMessage(database.db, {
      id: randomUUID(),
      taskId: ids.taskId,
      authorUserId: ids.userId,
      body: '把 macOS 的冒烟结果补进 README',
      kind: 'instruction',
      origin: 'human',
      targetAgentId: ids.agentId,
      runId: run.id,
      instructionState: 'accepted',
      createdAt: new Date('2026-08-25T00:00:02.000Z'),
    })

    // 追问（活跃 Run 上接着说）：走真人服务函数，落 pending
    const followup = await sendRunFollowup(database, harness.outbox, actor, run.id, {
      text: '顺便把 Windows 也补上',
      idempotencyKey: 'k-sep',
    })

    // 一条**被拒**的指令（终态清扫的形态）：这是用户最在意的「状态混乱」来源
    const rejected = await insertMessage(database.db, {
      id: randomUUID(),
      taskId: ids.taskId,
      authorUserId: ids.userId,
      body: '这句会被拒（Run 已结束）',
      kind: 'instruction',
      origin: 'human',
      targetAgentId: ids.agentId,
      runId: run.id,
      instructionState: 'rejected',
      instructionErrorCode: 'RUN_TERMINAL',
      instructionErrorMessage: 'run reached completed before the followup was accepted',
      createdAt: new Date('2026-08-25T00:00:03.000Z'),
    })

    const second = await insertMessage(database.db, {
      id: randomUUID(),
      taskId: ids.taskId,
      authorUserId: ids.userId,
      body: '同意，先小范围跑',
      kind: 'discussion',
      origin: 'human',
      createdAt: new Date('2026-08-25T00:00:04.000Z'),
    })

    return { ids, harness, run, discussion, instruction, followup, rejected, second }
  }

  it('讨论流**只**含 discussion：指令与追问（含被拒的）一条都不出现', async () => {
    const { ids, discussion, second } = await seedMixedTask()
    const room = await getTaskRoom(database.db, ids.taskId)
    expect(room).toBeDefined()

    expect(room?.comments.map((message) => message.id)).toEqual([discussion.id, second.id])
    // 明确断言「不含」：这是本片的核心判据（用户要的就是评论区看不到执行状态）。
    expect(room?.comments.every((message) => message.kind === 'discussion')).toBe(true)
  })

  it('执行流**只**含 instruction / followup，并带上状态与拒绝理由（执行区据此说明「为什么没被受理」）', async () => {
    const { ids, instruction, followup, rejected } = await seedMixedTask()
    const room = await getTaskRoom(database.db, ids.taskId)

    // 追问的 createdAt 由服务函数取"现在"（真实时钟），与上面两条固定时间戳不同，
    // 所以按 id 集合断言而不是位置断言；顺序契约由本文件最后一条判据单独钉。
    expect(new Set(room?.instructions.map((message) => message.id))).toEqual(
      new Set([instruction.id, followup.id, rejected.id]),
    )
    expect((room?.instructions ?? []).map((message) => message.kind).sort()).toEqual([
      'followup',
      'instruction',
      'instruction',
    ])
    const rejectedView = room?.instructions.find((message) => message.id === rejected.id)
    expect(rejectedView).toMatchObject({
      instructionState: 'rejected',
      instructionErrorCode: 'RUN_TERMINAL',
      instructionErrorMessage: 'run reached completed before the followup was accepted',
    })
    // 执行区的条目都带 runId（点开运行卡/覆盖层要用）
    expect(room?.instructions.every((message) => message.runId !== null)).toBe(true)
  })

  it('两条流**互斥不重叠**，且合计等于审计全量（不漏消息）', async () => {
    const { ids } = await seedMixedTask()
    const room = await getTaskRoom(database.db, ids.taskId)
    const all = await listMessages(database.db, ids.taskId)

    const shown = [...(room?.comments ?? []), ...(room?.instructions ?? [])].map((m) => m.id)
    expect(new Set(shown).size).toBe(shown.length) // 不重叠
    expect(shown.sort()).toEqual(all.map((row) => row.id).sort()) // 不漏
  })

  it('只有讨论的任务：instructions 是**空数组**（不是 undefined——执行区据此渲染空态）', async () => {
    const ids = await seedRunPrereqs(database.db)
    await insertMessage(database.db, {
      id: randomUUID(),
      taskId: ids.taskId,
      authorUserId: ids.userId,
      body: '纯讨论',
      kind: 'discussion',
      origin: 'human',
    })
    const room = await getTaskRoom(database.db, ids.taskId)
    expect(room?.comments).toHaveLength(1)
    expect(room?.instructions).toEqual([])
  })

  it('只有指令的任务：comments 是**空数组**（评论区空态，不含执行状态）', async () => {
    const ids = await seedRunPrereqs(database.db)
    await insertMessage(database.db, {
      id: randomUUID(),
      taskId: ids.taskId,
      authorUserId: ids.userId,
      body: '直接开工',
      kind: 'instruction',
      origin: 'human',
      targetAgentId: ids.agentId,
      instructionState: 'pending',
    })
    const room = await getTaskRoom(database.db, ids.taskId)
    expect(room?.comments).toEqual([])
    expect(room?.instructions).toHaveLength(1)
  })

  it('指令流也按 (created_at, id)：created_at 与 id 顺序故意相反 + 同刻次级键（评审 F）', async () => {
    const ids = await seedRunPrereqs(database.db)
    const base = Date.parse('2026-08-25T00:00:00.000Z')
    // 只造**指令流**（讨论流为空）：这样才能单独钉住执行区视图的顺序——
    // 评审变异 F 证明：把 `listInstructionMessages` 改成倒序时，原先 6 条判据全绿
    //（判据 2 用 Set 比较掩盖了顺序，判据 6 只造 discussion），而 03 §2.2 已对外承诺两条流同序。
    const make = (id: string, body: string, createdAt: number) =>
      insertMessage(database.db, {
        id,
        taskId: ids.taskId,
        authorUserId: ids.userId,
        body,
        kind: 'instruction' as const,
        origin: 'human' as const,
        targetAgentId: ids.agentId,
        instructionState: 'pending' as const,
        createdAt: new Date(createdAt),
      })
    // 插入序 = 晚→中→早；created_at 升序（早→中→晚）；id 序与 created_at **相反**；
    // 第 4 条与 middle 同 created_at 但 id 更小 → 钉住次级键。
    const late = await make('ffffffff-0000-7000-8000-000000000001', 'C 最晚', base + 3000)
    const middle = await make('ffffffff-0000-7000-8000-000000000002', 'B 中间', base + 2000)
    const early = await make('ffffffff-0000-7000-8000-000000000003', 'A 最早', base + 1000)
    const tieEarly = await make(
      'aaaaaaaa-0000-7000-8000-000000000000',
      'B′ 同刻但 id 更小',
      base + 2000,
    )

    const room = await getTaskRoom(database.db, ids.taskId)
    expect(room?.instructions.map((message) => message.id)).toEqual([
      early.id,
      tieEarly.id,
      middle.id,
      late.id,
    ])
    // 讨论流此时为空（本判据只针对执行区顺序，评审 F 的归因要精准）。
    expect(room?.comments).toEqual([])
  })

  it('runId 的诚实断言：accepted / rejected 的指令必带 runId，pending 的可以没有（评审应改 2）', async () => {
    const { ids, instruction, rejected } = await seedMixedTask()
    const room = await getTaskRoom(database.db, ids.taskId)
    const withRun = (room?.instructions ?? []).filter(
      (message) =>
        message.instructionState === 'accepted' || message.instructionState === 'rejected',
    )
    // 反例：合法 `pending` 指令可以 runId=null（DB 的 check 只约束 accepted），
    // 所以「所有执行流条目都带 runId」不是不变量——只对受理/拒绝过的成立。
    expect(withRun.length).toBeGreaterThanOrEqual(2)
    expect(withRun.every((message) => message.runId !== null)).toBe(true)
    expect(withRun.map((message) => message.id)).toEqual(
      expect.arrayContaining([instruction.id, rejected.id]),
    )

    // 同一个任务里再造一条合法 `pending` 指令（可以 runId=null）：`seedRunPrereqs` 每用例只能调一次
    //（team 是单例，再调一次会撞 `team_singleton`），所以复用本任务的夹具。
    const pending = await insertMessage(database.db, {
      id: randomUUID(),
      taskId: ids.taskId,
      authorUserId: ids.userId,
      body: '还没建 Run 的指令（pending + runId=null）',
      kind: 'instruction',
      origin: 'human',
      targetAgentId: ids.agentId,
      instructionState: 'pending',
    })
    const pendingRoom = await getTaskRoom(database.db, ids.taskId)
    expect(pendingRoom?.instructions.find((message) => message.id === pending.id)).toMatchObject({
      instructionState: 'pending',
      runId: null,
    })
  })

  it('顺序在讨论流里按 (created_at, id)（同刻按 id 升序）——与线程展示顺序一致', async () => {
    const ids = await seedRunPrereqs(database.db)
    const base = Date.parse('2026-08-25T00:00:00.000Z')
    const make = (id: string, body: string, createdAt: number) =>
      insertMessage(database.db, {
        id,
        taskId: ids.taskId,
        authorUserId: ids.userId,
        body,
        kind: 'discussion' as const,
        origin: 'human' as const,
        createdAt: new Date(createdAt),
      })
    // 插入序 = 晚→早，id 序与 created_at 序故意相反（钉住契约而不是堆序）
    const late = await make('ffffffff-0000-7000-8000-000000000001', '晚', base + 2000)
    const early = await make('ffffffff-0000-7000-8000-000000000002', '早', base + 1000)
    const room = await getTaskRoom(database.db, ids.taskId)
    expect(room?.comments.map((message) => message.id)).toEqual([early.id, late.id])
  })
})

describe('讨论/执行分栏的 HTTP 面（P1-194 评审观察 3：判据不能只在函数层）', () => {
  let database: Database
  let ctx: TestApp
  beforeAll(async () => {
    database = await createTestDatabase()
    ctx = await createTestApp(database)
  })
  beforeEach(async () => {
    await resetDatabase(database)
  })
  afterAll(async () => {
    await ctx.close()
    await database.close()
  })

  it('GET /tasks/:taskId 的 JSON 里同时有 comments 与 instructions（执行区据此渲染）', async () => {
    const alice = await driveSetup(ctx)
    const project = await apiInject(ctx, alice, {
      method: 'POST',
      url: '/api/v1/projects',
      payload: { name: 'P' },
      idempotencyKey: idemKey(),
    })
    const task = await apiInject(ctx, alice, {
      method: 'POST',
      url: `/api/v1/projects/${project.json().data.id}/tasks`,
      payload: { title: 'T', assigneeUserId: alice.userId },
      idempotencyKey: idemKey(),
    })
    const taskId = task.json().data.id as string

    // 走真人路径造一条讨论（HTTP），再直接种一条指令（今天 API 还不产指令，见验收文档）。
    await apiInject(ctx, alice, {
      method: 'POST',
      url: `/api/v1/tasks/${taskId}/comments`,
      payload: { body: '先讨论一下' },
    })
    // 团队/成员由 driveSetup 经 HTTP 建好，这里不再 seedRunPrereqs（team 是单例，会撞约束）；
    // 指令需要 target_agent_id；`driveSetup` 只建团队与成员（不建 Agent），这里补一个最小 Agent 行
    // （本判据验的是读模型在 HTTP 上的形状，不是 Agent 创建链——那条由 agent 相关用例覆盖）。
    const agent = await insertAgent(database.db, {
      id: randomUUID(),
      name: 'agent-http',
      createdBy: alice.userId,
    })
    await insertMessage(database.db, {
      id: randomUUID(),
      taskId,
      authorUserId: alice.userId,
      body: '执行区的指令',
      kind: 'instruction',
      origin: 'human',
      targetAgentId: agent.id,
      instructionState: 'pending',
    })

    const res = await apiInject(ctx, alice, { method: 'GET', url: `/api/v1/tasks/${taskId}` })
    expect(res.statusCode).toBe(200)
    const data = res.json().data as {
      comments: Array<{ kind: string; body: string }>
      instructions: Array<{ kind: string; body: string }>
    }
    // HTTP 契约：两条流都在，且各自只含该含的 kind。
    expect(data.comments.map((message) => message.body)).toEqual(['先讨论一下'])
    expect(data.comments.every((message) => message.kind === 'discussion')).toBe(true)
    expect(data.instructions.map((message) => message.body)).toEqual(['执行区的指令'])
    expect(data.instructions.every((message) => message.kind !== 'discussion')).toBe(true)
  })
})
