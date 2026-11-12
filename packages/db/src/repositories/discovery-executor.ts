import { and, asc, eq, gt, inArray, isNull, sql } from 'drizzle-orm'
import type { DbHandle, Tx } from '../client.js'
import {
  discoveryApplications,
  discoveryExecutions,
  discoveryPermits,
  discoverySlots,
} from '../schema/discovery.js'
import {
  discoveryExecutorAttempts as attempts,
  discoveryExecutorDispatches as dispatches,
  discoveryExecutorParentBudgets as parents,
  type DiscoveryExecutorAttemptRow,
  type DiscoveryExecutorDispatchPolicy,
  type DiscoveryExecutorDispatchRow,
  type DiscoveryExecutorLimits,
} from '../schema/discovery-executor.js'
import {
  coordinationBudgets as budgets,
  coordinationTeamPolicies,
  routerConfigurations,
} from '../schema/router.js'
import { runs } from '../schema/run.js'
import { works } from '../schema/work.js'

export type {
  DiscoveryExecutorAttemptRow,
  DiscoveryExecutorAttemptState,
  DiscoveryExecutorDispatchPolicy,
  DiscoveryExecutorDispatchRow,
  DiscoveryExecutorLimits,
  DiscoveryExecutorParentBudgetRow,
} from '../schema/discovery-executor.js'

const digest = /^[a-f0-9]{64}$/
const positive = (n: number): boolean => Number.isSafeInteger(n) && n > 0
const nonnegative = (n: number): boolean => Number.isSafeInteger(n) && n >= 0
const microsDivisor = 1_000_000n

function validLimits(limits: DiscoveryExecutorLimits | undefined): boolean {
  return (
    !!limits && positive(limits.calls) && positive(limits.tokens) && positive(limits.costMicros)
  )
}

function validPolicy(policy: DiscoveryExecutorDispatchPolicy): boolean {
  return (
    [policy.parent, policy.team, policy.project, policy.work].every(validLimits) &&
    positive(policy.parent.dispatches) &&
    positive(policy.maxInputTokens) &&
    positive(policy.maxOutputTokens) &&
    positive(policy.inputPriceMicrosPerMillionTokens) &&
    positive(policy.outputPriceMicrosPerMillionTokens) &&
    policy.work.calls <= policy.parent.calls &&
    policy.work.tokens <= policy.parent.tokens &&
    policy.work.costMicros <= policy.parent.costMicros
  )
}

/** Only the fixed, numeric policy fields enter the ledger snapshot. */
function snapshotPolicy(input: DiscoveryExecutorDispatchPolicy): DiscoveryExecutorDispatchPolicy {
  const limits = ({
    calls,
    tokens,
    costMicros,
  }: DiscoveryExecutorLimits): DiscoveryExecutorLimits => ({
    calls,
    tokens,
    costMicros,
  })
  return {
    parent: { ...limits(input.parent), dispatches: input.parent.dispatches },
    team: limits(input.team),
    project: limits(input.project),
    work: limits(input.work),
    maxInputTokens: input.maxInputTokens,
    maxOutputTokens: input.maxOutputTokens,
    inputPriceMicrosPerMillionTokens: input.inputPriceMicrosPerMillionTokens,
    outputPriceMicrosPerMillionTokens: input.outputPriceMicrosPerMillionTokens,
  }
}

function costFor(
  inputTokens: number,
  outputTokens: number,
  policy: DiscoveryExecutorDispatchPolicy,
): number | undefined {
  if (!nonnegative(inputTokens) || !nonnegative(outputTokens)) return undefined
  const numerator =
    BigInt(inputTokens) * BigInt(policy.inputPriceMicrosPerMillionTokens) +
    BigInt(outputTokens) * BigInt(policy.outputPriceMicrosPerMillionTokens)
  const value = Number((numerator + microsDivisor - 1n) / microsDivisor)
  return nonnegative(value) ? value : undefined
}

export function getDiscoveryExecutorDispatch(handle: DbHandle, runId: string) {
  return handle
    .select()
    .from(dispatches)
    .where(eq(dispatches.runId, runId))
    .then(([row]) => row)
}

export function getDiscoveryExecutorAttempt(handle: DbHandle, runId: string, attemptId: string) {
  return handle
    .select()
    .from(attempts)
    .where(attemptKey(runId, attemptId))
    .then(([row]) => row)
}

export function listDiscoveryExecutorAttempts(handle: DbHandle, runId: string) {
  return handle
    .select()
    .from(attempts)
    .where(eq(attempts.runId, runId))
    .orderBy(asc(attempts.createdAt), asc(attempts.attemptId))
}

export function getDiscoveryExecutorParentBudget(handle: DbHandle, slotId: string) {
  return handle
    .select()
    .from(parents)
    .where(eq(parents.slotId, slotId))
    .then(([row]) => row)
}

export interface RecordDiscoveryExecutorDispatchInput {
  readonly runId: string
  readonly executionId: string
  readonly teamId: string
  readonly routeDigest: string
  readonly policyGeneration: number
  readonly sourceGrantsDigest: string
  readonly policy: DiscoveryExecutorDispatchPolicy
  readonly now: Date
}

type DispatchDenial =
  | 'invalid_policy'
  | 'invalid_binding'
  | 'parent_budget_exhausted'
  | 'parent_egress_blocked'
  | 'dispatch_exists'
type DispatchResult =
  | { readonly ok: true; readonly dispatch: DiscoveryExecutorDispatchRow }
  | { readonly ok: false; readonly reason: DispatchDenial }

/**
 * Called in the same authorized transaction as creating the Run and its outbox.
 * A denied result must abort that transaction. Count accepted dispatches, never
 * charge a model call here; the discovery coordinator lifetime budget stays separate.
 */
export async function recordDiscoveryExecutorDispatch(
  tx: Tx,
  input: RecordDiscoveryExecutorDispatchInput,
): Promise<DispatchResult> {
  if (!validPolicy(input.policy) || !Number.isFinite(input.now.getTime()))
    return { ok: false, reason: 'invalid_policy' }
  if (
    !digest.test(input.routeDigest) ||
    !digest.test(input.sourceGrantsDigest) ||
    !positive(input.policyGeneration) ||
    input.policyGeneration > 2_147_483_647
  )
    return { ok: false, reason: 'invalid_binding' }
  const [binding] = await tx
    .select({
      projectId: discoveryExecutions.projectId,
      slotId: discoverySlots.id,
      permitId: discoveryPermits.id,
      permitVersion: discoveryPermits.version,
      workId: works.id,
      workKey: works.workKey,
    })
    .from(discoveryExecutions)
    .innerJoin(
      runs,
      and(
        eq(runs.id, input.runId),
        eq(runs.discoveryExecutionId, discoveryExecutions.id),
        eq(runs.taskId, discoveryExecutions.taskId),
        eq(runs.ownerUserId, discoveryExecutions.principalUserId),
      ),
    )
    .innerJoin(
      discoveryApplications,
      and(
        eq(discoveryApplications.id, discoveryExecutions.applicationId),
        eq(discoveryApplications.projectId, discoveryExecutions.projectId),
        eq(discoveryApplications.taskId, runs.taskId),
        eq(discoveryApplications.workId, discoveryExecutions.workId),
        eq(discoveryApplications.permitId, discoveryExecutions.parentPermitId),
        eq(discoveryApplications.permitVersion, discoveryExecutions.parentPermitVersion),
        eq(discoveryApplications.status, 'applied'),
      ),
    )
    .innerJoin(
      discoveryPermits,
      and(
        eq(discoveryPermits.id, discoveryExecutions.parentPermitId),
        eq(discoveryPermits.principalUserId, discoveryExecutions.principalUserId),
        eq(discoveryPermits.projectId, discoveryExecutions.projectId),
        eq(discoveryPermits.version, discoveryExecutions.parentPermitVersion),
        eq(discoveryPermits.slotId, discoveryApplications.slotId),
        eq(discoveryPermits.tier, 'execute'),
        eq(discoveryPermits.executorLimits, snapshotPolicy(input.policy).parent),
      ),
    )
    .innerJoin(
      discoverySlots,
      and(
        eq(discoverySlots.id, discoveryPermits.slotId),
        eq(discoverySlots.projectId, discoveryExecutions.projectId),
      ),
    )
    .innerJoin(
      works,
      and(
        eq(works.id, discoveryExecutions.workId),
        eq(works.projectId, discoveryExecutions.projectId),
        eq(works.taskId, runs.taskId),
        eq(works.workKey, runs.workKey),
      ),
    )
    .where(
      and(
        eq(discoveryExecutions.id, input.executionId),
        eq(discoveryExecutions.executorDigest, input.routeDigest),
        eq(discoveryExecutions.executorPolicyGeneration, input.policyGeneration),
        isNull(discoveryExecutions.revokedAt),
        gt(discoveryExecutions.expiresAt, input.now),
        isNull(discoveryPermits.revokedAt),
        gt(discoveryPermits.expiresAt, input.now),
        eq(runs.status, 'queued'),
      ),
    )
  if (!binding) return { ok: false, reason: 'invalid_binding' }
  // The fresh Run and its dispatch are not visible to attempt transactions before commit.
  const [dispatch] = await tx
    .insert(dispatches)
    .values({
      ...binding,
      runId: input.runId,
      executionId: input.executionId,
      teamId: input.teamId,
      routeDigest: input.routeDigest,
      policyGeneration: input.policyGeneration,
      sourceGrantsDigest: input.sourceGrantsDigest,
      policy: snapshotPolicy(input.policy),
      createdAt: input.now,
    })
    .onConflictDoNothing()
    .returning()
  if (!dispatch) return { ok: false, reason: 'dispatch_exists' }
  await tx
    .insert(parents)
    .values({ slotId: binding.slotId, projectId: binding.projectId })
    .onConflictDoNothing()
  const [parent] = await tx
    .select()
    .from(parents)
    .where(eq(parents.slotId, binding.slotId))
    .for('update')
  if (!parent || parent.projectId !== binding.projectId)
    throw new Error('discovery executor parent binding missing')
  if (parent.egressBlockedAt || parent.dispatches >= input.policy.parent.dispatches) {
    // A failed repository call may not accidentally commit an uncounted live dispatch.
    await tx.delete(dispatches).where(eq(dispatches.runId, input.runId))
    return {
      ok: false,
      reason: parent.egressBlockedAt ? 'parent_egress_blocked' : 'parent_budget_exhausted',
    }
  }
  await tx
    .update(parents)
    .set({ dispatches: sql`${parents.dispatches} + 1` })
    .where(eq(parents.slotId, binding.slotId))
  return { ok: true, dispatch }
}

export interface ClaimDiscoveryExecutorAttemptInput {
  readonly runId: string
  readonly attemptId: string
  readonly requestDigest: string
  readonly requestBytes: number
  readonly inputUpperBound: number
  readonly outputUpperBound: number
  readonly now: Date
}

type ClaimDenial =
  | 'invalid_request'
  | 'dispatch_missing'
  | 'attempt_already_claimed'
  | 'attempt_binding_changed'
  | 'attempt_unsettled'
  | 'request_already_claimed'
  | 'request_exceeds_ceiling'
  | 'budget_policy_missing'
  | 'budget_exhausted'
  | 'parent_egress_blocked'
type ClaimResult =
  | { readonly ok: true; readonly attempt: DiscoveryExecutorAttemptRow }
  | { readonly ok: false; readonly reason: ClaimDenial }

type BudgetScope = {
  readonly scope: 'team' | 'project' | 'work'
  readonly id: string
  readonly date: string
}
function scopesFor(dispatch: DiscoveryExecutorDispatchRow, date: string): BudgetScope[] {
  return [
    { scope: 'team', id: dispatch.teamId, date },
    { scope: 'project', id: dispatch.projectId, date },
    { scope: 'work', id: dispatch.workKey, date: 'lifetime' },
  ]
}

function budgetKey(scope: BudgetScope) {
  return and(
    eq(budgets.scope, scope.scope),
    eq(budgets.scopeId, scope.id),
    eq(budgets.utcDate, scope.date),
  )
}

function attemptKey(runId: string, attemptId: string) {
  return and(eq(attempts.runId, runId), eq(attempts.attemptId, attemptId))
}

function lowerLimits(
  frozen: DiscoveryExecutorLimits,
  live: DiscoveryExecutorLimits,
): DiscoveryExecutorLimits {
  return {
    calls: Math.min(frozen.calls, live.calls),
    tokens: Math.min(frozen.tokens, live.tokens),
    costMicros: Math.min(frozen.costMicros, live.costMicros),
  }
}

function canReserve(
  row: {
    calls: number
    inputTokens: number
    outputTokens: number
    reservedTokens: number
    costMicros: number
    reservedCostMicros: number
  },
  limits: DiscoveryExecutorLimits,
  tokens: number,
  costMicros: number,
): boolean {
  const values = [
    row.calls,
    row.inputTokens,
    row.outputTokens,
    row.reservedTokens,
    row.costMicros,
    row.reservedCostMicros,
  ]
  if (!values.every(nonnegative)) return false
  return (
    row.calls < limits.calls &&
    BigInt(row.inputTokens) +
      BigInt(row.outputTokens) +
      BigInt(row.reservedTokens) +
      BigInt(tokens) <=
      BigInt(limits.tokens) &&
    BigInt(row.costMicros) + BigInt(row.reservedCostMicros) + BigInt(costMicros) <=
      BigInt(limits.costMicros)
  )
}

/**
 * The caller must have revalidated and locked the live authority first. Only a
 * freshly inserted held attempt grants I/O, after commit. A lost response does
 * not make this operation replayable; the held amount already covers uncertainty.
 */
export async function claimDiscoveryExecutorAttempt(
  tx: Tx,
  input: ClaimDiscoveryExecutorAttemptInput,
): Promise<ClaimResult> {
  if (
    !digest.test(input.requestDigest) ||
    !positive(input.requestBytes) ||
    input.requestBytes > 2_147_483_647 ||
    !positive(input.inputUpperBound) ||
    !positive(input.outputUpperBound) ||
    !Number.isFinite(input.now.getTime())
  )
    return { ok: false, reason: 'invalid_request' }
  const [dispatch] = await tx
    .select()
    .from(dispatches)
    .where(eq(dispatches.runId, input.runId))
    .for('update')
  if (!dispatch) return { ok: false, reason: 'dispatch_missing' }
  const existing = await getDiscoveryExecutorAttempt(tx, input.runId, input.attemptId)
  if (existing)
    return {
      ok: false,
      reason:
        existing.requestDigest === input.requestDigest &&
        existing.requestBytes === input.requestBytes &&
        existing.maxInputTokens === input.inputUpperBound &&
        existing.maxOutputTokens === input.outputUpperBound
          ? 'attempt_already_claimed'
          : 'attempt_binding_changed',
    }
  const [open] = await tx
    .select({ id: attempts.attemptId })
    .from(attempts)
    .where(and(eq(attempts.runId, input.runId), inArray(attempts.state, ['held', 'unknown'])))
    .limit(1)
  if (open) return { ok: false, reason: 'attempt_unsettled' }
  const [duplicate] = await tx
    .select({ id: attempts.attemptId })
    .from(attempts)
    .where(and(eq(attempts.runId, input.runId), eq(attempts.requestDigest, input.requestDigest)))
    .limit(1)
  if (duplicate) return { ok: false, reason: 'request_already_claimed' }
  const policy = dispatch.policy
  if (!validPolicy(policy)) return { ok: false, reason: 'budget_policy_missing' }
  const tokens = input.inputUpperBound + input.outputUpperBound
  const cost = costFor(input.inputUpperBound, input.outputUpperBound, policy)
  if (
    input.inputUpperBound > policy.maxInputTokens ||
    input.outputUpperBound > policy.maxOutputTokens ||
    !positive(tokens) ||
    cost === undefined
  )
    return { ok: false, reason: 'request_exceeds_ceiling' }

  // Existing coordination code acquires current Team policy before shared daily
  // counters. Router configuration writes Project config before this lock, so
  // take an unlocked snapshot of Project config only after acquiring Team policy.
  const [team] = await tx
    .select()
    .from(coordinationTeamPolicies)
    .where(eq(coordinationTeamPolicies.teamId, dispatch.teamId))
    .for('update')
  const [project] = await tx
    .select()
    .from(routerConfigurations)
    .where(eq(routerConfigurations.projectId, dispatch.projectId))
  if (!team || !project) return { ok: false, reason: 'budget_policy_missing' }
  const limits = {
    team: lowerLimits(policy.team, {
      calls: team.dailyCallLimit,
      tokens: team.dailyTokenLimit,
      costMicros: team.dailyCostMicrosLimit,
    }),
    project: lowerLimits(policy.project, {
      calls: project.projectDailyCallLimit,
      tokens: project.projectDailyTokenLimit,
      costMicros: project.projectDailyCostMicrosLimit,
    }),
    work: policy.work,
  }
  if (!Object.values(limits).every(validLimits))
    return { ok: false, reason: 'budget_policy_missing' }
  const utcDate = input.now.toISOString().slice(0, 10)
  const scopes = scopesFor(dispatch, utcDate)
  for (const scope of scopes) {
    await tx
      .insert(budgets)
      .values({ scope: scope.scope, scopeId: scope.id, utcDate: scope.date })
      .onConflictDoNothing()
    const [row] = await tx.select().from(budgets).where(budgetKey(scope)).for('update')
    if (!row) throw new Error('discovery executor budget missing after insert')
    if (!canReserve(row, limits[scope.scope], tokens, cost))
      return { ok: false, reason: 'budget_exhausted' }
  }
  const [parent] = await tx
    .select()
    .from(parents)
    .where(eq(parents.slotId, dispatch.slotId))
    .for('update')
  if (!parent || parent.projectId !== dispatch.projectId)
    throw new Error('discovery executor parent budget missing')
  if (parent.egressBlockedAt) return { ok: false, reason: 'parent_egress_blocked' }
  if (!canReserve(parent, policy.parent, tokens, cost))
    return { ok: false, reason: 'budget_exhausted' }
  const [attempt] = await tx
    .insert(attempts)
    .values({
      runId: input.runId,
      attemptId: input.attemptId,
      requestDigest: input.requestDigest,
      requestBytes: input.requestBytes,
      utcDate,
      maxInputTokens: input.inputUpperBound,
      maxOutputTokens: input.outputUpperBound,
      reservedCostMicros: cost,
      state: 'held',
      createdAt: input.now,
    })
    .returning()
  if (!attempt) throw new Error('discovery executor attempt insert returned no row')
  for (const scope of scopes) {
    await tx
      .update(budgets)
      .set({
        calls: sql`${budgets.calls} + 1`,
        reservedTokens: sql`${budgets.reservedTokens} + ${tokens}`,
        reservedCostMicros: sql`${budgets.reservedCostMicros} + ${cost}`,
      })
      .where(budgetKey(scope))
  }
  await tx
    .update(parents)
    .set({
      calls: sql`${parents.calls} + 1`,
      reservedTokens: sql`${parents.reservedTokens} + ${tokens}`,
      reservedCostMicros: sql`${parents.reservedCostMicros} + ${cost}`,
    })
    .where(eq(parents.slotId, dispatch.slotId))
  return { ok: true, attempt }
}

export type DiscoveryExecutorAttemptOutcome =
  | {
      readonly kind: 'actual'
      readonly inputTokens: number
      readonly outputTokens: number
      readonly responseIdDigest?: string
    }
  | { readonly kind: 'confirmed_missing_usage' }
  | { readonly kind: 'proven_not_sent' }
  | { readonly kind: 'unknown' }

export interface SettleDiscoveryExecutorAttemptInput {
  readonly runId: string
  readonly attemptId: string
  readonly outcome: DiscoveryExecutorAttemptOutcome
  readonly now: Date
}

type SettleResult =
  | {
      readonly status: 'applied' | 'duplicate' | 'conflict'
      readonly attempt: DiscoveryExecutorAttemptRow
    }
  | { readonly status: 'missing' }

/**
 * Record trusted egress facts even if the Run has since been cancelled or its
 * sources revoked. Never release ambiguous reservations. Both claim and settle
 * lock dispatch → attempt → Team/Project/Work rows → stable parent, and neither
 * settlement nor the budget update locks or mutates Run rows.
 */
export async function settleDiscoveryExecutorAttempt(
  tx: Tx,
  input: SettleDiscoveryExecutorAttemptInput,
): Promise<SettleResult> {
  const [dispatch] = await tx
    .select()
    .from(dispatches)
    .where(eq(dispatches.runId, input.runId))
    .for('update')
  if (!dispatch) return { status: 'missing' }
  const [attempt] = await tx
    .select()
    .from(attempts)
    .where(attemptKey(input.runId, input.attemptId))
    .for('update')
  if (!attempt) return { status: 'missing' }
  const outcome = input.outcome
  if (
    outcome.kind === 'actual' &&
    (!positive(outcome.inputTokens) || !positive(outcome.outputTokens))
  )
    return { status: 'conflict', attempt }
  if (outcome.kind === 'unknown') {
    if (attempt.state === 'unknown') return { status: 'duplicate', attempt }
    if (attempt.state !== 'held') return { status: 'conflict', attempt }
    const [updated] = await tx
      .update(attempts)
      .set({ state: 'unknown' })
      .where(attemptKey(input.runId, input.attemptId))
      .returning()
    if (!updated) throw new Error('discovery executor attempt disappeared')
    return { status: 'applied', attempt: updated }
  }

  const state =
    outcome.kind === 'actual'
      ? 'actual'
      : outcome.kind === 'confirmed_missing_usage'
        ? 'estimated'
        : 'unsent'
  const inputTokens =
    outcome.kind === 'actual'
      ? outcome.inputTokens
      : state === 'estimated'
        ? attempt.maxInputTokens
        : 0
  const outputTokens =
    outcome.kind === 'actual'
      ? outcome.outputTokens
      : state === 'estimated'
        ? attempt.maxOutputTokens
        : 0
  const responseIdDigest = outcome.kind === 'actual' ? (outcome.responseIdDigest ?? null) : null
  const cost = costFor(inputTokens, outputTokens, dispatch.policy)
  if (
    cost === undefined ||
    (responseIdDigest !== null && !digest.test(responseIdDigest)) ||
    !Number.isFinite(input.now.getTime())
  )
    return { status: 'conflict', attempt }
  if (attempt.state !== 'held' && attempt.state !== 'unknown')
    return {
      status:
        attempt.state === state &&
        attempt.inputTokens === inputTokens &&
        attempt.outputTokens === outputTokens &&
        attempt.costMicros === cost &&
        attempt.responseIdDigest === responseIdDigest
          ? 'duplicate'
          : 'conflict',
      attempt,
    }
  const overage =
    state === 'actual' &&
    (inputTokens > attempt.maxInputTokens ||
      outputTokens > attempt.maxOutputTokens ||
      cost > attempt.reservedCostMicros)
  const reservedTokens = attempt.maxInputTokens + attempt.maxOutputTokens
  const [updated] = await tx
    .update(attempts)
    .set({
      state,
      inputTokens,
      outputTokens,
      costMicros: cost,
      responseIdDigest,
      overage,
      settledAt: input.now,
    })
    .where(attemptKey(input.runId, input.attemptId))
    .returning()
  if (!updated) throw new Error('discovery executor attempt disappeared')
  for (const scope of scopesFor(dispatch, attempt.utcDate)) {
    const [row] = await tx
      .update(budgets)
      .set({
        reservedTokens: sql`${budgets.reservedTokens} - ${reservedTokens}`,
        reservedCostMicros: sql`${budgets.reservedCostMicros} - ${attempt.reservedCostMicros}`,
        inputTokens: sql`${budgets.inputTokens} + ${inputTokens}`,
        outputTokens: sql`${budgets.outputTokens} + ${outputTokens}`,
        costMicros: sql`${budgets.costMicros} + ${cost}`,
      })
      .where(budgetKey(scope))
      .returning({ id: budgets.scopeId })
    if (!row) throw new Error('discovery executor settlement budget missing')
  }
  const [parent] = await tx
    .update(parents)
    .set({
      reservedTokens: sql`${parents.reservedTokens} - ${reservedTokens}`,
      reservedCostMicros: sql`${parents.reservedCostMicros} - ${attempt.reservedCostMicros}`,
      inputTokens: sql`${parents.inputTokens} + ${inputTokens}`,
      outputTokens: sql`${parents.outputTokens} + ${outputTokens}`,
      costMicros: sql`${parents.costMicros} + ${cost}`,
      ...(overage
        ? {
            egressBlockedAt: sql`coalesce(${parents.egressBlockedAt}, ${input.now.toISOString()}::timestamptz)`,
          }
        : {}),
    })
    .where(and(eq(parents.slotId, dispatch.slotId), eq(parents.projectId, dispatch.projectId)))
    .returning({ id: parents.slotId })
  if (!parent) throw new Error('discovery executor settlement parent budget missing')
  return { status: 'applied', attempt: updated }
}
