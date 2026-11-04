/**
 * #520 评审回归：Executor 预留/结算只回滚实际预留过的 scope。
 *
 * 场景：同团队的项目 A 配过 Router（team 日行存在），项目 B 未配置 Router，
 * 派工只预留 work lifetime。结算若无条件扣 team 行，会把别人的 0 预留推成
 * 负数并让 Run 终态事务永久失败。这里直接钉 repository 的 scope 语义。
 */
import { randomUUID } from 'node:crypto'
import { eq } from 'drizzle-orm'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { Database, NewWorkMandateRow } from '../src/index.js'
import {
  getCoordinationTeamPolicy,
  insertRun,
  insertWork,
  insertWorkMandate,
  reserveExecutorUsage,
  schema,
  setRunStatus,
  settleExecutorUsage,
} from '../src/index.js'
import {
  createTestDatabase,
  makeRunInput,
  resetDatabase,
  seedRunPrereqs,
  type SeedIds,
} from './helpers.js'

describe('Executor ledger reservation scopes', () => {
  let database: Database
  let ids: SeedIds
  let workKey: string
  let mandateId: string
  const utcDate = '2026-11-04'

  beforeAll(async () => {
    database = await createTestDatabase()
  })
  beforeEach(async () => {
    await resetDatabase(database)
    ids = await seedRunPrereqs(database.db)
    workKey = randomUUID()
    const work = await insertWork(database.db, {
      id: randomUUID(),
      projectId: ids.projectId,
      taskId: ids.taskId,
      workKey,
      humanOwnerUserId: ids.userId,
      goal: 'ledger scope regression',
    })
    const mandate: NewWorkMandateRow = {
      id: randomUUID(),
      workId: work.id,
      workKey,
      projectId: ids.projectId,
      taskId: ids.taskId,
      version: 1,
      status: 'active',
      principalUserId: ids.userId,
      onBehalfOfUserId: ids.userId,
      humanOwnerUserId: ids.userId,
      draftRecipientUserId: ids.userId,
      allowedActionClasses: ['analysis'],
      allowedSourceTypes: ['task_message'],
      maxRunsPerWork: 10,
      maxCostMicros: 1_000_000,
      maxTokens: 100_000,
      maxAttempts: 10,
      waitDeadlineSeconds: 60,
      expiresAt: new Date(Date.now() + 3_600_000),
    }
    mandateId = mandate.id
    await insertWorkMandate(database.db, mandate)
  })
  afterAll(async () => {
    await database.close()
  })

  async function reservedRun(tokens: number, costMicros: number) {
    const run = await insertRun(database.db, makeRunInput(ids))
    const reserved = await reserveExecutorUsage(database.db, {
      runId: run.id,
      projectId: ids.projectId,
      teamId: ids.teamId,
      workKey,
      mandateId,
      utcDate,
      reservedTokens: tokens,
      reservedCostMicros: costMicros,
      workLimits: { tokens: 100_000, costMicros: 1_000_000 },
    })
    expect(reserved.ok).toBe(true)
    return run
  }

  it('does not decrement team/project rows that were not part of the reservation', async () => {
    // 模拟同团队另一个项目的 Router 已创建 team 日行。
    await database.db.insert(schema.coordinationBudgets).values({
      scope: 'team',
      scopeId: ids.teamId,
      utcDate,
      calls: 1,
    })
    const run = await reservedRun(100, 10)
    // 断言形式必须让「结算抛 check violation」表现为断言失败，而不是测试运行错误。
    await expect(settleExecutorUsage(database.db, { runId: run.id })).resolves.toBe(true)
    const [team] = await database.db
      .select()
      .from(schema.coordinationBudgets)
      .where(eq(schema.coordinationBudgets.scope, 'team'))
    expect(team).toMatchObject({ reservedTokens: 0, reservedCostMicros: 0, inputTokens: 0 })
    const [work] = await database.db
      .select()
      .from(schema.coordinationBudgets)
      .where(eq(schema.coordinationBudgets.scope, 'work'))
    expect(work).toMatchObject({ reservedTokens: 0, inputTokens: 100, costMicros: 10 })
  })

  it('zero-charges a run that never started and clamps over-reserved usage', async () => {
    const neverStarted = await reservedRun(100, 10)
    expect(
      await settleExecutorUsage(database.db, { runId: neverStarted.id, zeroCharge: true }),
    ).toBe(true)
    const zero = (
      await database.db
        .select()
        .from(schema.executorUsageLedger)
        .where(eq(schema.executorUsageLedger.runId, neverStarted.id))
    ).find((row) => row.phase === 'settled')
    expect(zero).toMatchObject({ chargeMode: 'zero' })
    await setRunStatus(database.db, neverStarted.id, 'completed', { finishedAt: new Date() })

    const overspent = await reservedRun(100, 10)
    await settleExecutorUsage(database.db, {
      runId: overspent.id,
      usage: { inputTokens: 1000, outputTokens: 1000, costMicros: 1000 },
    })
    const settled = (
      await database.db
        .select()
        .from(schema.executorUsageLedger)
        .where(eq(schema.executorUsageLedger.runId, overspent.id))
    ).find((row) => row.phase === 'settled')
    expect(settled).toMatchObject({ chargeMode: 'reserved', usage: { inputTokens: 1000 } })
    const [work] = await database.db
      .select()
      .from(schema.coordinationBudgets)
      .where(eq(schema.coordinationBudgets.scope, 'work'))
    // zero run 0 + over-reserved run 100
    expect(work).toMatchObject({ inputTokens: 100, outputTokens: 0, costMicros: 10 })
  })

  it('does not create a team policy from an executor reservation', async () => {
    await reservedRun(100, 10)
    expect(await getCoordinationTeamPolicy(database.db, ids.teamId)).toBeUndefined()
  })
})
