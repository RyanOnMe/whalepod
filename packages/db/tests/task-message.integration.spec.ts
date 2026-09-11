/**
 * task_message 实体约束（#185 / ADR-0009 决策 2）：数据库层硬约束的机器证据。
 *
 * 这些 check 不是装饰：它们把两条产品红线钉在数据层——
 * 「讨论不驱动 Agent」（discussion 不得携带 Agent/Run/受理状态）与「受理即落账」
 * （指令/追问必须有 Agent 与受理状态、追问必须挂在既有 Run 上）。
 * 与 constraints.integration.spec.ts 同风格：23514 = check_violation。
 */
import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { Database } from '../src/index.js'
import { insertMessage, insertRun, insertTask, listMessages } from '../src/index.js'
import {
  catchPgError,
  createTestDatabase,
  makeRunInput,
  resetDatabase,
  seedRunPrereqs,
} from './helpers.js'

describe('task_message constraints', () => {
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

  it('老写法（只给 body）落库即讨论消息：kind=discussion、origin=human、无 Agent/Run/状态', async () => {
    const ids = await seedRunPrereqs(database.db)
    const row = await insertMessage(database.db, {
      id: randomUUID(),
      taskId: ids.taskId,
      authorUserId: ids.userId,
      body: '清单今天出，先把上周的发布项捋一遍',
    })
    // 默认值就是「评论」语义：既有调用点（Hub 评论路径）无需改动即落成讨论消息。
    expect(row).toMatchObject({
      kind: 'discussion',
      origin: 'human',
      targetAgentId: null,
      runId: null,
      instructionState: null,
    })
  })

  it('讨论消息不得携带目标 Agent / Run / 受理状态（讨论不驱动 Agent）', async () => {
    const ids = await seedRunPrereqs(database.db)
    const run = await insertRun(database.db, makeRunInput(ids))
    // 三种越界组合都必须在数据层被拒：否则一句闲聊可能悄悄进了某个 Agent 的上下文。
    for (const bad of [
      { targetAgentId: ids.agentId },
      { runId: run.id },
      { instructionState: 'accepted' as const },
    ]) {
      const error = await catchPgError(
        insertMessage(database.db, {
          id: randomUUID(),
          taskId: ids.taskId,
          authorUserId: ids.userId,
          body: '这只是一句讨论',
          ...bad,
        }),
      )
      expect(error).toMatchObject({
        code: '23514',
        constraintName: 'task_message_discussion_inert',
      })
    }
  })

  it('指令必须有目标 Agent 与受理状态（受理即落账，不留「已受理、零痕迹」）', async () => {
    const ids = await seedRunPrereqs(database.db)
    const missingAgent = await catchPgError(
      insertMessage(database.db, {
        id: randomUUID(),
        taskId: ids.taskId,
        authorUserId: ids.userId,
        body: '@Agent 整理发布记录',
        kind: 'instruction',
        instructionState: 'pending',
      }),
    )
    expect(missingAgent).toMatchObject({
      code: '23514',
      constraintName: 'task_message_instruction_addressed',
    })

    const missingState = await catchPgError(
      insertMessage(database.db, {
        id: randomUUID(),
        taskId: ids.taskId,
        authorUserId: ids.userId,
        body: '@Agent 整理发布记录',
        kind: 'instruction',
        targetAgentId: ids.agentId,
      }),
    )
    expect(missingState).toMatchObject({
      code: '23514',
      constraintName: 'task_message_instruction_addressed',
    })
  })

  it('追问必须挂在既有 Run 上（followup 是那次执行里的继续说话）', async () => {
    const ids = await seedRunPrereqs(database.db)
    const error = await catchPgError(
      insertMessage(database.db, {
        id: randomUUID(),
        taskId: ids.taskId,
        authorUserId: ids.userId,
        body: '顺便把 macOS 的冒烟结果也补进去',
        kind: 'followup',
        targetAgentId: ids.agentId,
        instructionState: 'pending',
      }),
    )
    expect(error).toMatchObject({ code: '23514', constraintName: 'task_message_followup_attached' })
  })

  it('kind / origin / instruction_state 只接受枚举内取值', async () => {
    const ids = await seedRunPrereqs(database.db)
    const base = {
      taskId: ids.taskId,
      authorUserId: ids.userId,
      body: '内容',
    }
    const badKind = await catchPgError(
      insertMessage(database.db, {
        ...base,
        id: randomUUID(),
        // 补齐其它必填，让违规点落在 kind 上（否则先撞 instruction_addressed）。
        kind: 'shout' as unknown as 'discussion',
        targetAgentId: ids.agentId,
        instructionState: 'pending',
      }),
    )
    expect(badKind).toMatchObject({ code: '23514', constraintName: 'task_message_kind_valid' })

    const badOrigin = await catchPgError(
      insertMessage(database.db, {
        ...base,
        id: randomUUID(),
        origin: 'robot' as unknown as 'human',
      }),
    )
    expect(badOrigin).toMatchObject({ code: '23514', constraintName: 'task_message_origin_valid' })

    const badState = await catchPgError(
      insertMessage(database.db, {
        ...base,
        id: randomUUID(),
        kind: 'instruction',
        targetAgentId: ids.agentId,
        instructionState: 'maybe' as unknown as 'pending',
      }),
    )
    expect(badState).toMatchObject({ code: '23514', constraintName: 'task_message_state_valid' })
  })

  it('线程读取按 (createdAt, id) 稳定排序，且只返回本 Task 的消息', async () => {
    const ids = await seedRunPrereqs(database.db)
    // 本部署是**单 Team**（team_singleton 唯一约束），不能 seed 第二次；换个 Task 即可
    // ——「只返回本 Task 的消息」验的正是 task_id 过滤。
    const otherTaskId = randomUUID()
    await insertTask(database.db, {
      id: otherTaskId,
      projectId: ids.projectId,
      title: '另一个任务',
      assigneeUserId: ids.userId,
      assignmentStatus: 'accepted',
      acceptedAt: new Date(),
      createdBy: ids.userId,
    })
    await insertMessage(database.db, {
      id: '00000000-0000-4000-8000-000000000001',
      taskId: ids.taskId,
      authorUserId: ids.userId,
      body: '第一条',
    })
    await insertMessage(database.db, {
      id: '00000000-0000-4000-8000-000000000002',
      taskId: ids.taskId,
      authorUserId: ids.userId,
      body: '第二条',
    })
    await insertMessage(database.db, {
      id: randomUUID(),
      taskId: otherTaskId,
      authorUserId: ids.userId,
      body: '别的任务的消息',
    })

    const rows = await listMessages(database.db, ids.taskId)
    expect(rows.map((row) => row.body)).toEqual(['第一条', '第二条'])
  })
})
