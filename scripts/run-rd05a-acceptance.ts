#!/usr/bin/env tsx
/** One real production campaign; only model responses are served by loopback replay. */
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { lstat, mkdir, readdir, rm, writeFile } from 'node:fs/promises'
import { join, relative, resolve } from 'node:path'
import { performance } from 'node:perf_hooks'
import { setTimeout as delay } from 'node:timers/promises'
import { schema } from '@whalepod/db'
import { eq, getTableColumns, inArray } from 'drizzle-orm'
import WebSocket from 'ws'
import { sha256 } from './lib/acceptance-provenance.js'
import type { DiscoveryExecutionBasis } from './lib/discovery-draft-fixture.js'
import {
  ProductionAcceptance,
  repoRoot,
  until,
  type AcceptanceActor,
} from './lib/production-acceptance.js'
import { Rd04c2Replay, privateMarker, toolErrorMarker } from './lib/rd04c2-replay.js'
import {
  type Rd05aEvidence,
  type Rd05aReceipt,
  type Rd05aRun,
  type Rd05aStage,
  type Rd05aSource,
} from './lib/rd05a-evidence.js'
import {
  driveFast,
  executorIdentity,
  prepareSlow,
  readStatus,
  setupRd05a,
} from './lib/rd05a-fixture.js'
import { bindRd05a } from './lib/rd05a-provenance.js'
import { Rd05aReplay, publicBody, sourceBody } from './lib/rd05a-replay.js'
import { verifyRd05a } from './verify-rd05a-acceptance.js'

type Rd05aExecutionBasis = Omit<DiscoveryExecutionBasis, 'execution'> & {
  execution:
    | null
    | (NonNullable<DiscoveryExecutionBasis['execution']> &
        Pick<Rd05aEvidence['slow']['authorization'], 'executor' | 'executorDigest'>)
}

const binding = await bindRd05a(repoRoot)
assert.equal(process.argv.length, 3, 'usage: run-rd05a-acceptance.ts <evidence/result.json>')
const resultPath = resolve(process.argv[2]!)
const parts = relative(
  join(repoRoot, 'artifacts/evidence/rd05a', binding.commit),
  resultPath,
).split('/')
assert.equal(parts.length, 2, 'result path must identify one fresh campaign at the current commit')
const campaignId = parts[0]!
assert(/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(campaignId))
assert.equal(parts[1], 'result.json')
const output = join(repoRoot, 'artifacts/evidence/rd05a', binding.commit, campaignId)
const replay = new Rd05aReplay()
const env = new ProductionAcceptance(
  (request, response) => void replay.respond(request, response),
  executorIdentity,
)
const sockets: WebSocket[] = []
const stages: Rd05aStage[] = []
const observations: Record<string, unknown>[] = []

async function browserSocket(member: AcceptanceActor) {
  const socket = new WebSocket(env.origin.replace(/^http:/, 'ws:') + '/ws/v1/client?cursor=0', {
    headers: { origin: env.origin, cookie: member.cookie },
    handshakeTimeout: 10_000,
  })
  sockets.push(socket)
  const frames: string[] = []
  socket.on('message', (data) => frames.push(data.toString()))
  await new Promise<void>((resolve, reject) => {
    socket.once('open', resolve)
    socket.once('error', reject)
  })
  return { socket, frames }
}

async function privateDirectories(runId: string) {
  try {
    return (await readdir(join(env.stateDir, 'runtime-home', runId))).filter(
      (name) => name.startsWith('discovery-workspace-') || name.startsWith('discovery-inputs-'),
    )
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw error
  }
}

async function cleanPrivate(runId: string) {
  await assert.rejects(lstat(join(env.workspaceDir, '.whalepod', 'drafts', runId + '.md')), {
    code: 'ENOENT',
  })
  await until('discovery directories cleaned', async () =>
    (await privateDirectories(runId)).length === 0 ? true : undefined,
  )
  return true
}

function receipt(row: typeof schema.runWorkInputReceipts.$inferSelect): Rd05aReceipt {
  return {
    id: row.id,
    runId: row.runId,
    manifestDigest: row.manifestDigest,
    receiptSeq: row.receiptSeq,
    digestVerified: row.digestVerified,
    entriesDelivered: row.entriesDelivered,
    entriesRead: row.entriesRead,
    readEvents: row.readEvents.map(({ inboxItemId, at, digestVerified }) => {
      assert(typeof inboxItemId === 'string')
      assert(typeof at === 'string')
      assert(typeof digestVerified === 'boolean')
      return { inboxItemId, at, digestVerified }
    }),
    missing: row.missing,
  }
}

function exactSource(row: {
  sourceId: string
  sourceVersion: string
  sourceDigest: string
  authorizationGeneration: string
}): Rd05aSource {
  return {
    kind: 'task_message',
    sourceId: row.sourceId,
    sourceVersion: row.sourceVersion,
    sourceDigest: row.sourceDigest,
    authorizationGeneration: row.authorizationGeneration,
  }
}

function observedRun(
  row: typeof schema.runs.$inferSelect & { projectId: string },
  role: Rd05aRun['role'],
): Rd05aRun {
  assert(
    row.workKey &&
      row.mandateId &&
      row.specRevisionId &&
      row.dispatchIntentId &&
      row.workInputManifestDigest &&
      row.workInputManifest &&
      row.startedAt &&
      row.finishedAt,
    JSON.stringify({
      component: 'acceptance.run_snapshot',
      role,
      runId: row.id,
      missing: [
        'workKey',
        'mandateId',
        'specRevisionId',
        'dispatchIntentId',
        'workInputManifestDigest',
        'workInputManifest',
        'startedAt',
        'finishedAt',
      ].filter((key) => !row[key as keyof typeof row]),
    }),
  )
  return {
    role,
    id: row.id,
    projectId: row.projectId,
    taskId: row.taskId,
    status: row.status,
    origin: row.origin,
    workKey: row.workKey,
    dshSessionId: row.dshSessionId,
    dispatchIntentId: row.dispatchIntentId,
    mandateId: row.mandateId,
    specRevisionId: row.specRevisionId,
    manifestDigest: row.workInputManifestDigest,
    itemIds: row.workInputManifest.entries.map((entry) => entry.inboxItemId),
    startedAt: row.startedAt.toISOString(),
    finishedAt: row.finishedAt.toISOString(),
  }
}

async function drive() {
  const fixture = await setupRd05a(env)
  const {
    db,
    project,
    colleague,
    venue,
    discussion,
    work,
    mandate,
    subscription,
    runRows,
    artifactsFor,
  } = fixture
  const checkpoint = async (stage: Rd05aStage['stage']) => {
    const [tasks, runs] = await Promise.all([
      db.select().from(schema.tasks).where(eq(schema.tasks.projectId, project.id)),
      db
        .select({ ...getTableColumns(schema.runs), projectId: schema.tasks.projectId })
        .from(schema.runs)
        .innerJoin(schema.tasks, eq(schema.tasks.id, schema.runs.taskId))
        .where(eq(schema.tasks.projectId, project.id)),
    ])
    stages.push({
      stage,
      at: new Date().toISOString(),
      taskCount: tasks.length,
      runIds: runs.map((row) => row.id).sort(),
    })
  }
  const fast = await driveFast(env, replay, fixture)
  await checkpoint('fast_stable')
  const slow = await prepareSlow(env, replay, fixture, fast.firstArtifact, 'Shuttle boarding plan')
  await checkpoint('discovery_created')
  assert(env.providerOrigin)
  const authorization = {
    sourceManifestDigest: slow.basis.sourceManifestDigest,
    executor: executorIdentity(env.providerOrigin),
    expiresAt: new Date(Date.now() + 1800_000).toISOString(),
    confirmsPrivateDraft: true,
  }
  const nonowner = await env.request(slow.executionUrl, authorization, { actor: colleague })
  assert.equal(nonowner.status, 404)
  await nonowner.body?.cancel()
  const wrong = await env.request(slow.executionUrl, {
    ...authorization,
    executor: { ...authorization.executor, account: 'wrong-replay-account' },
  })
  assert.equal(wrong.status, 409)
  await wrong.body?.cancel()
  const beforeAuthorizationRuns = (await runRows(slow.application.taskId)).length
  assert.equal(beforeAuthorizationRuns, 0)
  const live = await browserSocket(colleague)
  const sentinel = async (body: string) => {
    const result = await env.api<{ id: string }>(
      `/tasks/${slow.application.taskId}/comments`,
      { body },
      { actor: env.owner },
    )
    await until('public sentinel visible on live WS', async () =>
      live.frames.some((frame) => frame.includes('"comment.created"') && frame.includes(result.id))
        ? true
        : undefined,
    )
    return result
  }
  // This Task already has a Work and no subscription: controls cannot enter discovery or fast dispatch.
  const before = await sentinel('RD05A_PUBLIC_BEFORE_PRIVATE_RUN')
  let privateDirectoriesObserved = 0
  replay.slow.beforePrivateRead = async () => {
    const [run] = await runRows(slow.application.taskId)
    assert(run)
    privateDirectoriesObserved = (await privateDirectories(run.id)).length
    assert.equal(privateDirectoriesObserved, 2)
  }
  replay.stage = 'private'
  const idempotencyKey = randomUUID()
  const [authorized, concurrent] = await Promise.all([
    env.api<Rd05aExecutionBasis>(slow.executionUrl, authorization, { idempotencyKey }),
    env.api<Rd05aExecutionBasis>(slow.executionUrl, authorization, { idempotencyKey }),
  ])
  assert(authorized.execution)
  const repeated = await env.api<Rd05aExecutionBasis>(slow.executionUrl, authorization, {
    idempotencyKey,
  })
  assert.equal(concurrent.execution?.id, authorized.execution.id)
  assert.equal(repeated.execution?.id, authorized.execution.id)
  const privateRun = await until(
    'new-work private Run completed',
    async () => {
      replay.assertHealthy()
      const rows = await runRows(slow.application.taskId)
      assert(rows.length <= 1)
      assert(
        !rows.some((row) => ['failed', 'cancelled'].includes(row.status)),
        'private Run failed',
      )
      return rows[0]?.status === 'completed' ? rows[0] : undefined
    },
    60_000,
  )
  assert(privateRun.workInputManifest && privateRun.workInputManifestDigest)
  const slowReceipts = await until('exact discovery inputs read', async () => {
    const rows = await db
      .select()
      .from(schema.runWorkInputReceipts)
      .where(eq(schema.runWorkInputReceipts.runId, privateRun.id))
    return rows.some((row) => row.entriesRead.length === slow.basis.sources.length)
      ? rows
      : undefined
  })
  const [privateDraft] = await artifactsFor(privateRun.id)
  assert(privateDraft && (await artifactsFor(privateRun.id)).length === 1)
  const draftPath = `/artifacts/${privateDraft.id}/content`
  const ownerDraft = await env.request(draftPath)
  assert.equal(ownerDraft.status, 200)
  const ownerDownloadDigest = sha256(await ownerDraft.text())
  const memberDraft = await env.request(draftPath, undefined, { actor: colleague })
  assert.equal(memberDraft.status, 404)
  await memberDraft.body?.cancel()
  const paths = [
    `/runs/${privateRun.id}`,
    `/runs/${privateRun.id}/events`,
    `/tasks/${slow.application.taskId}`,
  ]
  const http = await Promise.all(paths.map((path) => readStatus(env, path, colleague)))
  assert.deepEqual(
    http.map((row) => row.status),
    [404, 404, 200],
  )
  const publish = await env.request(`/artifacts/${privateDraft.id}/publish`, {})
  assert([403, 404, 409].includes(publish.status))
  await publish.body?.cancel()
  const after = await sentinel('RD05A_PUBLIC_AFTER_PRIVATE_RUN')
  const history = await browserSocket(colleague)
  await until('public sentinels and private status replayed', async () =>
    [before.id, after.id, privateRun.id].every((id) =>
      history.frames.some((frame) => frame.includes(id)),
    )
      ? true
      : undefined,
  )
  assert(
    live.frames.some((frame) => frame.includes('"run.changed"') && frame.includes(privateRun.id)),
  )
  const surfaces = ['http', 'ws_live', 'ws_replay'] as const
  const visibility = [http.map((row) => row.body), live.frames, history.frames].map(
    (items, index) => ({
      surface: surfaces[index]!,
      observed: items.length,
      draftLeaks: items.filter((item) => item.includes(privateMarker)).length,
      toolErrorLeaks: items.filter((item) => item.includes(toolErrorMarker)).length,
    }),
  )
  assert(
    visibility.every((row) => row.observed > 0 && row.draftLeaks === 0 && row.toolErrorLeaks === 0),
  )
  const workspaceClean = await cleanPrivate(privateRun.id)
  const revoked = await env.request(slow.executionUrl, undefined, { method: 'DELETE' })
  assert.equal(revoked.status, 200)
  await revoked.body?.cancel()
  const hidden = await readStatus(env, draftPath)
  const ownerRoom = await readStatus(env, `/tasks/${slow.application.taskId}`)
  const basisAfterRevoke = await env.api<Rd05aExecutionBasis>(slow.executionUrl)
  assert.equal(hidden.status, 404)
  const positiveReplay = replay.slow
  const positiveActualReads = structuredClone(replay.actualPrivateReads)
  const positiveRunRows = [...fast.runs, privateRun]
  await checkpoint('slow_complete')

  // The derived agreement is not a confirmed scope for the next catalog.
  // Account for the owner's explicit maintenance rather than omitting the new Work.
  const maintained = await env.api<{ draftVersion: number }>(
    `/tasks/${slow.application.taskId}/agreement/draft`,
    {
      content: {
        goal: 'Maintain the shuttle boarding plan',
        constraints: 'Shuttle boarding only',
        acceptance: 'Private traceable boarding draft',
        openQuestions: '',
      },
    },
  )
  await env.api(`/tasks/${slow.application.taskId}/agreement/confirm`, {
    draftVersion: maintained.draftVersion,
  })
  replay.slow = new Rd04c2Replay(publicBody, sourceBody, true)
  const negative = await prepareSlow(
    env,
    replay,
    fixture,
    fast.firstArtifact,
    'Shuttle weather contingency draft',
    [slow.application.taskId],
  )
  let revokedRead:
    | {
        runId: string
        delivery: number
        correctionHttp: number
        privateDirectoriesObserved: number
      }
    | undefined
  replay.slow.beforePrivateRead = async () => {
    const [run] = await runRows(negative.application.taskId)
    assert(run)
    const receiptRows = await until(
      'negative inputs delivered before production correction',
      async () => {
        const rows = await db
          .select()
          .from(schema.runWorkInputReceipts)
          .where(eq(schema.runWorkInputReceipts.runId, run.id))
        return rows.find((row) => row.entriesDelivered.length === negative.basis.sources.length)
      },
    )
    assert(run.workInputManifest && run.workInputManifestDigest)
    assert.deepEqual(
      [...receiptRows.entriesDelivered].sort(),
      run.workInputManifest.entries.map((entry) => entry.inboxItemId).sort(),
      'negative delivery differs from its frozen Run',
    )
    for (const entry of run.workInputManifest.entries) {
      const source = negative.basis.sources.find((source) => source.sourceId === entry.sourceId)
      assert(
        source &&
          entry.sourceVersion === source.sourceVersion &&
          entry.sourceDigest === source.sourceDigest &&
          entry.authorizationGeneration === source.authorizationGeneration,
        'negative frozen source differs from exact authorization',
      )
    }
    const directories = (await privateDirectories(run.id)).length
    const response = await env.request(
      negative.base + '/sources/' + negative.source.id + '/correct',
      {
        body: 'RD05A_CORRECTED: The boarding survey changed; do not use the previous version.',
      },
      { actor: colleague },
    )
    assert.equal(response.status, 200)
    await response.body?.cancel()
    revokedRead = {
      runId: run.id,
      delivery: receiptRows.entriesDelivered.length,
      correctionHttp: response.status,
      privateDirectoriesObserved: directories,
    }
  }
  replay.stage = 'private'
  const negativeAuthorization = await env.api<Rd05aExecutionBasis>(negative.executionUrl, {
    ...authorization,
    sourceManifestDigest: negative.basis.sourceManifestDigest,
  })
  assert(negativeAuthorization.execution)
  const negativeRun = await until(
    'revoked-before-read Run stopped',
    async () => {
      replay.assertHealthy()
      const rows = await runRows(negative.application.taskId)
      assert(rows.length <= 1)
      assert.notEqual(rows[0]?.status, 'completed')
      return rows[0] && ['failed', 'cancelled'].includes(rows[0].status) ? rows[0] : undefined
    },
    60_000,
  )
  assert(
    revokedRead && revokedRead.runId === negativeRun.id,
    JSON.stringify({
      component: 'acceptance.revoke_before_read',
      runId: negativeRun.id,
      status: negativeRun.status,
      failureCode: negativeRun.failureCode,
      privateRequests: replay.slow.privateRequests,
      checks: env.events
        .filter(
          (event) =>
            event.component === 'node.discovery_execution' && event.runId === negativeRun.id,
        )
        .map(({ stage, allowed }) => ({ stage, allowed })),
    }),
  )
  const negativeReceipts = await db
    .select()
    .from(schema.runWorkInputReceipts)
    .where(eq(schema.runWorkInputReceipts.runId, negativeRun.id))
  const negativeBasis = await env.api<Rd05aExecutionBasis>(negative.executionUrl)
  const negativeClean = await cleanPrivate(negativeRun.id)
  const negativeDrafts = await artifactsFor(negativeRun.id)
  assert.equal(negativeReceipts.flatMap((row) => row.entriesRead).length, 0)
  assert.equal(replay.slow.privateReads.length, 0)
  assert.equal(replay.slow.privateRequests, 1)
  assert.equal(negativeDrafts.length, 0)
  await checkpoint('revoke_before_read_complete')
  await until('local coordination inference settled', async () => {
    const rows = await db
      .select()
      .from(schema.coordinationEvaluations)
      .where(eq(schema.coordinationEvaluations.projectId, project.id))
    return rows.every((row) => !['queued', 'dispatched', 'running'].includes(row.status))
      ? true
      : undefined
  })
  const stableSnapshot = async () => {
    const [tasks, runs, evaluations] = await Promise.all([
      db
        .select({ id: schema.tasks.id })
        .from(schema.tasks)
        .where(eq(schema.tasks.projectId, project.id)),
      db
        .select({ id: schema.runs.id })
        .from(schema.runs)
        .innerJoin(schema.tasks, eq(schema.tasks.id, schema.runs.taskId))
        .where(eq(schema.tasks.projectId, project.id)),
      db
        .select({ id: schema.coordinationEvaluations.id })
        .from(schema.coordinationEvaluations)
        .where(eq(schema.coordinationEvaluations.projectId, project.id)),
    ])
    return {
      taskIds: tasks.map((row) => row.id).sort(),
      runIds: runs.map((row) => row.id).sort(),
      evaluationIds: evaluations.map((row) => row.id).sort(),
    }
  }
  const stabilityBefore = await stableSnapshot()
  const stabilityStartedAt = new Date().toISOString()
  const stabilityStart = performance.now()
  await delay(2500)
  const stabilityAfter = await stableSnapshot()
  const stability = {
    before: stabilityBefore,
    after: stabilityAfter,
    startedAt: stabilityStartedAt,
    finishedAt: new Date().toISOString(),
    observedMs: Math.floor(performance.now() - stabilityStart),
  }
  replay.assertHealthy()
  assert.deepEqual(stability.after, stability.before, 'campaign outputs triggered new work')
  observations.push({
    component: 'acceptance.snapshot',
    type: 'campaign.stability',
    campaignId,
    ...stability,
  })

  const fastReceipts = fast.receipts.map(receipt)
  const capturedSlowReceipts = slowReceipts.map(receipt)
  const capturedNegativeReceipts = negativeReceipts.map(receipt)
  const runs = positiveRunRows.map((row, index) =>
    observedRun(row, (['bootstrap', 'continuation', 'discovery'] as const)[index]!),
  )
  const fastReads = fast.runs.map((run, index) => {
    const observed = replay.executorCalls.find(
      (call) => call.phase === index + 1 && call.name === 'write',
    )
    assert(observed?.bodyDigest)
    return {
      runId: run.id,
      callId: 'read-' + (index + 1),
      inboxItemId: run.workInputManifest!.entries[0]!.inboxItemId,
      bodyDigest: observed.bodyDigest,
    }
  })
  const slowReads = positiveActualReads.map(({ inboxItemId, callId, bodyDigest }) => ({
    runId: privateRun.id,
    callId,
    inboxItemId,
    bodyDigest,
  }))
  const allReceipts = [...fastReceipts, ...capturedSlowReceipts, ...capturedNegativeReceipts]
  const allRunRows = [...positiveRunRows, negativeRun]
  const localEvaluations = await db
    .select()
    .from(schema.coordinationEvaluations)
    .where(eq(schema.coordinationEvaluations.projectId, project.id))
  const [coordinationRows, executorRows, liveDispatches, liveAttempts] = await Promise.all([
    db
      .select({
        ...getTableColumns(schema.coordinationUsageLedger),
        purpose: schema.coordinationEvaluations.purpose,
      })
      .from(schema.coordinationUsageLedger)
      .innerJoin(
        schema.coordinationEvaluations,
        eq(schema.coordinationEvaluations.id, schema.coordinationUsageLedger.evaluationId),
      )
      .where(eq(schema.coordinationUsageLedger.projectId, project.id)),
    db
      .select()
      .from(schema.executorUsageLedger)
      .where(eq(schema.executorUsageLedger.projectId, project.id)),
    db
      .select()
      .from(schema.discoveryExecutorDispatches)
      .where(
        inArray(
          schema.discoveryExecutorDispatches.runId,
          allRunRows.map((run) => run.id),
        ),
      ),
    db
      .select()
      .from(schema.discoveryExecutorAttempts)
      .where(
        inArray(
          schema.discoveryExecutorAttempts.runId,
          allRunRows.map((run) => run.id),
        ),
      ),
  ])
  const handoffRows = await db
    .select()
    .from(schema.handoffDrafts)
    .where(
      inArray(
        schema.handoffDrafts.sourceRunId,
        allRunRows.map((run) => run.id),
      ),
    )
  assert.equal(handoffRows.length, 2, 'unexpected automatic handoff drafts')
  const accounting = {
    suppressedRouter: localEvaluations
      .filter(
        (row) =>
          row.purpose === 'router' && !fast.evaluations.some((fastRow) => fastRow.id === row.id),
      )
      .map((row) => {
        assert.equal(row.modelStartedAt, null, 'extra Router called a model')
        assert.equal(row.reservedTokens, null, 'extra Router reserved tokens')
        assert.equal(row.reservedCostMicros, null, 'extra Router reserved cost')
        assert(row.workKey && row.taskId && row.failureCode, 'suppressed Router identity missing')
        return {
          id: row.id,
          projectId: row.projectId,
          workKey: row.workKey,
          taskId: row.taskId,
          purpose: 'router' as const,
          status: row.status,
          failureCode: row.failureCode,
          modelStarted: false as const,
          reservedTokens: null,
          reservedCostMicros: null,
        }
      }),
    handoff: handoffRows.map((row) => {
      const calls = replay.handoffCalls.filter((call) => call.runId === row.sourceRunId)
      assert.equal(calls.length, 1, 'handoff is missing its actual model request')
      assert(row.specRevisionId, 'handoff is missing its confirmed agreement')
      return {
        runId: row.sourceRunId,
        draftId: row.id,
        taskId: row.taskId,
        specRevisionId: row.specRevisionId,
        status: row.status,
        origin: row.origin,
        requests: calls.length,
        inputTokens: calls[0]!.inputTokens,
        outputTokens: calls[0]!.outputTokens,
        metering: 'loopback_unmetered' as const,
        published: row.publishedRevisionId !== null,
      }
    }),
    localEvaluations: localEvaluations
      .filter((row) => row.purpose === 'inference')
      .map((row) => {
        assert.equal(row.modelStartedAt, null, 'local inference unexpectedly called a model')
        assert(['completed', 'skipped'].includes(row.status), 'local inference did not settle')
        return {
          id: row.id,
          projectId: row.projectId,
          purpose: 'inference' as const,
          status: row.status,
          modelStarted: false as const,
        }
      }),
    coordination: coordinationRows.map(
      ({
        id,
        evaluationId,
        purpose,
        attempt,
        phase,
        projectId,
        workKey,
        reservedTokens,
        reservedCostMicros,
        chargeMode,
        usage,
      }) => ({
        id,
        evaluationId,
        purpose,
        attempt,
        phase,
        projectId,
        workKey,
        reservedTokens,
        reservedCostMicros,
        chargeMode,
        usage,
      }),
    ),
    executor: executorRows.map(
      ({
        id,
        runId,
        phase,
        projectId,
        workKey,
        mandateId,
        reservedTokens,
        reservedCostMicros,
        chargeMode,
        usage,
      }) => ({
        id,
        runId,
        phase,
        projectId,
        workKey,
        mandateId,
        reservedTokens,
        reservedCostMicros,
        chargeMode,
        usage,
      }),
    ),
    replay: allRunRows.map((run, index) => ({
      runId: run.id,
      mode: index < 2 ? ('ordinary_ledger' as const) : ('loopback_unmetered' as const),
      requests:
        index < 2
          ? replay.executorCalls.filter((call) => call.phase === index + 1).length +
            replay.handoffCalls.filter((call) => call.runId === run.id).length
          : index === 2
            ? positiveReplay.privateRequests
            : replay.slow.privateRequests,
      liveDispatchRows: liveDispatches.filter((row) => row.runId === run.id).length,
      liveAttemptRows: liveAttempts.filter((row) => row.runId === run.id).length,
    })),
  }
  const projected = await db
    .select()
    .from(schema.runEvents)
    .where(
      inArray(
        schema.runEvents.runId,
        fast.runs.map((row) => row.id),
      ),
    )
  observations.push(
    ...allReceipts.map((row) => ({
      component: 'hub.work_input',
      type: 'work_input.receipt',
      ...row,
    })),
    ...[...fastReads, ...slowReads].map((row) => ({
      component: 'acceptance.replay',
      type: 'tool_read.observed',
      ...row,
    })),
    ...positiveReplay.toolErrors.map((row) => ({
      component: 'acceptance.replay',
      type: 'tool_error.observed',
      runId: privateRun.id,
      ...row,
    })),
    ...stages.map((row) => ({
      component: 'acceptance.campaign',
      type: 'campaign.stage',
      campaignId,
      ...row,
    })),
    ...projected
      .filter((row) => ['runtime.ready', 'run.completed'].includes(row.type))
      .map((row) => ({
        component: 'hub.run',
        type: row.type,
        runId: row.runId,
        audience: row.audience,
      })),
    ...allRunRows.map((row) => ({
      component: 'acceptance.snapshot',
      type: 'run.status',
      runId: row.id,
      status: row.status,
      projectId: row.projectId,
      taskId: row.taskId,
      workKey: row.workKey,
      executionId: row.discoveryExecutionId,
    })),
  )
  const fastDraftResponse = await env.request(`/artifacts/${fast.draft.id}/content`)
  await fastDraftResponse.body?.cancel()
  assert(fast.firstSnapshot)
  assert(privateRun.discoveryExecutionId)
  assert(positiveReplay.privateDraftDigest)
  assert(basisAfterRevoke.execution)
  assert(
    negativeRun.workKey &&
      negativeRun.discoveryExecutionId &&
      negativeRun.workInputManifest &&
      negativeRun.workInputManifestDigest,
  )
  assert(negativeBasis.execution)
  const negativeSources = negative.basis.sources.map((source): Rd05aSource => {
    assert(source.kind === 'task_message' || source.kind === 'artifact')
    return { ...source, kind: source.kind }
  })
  const authorizedSources = slow.basis.sources.map((source): Rd05aSource => {
    assert(source.kind === 'task_message' || source.kind === 'artifact')
    return { ...source, kind: source.kind }
  })
  const discoverySource = authorizedSources.find((source) => source.kind === 'task_message')
  assert(discoverySource)
  const result: Omit<Rd05aEvidence, 'provenance'> = {
    schemaVersion: 1,
    mode: 'rd05a_loopback_combined',
    campaignId,
    generatedAt: new Date().toISOString(),
    projectId: project.id,
    members: { ownerId: env.owner.userId, memberId: colleague.userId, count: 2 },
    assembly: {
      hub: 'production-package-bin',
      node: 'production-package-replay-assembly',
      runtime: 'production-dsh-package-bin',
      database: 'postgresql',
      model: 'loopback-http-replay',
    },
    modelQuality: 'not_run',
    humanEfficiency: 'not_run',
    invoice: 'not_run',
    paidRequests: 0,
    runs,
    stages,
    stability,
    accounting,
    humanActions: {
      setup: [
        colleague.userId,
        project.id,
        env.deviceId,
        project.id, // Router configuration.
        fixture.agent.id,
        venue.id,
        discussion.id,
        venue.id, // Task acceptance.
        venue.id, // Agreement draft.
        venue.id, // Agreement confirmation.
        venue.id, // Explicitly enable confirmed agreement binding.
        work.workKey,
        mandate.id,
        subscription.id,
        slow.slotId,
        project.id, // Discovery permit.
        colleague.userId, // Source-author participation.
      ].map((subjectId) => ({ action: 'setup', subjectId })),
      positive: [
        { action: 'bootstrap', subjectId: venue.id },
        { action: 'publication', subjectId: fast.firstArtifact.id },
        { action: 'catalogVerification', subjectId: slow.application.id },
        { action: 'executionAuthorization', subjectId: authorized.execution.id },
      ],
      corrections: [{ action: 'correction', subjectId: authorized.execution.id }],
      negative: [
        { action: 'setup', subjectId: slow.application.taskId }, // Explicit scope draft maintenance.
        { action: 'setup', subjectId: slow.application.taskId }, // Explicit confirmation, not automatic creation.
        { action: 'setup', subjectId: negative.slotId },
        { action: 'setup', subjectId: project.id },
        { action: 'setup', subjectId: colleague.userId },
        { action: 'catalogVerification', subjectId: negative.application.id },
        { action: 'executionAuthorization', subjectId: negativeAuthorization.execution.id },
        { action: 'correction', subjectId: negativeAuthorization.execution.id },
      ],
    },
    fast: {
      taskId: venue.id,
      discussionTaskId: discussion.id,
      workKey: work.workKey,
      mandateId: mandate.id,
      subscriptionId: subscription.id,
      bootstrapIntentId: fast.bootstrap.proposedIntent.id,
      firstSnapshot: fast.firstSnapshot,
      bootstrapSource: exactSource(fast.firstItem),
      statusBeforeBoundary: 'pending',
      supplement: {
        source: exactSource(fast.secondItem),
        authorId: env.owner.userId,
        itemId: fast.secondItem.id,
        replayedMessageId: fast.ingress.duplicateSourceId,
        admissionCount: fast.ingress.admissionCount,
        outcome: fast.ingress.outcome,
        reason: fast.ingress.reason,
        subscriptionId: subscription.id,
        admissionItemId: fast.ingress.admissionItemId,
        admissionSubscriptionId: fast.ingress.admissionSubscriptionId,
        status: fast.ingress.status,
        routerInvoked: fast.ingress.routerInvoked,
        routerCalls: fast.ingress.routerCalls,
        routerRows: fast.ingress.routerRows,
        runCount: fast.ingress.runCount,
      },
      inbox: fast.inbox.map(({ id, sourceId, status, bodyDigest }) => ({
        id,
        sourceId,
        status,
        bodyDigest,
      })),
      receipts: fastReceipts,
      consumptions: fast.consumptions.map(
        ({ receiptId, runId, inboxItemId, kind, manifestDigest, readAt }) => {
          assert(readAt && receiptId, 'input consumption is missing its actual read receipt')
          return {
            receiptId,
            runId,
            inboxItemId,
            kind,
            manifestDigest,
            readAt: readAt.toISOString(),
          }
        },
      ),
      intents: fast.intents.map(({ id, runId, status, approvalBasis, mandateId }) => {
        assert(runId && approvalBasis)
        return { id, runId, status, approvalBasis, mandateId }
      }),
      boundaries: fast.boundaries.map(({ runId, evaluationId, triggerKey, status }) => {
        assert(evaluationId)
        return { runId, evaluationId, triggerKey, status }
      }),
      evaluations: fast.evaluations.map(
        ({ id, status, routerProposal, readEntryIds, inputManifest }) => {
          assert(routerProposal)
          return {
            id,
            status,
            decision: routerProposal.decision,
            coverage: routerProposal.coverage,
            readEntryIds,
            entries: (
              inputManifest.entries as {
                id: string
                kind: string
                sourceId: string
                digest: string
              }[]
            ).map(({ id, kind, sourceId, digest }) => ({ id, kind, sourceId, digest })),
          }
        },
      ),
      applications: (
        await db
          .select()
          .from(schema.routerApplications)
          .where(eq(schema.routerApplications.workKey, work.workKey))
      ).map(({ evaluationId, decision, status, runId, intentId, waitId }) => ({
        evaluationId,
        decision,
        status,
        runId,
        intentId,
        waitId,
      })),
      wait: { id: fast.wait.id, evaluationId: fast.wait.evaluationId, status: fast.wait.status },
      replay: { routerCalls: replay.routerCalls, toolReads: fastReads },
      publicArtifact: {
        id: fast.firstArtifact.id,
        runId: fast.firstArtifact.runId,
        ownerUserId: fast.firstArtifact.ownerUserId,
        sha256: fast.firstArtifact.sha256,
        status: fast.firstArtifact.status,
        memberHttp: fast.publicHttp,
        publishedAt: fast.firstArtifact.publishedAt!.toISOString(),
      },
      draft: {
        id: fast.draft.id,
        runId: fast.draft.runId,
        ownerUserId: fast.draft.ownerUserId,
        status: fast.draft.status,
        sha256: fast.draft.sha256,
        ownerDownloadDigest: fast.downloadedDigest,
        ownerHttp: fastDraftResponse.status,
        memberHttp: fast.memberHttp,
        cacheControl: fastDraftResponse.headers.get('cache-control'),
        publishHttp: null,
      },
    },
    slow: {
      taskId: slow.application.taskId,
      specRevisionId: slow.application.specRevisionId,
      applicationId: slow.application.id,
      evaluationId: slow.application.evaluationId,
      source: discoverySource,
      sourceAuthorId: colleague.userId,
      createdTaskIds: [slow.application.taskId],
      beforeAuthorizationRuns,
      wrongAccountHttp: wrong.status,
      nonownerHttp: nonowner.status,
      authorization: {
        ...authorized.execution,
        ownerUserId: env.owner.userId,
        sources: authorizedSources,
        liveOnlyGrantCount: 0,
      },
      repeatExecutionId: repeated.execution?.id,
      concurrentExecutionId: concurrent.execution?.id,
      targetRunCount: (await runRows(slow.application.taskId)).length,
      executionId: privateRun.discoveryExecutionId,
      approvalPolicy: privateRun.approvalPolicy,
      entries: privateRun.workInputManifest.entries.map(
        ({
          inboxItemId,
          sourceType,
          sourceId,
          sourceVersion,
          sourceDigest,
          authorizationGeneration,
          bodyDigest,
        }) => ({
          inboxItemId,
          sourceType,
          sourceId,
          sourceVersion,
          sourceDigest,
          authorizationGeneration,
          bodyDigest,
        }),
      ),
      receipts: capturedSlowReceipts,
      replay: {
        discoveryRequests: positiveReplay.discoveryRequests,
        privateRequests: positiveReplay.privateRequests,
        toolReads: slowReads,
        toolErrors: positiveReplay.toolErrors,
        draftDigest: positiveReplay.privateDraftDigest,
      },
      draft: {
        id: privateDraft.id,
        runId: privateDraft.runId,
        ownerUserId: privateDraft.ownerUserId,
        status: privateDraft.status,
        sha256: privateDraft.sha256,
        ownerDownloadDigest,
        ownerHttp: ownerDraft.status,
        memberHttp: memberDraft.status,
        cacheControl: ownerDraft.headers.get('cache-control'),
        publishHttp: publish.status,
      },
      publicArtifactMemberHttp: fast.publicHttp,
      visibility,
      privateDirectoriesObserved,
      workspaceClean,
      revocation: {
        executionId: authorized.execution.id,
        status: basisAfterRevoke.execution?.status,
        ownerHttp: hidden.status,
        ownerRoomHasRevokedTitle: ownerRoom.body.includes(privateMarker),
      },
    },
    revokeBeforeRead: {
      projectId: project.id,
      taskId: negative.application.taskId,
      workKey: negativeRun.workKey,
      evaluationId: negative.application.evaluationId,
      sourceId: negative.source.id,
      executionId: negativeRun.discoveryExecutionId,
      authorizedExecutionId: negativeAuthorization.execution.id,
      sourceManifestDigest: negative.basis.sourceManifestDigest,
      sources: negativeSources,
      manifestDigest: negativeRun.workInputManifestDigest,
      entries: negativeRun.workInputManifest.entries.map(
        ({
          inboxItemId,
          sourceType,
          sourceId,
          sourceVersion,
          sourceDigest,
          authorizationGeneration,
          bodyDigest,
        }) => ({
          inboxItemId,
          sourceType,
          sourceId,
          sourceVersion,
          sourceDigest,
          authorizationGeneration,
          bodyDigest,
        }),
      ),
      runId: negativeRun.id,
      delivery: revokedRead.delivery,
      correctionHttp: revokedRead.correctionHttp,
      runStatus: negativeRun.status,
      executionStatus: negativeBasis.execution?.status,
      privateRequests: replay.slow.privateRequests,
      toolResults: replay.slow.privateReads.length,
      drafts: negativeDrafts.length,
      reads: negativeReceipts.flatMap((row) => row.entriesRead).length,
      receipts: capturedNegativeReceipts,
      privateDirectoriesObserved: revokedRead.privateDirectoriesObserved,
      workspaceClean: negativeClean,
    },
  }
  return result
}

let stopped = false
async function cleanup() {
  if (stopped) return
  stopped = true
  for (const socket of sockets) socket.terminate()
  await env.stop()
}
process.once('SIGTERM', () => void cleanup().finally(() => process.exit(143)))
process.once('SIGINT', () => void cleanup().finally(() => process.exit(130)))

let ownsOutput = false
try {
  await mkdir(join(output, '..'), { recursive: true })
  await mkdir(output)
  ownsOutput = true
  await writeFile(
    join(output, 'attempt.json'),
    JSON.stringify(
      { schemaVersion: 1, campaignId, ...binding, startedAt: new Date().toISOString() },
      null,
      2,
    ) + '\n',
    { flag: 'wx' },
  )
  const result = await drive()
  assert.deepEqual(await bindRd05a(repoRoot), binding, 'campaign assembly or harness changed')
  const eventBytes = observations.map((event) => JSON.stringify(event)).join('\n') + '\n'
  await writeFile(join(output, 'events.jsonl'), eventBytes, { flag: 'wx' })
  await writeFile(
    resultPath,
    JSON.stringify(
      { ...result, provenance: { ...binding, eventsDigest: sha256(eventBytes) } },
      null,
      2,
    ) + '\n',
    { flag: 'wx' },
  )
  await verifyRd05a(resultPath, binding)
  console.log('RD-05a combined production acceptance PASS: ' + output.slice(repoRoot.length + 1))
} catch (error) {
  const sites =
    error instanceof Error
      ? [...new Set(error.stack?.match(/scripts\/[a-zA-Z0-9_./-]+\.ts:\d+:\d+/g) ?? [])]
      : []
  const message = env.redact(
    (error instanceof Error ? error.message : String(error)) +
      '\n' +
      JSON.stringify({ component: 'acceptance.failure', sites }),
  )
  if (ownsOutput) {
    await rm(resultPath, { force: true })
    await writeFile(join(output, 'failure.log'), message + '\n' + env.diagnostics() + '\n', {
      flag: 'wx',
    })
  }
  console.error(message)
  process.exitCode = 1
} finally {
  await cleanup()
}
