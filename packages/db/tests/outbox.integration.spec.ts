import { randomUUID } from 'node:crypto'
import { eq } from 'drizzle-orm'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { ClaimedCommand, Database } from '../src/index.js'
import { claimInTransaction, computeBackoffMs, Outbox, transactCommand } from '../src/index.js'
import { dispatchOutbox } from '../src/schema/index.js'
import { createTestDatabase, resetDatabase, seedRunPrereqs } from './helpers.js'

// 02-第一阶段实施计划.md Task 4 Step 5/6：Outbox claim/ack/fail、退避与崩溃恢复。
describe('outbox', () => {
  let database: Database
  let outbox: Outbox
  beforeAll(async () => {
    database = await createTestDatabase()
    outbox = new Outbox(database, { random: () => 0 })
  })
  beforeEach(async () => {
    await resetDatabase(database)
  })
  afterAll(async () => {
    await database.close()
  })

  it('claims a queued command and bumps attempt bookkeeping', async () => {
    const ids = await seedRunPrereqs(database.db)
    const fixedNow = new Date('2026-08-25T00:00:00.000Z')
    const clocked = new Outbox(database, { now: () => fixedNow, random: () => 0 })
    const commandId = randomUUID()
    const runId = randomUUID()
    await database.transaction(async (tx) => {
      await clocked.enqueue(tx, {
        id: commandId,
        deviceId: ids.deviceId,
        type: 'run.status_request',
        payload: { commandId, runId },
        notBefore: fixedNow,
      })
    })

    const claimed = await clocked.claim()
    expect(claimed).toHaveLength(1)
    expect(claimed[0]).toMatchObject({ id: commandId, attemptCount: 1 })
    expect(claimed[0]?.payload).toEqual({ commandId, runId })

    const [row] = await database.db
      .select()
      .from(dispatchOutbox)
      .where(eq(dispatchOutbox.id, commandId))
    expect(row).toMatchObject({ attemptCount: 1 })
    // random=()=>0：退避精确为 min(30s, 250ms * 2^0) = 250ms。
    expect(row?.nextAttemptAt.getTime() - fixedNow.getTime()).toBe(250)
  })

  it('未给 notBefore = 立即可投：next_attempt_at 用 Outbox 的时钟，不是 DB 默认 now()', async () => {
    // #186 实测的坑：老实现让没传 notBefore 的行落 DB 的 now()，而 worker 的 claim 用注入
    // 时钟比较（`next_attempt_at <= now`）。两者在假时钟下不同 → 命令**永远不可 claim**、
    // 静默躺在表里。这条用例是可失败判据：把 enqueue 改回不写 nextAttemptAt 就会红
    //（本文件其它用例都用真实时钟，DB now() 与 new Date() 同刻度，变异不掉）。
    const ids = await seedRunPrereqs(database.db)
    const fixedNow = new Date('2026-08-25T00:00:00.000Z')
    const clocked = new Outbox(database, { now: () => fixedNow, random: () => 0 })
    const commandId = randomUUID()
    await database.transaction(async (tx) => {
      await clocked.enqueue(tx, {
        id: commandId,
        deviceId: ids.deviceId,
        type: 'run.followup',
        // 不传 messageId：本用例只验时钟口径（message_id 与 followup 的关联在
        // apps/hub/tests/followup.integration.spec.ts 验）。
        payload: { commandId, runId: randomUUID(), text: 'x' },
      })
    })

    const [row] = await database.db
      .select()
      .from(dispatchOutbox)
      .where(eq(dispatchOutbox.id, commandId))
    expect(row?.nextAttemptAt.getTime()).toBe(fixedNow.getTime())
    // 同刻即可 claim —— 这正是生产里「入队后立刻可投」的语义。
    const claimed = await clocked.claim()
    expect(claimed.map((command) => command.id)).toContain(commandId)
  })

  it('does not claim commands scheduled in the future', async () => {
    const ids = await seedRunPrereqs(database.db)
    await database.transaction(async (tx) => {
      await outbox.enqueue(tx, {
        id: randomUUID(),
        deviceId: ids.deviceId,
        type: 'run.cancel',
        payload: {},
        notBefore: new Date(Date.now() + 3_600_000),
      })
    })
    expect(await outbox.claim()).toEqual([])
  })

  it('rejects claim limits outside 1..50', async () => {
    await expect(outbox.claim(0)).rejects.toThrow(RangeError)
    await expect(outbox.claim(51)).rejects.toThrow(RangeError)
  })

  it('claims at most 50 commands per batch', async () => {
    const ids = await seedRunPrereqs(database.db)
    await database.transaction(async (tx) => {
      for (let i = 0; i < 60; i += 1) {
        await outbox.enqueue(tx, {
          id: randomUUID(),
          deviceId: ids.deviceId,
          type: 'run.status_request',
          payload: { i },
        })
      }
    })
    const claimed = await outbox.claim()
    expect(claimed).toHaveLength(50)
  })

  it('claims disjoint batches under concurrent workers (FOR UPDATE SKIP LOCKED)', async () => {
    const ids = await seedRunPrereqs(database.db)
    await database.transaction(async (tx) => {
      for (let i = 0; i < 10; i += 1) {
        await outbox.enqueue(tx, {
          id: randomUUID(),
          deviceId: ids.deviceId,
          type: 'run.status_request',
          payload: { i },
        })
      }
    })

    const databaseB = await createTestDatabase()
    const outboxB = new Outbox(databaseB, { random: () => 0 })
    try {
      let releaseA!: () => void
      const gateA = new Promise<void>((resolve) => {
        releaseA = resolve
      })
      let signalAClaimed!: () => void
      const aClaimed = new Promise<void>((resolve) => {
        signalAClaimed = resolve
      })
      let claimedA: ClaimedCommand[] = []
      // worker A 在事务内 claim 4 条并持有行锁，停在提交前。
      const txA = database.transaction(async (tx) => {
        claimedA = await claimInTransaction(tx, { limit: 4, now: new Date(), random: () => 0 })
        signalAClaimed()
        await gateA
      })
      await aClaimed
      // A 持锁期间 worker B 只能拿走剩余 6 条（SKIP LOCKED）。
      const claimedB = await outboxB.claim()
      releaseA()
      await txA

      expect(claimedA).toHaveLength(4)
      expect(claimedB).toHaveLength(6)
      const overlap = claimedA.filter((a) => claimedB.some((b) => b.id === a.id))
      expect(overlap).toEqual([])
    } finally {
      await databaseB.close()
    }
  })

  it('ack is idempotent and removes the command from the pending set', async () => {
    const ids = await seedRunPrereqs(database.db)
    const commandId = randomUUID()
    await database.transaction(async (tx) => {
      await outbox.enqueue(tx, {
        id: commandId,
        deviceId: ids.deviceId,
        type: 'run.cancel',
        payload: {},
      })
    })
    await outbox.claim()
    expect(await outbox.ack(commandId)).toBe(true)
    expect(await outbox.ack(commandId)).toBe(false)
    expect(await outbox.claim()).toEqual([])
  })

  it('fail is terminal and idempotent', async () => {
    const ids = await seedRunPrereqs(database.db)
    const commandId = randomUUID()
    await database.transaction(async (tx) => {
      await outbox.enqueue(tx, {
        id: commandId,
        deviceId: ids.deviceId,
        type: 'run.cancel',
        payload: {},
      })
    })
    await outbox.claim()
    expect(await outbox.fail(commandId)).toBe(true)
    expect(await outbox.fail(commandId)).toBe(false)
    // 已 fail 的命令不再投递，也不再接受 ack。
    expect(await outbox.ack(commandId)).toBe(false)
    expect(await outbox.claim()).toEqual([])
  })

  it('delivers a committed command to a rebuilt worker after the enqueuing process is gone', async () => {
    // 02 Task 4 Step 6：事务提交后不运行 dispatcher；重建 Outbox worker 必须仍能 claim。
    // 全链路只走数据库表，不依赖任何进程内事件 emitter。
    const ids = await seedRunPrereqs(database.db)
    const commandId = randomUUID()

    // “进程 A”：命令事务提交（领域写 + Outbox 入队），随后整体关闭连接模拟崩溃/退出。
    const databaseA = await createTestDatabase()
    const outboxA = new Outbox(databaseA)
    await transactCommand(databaseA, `cmd-${commandId}`, async (tx) => {
      await outboxA.enqueue(tx, {
        id: commandId,
        deviceId: ids.deviceId,
        type: 'run.cancel',
        payload: { commandId, runId: randomUUID(), cause: 'user' },
      })
      return { queued: commandId }
    })
    await databaseA.close()

    // “进程 B”：全新连接 + 全新 worker，直接 claim 到该命令。
    const databaseB = await createTestDatabase()
    try {
      const outboxB = new Outbox(databaseB)
      const claimed = await outboxB.claim()
      expect(claimed.map((command) => command.id)).toContain(commandId)
      expect(await outboxB.ack(commandId)).toBe(true)
    } finally {
      await databaseB.close()
    }
  })

  it('redelivers an unacked command after the visibility timeout', async () => {
    const ids = await seedRunPrereqs(database.db)
    const commandId = randomUUID()
    await database.transaction(async (tx) => {
      await outbox.enqueue(tx, {
        id: commandId,
        deviceId: ids.deviceId,
        type: 'run.cancel',
        payload: {},
        // 显式给过去时刻：缺省时 next_attempt_at 落 PG defaultNow()，而 claim 的
        // now 取 JS Date.now()，两条时钟线存在亚毫秒偏差会让首查偶发为空（#42）。
        // 「立即派发」的确定性由「行时刻严格早于任何后续 JS 时钟」保证。
        notBefore: new Date(Date.now() - 60_000),
      })
    })

    // worker 第一次 claim 后“崩溃”：不 ack；把 next_attempt_at 拨回过去模拟退避到期。
    const first = await outbox.claim()
    expect(first.map((command) => command.id)).toEqual([commandId])
    await database.db
      .update(dispatchOutbox)
      .set({ nextAttemptAt: new Date(Date.now() - 1000) })
      .where(eq(dispatchOutbox.id, commandId))

    const second = await outbox.claim()
    expect(second).toHaveLength(1)
    expect(second[0]).toMatchObject({ id: commandId, attemptCount: 2 })
  })
})

describe('computeBackoffMs', () => {
  it('grows exponentially from 250ms', () => {
    expect(computeBackoffMs(0, () => 0)).toBe(250)
    expect(computeBackoffMs(1, () => 0)).toBe(500)
    expect(computeBackoffMs(3, () => 0)).toBe(2000)
  })

  it('caps the base delay at 30s', () => {
    expect(computeBackoffMs(10, () => 0)).toBe(30_000)
    expect(computeBackoffMs(20, () => 0)).toBe(30_000)
  })

  it('adds 0–20% jitter on top of the capped base', () => {
    expect(computeBackoffMs(0, () => 0.5)).toBe(275)
    expect(computeBackoffMs(0, () => 1)).toBe(300)
    expect(computeBackoffMs(20, () => 1)).toBe(36_000)
  })
})
