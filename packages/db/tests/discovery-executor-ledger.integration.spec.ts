import { randomUUID } from 'node:crypto'
import { and, eq } from 'drizzle-orm'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import {
  claimDiscoveryExecutorAttempt,
  type Database,
  type DiscoveryExecutorAttemptOutcome,
  type DiscoveryExecutorDispatchPolicy,
  getDiscoveryExecutorDispatch,
  getDiscoveryExecutorParentBudget,
  insertRun,
  insertTask,
  listDiscoveryExecutorAttempts,
  recordDiscoveryExecutorDispatch,
  schema,
  settleDiscoveryExecutorAttempt,
} from '../src/index.js'
import {
  createTestDatabase,
  makeRunInput,
  resetDatabase,
  seedRunPrereqs,
  type SeedIds,
} from './helpers.js'

const reservedAt = new Date('2026-11-12T23:59:59.000Z')
const settledAt = new Date('2026-11-13T00:00:01.000Z')
const expiresAt = new Date('2026-11-14T00:00:00.000Z')
const utcDate = '2026-11-12'
const routeDigest = 'a'.repeat(64)
const sourceGrantsDigest = 'b'.repeat(64)
const sourceDigest = 'c'.repeat(64)
const requestDigest = 'd'.repeat(64)
const responseIdDigest = 'e'.repeat(64)
const template = {
  goal: 'Summarize the source',
  constraints: '',
  acceptance: '',
  openQuestions: '',
}
const limits = { calls: 20, tokens: 500, costMicros: 500 }
const policy: DiscoveryExecutorDispatchPolicy = {
  parent: { ...limits, dispatches: 1 },
  work: { calls: 10, tokens: 250, costMicros: 250 },
  team: limits,
  project: limits,
  maxInputTokens: 20,
  maxOutputTokens: 10,
  inputPriceMicrosPerMillionTokens: 500_000,
  outputPriceMicrosPerMillionTokens: 2_000_000,
}

describe('Discovery Executor durable accounting', () => {
  let database: Database
  let ids: SeedIds
  let slotId: string

  beforeAll(async () => {
    database = await createTestDatabase()
  })
  afterAll(async () => {
    await database.close()
  })
  beforeEach(async () => {
    await resetDatabase(database)
    ids = await seedRunPrereqs(database.db)
    slotId = randomUUID()
    await database.db.insert(schema.discoverySlots).values({
      id: slotId,
      projectId: ids.projectId,
      activity: 'monthly-report',
      slot: 'owner-notes',
      createdAt: reservedAt,
      updatedAt: reservedAt,
    })
    await database.db.insert(schema.coordinationTeamPolicies).values({
      teamId: ids.teamId,
      dailyCallLimit: limits.calls,
      dailyTokenLimit: limits.tokens,
      dailyCostMicrosLimit: limits.costMicros,
      updatedByUserId: ids.userId,
    })
    await database.db.insert(schema.routerConfigurations).values({
      projectId: ids.projectId,
      enabled: true,
      configVersion: 1,
      deviceId: ids.deviceId,
      operatorUserId: ids.userId,
      billingUserId: ids.userId,
      configuredByUserId: ids.userId,
      credentialSlot: 'fixture',
      credentialConfigRevision: 'fixture-revision',
      provider: 'fixture-provider',
      model: 'fixture-router',
      teamDailyCallLimit: limits.calls,
      teamDailyTokenLimit: limits.tokens,
      teamDailyCostMicrosLimit: limits.costMicros,
      projectDailyCallLimit: limits.calls,
      projectDailyTokenLimit: limits.tokens,
      projectDailyCostMicrosLimit: limits.costMicros,
      maxInputTokens: 50,
      maxOutputTokens: 50,
      maxCostMicros: 500,
      inputPriceMicrosPerMillionTokens: 1,
      outputPriceMicrosPerMillionTokens: 1,
      timeoutSeconds: 10,
      maxRetries: 0,
    })
  })

  // This repository test arranges the authority graph; the assembled acceptance
  // separately exercises the Hub authorization and Node/DSH provider path.
  async function fixture(permitVersion = 1) {
    const { db } = database
    const taskId = randomUUID()
    const sourceId = randomUUID()
    const evaluationId = randomUUID()
    const candidateId = randomUUID()
    const permitId = randomUUID()
    const applicationId = randomUUID()
    const executionId = randomUUID()
    const workId = randomUUID()
    const workKey = randomUUID()
    const specRevisionId = randomUUID()
    const mandateId = randomUUID()
    const dispatchIntentId = randomUUID()
    await insertTask(db, {
      id: taskId,
      projectId: ids.projectId,
      title: 'Derived task',
      createdBy: ids.userId,
      assigneeUserId: ids.userId,
      assignmentStatus: 'accepted',
      acceptedAt: reservedAt,
    })
    await db.insert(schema.taskMessages).values({
      id: sourceId,
      taskId: ids.taskId,
      authorUserId: ids.userId,
      body: 'Synthetic notes',
    })
    await db.insert(schema.coordinationEvaluations).values({
      id: evaluationId,
      projectId: ids.projectId,
      status: 'skipped',
      finishedAt: reservedAt,
      inputDigest: sourceDigest,
      rulesVersion: 'fixture',
      processorVersion: 'fixture',
      queueExpiresAt: expiresAt,
      attempt: permitVersion,
    })
    await db.insert(schema.discoveryAdmissions).values({
      sourceId,
      projectId: ids.projectId,
      entryTaskId: ids.taskId,
      sourceVersion: '1',
      sourceDigest,
      route: 'discovery',
      reason: 'fixture',
      entryGeneration: '1',
      configVersion: 1,
      permitVersion,
      authorVersion: 1,
      evaluationId,
      createdAt: reservedAt,
    })
    await db.insert(schema.discoveryCandidates).values({
      id: candidateId,
      evaluationId,
      projectId: ids.projectId,
      sourceId,
      sourceVersion: '1',
      principalUserId: ids.userId,
      createdAt: reservedAt,
      checkedAt: reservedAt,
      expiresAt,
      proposal: {
        classification: 'independent_gap',
        source: sourceId,
        slot: slotId,
        citations: [sourceId],
        reason: 'Fixture',
      },
    })
    await db.insert(schema.discoveryPermits).values({
      id: permitId,
      projectId: ids.projectId,
      slotId,
      configVersion: 1,
      version: permitVersion,
      principalUserId: ids.userId,
      entryTaskId: ids.taskId,
      tier: 'execute',
      templateVersion: '1',
      template,
      templateDigest: sourceDigest,
      maxCreations: 1,
      executorLimits: policy.parent,
      expiresAt,
      verifierUserIds: [ids.userId],
      confirmedAt: reservedAt,
    })
    await db.insert(schema.works).values({
      id: workId,
      projectId: ids.projectId,
      taskId,
      workKey,
      humanOwnerUserId: ids.userId,
      goal: template.goal,
    })
    await db.insert(schema.taskSpecRevisions).values({
      id: specRevisionId,
      taskId,
      status: 'derived',
      origin: 'preauthorized_template',
      content: template,
      createdBy: ids.userId,
    })
    await db.insert(schema.discoveryApplications).values({
      id: applicationId,
      candidateId,
      evaluationId,
      projectId: ids.projectId,
      slotId,
      permitId,
      permitVersion,
      sourceId,
      sourceVersion: '1',
      sourceDigest,
      taskId,
      workId,
      specRevisionId,
      verification: {
        kind: 'receipt',
        evidence: [],
        receiptIds: [],
        verifierUserIds: [ids.userId],
      },
      status: 'applied',
      appliedAt: reservedAt,
    })
    await db.insert(schema.discoveryExecutions).values({
      id: executionId,
      projectId: ids.projectId,
      applicationId,
      taskId,
      workId,
      principalUserId: ids.userId,
      parentPermitId: permitId,
      parentPermitVersion: permitVersion,
      purpose: 'private_draft',
      executorProvider: 'fixture-provider',
      executorModel: 'fixture-model',
      executorEndpoint: 'fixture-endpoint',
      executorAccount: 'fixture-account',
      executorPolicyGeneration: 1,
      executorDigest: routeDigest,
      sourceManifestDigest: sourceDigest,
      expiresAt,
      authorizedAt: reservedAt,
      createdAt: reservedAt,
    })
    await db.insert(schema.workMandates).values({
      id: mandateId,
      workId,
      workKey,
      projectId: ids.projectId,
      taskId,
      version: 1,
      status: 'active',
      principalUserId: ids.userId,
      onBehalfOfUserId: ids.userId,
      humanOwnerUserId: ids.userId,
      draftRecipientUserId: ids.userId,
      allowedActionClasses: ['draft'],
      allowedSourceTypes: ['task_message'],
      maxRunsPerWork: 1,
      maxTokens: policy.work.tokens,
      maxCostMicros: policy.work.costMicros,
      maxAttempts: 1,
      waitDeadlineSeconds: 1,
      expiresAt,
    })
    await db.insert(schema.dispatchIntents).values({
      id: dispatchIntentId,
      workId,
      workKey,
      projectId: ids.projectId,
      taskId,
      mandateId,
      mandateVersion: 1,
      status: 'proposed',
      authorizedByUserId: ids.userId,
      onBehalfOfUserId: ids.userId,
      inputDigest: sourceDigest,
      triggerRefs: [{ discoveryExecutionId: executionId }],
      reason: 'Discovery Executor accounting fixture',
      expiresAt,
    })
    const run = await insertRun(
      db,
      makeRunInput(
        { ...ids, taskId },
        {
          discoveryExecutionId: executionId,
          specRevisionId,
          workKey,
          workInputManifestDigest: sourceDigest,
          origin: 'mandate',
          resumeContext: 'blocked',
          mandateId,
          dispatchIntentId,
          onBehalfOfUserId: ids.userId,
          workInputManifest: {
            version: 'rd02a2.v1',
            workKey,
            entries: [
              {
                inboxItemId: randomUUID(),
                sourceType: 'discovery_source',
                sourceId,
                sourceVersion: '1',
                sourceDigest,
                bodyDigest: sourceDigest,
                byteSize: 15,
                authorizationGeneration: '1',
                title: 'Synthetic notes',
              },
            ],
          },
        },
      ),
    )
    return { runId: run.id, executionId, workKey, permitId }
  }

  function dispatch(f: { runId: string; executionId: string }, overrides = {}) {
    return database.transaction((tx) =>
      recordDiscoveryExecutorDispatch(tx, {
        runId: f.runId,
        executionId: f.executionId,
        teamId: ids.teamId,
        routeDigest,
        sourceGrantsDigest,
        policyGeneration: 1,
        policy,
        now: reservedAt,
        ...overrides,
      }),
    )
  }

  async function activeFixture() {
    const f = await fixture()
    expect(await dispatch(f)).toMatchObject({
      ok: true,
      dispatch: { runId: f.runId, slotId, policy },
    })
    return f
  }

  function claim(runId: string, attemptId = randomUUID(), overrides = {}) {
    return database.transaction((tx) =>
      claimDiscoveryExecutorAttempt(tx, {
        runId,
        attemptId,
        requestDigest,
        requestBytes: 20,
        inputUpperBound: 20,
        outputUpperBound: 10,
        now: reservedAt,
        ...overrides,
      }),
    )
  }

  function settle(runId: string, attemptId: string, outcome: DiscoveryExecutorAttemptOutcome) {
    return database.transaction((tx) =>
      settleDiscoveryExecutorAttempt(tx, {
        runId,
        attemptId,
        outcome,
        now: settledAt,
      }),
    )
  }

  async function counters(
    scope: 'team' | 'project' | 'work' | 'discovery',
    id: string,
    date: string,
  ) {
    const [row] = await database.db
      .select()
      .from(schema.coordinationBudgets)
      .where(
        and(
          eq(schema.coordinationBudgets.scope, scope),
          eq(schema.coordinationBudgets.scopeId, id),
          eq(schema.coordinationBudgets.utcDate, date),
        ),
      )
    return row
  }

  it('counts only one dispatch across permit versions for the same stable slot', async () => {
    const first = await fixture()
    const renewed = await fixture(2)
    await database.db.insert(schema.coordinationBudgets).values({
      scope: 'discovery',
      scopeId: ids.projectId,
      utcDate: 'lifetime',
      calls: 7,
    })
    await expect(dispatch(first, { routeDigest: responseIdDigest })).resolves.toEqual({
      ok: false,
      reason: 'invalid_binding',
    })
    await expect(
      dispatch(first, { policy: { ...policy, parent: { ...policy.parent, dispatches: 2 } } }),
    ).resolves.toEqual({
      ok: false,
      reason: 'invalid_binding',
    })
    const results = await Promise.all([dispatch(first), dispatch(renewed)])
    expect(results.filter(({ ok }) => ok)).toHaveLength(1)
    expect(results).toContainEqual({ ok: false, reason: 'parent_budget_exhausted' })
    const accepted = results[0]?.ok ? first : renewed
    const denied = results[0]?.ok ? renewed : first
    await expect(dispatch(accepted)).resolves.toEqual({ ok: false, reason: 'dispatch_exists' })
    await expect(getDiscoveryExecutorDispatch(database.db, denied.runId)).resolves.toBeUndefined()
    await expect(getDiscoveryExecutorParentBudget(database.db, slotId)).resolves.toMatchObject({
      dispatches: 1,
      calls: 0,
      reservedTokens: 0,
      costMicros: 0,
    })
    await expect(counters('discovery', ids.projectId, 'lifetime')).resolves.toMatchObject({
      calls: 7,
    })
  })

  it('grants one attempt, settles exactly on its UTC day, and preserves earlier shared usage', async () => {
    const f = await activeFixture()
    await database.db.insert(schema.coordinationBudgets).values({
      scope: 'team',
      scopeId: ids.teamId,
      utcDate,
      calls: 4,
      inputTokens: 8,
      outputTokens: 9,
      costMicros: 17,
      reservedTokens: 3,
      reservedCostMicros: 5,
    })
    const attemptId = randomUUID()
    const grants = await Promise.all([claim(f.runId, attemptId), claim(f.runId, attemptId)])
    expect(grants.filter(({ ok }) => ok)).toHaveLength(1)
    expect(grants).toContainEqual({ ok: false, reason: 'attempt_already_claimed' })
    await expect(claim(f.runId, attemptId, { requestBytes: 21 })).resolves.toEqual({
      ok: false,
      reason: 'attempt_binding_changed',
    })
    await expect(claim(f.runId)).resolves.toEqual({ ok: false, reason: 'attempt_unsettled' })
    await expect(getDiscoveryExecutorParentBudget(database.db, slotId)).resolves.toMatchObject({
      dispatches: 1,
      calls: 1,
      reservedTokens: 30,
      reservedCostMicros: 30,
      costMicros: 0,
    })
    // Billing facts still have to be reconciled after authorization has ended.
    await database.db
      .update(schema.discoveryExecutions)
      .set({ revokedAt: settledAt, revokedReason: 'fixture' })
      .where(eq(schema.discoveryExecutions.id, f.executionId))
    await database.db
      .update(schema.runs)
      .set({ status: 'cancelled', finishedAt: settledAt })
      .where(eq(schema.runs.id, f.runId))
    const usage = { kind: 'actual', inputTokens: 11, outputTokens: 7, responseIdDigest } as const
    await expect(settle(f.runId, attemptId, usage)).resolves.toMatchObject({
      status: 'applied',
      attempt: {
        state: 'actual',
        requestDigest,
        responseIdDigest,
        utcDate,
        inputTokens: 11,
        outputTokens: 7,
        costMicros: 20,
        settledAt,
        overage: false,
      },
    })
    await expect(settle(f.runId, attemptId, usage)).resolves.toMatchObject({ status: 'duplicate' })
    await expect(settle(f.runId, attemptId, { ...usage, inputTokens: 12 })).resolves.toMatchObject({
      status: 'conflict',
    })
    await expect(claim(f.runId, attemptId)).resolves.toEqual({
      ok: false,
      reason: 'attempt_already_claimed',
    })
    await expect(claim(f.runId)).resolves.toEqual({ ok: false, reason: 'request_already_claimed' })
    const charged = {
      calls: 1,
      inputTokens: 11,
      outputTokens: 7,
      costMicros: 20,
      reservedTokens: 0,
      reservedCostMicros: 0,
    }
    await expect(getDiscoveryExecutorParentBudget(database.db, slotId)).resolves.toMatchObject(
      charged,
    )
    await expect(counters('work', f.workKey, 'lifetime')).resolves.toMatchObject(charged)
    await expect(counters('project', ids.projectId, utcDate)).resolves.toMatchObject(charged)
    await expect(counters('team', ids.teamId, utcDate)).resolves.toMatchObject({
      calls: 5,
      inputTokens: 19,
      outputTokens: 16,
      costMicros: 37,
      reservedTokens: 3,
      reservedCostMicros: 5,
    })
    await expect(counters('team', ids.teamId, '2026-11-13')).resolves.toBeUndefined()
  })

  it('keeps uncertainty reserved, charges exact overage, and permanently blocks its parent slot', async () => {
    const f = await activeFixture()
    const attemptId = randomUUID()
    await expect(claim(f.runId, attemptId)).resolves.toMatchObject({ ok: true })
    await expect(settle(f.runId, attemptId, { kind: 'unknown' })).resolves.toMatchObject({
      status: 'applied',
      attempt: { state: 'unknown', settledAt: null },
    })
    await expect(settle(f.runId, attemptId, { kind: 'unknown' })).resolves.toMatchObject({
      status: 'duplicate',
    })
    await expect(claim(f.runId)).resolves.toEqual({ ok: false, reason: 'attempt_unsettled' })
    await expect(counters('work', f.workKey, 'lifetime')).resolves.toMatchObject({
      calls: 1,
      inputTokens: 0,
      outputTokens: 0,
      costMicros: 0,
      reservedTokens: 30,
      reservedCostMicros: 30,
    })
    await expect(
      settle(f.runId, attemptId, { kind: 'actual', inputTokens: 24, outputTokens: 10 }),
    ).resolves.toMatchObject({
      status: 'applied',
      attempt: { inputTokens: 24, costMicros: 32, overage: true },
    })
    await expect(counters('work', f.workKey, 'lifetime')).resolves.toMatchObject({
      calls: 1,
      inputTokens: 24,
      outputTokens: 10,
      costMicros: 32,
      reservedTokens: 0,
      reservedCostMicros: 0,
    })
    await expect(getDiscoveryExecutorParentBudget(database.db, slotId)).resolves.toMatchObject({
      egressBlockedAt: settledAt,
      inputTokens: 24,
      costMicros: 32,
    })
    await expect(claim(f.runId, randomUUID(), { requestDigest: 'f'.repeat(64) })).resolves.toEqual({
      ok: false,
      reason: 'parent_egress_blocked',
    })
    await expect(dispatch(await fixture(2))).resolves.toEqual({
      ok: false,
      reason: 'parent_egress_blocked',
    })
  })

  it('charges the reservation when the response omitted usage, but zero if proven unsent', async () => {
    const f = await activeFixture()
    const unsent = randomUUID()
    const estimated = randomUUID()
    await expect(claim(f.runId, unsent)).resolves.toMatchObject({ ok: true })
    await expect(settle(f.runId, unsent, { kind: 'proven_not_sent' })).resolves.toMatchObject({
      status: 'applied',
      attempt: { state: 'unsent', inputTokens: 0, outputTokens: 0, costMicros: 0 },
    })
    await expect(
      claim(f.runId, estimated, { requestDigest: 'f'.repeat(64) }),
    ).resolves.toMatchObject({ ok: true })
    await expect(
      settle(f.runId, estimated, { kind: 'confirmed_missing_usage' }),
    ).resolves.toMatchObject({
      status: 'applied',
      attempt: { state: 'estimated', inputTokens: 20, outputTokens: 10, costMicros: 30 },
    })
    await expect(listDiscoveryExecutorAttempts(database.db, f.runId)).resolves.toHaveLength(2)
    await expect(getDiscoveryExecutorParentBudget(database.db, slotId)).resolves.toMatchObject({
      dispatches: 1,
      calls: 2,
      inputTokens: 20,
      outputTokens: 10,
      costMicros: 30,
      reservedTokens: 0,
      reservedCostMicros: 0,
      egressBlockedAt: null,
    })
  })

  it('denies per-request overage and enforces a tightened live cap without charging a call', async () => {
    const f = await activeFixture()
    await expect(claim(f.runId, randomUUID(), { outputUpperBound: 11 })).resolves.toEqual({
      ok: false,
      reason: 'request_exceeds_ceiling',
    })
    await database.db
      .update(schema.coordinationTeamPolicies)
      .set({ dailyTokenLimit: 29 })
      .where(eq(schema.coordinationTeamPolicies.teamId, ids.teamId))
    await expect(claim(f.runId)).resolves.toEqual({ ok: false, reason: 'budget_exhausted' })
    await expect(listDiscoveryExecutorAttempts(database.db, f.runId)).resolves.toEqual([])
    await expect(getDiscoveryExecutorParentBudget(database.db, slotId)).resolves.toMatchObject({
      dispatches: 1,
      calls: 0,
      reservedTokens: 0,
      costMicros: 0,
    })
  })
})
