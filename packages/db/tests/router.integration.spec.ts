/** Repository/DB constraints only; production Router lifecycle is tested through Hub APIs. */
import { randomUUID } from 'node:crypto'
import { and, eq } from 'drizzle-orm'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import {
  insertEvaluation,
  insertProject,
  configureRouter,
  getRouterConfig,
  getCoordinationTeamPolicy,
  reserveCoordinationUsage,
  settleCoordinationUsage,
  schema,
  type Database,
  type ReserveCoordinationUsageInput,
} from '../src/index.js'
import {
  catchPgError,
  createTestDatabase,
  resetDatabase,
  seedRunPrereqs,
  type SeedIds,
} from './helpers.js'

describe('Router budget atomicity and evaluation constraints', () => {
  let database: Database
  let ids: SeedIds
  beforeAll(async () => {
    database = await createTestDatabase()
  })
  beforeEach(async () => {
    await resetDatabase(database)
    ids = await seedRunPrereqs(database.db)
    await database.transaction((tx) => configureRouter(tx, configuration()))
  })
  afterAll(async () => {
    await database.close()
  })
  function configuration(
    overrides: Partial<Parameters<typeof configureRouter>[1]> = {},
  ): Parameters<typeof configureRouter>[1] {
    return {
      projectId: ids.projectId,
      teamId: ids.teamId,
      enabled: true,
      configVersion: 1,
      deviceId: ids.deviceId,
      operatorUserId: ids.userId,
      billingUserId: ids.userId,
      configuredByUserId: ids.userId,
      credentialSlot: 'coordination',
      credentialConfigRevision: 'v1',
      provider: 'test',
      model: 'model',
      teamDailyCallLimit: 2,
      teamDailyTokenLimit: 200,
      teamDailyCostMicrosLimit: 100,
      projectDailyCallLimit: 2,
      projectDailyTokenLimit: 200,
      projectDailyCostMicrosLimit: 100,
      maxInputTokens: 32_000,
      maxOutputTokens: 1000,
      maxCostMicros: 50,
      inputPriceMicrosPerMillionTokens: 1000,
      outputPriceMicrosPerMillionTokens: 1000,
      timeoutSeconds: 60,
      maxRetries: 1,
      ...overrides,
    }
  }
  async function evaluation(status: 'queued' | 'dispatched' = 'queued', projectId = ids.projectId) {
    return insertEvaluation(database.db, {
      id: randomUUID(),
      projectId,
      inputDigest: randomUUID().replaceAll('-', '').padEnd(64, 'a'),
      inputManifest: {},
      rulesVersion: 'test',
      processorVersion: 'test',
      queuedAt: new Date(),
      queueExpiresAt: new Date(Date.now() + 60_000),
      status,
    })
  }
  function reservation(
    evaluationId: string,
    overrides: Partial<ReserveCoordinationUsageInput> = {},
  ): ReserveCoordinationUsageInput {
    return {
      evaluationId,
      attempt: 1,
      projectId: ids.projectId,
      teamId: ids.teamId,
      workKey: ids.taskId,
      utcDate: '2026-11-04',
      reservedTokens: 100,
      reservedCostMicros: 50,
      teamLimits: { calls: 2, tokens: 200, costMicros: 100 },
      projectLimits: { calls: 2, tokens: 200, costMicros: 100 },
      workLimits: { tokens: 200, costMicros: 100, maxAttempts: 1 },
      retry: false,
      ...overrides,
    }
  }
  it('retains legacy inference defaults and rejects unbound router evaluations', async () => {
    const row = await evaluation()
    expect(row.purpose).toBe('inference')
    const error = await catchPgError(
      insertEvaluation(database.db, {
        ...row,
        id: randomUUID(),
        purpose: 'router',
        inputDigest: 'f'.repeat(64),
      }),
    )
    expect(error.code).toBe('23514')
    expect(error.constraintName).toBe('coordination_evaluation_router_binding')
  })
  it('shares the project execution slot across all evaluations', async () => {
    await evaluation('dispatched')
    const error = await catchPgError(evaluation('dispatched'))
    expect(error.code).toBe('23505')
    expect(error.constraintName).toBe('coordination_evaluation_one_running')
  })
  it('reserves once, charges every scope, and rejects exhausted budgets', async () => {
    const row = await evaluation()
    await database.transaction((tx) =>
      configureRouter(
        tx,
        configuration({
          teamDailyCallLimit: 1,
          teamDailyTokenLimit: 100,
          teamDailyCostMicrosLimit: 50,
          configVersion: 2,
        }),
      ),
    )
    const input = reservation(row.id, {
      teamLimits: { calls: 999, tokens: 99_999, costMicros: 99_999 },
    })
    expect(await database.transaction((tx) => reserveCoordinationUsage(tx, input))).toBe(true)
    expect(await database.transaction((tx) => reserveCoordinationUsage(tx, input))).toBe(true)
    const rows = await database.db.select().from(schema.coordinationBudgets)
    expect(rows).toHaveLength(3)
    expect(
      rows.every((r) => r.calls === 1 && r.reservedTokens === 100 && r.reservedCostMicros === 50),
    ).toBe(true)
    const second = await evaluation('dispatched')
    expect(
      await database.transaction((tx) =>
        reserveCoordinationUsage(tx, reservation(second.id, { ...input, evaluationId: second.id })),
      ),
    ).toBe(false)
    expect(await database.db.select().from(schema.coordinationUsageLedger)).toHaveLength(1)
  })

  it('uses the latest global team policy instead of another project old wider configuration', async () => {
    await database.transaction((tx) =>
      configureRouter(
        tx,
        configuration({
          teamDailyCallLimit: 10,
          teamDailyTokenLimit: 1000,
          teamDailyCostMicrosLimit: 1000,
          configVersion: 2,
        }),
      ),
    )
    const secondProjectId = randomUUID()
    await insertProject(database.db, { id: secondProjectId, name: 'second', createdBy: ids.userId })
    await database.transaction((tx) =>
      configureRouter(
        tx,
        configuration({
          projectId: secondProjectId,
          teamDailyCallLimit: 1,
          teamDailyTokenLimit: 100,
          teamDailyCostMicrosLimit: 50,
        }),
      ),
    )
    const old = await getRouterConfig(database.db, ids.projectId)
    const policy = await getCoordinationTeamPolicy(database.db, ids.teamId)
    expect(old?.teamDailyCallLimit).toBe(10)
    expect(policy?.dailyCallLimit).toBe(1)
    expect(policy?.version).toBe(3)
    const first = await evaluation()
    expect(
      await database.transaction((tx) =>
        reserveCoordinationUsage(
          tx,
          reservation(first.id, { teamLimits: { calls: 10, tokens: 1000, costMicros: 1000 } }),
        ),
      ),
    ).toBe(true)
    const second = await evaluation('queued', secondProjectId)
    expect(
      await database.transaction((tx) =>
        reserveCoordinationUsage(
          tx,
          reservation(second.id, {
            projectId: secondProjectId,
            workKey: randomUUID(),
            teamLimits: { calls: 10, tokens: 1000, costMicros: 1000 },
          }),
        ),
      ),
    ).toBe(false)
    expect(await database.db.select().from(schema.coordinationUsageLedger)).toHaveLength(1)
  })
  it('fails closed when no explicit global team policy exists', async () => {
    await database.db.delete(schema.coordinationTeamPolicies)
    const row = await evaluation()
    expect(
      await database.transaction((tx) => reserveCoordinationUsage(tx, reservation(row.id))),
    ).toBe(false)
    expect(await database.db.select().from(schema.coordinationUsageLedger)).toHaveLength(0)
  })

  it('serializes concurrent projects against the same global limit', async () => {
    await database.transaction((tx) =>
      configureRouter(tx, configuration({ teamDailyCallLimit: 1 })),
    )
    const secondProjectId = randomUUID()
    await insertProject(database.db, {
      id: secondProjectId,
      name: 'parallel',
      createdBy: ids.userId,
    })
    const first = await evaluation()
    const second = await evaluation('queued', secondProjectId)
    const results = await Promise.all([
      database.transaction((tx) => reserveCoordinationUsage(tx, reservation(first.id))),
      database.transaction((tx) =>
        reserveCoordinationUsage(
          tx,
          reservation(second.id, { projectId: secondProjectId, workKey: randomUUID() }),
        ),
      ),
    ])
    expect(results.filter(Boolean)).toHaveLength(1)
    expect(await database.db.select().from(schema.coordinationUsageLedger)).toHaveLength(1)
    const [team] = await database.db
      .select()
      .from(schema.coordinationBudgets)
      .where(eq(schema.coordinationBudgets.scope, 'team'))
    expect(team?.calls).toBe(1)
  })
  it('rolls back ledger and all budgets with the dispatch transaction', async () => {
    const row = await evaluation()
    await expect(
      database.transaction(async (tx) => {
        expect(await reserveCoordinationUsage(tx, reservation(row.id))).toBe(true)
        throw new Error('dispatch aborted')
      }),
    ).rejects.toThrow('dispatch aborted')
    expect(await database.db.select().from(schema.coordinationUsageLedger)).toHaveLength(0)
    expect(await database.db.select().from(schema.coordinationBudgets)).toHaveLength(0)
    expect(
      await database.transaction((tx) => reserveCoordinationUsage(tx, reservation(row.id))),
    ).toBe(true)
  })

  it('settles once using reservation UTC date and preserves actual overspend', async () => {
    const row = await evaluation()
    await database.transaction((tx) => reserveCoordinationUsage(tx, reservation(row.id)))
    const usage = {
      inputTokens: 110,
      outputTokens: 20,
      costMicros: 70,
      provider: 'test',
      model: 'model',
    }
    expect(
      await database.transaction((tx) =>
        settleCoordinationUsage(tx, { evaluationId: row.id, attempt: 1, usage, zeroCharge: false }),
      ),
    ).toBe(true)
    expect(
      await database.transaction((tx) =>
        settleCoordinationUsage(tx, { evaluationId: row.id, attempt: 1, usage, zeroCharge: false }),
      ),
    ).toBe(false)
    const budgets = await database.db.select().from(schema.coordinationBudgets)
    expect(
      budgets.every(
        (r) =>
          r.reservedTokens === 0 &&
          r.reservedCostMicros === 0 &&
          r.inputTokens === 110 &&
          r.outputTokens === 20 &&
          r.costMicros === 70,
      ),
    ).toBe(true)
    const ledger = await database.db
      .select()
      .from(schema.coordinationUsageLedger)
      .where(eq(schema.coordinationUsageLedger.phase, 'settled'))
    expect(ledger[0]?.utcDate).toBe('2026-11-04')
    expect(ledger[0]?.chargeMode).toBe('actual')
  })
  it('charges unknown crash usage conservatively; explicit pre-model failure is zero', async () => {
    const row = await evaluation()
    await database.transaction((tx) => reserveCoordinationUsage(tx, reservation(row.id)))
    await database.transaction((tx) =>
      settleCoordinationUsage(tx, { evaluationId: row.id, attempt: 1, zeroCharge: false }),
    )
    const work = await database.db
      .select()
      .from(schema.coordinationBudgets)
      .where(
        and(
          eq(schema.coordinationBudgets.scope, 'work'),
          eq(schema.coordinationBudgets.scopeId, ids.taskId),
        ),
      )
    expect(work[0]?.inputTokens).toBe(100)
    expect(work[0]?.costMicros).toBe(50)
    const other = await evaluation('dispatched')
    await database.transaction((tx) =>
      reserveCoordinationUsage(tx, reservation(other.id, { utcDate: '2026-11-05' })),
    )
    await database.transaction((tx) =>
      settleCoordinationUsage(tx, { evaluationId: other.id, attempt: 1, zeroCharge: true }),
    )
    const ledger = await database.db
      .select()
      .from(schema.coordinationUsageLedger)
      .where(
        and(
          eq(schema.coordinationUsageLedger.evaluationId, other.id),
          eq(schema.coordinationUsageLedger.phase, 'settled'),
        ),
      )
    expect(ledger[0]?.chargeMode).toBe('zero')
  })
  it('keeps lifetime work spend and shared retry limits across dates', async () => {
    const row = await evaluation()
    await database.transaction((tx) =>
      reserveCoordinationUsage(tx, reservation(row.id, { retry: true })),
    )
    await database.transaction((tx) =>
      settleCoordinationUsage(tx, { evaluationId: row.id, attempt: 1, zeroCharge: true }),
    )
    const other = await evaluation('dispatched')
    expect(
      await database.transaction((tx) =>
        reserveCoordinationUsage(tx, reservation(other.id, { utcDate: '2026-11-05', retry: true })),
      ),
    ).toBe(false)
  })
})
