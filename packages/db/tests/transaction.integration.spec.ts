import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { Database } from '../src/index.js'
import {
  appendTeamEvent,
  findCommandReceipt,
  getMember,
  getRun,
  insertMember,
  insertRun,
  insertUser,
  listTeamEvents,
  Outbox,
  setMemberRole,
  disableUser,
  transactCommand,
} from '../src/index.js'
import { dispatchOutbox } from '../src/schema/index.js'
import { createTestDatabase, makeRunInput, resetDatabase, seedRunPrereqs } from './helpers.js'

// 02-第一阶段实施计划.md Task 4 Step 4：命令事务与「最后 Owner」事务策略。
describe('transactCommand', () => {
  let database: Database
  let outbox: Outbox
  beforeAll(async () => {
    database = await createTestDatabase()
    outbox = new Outbox(database)
  })
  beforeEach(async () => {
    await resetDatabase(database)
  })
  afterAll(async () => {
    await database.close()
  })

  it('commits domain write + Team Event + Outbox + receipt atomically', async () => {
    const ids = await seedRunPrereqs(database.db)
    const key = `cmd-${randomUUID()}`
    const commandId = randomUUID()

    const result = await transactCommand(database, key, async (tx) => {
      const run = await insertRun(tx, makeRunInput(ids))
      await appendTeamEvent(tx, {
        type: 'run.changed',
        payload: { runId: run.id, status: 'queued' },
      })
      await outbox.enqueue(tx, {
        id: commandId,
        deviceId: ids.deviceId,
        type: 'run.start',
        payload: { commandId, runId: run.id },
      })
      return { runId: run.id }
    })

    expect(await getRun(database.db, result.runId)).toMatchObject({
      taskId: ids.taskId,
      status: 'queued',
    })
    expect(await listTeamEvents(database.db)).toHaveLength(1)
    const claimed = await outbox.claim()
    expect(claimed.map((command) => command.id)).toEqual([commandId])
    expect(await findCommandReceipt(database.db, key)).toMatchObject({ result })
  })

  it('rolls back everything when the command fails', async () => {
    const ids = await seedRunPrereqs(database.db)
    const key = `cmd-${randomUUID()}`
    const runId = randomUUID()

    await expect(
      transactCommand(database, key, async (tx) => {
        await insertRun(tx, makeRunInput(ids, { id: runId }))
        await appendTeamEvent(tx, { type: 'run.changed', payload: { runId } })
        await outbox.enqueue(tx, {
          id: randomUUID(),
          deviceId: ids.deviceId,
          type: 'run.start',
          payload: {},
        })
        throw new Error('boom')
      }),
    ).rejects.toThrow('boom')

    expect(await getRun(database.db, runId)).toBeUndefined()
    expect(await listTeamEvents(database.db)).toHaveLength(0)
    expect(await database.db.select().from(dispatchOutbox)).toHaveLength(0)
    expect(await findCommandReceipt(database.db, key)).toBeUndefined()
  })
})

describe('last-owner transaction policy', () => {
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

  it('blocks demoting the last enabled Owner', async () => {
    const ids = await seedRunPrereqs(database.db)
    await expect(
      setMemberRole(database.db, ids.teamId, ids.userId, 'member'),
    ).rejects.toMatchObject({ code: 'LAST_OWNER_REQUIRED' })
    expect(await getMember(database.db, ids.teamId, ids.userId)).toMatchObject({ role: 'owner' })
  })

  it('blocks disabling the last enabled Owner', async () => {
    const ids = await seedRunPrereqs(database.db)
    await expect(disableUser(database.db, ids.userId, new Date())).rejects.toMatchObject({
      code: 'LAST_OWNER_REQUIRED',
    })
  })

  it('allows demotion once another enabled Owner exists', async () => {
    const ids = await seedRunPrereqs(database.db)
    const secondId = randomUUID()
    await insertUser(database.db, {
      id: secondId,
      username: `owner-${randomUUID().slice(0, 8)}`,
      displayName: 'Second Owner',
      passwordHash: '$argon2id$placeholder$placeholder',
    })
    await insertMember(database.db, { teamId: ids.teamId, userId: secondId, role: 'owner' })

    await setMemberRole(database.db, ids.teamId, ids.userId, 'member')
    expect(await getMember(database.db, ids.teamId, ids.userId)).toMatchObject({ role: 'member' })
  })

  it('does not count a disabled Owner as enabled protection', async () => {
    const ids = await seedRunPrereqs(database.db)
    const secondId = randomUUID()
    await insertUser(database.db, {
      id: secondId,
      username: `owner-${randomUUID().slice(0, 8)}`,
      displayName: 'Second Owner',
      passwordHash: '$argon2id$placeholder$placeholder',
    })
    await insertMember(database.db, { teamId: ids.teamId, userId: secondId, role: 'owner' })

    // 停用第一个 Owner（仍有第二个未停用 Owner，合法）。
    await disableUser(database.db, ids.userId, new Date())
    // 第二个 Owner 成为最后未停用 Owner：降级必须被拒绝。
    await expect(setMemberRole(database.db, ids.teamId, secondId, 'member')).rejects.toMatchObject({
      code: 'LAST_OWNER_REQUIRED',
    })
  })
})
