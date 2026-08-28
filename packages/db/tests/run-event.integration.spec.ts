/**
 * P1-13 db 层扩展的集成验收（真实 PostgreSQL，Q2 门）：
 * - runEventWatermark：连续水位——缺口不越过（spool 不会误删未达事件）；
 * - insertApprovalIfAbsent：双受众同一 approvalId 的第二行幂等跳过；
 * - listRunEvents：受众过滤 / afterSeq 增量 / limit。
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { Database } from '../src/index.js'
import {
  appendRunEvent,
  insertApprovalIfAbsent,
  insertRun,
  listRunEvents,
  runEventWatermark,
} from '../src/index.js'
import {
  createTestDatabase,
  makeApprovalInput,
  makeRunEventInput,
  makeRunInput,
  resetDatabase,
  seedRunPrereqs,
} from './helpers.js'

describe('run event repositories（P1-13）', () => {
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

  it('watermark：无事件为 0；连续到 N 为 N；缺口停在缺口前', async () => {
    const ids = await seedRunPrereqs(database.db)
    const run = await insertRun(database.db, makeRunInput(ids))
    expect(await runEventWatermark(database.db, run.id)).toBe(0)

    await appendRunEvent(database.db, makeRunEventInput(run.id, 1))
    await appendRunEvent(database.db, makeRunEventInput(run.id, 2))
    expect(await runEventWatermark(database.db, run.id)).toBe(2)

    // 直接插 seq=4（跳过 3，模拟乱序到达）：水位停在 2，绝不越过缺口。
    await appendRunEvent(database.db, makeRunEventInput(run.id, 4))
    expect(await runEventWatermark(database.db, run.id)).toBe(2)

    await appendRunEvent(database.db, makeRunEventInput(run.id, 3))
    expect(await runEventWatermark(database.db, run.id)).toBe(4)
  })

  it('insertApprovalIfAbsent：同 approvalId 第二次插入幂等跳过（双受众去重）', async () => {
    const ids = await seedRunPrereqs(database.db)
    const run = await insertRun(database.db, makeRunInput(ids))
    const input = makeApprovalInput(run.id, 'call-1')
    const first = await insertApprovalIfAbsent(database.db, input)
    expect(first.inserted).toBe(true)
    const second = await insertApprovalIfAbsent(database.db, { ...input })
    expect(second.inserted).toBe(false)
  })

  it('listRunEvents：受众过滤只返回许可行；afterSeq/limit 生效', async () => {
    const ids = await seedRunPrereqs(database.db)
    const run = await insertRun(database.db, makeRunInput(ids))
    await appendRunEvent(database.db, {
      ...makeRunEventInput(run.id, 1),
      audience: 'project',
      type: 'run.phase',
    })
    await appendRunEvent(database.db, {
      ...makeRunEventInput(run.id, 2),
      audience: 'owner',
      type: 'assistant.message',
    })
    await appendRunEvent(database.db, {
      ...makeRunEventInput(run.id, 3),
      audience: 'admin',
      type: 'run.failed',
    })

    const memberView = await listRunEvents(database.db, run.id, { audiences: ['project'] })
    expect(memberView.map((row) => row.seq)).toEqual([1])

    const ownerView = await listRunEvents(database.db, run.id, {
      audiences: ['owner', 'project'],
    })
    expect(ownerView.map((row) => row.seq)).toEqual([1, 2])

    const after = await listRunEvents(database.db, run.id, { afterSeq: 1, limit: 1 })
    expect(after.map((row) => row.seq)).toEqual([2])
  })
})
