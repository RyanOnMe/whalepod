import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { Database } from '@whalepod/db'
import { insertMessage, listMessages, schema, setRunStatus } from '@whalepod/db'
import { sendRunFollowup } from '../src/modules/run/followup.js'
import { getTaskRoom } from '../src/modules/task/view.js'
import {
  createTestDatabase,
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

  it('顺序在两条流里都按 (created_at, id)（同刻按 id 升序）——与线程展示顺序一致', async () => {
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
