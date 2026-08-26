import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { Database, Tx } from '../src/index.js'
import {
  appendTeamEvent,
  findCommandReceipt,
  insertRun,
  listRunsByTask,
  listTeamEvents,
  transactCommand,
} from '../src/index.js'
import { createTestDatabase, makeRunInput, resetDatabase, seedRunPrereqs } from './helpers.js'
import { commandReceipts } from '../src/schema/index.js'

// 02-第一阶段实施计划.md Task 4 Step 4：命令回执幂等（含并发同 key）。
describe('command idempotency', () => {
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

  it('replays a command without re-executing side effects', async () => {
    const ids = await seedRunPrereqs(database.db)
    const key = `cmd-${randomUUID()}`
    let executions = 0
    const execute = async (tx: Tx) => {
      executions += 1
      const run = await insertRun(tx, makeRunInput(ids))
      await appendTeamEvent(tx, { type: 'run.changed', payload: { runId: run.id } })
      return { runId: run.id, execution: executions }
    }

    const first = await transactCommand(database, key, execute)
    const second = await transactCommand(database, key, execute)

    expect(second).toEqual(first)
    expect(executions).toBe(2)
    // 重放不产生第二条领域写 / Team Event。
    expect(await listRunsByTask(database.db, ids.taskId)).toHaveLength(1)
    expect(await listTeamEvents(database.db)).toHaveLength(1)
    expect(await findCommandReceipt(database.db, key)).toMatchObject({ result: first })
  })

  it('executes distinct keys independently', async () => {
    await seedRunPrereqs(database.db)
    let executions = 0
    const execute = async () => {
      executions += 1
      return { execution: executions }
    }
    const a = await transactCommand(database, `cmd-a-${randomUUID()}`, execute)
    const b = await transactCommand(database, `cmd-b-${randomUUID()}`, execute)
    expect(a).toEqual({ execution: 1 })
    expect(b).toEqual({ execution: 2 })
  })

  it('settles concurrent same-key commands on exactly one committed result', async () => {
    await seedRunPrereqs(database.db)
    const key = `cmd-${randomUUID()}`

    // 确定性构造 23505 冲突路径（而非碰巧撞上时序）：
    // 事务 A 持有未提交的回执行；B 的 SELECT 看不到它，执行副作用后
    // 阻塞在回执 INSERT 上；A 提交后 B 撞 23505，回滚并回读胜者结果。
    let releaseA!: () => void
    const gateA = new Promise<void>((resolve) => {
      releaseA = resolve
    })
    let signalAReceiptWritten!: () => void
    const aReceiptWritten = new Promise<void>((resolve) => {
      signalAReceiptWritten = resolve
    })
    const txA = database.transaction(async (tx) => {
      const event = await appendTeamEvent(tx, { type: 'task.changed', payload: { key, by: 'a' } })
      await tx.insert(commandReceipts).values({ key, result: { cursor: event.id } })
      signalAReceiptWritten()
      await gateA
      return { cursor: event.id }
    })
    await aReceiptWritten

    let bExecuted = false
    const bPromise = transactCommand(database, key, async (tx) => {
      bExecuted = true
      const event = await appendTeamEvent(tx, { type: 'task.changed', payload: { key, by: 'b' } })
      return { cursor: event.id }
    })
    // 让 B 完成事务内 SELECT（看不到 A 未提交的回执）后再放行 A 提交。
    await new Promise((resolve) => setTimeout(resolve, 100))
    releaseA()

    const [a, b] = await Promise.all([txA, bPromise])
    expect(bExecuted).toBe(true) // 证明走的是 23505 冲突回读路径，而非事务内命中回执
    expect(b).toEqual(a)
    // 只有胜者的 Team Event 与回执被提交。
    expect(await listTeamEvents(database.db)).toHaveLength(1)
    expect(await findCommandReceipt(database.db, key)).toMatchObject({ result: a })
  })
})
