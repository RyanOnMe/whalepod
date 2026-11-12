#!/usr/bin/env tsx
/** Real executor only after the c3 guard; discovery/public control remain synthetic replay. */
import assert from 'node:assert/strict'
import { randomBytes, randomUUID } from 'node:crypto'
import { lstat, mkdir, readdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { parseArgs } from 'node:util'
import { schema } from '@whalepod/db'
import { and, asc, eq } from 'drizzle-orm'
import WebSocket from 'ws'
import { isSha256, reserveHoldoutAttempt, sha256 } from './lib/acceptance-provenance.js'
import {
  prepareDiscoveryDraftFixture,
  type DiscoveryExecutionBasis,
} from './lib/discovery-draft-fixture.js'
import {
  ProductionAcceptance,
  repoRoot,
  until,
  type AcceptanceActor,
} from './lib/production-acceptance.js'
import { Rd04c2Replay } from './lib/rd04c2-replay.js'
import {
  EXECUTOR_LIMITS,
  EXECUTOR_PERSONA,
  EXECUTOR_POLICY,
  EXECUTOR_ROUTE,
  FIXTURE_FACT,
  FIXTURE_RECOMMENDATION,
  bindGuardedAssembly,
  bindGuardedAcceptancePlan,
  checkGuardNegatives,
  checkRd04c3,
  guardedFixtureWitnesses,
  privateMarkerForRun,
  readPrivateAcceptanceCredential,
  type ExecutorEvent,
  type ExecutorUsage,
  type GuardNegativeCase,
  type GuardedAcceptanceEvidence,
  type GuardedAcceptancePlan,
} from './lib/rd04c3-acceptance.js'

const root = join(repoRoot, 'artifacts/evidence/rd04c3')
const planPath = join(root, 'plan.json')
const guardsPath = join(root, 'guard-negatives.json')
const attemptDirectory = join(root, 'live')
const sockets: WebSocket[] = []
const options = { flag: 'wx', mode: 0o600, flush: true } as const
const liveTimeout = 180_000
let env: ProductionAcceptance | undefined
let liveStage:
  | 'fixture'
  | 'dispatch'
  | 'provider'
  | 'receipt'
  | 'draft'
  | 'privacy'
  | 'ledger'
  | 'verification' = 'fixture'

async function socket(h: ProductionAcceptance, actor: AcceptanceActor) {
  const ws = new WebSocket(h.origin.replace(/^http:/, 'ws:') + '/ws/v1/client?cursor=0', {
    headers: { origin: h.origin, cookie: actor.cookie },
    handshakeTimeout: 10_000,
  })
  sockets.push(ws)
  const frames: string[] = []
  ws.on('message', (data) => frames.push(data.toString()))
  await new Promise<void>((resolve, reject) => {
    ws.once('open', resolve)
    ws.once('error', reject)
  })
  return frames
}

type ScopeCounter = {
  readonly calls: number
  readonly inputTokens: number
  readonly outputTokens: number
  readonly costMicros: number
  readonly reservedTokens: number
  readonly reservedCostMicros: number
}
const zero = {
  calls: 0,
  inputTokens: 0,
  outputTokens: 0,
  costMicros: 0,
  reservedTokens: 0,
  reservedCostMicros: 0,
}
const sum = (rows: readonly ScopeCounter[]) =>
  rows.reduce(
    (acc, next) => ({
      calls: acc.calls + next.calls,
      inputTokens: acc.inputTokens + next.inputTokens,
      outputTokens: acc.outputTokens + next.outputTokens,
      costMicros: acc.costMicros + next.costMicros,
      reservedTokens: acc.reservedTokens + next.reservedTokens,
      reservedCostMicros: acc.reservedCostMicros + next.reservedCostMicros,
    }),
    zero,
  )
function charged(before: ScopeCounter, after: ScopeCounter): ExecutorUsage {
  assert.equal(after.reservedTokens, before.reservedTokens, 'scope retains a token reservation')
  assert.equal(
    after.reservedCostMicros,
    before.reservedCostMicros,
    'scope retains a cost reservation',
  )
  return {
    calls: after.calls - before.calls,
    inputTokens: after.inputTokens - before.inputTokens,
    outputTokens: after.outputTokens - before.outputTokens,
    tokens: after.inputTokens + after.outputTokens - before.inputTokens - before.outputTokens,
    costMicros: after.costMicros - before.costMicros,
  }
}

async function prepareGuardedFixture(
  h: ProductionAcceptance,
  replay: Rd04c2Replay,
  key: string,
  negative = false,
) {
  const fixture = await prepareDiscoveryDraftFixture(h, replay, {
    projectName: 'RD-04c3 guarded model acceptance',
    startNode: (origin) =>
      h.startNodeWithGuardedExecutor(
        origin,
        { executor: EXECUTOR_ROUTE, maxOutputTokens: EXECUTOR_POLICY.maxOutputTokens },
        key,
        negative,
      ),
    // Daily caps leave room for the separately accounted discovery replay.
    dailyLimits: { calls: 10, tokens: 10_000_000, costMicros: 3_200_000 },
    permitLimits: {
      executorLimits: { ...EXECUTOR_LIMITS, costMicros: negative ? 1 : EXECUTOR_LIMITS.costMicros },
    },
  })
  const {
    colleague,
    pack,
    application,
    source,
    rowsForTask,
    base,
    basis,
    executionUrl,
    publicArtifact,
  } = fixture
  await h.api('/agents', {
    name: 'Guarded private draft executor',
    persona: EXECUTOR_PERSONA,
    provider: 'deepseek-official',
    model: EXECUTOR_ROUTE.model,
    credentialSlot: 'acceptance',
    pluginPackId: pack.id,
    approvalPolicy: 'approval_required',
    maxTokens: EXECUTOR_POLICY.maxOutputTokens,
    inputPriceMicrosPerMillionTokens: EXECUTOR_POLICY.inputPriceMicrosPerMillion,
    outputPriceMicrosPerMillionTokens: EXECUTOR_POLICY.outputPriceMicrosPerMillion,
  })
  const grantPath = base + '/applications/' + application.id + '/executor-source-grants'
  const grantBody = (exactSource: DiscoveryExecutionBasis['sources'][number]) => ({
    source: exactSource,
    executor: EXECUTOR_ROUTE,
    confirmsPrivateDraft: true,
  })
  const artifact = basis.sources.find((row) => row.kind === 'artifact')
  assert(artifact?.sourceId === publicArtifact.id)
  const forbidden = await h.request(grantPath, grantBody(artifact), { actor: colleague })
  assert([403, 404].includes(forbidden.status))
  await forbidden.body?.cancel()
  const ownerGrant = await h.request(grantPath, grantBody(artifact))
  assert(ownerGrant.ok)
  await ownerGrant.body?.cancel()
  const authorization = {
    sourceManifestDigest: basis.sourceManifestDigest,
    executor: EXECUTOR_ROUTE,
    expiresAt: new Date(Date.now() + 30 * 60_000).toISOString(),
    confirmsPrivateDraft: true,
  }
  const partialGrant = await h.request(executionUrl, authorization)
  assert.equal(partialGrant.status, 409)
  await partialGrant.body?.cancel()
  const comment = basis.sources.find((row) => row.kind === 'task_message')
  assert(comment?.sourceId === source.id)
  const commentGrant = await h.request(grantPath, grantBody(comment), { actor: colleague })
  assert(commentGrant.ok)
  const commentGrantData = (await commentGrant.json()) as { data: { id: string } }
  assert(typeof commentGrantData.data.id === 'string')
  const wrong = await h.request(executionUrl, {
    ...authorization,
    executor: { ...EXECUTOR_ROUTE, account: 'unapproved-acceptance-account' },
  })
  assert.equal(wrong.status, 409)
  await wrong.body?.cancel()
  const before = await rowsForTask(application.taskId)
  assert.equal(before.length, 0)
  return {
    ...fixture,
    grantPath,
    commentGrantId: commentGrantData.data.id,
    authorization,
    grantCount: Number(ownerGrant.ok) + Number(commentGrant.ok),
    unauthorizedSourceGrantHttp: forbidden.status,
    wrongRouteHttp: wrong.status,
    partialGrantHttp: partialGrant.status,
    beforeAuthorizationRuns: before.length,
  }
}

async function drive(
  h: ProductionAcceptance,
  replay: Rd04c2Replay,
  key: string,
  witnesses: ReturnType<typeof guardedFixtureWitnesses>,
) {
  const {
    project,
    venue,
    colleague,
    application,
    db,
    post,
    rowsForTask,
    artifactsFor,
    basis,
    executionUrl,
    publicResponse,
    authorization,
    grantCount,
    unauthorizedSourceGrantHttp,
    wrongRouteHttp,
    partialGrantHttp,
    beforeAuthorizationRuns,
  } = await prepareGuardedFixture(h, replay, key)
  liveStage = 'dispatch'
  const beforeBudget = await db.select().from(schema.coordinationBudgets)
  const [parentBefore] = await db
    .select()
    .from(schema.discoveryExecutorParentBudgets)
    .where(eq(schema.discoveryExecutorParentBudgets.slotId, application.slotId))
  const live = await socket(h, colleague)
  const first = await post('RD04C3_PUBLIC_BEFORE', venue.id)
  await until('member realtime stream observed the public before-run sentinel', async () =>
    live.some((frame) => frame.includes('"comment.created"') && frame.includes(first.id))
      ? true
      : undefined,
  )
  // A regression that calls the c2 executor fixture will be recorded as failure, never a replay success.
  replay.phase = 'private'
  const idempotencyKey = randomUUID()
  const accepted = await h.api<DiscoveryExecutionBasis>(executionUrl, authorization, {
    idempotencyKey,
  })
  assert(accepted.execution)
  liveStage = 'provider'
  const run = await until(
    'guarded live private Run reached completion',
    async () => {
      replay.assertHealthy()
      assert.equal(replay.privateRequests, 0, 'live Executor unexpectedly used replay')
      const rows = await rowsForTask(application.taskId)
      assert(rows.length <= 1)
      const [row] = rows
      if (row?.status === 'failed' || row?.status === 'cancelled')
        throw new Error(
          'private Run did not complete: ' + row.status + ' ' + (row.failureCode ?? 'no_code'),
        )
      return row?.status === 'completed' ? row : undefined
    },
    liveTimeout,
  )
  const repeated = await h.api<DiscoveryExecutionBasis>(executionUrl, authorization, {
    idempotencyKey,
  })
  assert.equal(repeated.execution?.id, accepted.execution.id)
  assert.equal(run.discoveryExecutionId, accepted.execution.id)
  assert.equal(run.origin, 'mandate')
  assert.equal(run.approvalPolicy, 'approval_required')
  assert(run.workInputManifest && run.workInputManifestDigest)

  const [dispatch] = await db
    .select()
    .from(schema.discoveryExecutorDispatches)
    .where(eq(schema.discoveryExecutorDispatches.runId, run.id))
  assert(dispatch && dispatch.executionId === accepted.execution.id)
  assert.equal(dispatch.slotId, application.slotId)
  assert.equal(dispatch.permitId, application.permitId)
  assert.equal(dispatch.policyGeneration, EXECUTOR_ROUTE.policyGeneration)
  assert(isSha256(dispatch.routeDigest) && isSha256(dispatch.sourceGrantsDigest))
  assert.deepEqual(dispatch.policy.parent, EXECUTOR_LIMITS)
  assert.equal(dispatch.policy.maxInputTokens, EXECUTOR_POLICY.maxInputTokens)
  assert.equal(dispatch.policy.maxOutputTokens, EXECUTOR_POLICY.maxOutputTokens)
  assert.equal(
    dispatch.policy.inputPriceMicrosPerMillionTokens,
    EXECUTOR_POLICY.inputPriceMicrosPerMillion,
  )
  assert.equal(
    dispatch.policy.outputPriceMicrosPerMillionTokens,
    EXECUTOR_POLICY.outputPriceMicrosPerMillion,
  )
  const calls = await db
    .select()
    .from(schema.discoveryExecutorAttempts)
    .where(eq(schema.discoveryExecutorAttempts.runId, run.id))
    .orderBy(
      asc(schema.discoveryExecutorAttempts.createdAt),
      asc(schema.discoveryExecutorAttempts.attemptId),
    )
  liveStage = 'receipt'
  const receipts = await until('DSH consumed the exact frozen inputs', async () => {
    const rows = await db
      .select()
      .from(schema.runWorkInputReceipts)
      .where(eq(schema.runWorkInputReceipts.runId, run.id))
    return rows.some(
      (row) =>
        row.manifestDigest === run.workInputManifestDigest &&
        row.entriesRead.length === basis.sources.length &&
        row.entriesDelivered.length === basis.sources.length &&
        row.missing.length === 0,
    )
      ? rows
      : undefined
  })
  liveStage = 'draft'
  const draftRows = await artifactsFor(run.id)
  assert.equal(draftRows.length, 1)
  const [draft] = draftRows
  const privateMarker = privateMarkerForRun(run.id)
  assert(draft?.status === 'candidate' && draft.title === privateMarker)
  const draftPath = '/artifacts/' + draft.id + '/content'
  const [ownerDraft, memberDraft, formalPublish] = await Promise.all([
    h.request(draftPath),
    h.request(draftPath, undefined, { actor: colleague }),
    h.request('/artifacts/' + draft.id + '/publish', {}),
  ])
  assert.equal(ownerDraft.status, 200)
  assert.equal(memberDraft.status, 404)
  assert.equal(formalPublish.status, 404)
  const body = await ownerDraft.text()
  await Promise.all([memberDraft.body?.cancel(), formalPublish.body?.cancel()])
  liveStage = 'privacy'
  const final = await post('RD04C3_PUBLIC_AFTER', venue.id)
  const history = await socket(h, colleague)
  await until(
    'member realtime and replay streams observed non-private sentinels and status',
    async () =>
      [live, history].every(
        (frames) =>
          frames.some((frame) => frame.includes(first.id)) &&
          frames.some((frame) => frame.includes(final.id)) &&
          frames.some((frame) => frame.includes('"run.changed"') && frame.includes(run.id)),
      )
        ? true
        : undefined,
  )
  const memberReads = await Promise.all([
    h.request('/runs/' + run.id, undefined, { actor: colleague }),
    h.request('/runs/' + run.id + '/events', undefined, { actor: colleague }),
    h.request('/tasks/' + application.taskId, undefined, { actor: colleague }),
  ])
  assert.deepEqual(
    memberReads.map((response) => response.status),
    [404, 404, 200],
  )
  const memberBodies = await Promise.all(memberReads.map((response) => response.text()))
  const visibility = [memberBodies, live, history].map((frames) => ({
    observed: frames.length,
    leaks: frames.filter((frame) => frame.includes(privateMarker) || frame.includes(draft.id))
      .length,
  }))
  await assert.rejects(lstat(join(h.workspaceDir, '.whalepod', 'drafts', run.id + '.md')), {
    code: 'ENOENT',
  })
  const workspacesClean = await until(
    'private runtime input and draft directories are removed',
    async () => {
      const names = await readdir(join(h.stateDir, 'runtime-home', run.id)).catch(
        (error: NodeJS.ErrnoException) => {
          if (error.code === 'ENOENT') return []
          throw error
        },
      )
      return !names.some((name) => /^discovery-(?:workspace|inputs)-/.test(name)) ? true : undefined
    },
  )
  liveStage = 'ledger'
  const afterBudget = await db.select().from(schema.coordinationBudgets)
  const [parentAfter] = await db
    .select()
    .from(schema.discoveryExecutorParentBudgets)
    .where(eq(schema.discoveryExecutorParentBudgets.slotId, application.slotId))
  assert(parentAfter && parentAfter.dispatches - (parentBefore?.dispatches ?? 0) === 1)
  assert.equal(parentAfter.egressBlockedAt, null)
  const delta = (scope: 'team' | 'project' | 'work', id: string) =>
    charged(
      sum(beforeBudget.filter((row) => row.scope === scope && row.scopeId === id)),
      sum(afterBudget.filter((row) => row.scope === scope && row.scopeId === id)),
    )
  const events: ExecutorEvent[] = []
  for (const event of h.events) {
    if (
      event.component !== 'node.discovery_execution' ||
      (event.action !== 'discovery.executor.sent' &&
        event.action !== 'discovery.executor.provider_usage')
    )
      continue
    assert(
      event.runId === run.id &&
        typeof event.attemptId === 'string' &&
        typeof event.at === 'string' &&
        event.transport === 'native_https',
    )
    // Explicitly discard all other fields. Do not export raw Runtime or provider logs.
    events.push({
      component: event.component,
      action: event.action,
      runId: run.id,
      attemptId: event.attemptId,
      at: event.at,
      transport: event.transport,
      ...(typeof event.inputTokens === 'number' ? { inputTokens: event.inputTokens } : {}),
      ...(typeof event.outputTokens === 'number' ? { outputTokens: event.outputTokens } : {}),
      ...(isSha256(event.responseIdDigest) ? { responseIdDigest: event.responseIdDigest } : {}),
    })
  }
  replay.assertHealthy()
  return {
    events,
    evidence: {
      schemaVersion: 1,
      mode: 'guarded_live_model',
      invoiceReconciliation: 'not_run',
      provider: EXECUTOR_ROUTE,
      projectId: project.id,
      taskId: application.taskId,
      executionId: accepted.execution.id,
      runId: run.id,
      runCount: (await rowsForTask(application.taskId)).length,
      runStatus: run.status,
      dispatch: {
        policyGeneration: dispatch.policyGeneration,
        routeDigest: dispatch.routeDigest,
        sourceGrantsDigest: dispatch.sourceGrantsDigest,
        idempotent: repeated.execution?.id === accepted.execution.id,
      },
      grantCount,
      unauthorizedSourceGrantHttp,
      wrongRouteHttp,
      partialGrantHttp,
      beforeAuthorizationRuns,
      publicReplayRequests: replay.publicRequests,
      discoveryReplayRequests: replay.discoveryRequests,
      executorReplayRequests: replay.privateRequests,
      sources: basis.sources,
      manifest: run.workInputManifest.entries.map(
        ({ inboxItemId, sourceId, sourceVersion, sourceDigest, authorizationGeneration }) => ({
          inboxItemId,
          sourceId,
          sourceVersion,
          sourceDigest,
          authorizationGeneration,
        }),
      ),
      manifestDigest: run.workInputManifestDigest,
      readReceipts: receipts.flatMap((row) => {
        assert.equal(row.manifestDigest, run.workInputManifestDigest)
        return row.readEvents.map(({ inboxItemId, digestVerified }) => {
          assert(typeof inboxItemId === 'string' && typeof digestVerified === 'boolean')
          return { inboxItemId, digestVerified }
        })
      }),
      draft: {
        ownerHttp: ownerDraft.status,
        memberHttp: memberDraft.status,
        publicControlHttp: publicResponse.status,
        formalPublishHttp: formalPublish.status,
        privateNoStore: ownerDraft.headers.get('cache-control') === 'private, no-store',
        bytesDigest: sha256(body),
        metadataDigest: draft.sha256,
        fixtureFact: body.includes(FIXTURE_FACT),
        recommendation: body.toLowerCase().includes(FIXTURE_RECOMMENDATION),
        privateMarker: draft.title === privateMarker,
        sourceWitnessesMatched:
          body.includes(witnesses.artifactCode) && body.includes(witnesses.commentCode),
        sourceWitnessesDigest: witnesses.digest,
      },
      visibility,
      workspacesClean,
      calls: calls.map((call) => ({
        runId: call.runId,
        attemptId: call.attemptId,
        state: call.state,
        requestDigest: call.requestDigest,
        requestBytes: call.requestBytes,
        utcDate: call.utcDate,
        maxInputTokens: call.maxInputTokens,
        maxOutputTokens: call.maxOutputTokens,
        reservedCostMicros: call.reservedCostMicros,
        inputTokens: call.inputTokens,
        outputTokens: call.outputTokens,
        costMicros: call.costMicros,
        responseIdDigest: call.responseIdDigest,
        overage: call.overage,
        createdAt: call.createdAt.toISOString(),
        settledAt: call.settledAt?.toISOString() ?? null,
      })),
      usageByScope: {
        team: delta('team', dispatch.teamId),
        project: delta('project', dispatch.projectId),
        parent: charged(parentBefore ?? zero, parentAfter),
        work: delta('work', dispatch.workKey),
      },
    } satisfies Omit<GuardedAcceptanceEvidence, 'attemptId' | 'provenance'>,
  }
}

async function driveGuardNegative(kind: 'budget' | 'revoked_grant'): Promise<GuardNegativeCase> {
  const witnesses = guardedFixtureWitnesses(randomUUID())
  const replay = new Rd04c2Replay(witnesses.publicBody, witnesses.sourceBody)
  const h = new ProductionAcceptance(
    (request, response) => void replay.respond(request, response),
    undefined,
    EXECUTOR_POLICY,
  )
  env = h
  const statuses = (action: 'hub_begin' | 'hub_online_check') =>
    h.events.flatMap((event) =>
      event.component === 'testkit.rd04c3' &&
      event.action === action &&
      typeof event.status === 'number'
        ? [event.status]
        : [],
    )
  try {
    const fixture = await prepareGuardedFixture(
      h,
      replay,
      randomBytes(32).toString('base64url'),
      true,
    )
    const {
      application,
      artifactsFor,
      rowsForTask,
      db,
      grantPath,
      commentGrantId,
      colleague,
      executionUrl,
      authorization,
    } = fixture
    const beforeScopes = (await db.select().from(schema.coordinationBudgets))
      .map((row) => row.scope)
      .sort()
    const revoked =
      kind === 'revoked_grant'
        ? await h.request(grantPath + '/' + commentGrantId, undefined, {
            method: 'DELETE',
            actor: colleague,
          })
        : null
    if (revoked) assert.equal(revoked.status, 204)
    replay.phase = 'private'
    const authorized = await h.request(executionUrl, authorization, {
      idempotencyKey: randomUUID(),
    })
    assert.equal(authorized.status, kind === 'budget' ? 200 : 409)
    await authorized.body?.cancel()
    let workBudgetRows = 0
    let draftCount = 0
    let terminal: 'failed' | 'cancelled' | 'no_run' = 'no_run'
    if (kind === 'budget') {
      const run = await until(
        'underfunded executor Run failed without provider traffic',
        async () => {
          replay.assertHealthy()
          const [candidate] = await rowsForTask(application.taskId)
          assert.notEqual(candidate?.status, 'completed')
          return candidate?.status === 'failed' || candidate?.status === 'cancelled'
            ? candidate
            : undefined
        },
        90_000,
      )
      assert(run.status === 'failed' || run.status === 'cancelled')
      terminal = run.status
      const [dispatch] = await db
        .select()
        .from(schema.discoveryExecutorDispatches)
        .where(eq(schema.discoveryExecutorDispatches.runId, run.id))
      assert(dispatch?.policy.work.costMicros === 1)
      const budgetRows = await db
        .select()
        .from(schema.coordinationBudgets)
        .where(
          and(
            eq(schema.coordinationBudgets.scope, 'work'),
            eq(schema.coordinationBudgets.scopeId, dispatch.workKey),
          ),
        )
      // The first model attempt got to the real ledger, rather than failing at an unrelated startup step.
      if (budgetRows.length !== 1) {
        const afterScopes = (await db.select().from(schema.coordinationBudgets))
          .map((row) => row.scope)
          .sort()
        throw new Error(
          'underfunded Run did not reach the Work call budget: ' +
            JSON.stringify({
              code: run.failureCode,
              beforeScopes,
              afterScopes,
              hubBeginStatuses: statuses('hub_begin'),
              hubOnlineStatuses: statuses('hub_online_check'),
            }),
        )
      }
      assert.deepEqual(charged(zero, sum(budgetRows)), {
        calls: 0,
        inputTokens: 0,
        outputTokens: 0,
        tokens: 0,
        costMicros: 0,
      })
      workBudgetRows = budgetRows.length
      draftCount = (await artifactsFor(run.id)).length
    }
    replay.assertHealthy()
    return {
      kind,
      terminal,
      authorizedHttp: authorized.status,
      revokedHttp: revoked?.status ?? null,
      runCount: (await rowsForTask(application.taskId)).length,
      attemptCount: (await db.select().from(schema.discoveryExecutorAttempts)).length,
      draftCount,
      workBudgetRows,
      wrongRouteHttp: fixture.wrongRouteHttp,
      partialGrantHttp: fixture.partialGrantHttp,
      unauthorizedSourceGrantHttp: fixture.unauthorizedSourceGrantHttp,
      executorReplayRequests: replay.privateRequests,
      hubBeginStatuses: statuses('hub_begin'),
      hubOnlineStatuses: statuses('hub_online_check'),
      observedEgress: h.events.filter(
        (event) =>
          (event.component === 'testkit.rd04c3' && event.action === 'external_network_blocked') ||
          (event.component === 'node.discovery_execution' &&
            (event.action === 'discovery.executor.sent' ||
              event.action === 'discovery.executor.provider_usage')),
      ).length,
    }
  } catch (error) {
    // Only the synthetic controls can emit the safe, selected component diagnostics.
    console.error(h.diagnostics().slice(-6_000))
    throw error
  } finally {
    await h.stop()
    env = undefined
  }
}

let stopping: Promise<void> | undefined
function stop() {
  stopping ??= (async () => {
    for (const ws of sockets) ws.terminate()
    await env?.stop()
  })()
  return stopping
}

async function main() {
  const { values } = parseArgs({
    options: {
      'prepare-only': { type: 'boolean' },
      'guard-negatives': { type: 'boolean' },
      'accept-charges': { type: 'boolean' },
      'key-file': { type: 'string' },
    },
  })
  if (values['guard-negatives']) {
    assert(
      !values['prepare-only'] && !values['accept-charges'] && !values['key-file'],
      'guard negatives take no credential or charge consent',
    )
    const binding = await bindGuardedAssembly()
    const cases = [await driveGuardNegative('budget'), await driveGuardNegative('revoked_grant')]
    assert.deepEqual(
      await bindGuardedAssembly(),
      binding,
      'assembly changed during guard negatives',
    )
    const report = { schemaVersion: 1, ...binding, cases }
    checkGuardNegatives(report, binding)
    await mkdir(root, { recursive: true, mode: 0o700 })
    await writeFile(guardsPath, JSON.stringify(report, null, 2) + '\n', options)
    console.log('RD-04c3 packaged guard negatives PASS; provider egress zero')
    return
  }
  if (values['prepare-only']) {
    assert(
      !values['accept-charges'] && !values['key-file'],
      'preparation must not receive a key or charge consent',
    )
    const plan = await bindGuardedAcceptancePlan(new Date().toISOString())
    await mkdir(root, { recursive: true, mode: 0o700 })
    await writeFile(planPath, JSON.stringify(plan, null, 2) + '\n', options)
    console.log('RD-04c3 prepared; live model and billing not_run')
    return
  }
  assert(
    values['accept-charges'] && values['key-file'],
    'live probe requires --accept-charges and --key-file',
  )
  const planRaw = await readFile(planPath, 'utf8')
  const plan = JSON.parse(planRaw) as GuardedAcceptancePlan
  assert.deepEqual(
    await bindGuardedAcceptancePlan(plan.preparedAt),
    plan,
    'prepared evidence or assembly changed',
  )
  const key = await readPrivateAcceptanceCredential(values['key-file'])
  const attempt = await reserveHoldoutAttempt(attemptDirectory, sha256(planRaw), plan.preparedAt)
  const witnesses = guardedFixtureWitnesses(attempt.attempt.id)
  const replay = new Rd04c2Replay(witnesses.publicBody, witnesses.sourceBody)
  env = new ProductionAcceptance(
    (request, response) => void replay.respond(request, response),
    undefined,
    EXECUTOR_POLICY,
  )
  env.protect(key)
  try {
    const { events, evidence } = await drive(env, replay, key, witnesses)
    liveStage = 'verification'
    assert.deepEqual(
      await bindGuardedAcceptancePlan(plan.preparedAt),
      plan,
      'assembly changed during live execution',
    )
    const eventsRaw = events.map((event) => JSON.stringify(event)).join('\n') + '\n'
    const result: GuardedAcceptanceEvidence = {
      ...evidence,
      attemptId: attempt.attempt.id,
      provenance: {
        planDigest: sha256(planRaw),
        attemptDigest: attempt.digest,
        eventsDigest: sha256(eventsRaw),
      },
    }
    const totals = checkRd04c3(result, eventsRaw, planRaw, attempt.raw)
    await writeFile(join(attemptDirectory, 'events.jsonl'), eventsRaw, options)
    await writeFile(
      join(attemptDirectory, 'result.json'),
      JSON.stringify(result, null, 2) + '\n',
      options,
    )
    console.log('RD-04c3 guarded live usage PASS', JSON.stringify(totals))
  } catch (error) {
    // No exception body, key path, or raw logs are evidence. An interrupted attempt remains exclusive.
    await writeFile(
      join(attemptDirectory, 'failure.json'),
      JSON.stringify({
        schemaVersion: 1,
        attemptId: attempt.attempt.id,
        status: 'failed',
        reason: 'guarded_live_acceptance_failed',
        stage: liveStage,
        observedSends: env.events.filter(
          (event) =>
            event.component === 'node.discovery_execution' &&
            event.action === 'discovery.executor.sent',
        ).length,
        observedUsage: env.events.filter(
          (event) =>
            event.component === 'node.discovery_execution' &&
            event.action === 'discovery.executor.provider_usage',
        ).length,
      }) + '\n',
      options,
    )
    throw error
  } finally {
    await stop()
  }
}

for (const [signal, code] of [
  ['SIGTERM', 143],
  ['SIGINT', 130],
] as const)
  process.once(signal, () => void stop().finally(() => process.exit(code)))
try {
  await main()
} catch (error) {
  // Assertion diffs can contain fixture details; output only a fixed failure once live begins.
  console.error(
    env
      ? 'RD-04c3 live probe failed; do not overwrite the attempted run'
      : 'RD-04c3 preflight failed: ' + (error instanceof Error ? error.message : 'unknown error'),
  )
  process.exitCode = 1
}
