import { randomUUID } from 'node:crypto'
import { and, asc, desc, eq, inArray, sql } from 'drizzle-orm'
import type { CoordinationUsage } from '@whalepod/protocol'
import type { DbHandle } from '../client.js'
import { coordinationEvaluations } from '../schema/coordination.js'
import {
  coordinationBudgets,
  coordinationUsageLedger,
  routerConfigurations,
  coordinationTeamPolicies,
} from '../schema/router.js'
export type {
  RouterConfigRow,
  CoordinationBudgetRow,
  CoordinationLedgerRow,
  CoordinationTeamPolicyRow,
} from '../schema/router.js'

export async function configureRouter(
  handle: DbHandle,
  values: typeof routerConfigurations.$inferInsert & { readonly teamId: string },
) {
  const { teamId, ...configuration } = values
  const [row] = await handle
    .insert(routerConfigurations)
    .values(configuration)
    .onConflictDoUpdate({
      target: routerConfigurations.projectId,
      set: { ...configuration, updatedAt: new Date() },
    })
    .returning()
  if (row === undefined) throw new Error('router configuration insert returned no row')
  await handle
    .insert(coordinationTeamPolicies)
    .values({
      teamId,
      dailyCallLimit: row.teamDailyCallLimit,
      dailyTokenLimit: row.teamDailyTokenLimit,
      dailyCostMicrosLimit: row.teamDailyCostMicrosLimit,
      updatedByUserId: row.configuredByUserId,
    })
    .onConflictDoUpdate({
      target: coordinationTeamPolicies.teamId,
      set: {
        dailyCallLimit: row.teamDailyCallLimit,
        dailyTokenLimit: row.teamDailyTokenLimit,
        dailyCostMicrosLimit: row.teamDailyCostMicrosLimit,
        version: sql`${coordinationTeamPolicies.version}+1`,
        updatedByUserId: row.configuredByUserId,
        updatedAt: new Date(),
      },
    })
  return row
}
export async function getRouterConfig(handle: DbHandle, projectId: string) {
  const [row] = await handle
    .select()
    .from(routerConfigurations)
    .where(eq(routerConfigurations.projectId, projectId))
  return row
}

/** Work lifetime identity survives new inputs, model configs and Mandate versions. */
export async function countChargedRouterFailuresForWork(
  handle: DbHandle,
  workKey: string,
): Promise<number> {
  const [row] = await handle
    .select({ value: sql<number>`count(*)::int` })
    .from(coordinationEvaluations)
    .where(
      and(
        eq(coordinationEvaluations.purpose, 'router'),
        eq(coordinationEvaluations.workKey, workKey),
        inArray(coordinationEvaluations.status, ['failed', 'cancelled', 'stale']),
        eq(coordinationEvaluations.preModelFailureConfirmed, false),
        sql`${coordinationEvaluations.reservedTokens} is not null`,
      ),
    )
  return row?.value ?? 0
}

export async function getWorkCoordinationBudget(handle: DbHandle, workKey: string) {
  const [row] = await handle
    .select()
    .from(coordinationBudgets)
    .where(
      and(
        eq(coordinationBudgets.scope, 'work'),
        eq(coordinationBudgets.scopeId, workKey),
        eq(coordinationBudgets.utcDate, 'lifetime'),
      ),
    )
  return row
}
export async function getRouterConfigForUpdate(handle: DbHandle, projectId: string) {
  const [row] = await handle
    .select()
    .from(routerConfigurations)
    .where(eq(routerConfigurations.projectId, projectId))
    .for('update')
  return row
}
export async function findRouterEvaluationByDigest(
  handle: DbHandle,
  projectId: string,
  evaluationDigest: string,
) {
  const [row] = await handle
    .select()
    .from(coordinationEvaluations)
    .where(
      and(
        eq(coordinationEvaluations.projectId, projectId),
        eq(coordinationEvaluations.purpose, 'router'),
        eq(coordinationEvaluations.evaluationDigest, evaluationDigest),
      ),
    )
    .orderBy(desc(coordinationEvaluations.attempt))
    .limit(1)
  return row
}
export async function findQueuedRouterEvaluationForUpdate(
  handle: DbHandle,
  projectId: string,
  workKey: string,
) {
  const [row] = await handle
    .select()
    .from(coordinationEvaluations)
    .where(
      and(
        eq(coordinationEvaluations.projectId, projectId),
        eq(coordinationEvaluations.purpose, 'router'),
        eq(coordinationEvaluations.workKey, workKey),
        eq(coordinationEvaluations.status, 'queued'),
      ),
    )
    .for('update')
  return row
}
export async function listRouterEvaluations(handle: DbHandle, workKey: string, limit = 50) {
  return handle
    .select()
    .from(coordinationEvaluations)
    .where(
      and(
        eq(coordinationEvaluations.purpose, 'router'),
        eq(coordinationEvaluations.workKey, workKey),
      ),
    )
    .orderBy(desc(coordinationEvaluations.createdAt), desc(coordinationEvaluations.id))
    .limit(limit)
}
export async function listQueuedRouterEvaluations(handle: DbHandle, limit = 20) {
  return handle
    .select()
    .from(coordinationEvaluations)
    .where(
      and(
        eq(coordinationEvaluations.purpose, 'router'),
        eq(coordinationEvaluations.status, 'queued'),
      ),
    )
    .orderBy(asc(coordinationEvaluations.queuedAt), asc(coordinationEvaluations.id))
    .limit(limit)
}
export async function hasRunningCoordinationEvaluation(handle: DbHandle, projectId: string) {
  const [row] = await handle
    .select({ id: coordinationEvaluations.id })
    .from(coordinationEvaluations)
    .where(
      and(
        eq(coordinationEvaluations.projectId, projectId),
        inArray(coordinationEvaluations.status, ['dispatched', 'running']),
      ),
    )
    .limit(1)
  return row !== undefined
}

export interface CoordinationLimits {
  readonly calls: number
  readonly tokens: number
  readonly costMicros: number
}
export interface ReserveCoordinationUsageInput {
  readonly evaluationId: string
  readonly attempt: number
  readonly projectId: string
  readonly teamId: string
  readonly workKey: string
  readonly utcDate: string
  readonly reservedTokens: number
  readonly reservedCostMicros: number
  /** Compatibility hint only; the locked global team policy is authoritative. */
  readonly teamLimits: CoordinationLimits
  readonly projectLimits: CoordinationLimits
  readonly workLimits: {
    readonly tokens: number
    readonly costMicros: number
    readonly maxAttempts: number
  }
  readonly retry: boolean
  /** Existing Executor failures share maxAttempts until its own ledger is written. */
  readonly executorFailedAttempts?: number
}
const lifetimeDate = 'lifetime'
function key(scope: 'team' | 'project' | 'work', scopeId: string, utcDate: string) {
  return and(
    eq(coordinationBudgets.scope, scope),
    eq(coordinationBudgets.scopeId, scopeId),
    eq(coordinationBudgets.utcDate, utcDate),
  )
}

/** Caller must use a transaction; reservation and dispatch commit together. */
export async function reserveCoordinationUsage(
  handle: DbHandle,
  input: ReserveCoordinationUsageInput,
): Promise<boolean> {
  await handle
    .select({ id: coordinationEvaluations.id })
    .from(coordinationEvaluations)
    .where(eq(coordinationEvaluations.id, input.evaluationId))
    .for('update')
  const [existing] = await handle
    .select()
    .from(coordinationUsageLedger)
    .where(
      and(
        eq(coordinationUsageLedger.evaluationId, input.evaluationId),
        eq(coordinationUsageLedger.attempt, input.attempt),
        eq(coordinationUsageLedger.phase, 'reserved'),
      ),
    )
  if (existing !== undefined) return true
  if (
    !/^\d{4}-\d{2}-\d{2}$/.test(input.utcDate) ||
    !Number.isSafeInteger(input.reservedTokens) ||
    input.reservedTokens < 0 ||
    !Number.isSafeInteger(input.reservedCostMicros) ||
    input.reservedCostMicros < 0
  )
    throw new Error('invalid coordination reservation')
  const [teamPolicy] = await handle
    .select()
    .from(coordinationTeamPolicies)
    .where(eq(coordinationTeamPolicies.teamId, input.teamId))
    .for('update')
  if (teamPolicy === undefined) return false
  const scopes = [
    {
      scope: 'team' as const,
      id: input.teamId,
      date: input.utcDate,
      limits: {
        calls: teamPolicy.dailyCallLimit,
        tokens: teamPolicy.dailyTokenLimit,
        costMicros: teamPolicy.dailyCostMicrosLimit,
      },
    },
    {
      scope: 'project' as const,
      id: input.projectId,
      date: input.utcDate,
      limits: input.projectLimits,
    },
    {
      scope: 'work' as const,
      id: input.workKey,
      date: lifetimeDate,
      limits: {
        calls: Number.MAX_SAFE_INTEGER,
        tokens: input.workLimits.tokens,
        costMicros: input.workLimits.costMicros,
      },
    },
  ]
  for (const item of scopes) {
    await handle
      .insert(coordinationBudgets)
      .values({ scope: item.scope, scopeId: item.id, utcDate: item.date })
      .onConflictDoNothing()
    const [row] = await handle
      .select()
      .from(coordinationBudgets)
      .where(key(item.scope, item.id, item.date))
      .for('update')
    if (row === undefined) throw new Error('coordination budget missing after insert')
    if (
      row.calls + 1 > item.limits.calls ||
      row.inputTokens + row.outputTokens + row.reservedTokens + input.reservedTokens >
        item.limits.tokens ||
      row.costMicros + row.reservedCostMicros + input.reservedCostMicros > item.limits.costMicros
    )
      return false
    if (
      item.scope === 'work' &&
      row.retryAttempts + (input.retry ? 1 : 0) + (input.executorFailedAttempts ?? 0) >
        input.workLimits.maxAttempts
    )
      return false
  }
  const [reserved] = await handle
    .insert(coordinationUsageLedger)
    .values({
      id: randomUUID(),
      evaluationId: input.evaluationId,
      attempt: input.attempt,
      phase: 'reserved',
      projectId: input.projectId,
      teamId: input.teamId,
      workKey: input.workKey,
      utcDate: input.utcDate,
      reservedTokens: input.reservedTokens,
      reservedCostMicros: input.reservedCostMicros,
      retry: input.retry,
    })
    .onConflictDoNothing()
    .returning()
  if (reserved === undefined) return true
  for (const item of scopes)
    await handle
      .update(coordinationBudgets)
      .set({
        calls: sql`${coordinationBudgets.calls}+1`,
        retryAttempts: sql`${coordinationBudgets.retryAttempts}+${input.retry ? 1 : 0}`,
        reservedTokens: sql`${coordinationBudgets.reservedTokens}+${input.reservedTokens}`,
        reservedCostMicros: sql`${coordinationBudgets.reservedCostMicros}+${input.reservedCostMicros}`,
      })
      .where(key(item.scope, item.id, item.date))
  return true
}

/** Run in a separate committed transaction after result acceptance/rejection. */
export async function settleCoordinationUsage(
  handle: DbHandle,
  input: {
    readonly evaluationId: string
    readonly attempt: number
    readonly usage?: CoordinationUsage
    readonly zeroCharge: boolean
  },
): Promise<boolean> {
  await handle
    .select({ id: coordinationEvaluations.id })
    .from(coordinationEvaluations)
    .where(eq(coordinationEvaluations.id, input.evaluationId))
    .for('update')
  const [reserved] = await handle
    .select()
    .from(coordinationUsageLedger)
    .where(
      and(
        eq(coordinationUsageLedger.evaluationId, input.evaluationId),
        eq(coordinationUsageLedger.attempt, input.attempt),
        eq(coordinationUsageLedger.phase, 'reserved'),
      ),
    )
    .for('update')
  if (reserved === undefined) return false
  const [existing] = await handle
    .select()
    .from(coordinationUsageLedger)
    .where(
      and(
        eq(coordinationUsageLedger.evaluationId, input.evaluationId),
        eq(coordinationUsageLedger.attempt, input.attempt),
        eq(coordinationUsageLedger.phase, 'settled'),
      ),
    )
  if (existing !== undefined) return false
  const usage = input.zeroCharge ? undefined : input.usage
  const inputTokens = input.zeroCharge ? 0 : (usage?.inputTokens ?? reserved.reservedTokens)
  const outputTokens = input.zeroCharge ? 0 : (usage?.outputTokens ?? 0)
  const costMicros = input.zeroCharge ? 0 : (usage?.costMicros ?? reserved.reservedCostMicros)
  for (const value of [inputTokens, outputTokens, costMicros])
    if (!Number.isSafeInteger(value) || value < 0)
      throw new Error('invalid coordination settlement')
  const [settled] = await handle
    .insert(coordinationUsageLedger)
    .values({
      ...reserved,
      id: randomUUID(),
      phase: 'settled',
      usage: usage ?? null,
      chargeMode: input.zeroCharge ? 'zero' : usage === undefined ? 'reserved' : 'actual',
      createdAt: new Date(),
    })
    .onConflictDoNothing()
    .returning()
  if (settled === undefined) return false
  for (const item of [
    { scope: 'team' as const, id: reserved.teamId, date: reserved.utcDate },
    { scope: 'project' as const, id: reserved.projectId, date: reserved.utcDate },
    { scope: 'work' as const, id: reserved.workKey, date: lifetimeDate },
  ]) {
    const [row] = await handle
      .update(coordinationBudgets)
      .set({
        reservedTokens: sql`${coordinationBudgets.reservedTokens}-${reserved.reservedTokens}`,
        reservedCostMicros: sql`${coordinationBudgets.reservedCostMicros}-${reserved.reservedCostMicros}`,
        inputTokens: sql`${coordinationBudgets.inputTokens}+${inputTokens}`,
        outputTokens: sql`${coordinationBudgets.outputTokens}+${outputTokens}`,
        costMicros: sql`${coordinationBudgets.costMicros}+${costMicros}`,
      })
      .where(key(item.scope, item.id, item.date))
      .returning()
    if (row === undefined) throw new Error('coordination settlement budget missing')
  }
  return true
}
export async function listUnsettledCoordinationUsage(handle: DbHandle, limit = 100) {
  return handle
    .select()
    .from(coordinationUsageLedger)
    .where(
      and(
        eq(coordinationUsageLedger.phase, 'reserved'),
        sql`not exists(select 1 from coordination_usage_ledger s where s.evaluation_id=${coordinationUsageLedger.evaluationId} and s.attempt=${coordinationUsageLedger.attempt} and s.phase='settled')`,
      ),
    )
    .orderBy(asc(coordinationUsageLedger.createdAt))
    .limit(limit)
}

export async function getCoordinationTeamPolicy(handle: DbHandle, teamId: string) {
  const [row] = await handle
    .select()
    .from(coordinationTeamPolicies)
    .where(eq(coordinationTeamPolicies.teamId, teamId))
  return row
}
