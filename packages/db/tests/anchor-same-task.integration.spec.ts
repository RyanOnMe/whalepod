/**
 * 同 Task 锚点双侧不变式（#199；migration 0005 的镜像）。
 *
 * 0005 只在 `run` 表上挂了 `run_trigger_message_same_task_check`，
 * 直接 `update task_message set task_id = <别的 Task>` 仍能造出
 * `run.task_id ≠ task_message.task_id` 的坏账（评审 #197 实测）。
 * 本文件钉住消息侧的镜像约束：已被 Run 锚定的消息不得搬 Task。
 */
import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { eq } from 'drizzle-orm'
import type { Database } from '../src/index.js'
import { insertMessage, insertRun, insertTask, schema } from '../src/index.js'
import {
  catchPgError,
  createTestDatabase,
  makeRunInput,
  resetDatabase,
  seedRunPrereqs,
} from './helpers.js'

describe('anchor same-task both sides (#199)', () => {
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

  /** 建好「Task A 指令 ↔ Run」双向锚定，返回第二个 Task B 的 id。 */
  async function seedAnchored(ids: Awaited<ReturnType<typeof seedRunPrereqs>>) {
    const taskB = randomUUID()
    await insertTask(database.db, {
      id: taskB,
      projectId: ids.projectId,
      title: 'Task B',
      assigneeUserId: ids.userId,
      assignmentStatus: 'accepted',
      acceptedAt: new Date(),
      createdBy: ids.userId,
    })
    const message = await insertMessage(database.db, {
      id: randomUUID(),
      taskId: ids.taskId,
      authorUserId: ids.userId,
      body: '修登录并发',
      kind: 'instruction',
      origin: 'human',
      targetAgentId: ids.agentId,
      instructionState: 'pending',
    })
    const run = await insertRun(database.db, makeRunInput(ids))
    await database.db
      .update(schema.runs)
      .set({ triggerMessageId: message.id })
      .where(eq(schema.runs.id, run.id))
    return { messageId: message.id, runId: run.id, taskB }
  }

  it('已被 Run 锚定的消息不得搬到别的 Task（23514）', async () => {
    const ids = await seedRunPrereqs(database.db)
    const { messageId, taskB } = await seedAnchored(ids)
    const error = await catchPgError(
      database.db
        .update(schema.taskMessages)
        .set({ taskId: taskB })
        .where(eq(schema.taskMessages.id, messageId)),
    )
    expect(error).toMatchObject({ code: '23514' })
  })

  it('未被锚定的消息搬 Task 不受影响（讨论消息可自由归属）', async () => {
    const ids = await seedRunPrereqs(database.db)
    const { taskB } = await seedAnchored(ids)
    const free = await insertMessage(database.db, {
      id: randomUUID(),
      taskId: ids.taskId,
      authorUserId: ids.userId,
      body: '这只是讨论',
    })
    const [moved] = await database.db
      .update(schema.taskMessages)
      .set({ taskId: taskB })
      .where(eq(schema.taskMessages.id, free.id))
      .returning()
    expect(moved?.taskId).toBe(taskB)
  })

  it('同 Task 内 touch 消息行（如改 body）不触发误伤', async () => {
    const ids = await seedRunPrereqs(database.db)
    const { messageId } = await seedAnchored(ids)
    const [touched] = await database.db
      .update(schema.taskMessages)
      .set({ body: '修登录并发（补充）' })
      .where(eq(schema.taskMessages.id, messageId))
      .returning()
    expect(touched?.body).toBe('修登录并发（补充）')
  })
})
