/** One production assembly shared by subscribed continuation and discovery drafting. */
import assert from 'node:assert/strict'
import { randomBytes, randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { schema } from '@whalepod/db'
import { and, asc, eq, getTableColumns, inArray } from 'drizzle-orm'
import { sha256 } from './acceptance-provenance.js'
import type { DiscoveryExecutionBasis } from './discovery-draft-fixture.js'
import { type AcceptanceActor, type ProductionAcceptance, until } from './production-acceptance.js'
import {
  Rd05aReplay,
  firstSource,
  secondSource,
  firstDraft,
  secondDraft,
  sourceBody,
} from './rd05a-replay.js'

export async function setupRd05a(env: ProductionAcceptance) {
  await env.start()
  assert(env.providerOrigin)
  const colleague = await env.inviteMember('combined-colleague')
  const project = await env.api<{ id: string }>('/projects', { name: 'WhalePod combined paths' })
  await env.cli([
    'workspace',
    'add',
    env.workspaceDir,
    '--name',
    'acceptance',
    '--state-dir',
    env.stateDir,
  ])
  await env.cli(
    ['secret', 'set', 'deepseek-official', 'acceptance', '--state-dir', env.stateDir],
    randomBytes(24).toString('base64url') + '\n',
  )
  await env.cli([
    'coordination',
    'configure',
    '--state-dir',
    env.stateDir,
    '--owner-user-id',
    env.owner.userId,
    '--billing-user-id',
    env.owner.userId,
    '--provider',
    'replay',
    '--model',
    'combined-replay',
    '--slot',
    'acceptance',
    '--endpoint',
    env.providerOrigin + '/discovery/chat/completions',
  ])
  await env.cli(
    ['coordination', 'secret', 'set', 'replay', 'acceptance', '--state-dir', env.stateDir],
    randomBytes(24).toString('base64url') + '\n',
  )
  const { configRevision } = JSON.parse(
    await readFile(join(env.stateDir, 'coordination.json'), 'utf8'),
  ) as { configRevision: string }
  env.startNode(env.providerOrigin)
  await env.waitCoordinationInventory()
  await until('combined workspace inventory', async () =>
    (await env.api<{ name: string }[]>('/workspaces')).find((row) => row.name === 'acceptance'),
  )
  await env.api(`/projects/${project.id}/router/config`, {
    enabled: true,
    deviceId: env.deviceId,
    operatorUserId: env.owner.userId,
    billingUserId: env.owner.userId,
    credentialSlot: 'acceptance',
    credentialConfigRevision: configRevision,
    provider: 'replay',
    model: 'combined-replay',
    teamDailyCallLimit: 40,
    projectDailyCallLimit: 40,
    teamDailyTokenLimit: 2_000_000,
    projectDailyTokenLimit: 2_000_000,
    teamDailyCostMicrosLimit: 100_000,
    projectDailyCostMicrosLimit: 100_000,
    maxInputTokens: 128_000,
    maxOutputTokens: 1024,
    maxCostMicros: 1000,
    inputPriceMicrosPerMillionTokens: 1,
    outputPriceMicrosPerMillionTokens: 1,
    timeoutSeconds: 30,
    maxRetries: 0,
  })
  const pack = (await env.api<{ id: string; name: string }[]>('/plugin-packs')).find(
    (row) => row.name === 'core-empty',
  )
  assert(pack, 'core-empty production pack missing')
  const agent = await env.api<{ id: string }>('/agents', {
    name: 'Combined draft executor',
    persona: 'Read the exact available inputs and prepare a private draft.',
    provider: 'deepseek-official',
    model: 'deepseek-v4-flash',
    credentialSlot: 'acceptance',
    pluginPackId: pack.id,
    approvalPolicy: 'approval_required',
    maxTokens: 2048,
    inputPriceMicrosPerMillionTokens: 1,
    outputPriceMicrosPerMillionTokens: 1,
  })
  const task = (title: string) =>
    env.api<{ id: string }>(`/projects/${project.id}/tasks`, {
      title,
      assigneeUserId: env.owner.userId,
    })
  const venue = await task('Existing accessible venue plan')
  const discussion = await task('Preparation discussion')
  await env.api(`/tasks/${venue.id}/accept`, {})
  const agreement = await env.api<{ draftVersion: number }>(`/tasks/${venue.id}/agreement/draft`, {
    content: {
      goal: 'Maintain venue seating and signage',
      constraints: 'Venue plan only; draft outputs',
      acceptance: 'Traceable accessible seating',
      openQuestions: '',
    },
  })
  await env.api(`/tasks/${venue.id}/agreement/confirm`, { draftVersion: agreement.draftVersion })
  await env.api(`/tasks/${venue.id}`, { agreementEnabled: true }, { method: 'PATCH' })
  const work = await env.api<{ workKey: string }>(`/tasks/${venue.id}/works`, {
    goal: 'Maintain the accessible venue plan',
  })
  const mandate = await env.api<{ id: string }>(`/works/${work.workKey}/mandates`, {
    autoDispatch: 'existing_task',
    allowedAgentIds: [agent.id],
    allowedToolNames: ['write'],
    allowedActionClasses: ['draft'],
    allowedSourceTypes: ['task_message'],
    maxRunsPerWork: 3,
    maxAttempts: 3,
    expiresAt: new Date(Date.now() + 3600_000).toISOString(),
  })
  const subscription = await env.api<{ id: string }>(`/works/${work.workKey}/subscriptions`, {
    targetType: 'task',
    targetRef: venue.id,
  })
  const { db } = env.database
  const runRows = (taskId: string) =>
    db
      .select({ ...getTableColumns(schema.runs), projectId: schema.tasks.projectId })
      .from(schema.runs)
      .innerJoin(schema.tasks, eq(schema.tasks.id, schema.runs.taskId))
      .where(eq(schema.runs.taskId, taskId))
      .orderBy(asc(schema.runs.createdAt))
  const artifactsFor = (runId: string) =>
    db.select().from(schema.artifacts).where(eq(schema.artifacts.runId, runId))
  return {
    colleague,
    agent,
    project,
    venue,
    discussion,
    work,
    mandate,
    subscription,
    db,
    runRows,
    artifactsFor,
  }
}

export type Rd05aFixture = Awaited<ReturnType<typeof setupRd05a>>

export function observeRd05aAdmission(
  actual: { inboxItemId: string | null; subscriptionId: string | null },
  expected: { inboxItemId: string; subscriptionId: string },
) {
  assert.equal(actual.inboxItemId, expected.inboxItemId, 'admission delivered another inbox item')
  assert.equal(
    actual.subscriptionId,
    expected.subscriptionId,
    'admission used another subscription',
  )
  assert(actual.inboxItemId && actual.subscriptionId)
  return { admissionItemId: actual.inboxItemId, admissionSubscriptionId: actual.subscriptionId }
}

export async function driveFast(
  env: ProductionAcceptance,
  replay: Rd05aReplay,
  fixture: Rd05aFixture,
) {
  const { colleague, project, venue, work, subscription, db, runRows, artifactsFor } = fixture
  const admissions = () =>
    db
      .select()
      .from(schema.workEntryAdmissions)
      .where(eq(schema.workEntryAdmissions.workKey, work.workKey))
  const inbox = () =>
    db.select().from(schema.workInboxItems).where(eq(schema.workInboxItems.workKey, work.workKey))
  const post = (body: string, idempotencyKey = randomUUID()) =>
    env.api<{ id: string }>(
      `/tasks/${venue.id}/comments`,
      { body },
      { actor: env.owner, idempotencyKey },
    )
  const first = await post(firstSource)
  const duplicateKey = randomUUID()
  const second = await post(secondSource, duplicateKey)
  const duplicate = await post(secondSource, duplicateKey)
  assert.equal(duplicate.id, second.id)
  const items = await inbox()
  const firstItem = items.find((row) => row.sourceId === first.id)
  const secondItem = items.find((row) => row.sourceId === second.id)
  const admission = (await admissions()).find((row) => row.sourceId === second.id)
  assert(firstItem && secondItem && admission)
  replay.itemIds = { first: firstItem.id, second: secondItem.id }
  replay.resolveFastRuns = async () => {
    const rows = await runRows(venue.id)
    return { first: rows[0]?.id ?? '', second: rows[1]?.id ?? '' }
  }
  const ingress = {
    sourceId: second.id,
    itemId: secondItem.id,
    sourceVersion: secondItem.sourceVersion,
    sourceDigest: secondItem.sourceDigest,
    subscriptionId: subscription.id,
    ...observeRd05aAdmission(admission, {
      inboxItemId: secondItem.id,
      subscriptionId: subscription.id,
    }),
    outcome: admission.outcome,
    reason: admission.reason,
    routerInvoked: admission.routerInvoked,
    routerCalls: replay.routerCalls.length,
    routerRows: (await db.select().from(schema.workEntryRouterCalls)).length,
    status: secondItem.status,
    duplicateSourceId: duplicate.id,
    admissionCount: (await admissions()).filter((row) => row.sourceId === second.id).length,
    runCount: (await runRows(venue.id)).length,
  }
  assert.equal(ingress.routerCalls, 0)
  assert.equal(ingress.routerRows, 0)
  assert.equal(ingress.runCount, 0)
  const bootstrap = await env.api<{
    proposedIntent: { id: string; runId: string; status: string; statusReason: string | null }
  }>(`/works/${work.workKey}/admission-checks`, { sourceType: 'task_message', sourceId: first.id })
  assert.equal(
    bootstrap.proposedIntent?.status,
    'dispatched',
    bootstrap.proposedIntent?.statusReason ?? 'bootstrap not dispatched',
  )
  const running = await until(
    'bootstrap waiting at publication barrier',
    async () => {
      replay.assertHealthy()
      const [run] = await runRows(venue.id)
      assert.notEqual(run?.status, 'failed', run?.failureCode ?? 'bootstrap failed')
      return replay.firstFinal && run?.status === 'running' ? run : undefined
    },
    60_000,
  )
  const firstSnapshot = running.workInputManifestDigest
  assert.equal((await inbox()).find((row) => row.id === secondItem.id)?.status, 'pending')
  assert.equal(replay.routerCalls.length, 0)
  const firstArtifact = await until(
    'bootstrap candidate through production collector',
    async () => (await artifactsFor(running.id))[0],
  )
  await env.api(`/artifacts/${firstArtifact.id}/publish`, {})
  const publicResponse = await env.request(`/artifacts/${firstArtifact.id}/content`, undefined, {
    actor: colleague,
  })
  assert.equal(publicResponse.status, 200)
  assert.equal(sha256(await publicResponse.text()), sha256(firstDraft))
  replay.releaseFirstFinal()
  const next = await until(
    'automatic boundary continuation completed',
    async () => {
      replay.assertHealthy()
      const rows = await runRows(venue.id)
      assert(rows.length <= 2, 'extra existing-work Run')
      assert.notEqual(rows[1]?.status, 'failed', rows[1]?.failureCode ?? 'continuation failed')
      return rows[1]?.status === 'completed' ? rows[1] : undefined
    },
    60_000,
  )
  const draft = await until('continuation draft', async () => (await artifactsFor(next.id))[0])
  const ownerResponse = await env.request(`/artifacts/${draft.id}/content`)
  assert.equal(ownerResponse.status, 200)
  const downloadedDigest = sha256(await ownerResponse.text())
  assert.equal(downloadedDigest, sha256(secondDraft))
  const memberResponse = await env.request(`/artifacts/${draft.id}/content`, undefined, {
    actor: colleague,
  })
  assert.equal(memberResponse.status, 404)
  await memberResponse.body?.cancel()
  const wait = await until(
    'boundary wait without a third Run',
    async () => {
      replay.assertHealthy()
      assert.equal((await runRows(venue.id)).length, 2)
      const rows = await db
        .select()
        .from(schema.workWaits)
        .where(eq(schema.workWaits.workKey, work.workKey))
      return rows.find((row) => row.status === 'open')
    },
    45_000,
  )
  const runs = await runRows(venue.id)
  const runIds = runs.map((row) => row.id)
  const [boundaries, receipts, consumptions, intents, evaluations, usage] = await Promise.all([
    db
      .select()
      .from(schema.workRunBoundaries)
      .where(eq(schema.workRunBoundaries.workKey, work.workKey))
      .orderBy(asc(schema.workRunBoundaries.createdAt)),
    db
      .select()
      .from(schema.runWorkInputReceipts)
      .where(inArray(schema.runWorkInputReceipts.runId, runIds)),
    db
      .select()
      .from(schema.workInputConsumptions)
      .where(inArray(schema.workInputConsumptions.runId, runIds)),
    db
      .select()
      .from(schema.dispatchIntents)
      .where(eq(schema.dispatchIntents.workKey, work.workKey)),
    db
      .select()
      .from(schema.coordinationEvaluations)
      .where(
        and(
          eq(schema.coordinationEvaluations.workKey, work.workKey),
          eq(schema.coordinationEvaluations.purpose, 'router'),
        ),
      ),
    db
      .select()
      .from(schema.executorUsageLedger)
      .where(inArray(schema.executorUsageLedger.runId, runIds)),
  ])
  assert.equal(runs[0]!.workInputManifestDigest, firstSnapshot)
  assert.equal(replay.routerCalls.length, 2)
  const [published] = await artifactsFor(running.id)
  assert.equal(published?.status, 'published')
  return {
    first,
    second,
    firstItem,
    secondItem,
    ingress,
    bootstrap,
    firstSnapshot,
    runs,
    firstArtifact: published!,
    publicHttp: publicResponse.status,
    draft,
    downloadedDigest,
    memberHttp: memberResponse.status,
    wait,
    boundaries,
    receipts,
    consumptions,
    intents,
    evaluations,
    usage,
    inbox: await inbox(),
    tasksBeforeDiscovery: (
      await db.select().from(schema.tasks).where(eq(schema.tasks.projectId, project.id))
    ).length,
  }
}

export async function prepareSlow(
  env: ProductionAcceptance,
  replay: Rd05aReplay,
  fixture: Rd05aFixture,
  publicArtifact: { id: string; sha256: string },
  slot: string,
  additionalAgreementTaskIds: string[] = [],
) {
  const { colleague, project, venue, discussion, db } = fixture
  const base = `/projects/${project.id}/discovery`
  const { configVersion, slotId } = await env.api<{ configVersion: number; slotId: string }>(
    base + '/config',
    {
      enabled: true,
      entryTaskId: discussion.id,
      principalUserId: env.owner.userId,
      activity: 'Accessible event',
      slot,
      templateVersion: 'combined-v1',
      expiresAt: new Date(Date.now() + 3600_000).toISOString(),
      maxCalls: 6,
      maxTokens: 200_000,
      maxCostMicros: 1000,
      agreementTaskIds: [venue.id, ...additionalAgreementTaskIds],
      evidenceArtifactIds: [publicArtifact.id],
      tier: 'execute',
      template: {
        goal: 'Prepare {{slot}} for {{activity}}',
        constraints: 'Use approved source {{sourceId}}',
        acceptance: 'Produce private {{slot}}',
        openQuestions: '',
      },
      verifierUserIds: [env.owner.userId],
      maxCreations: 1,
    },
  )
  const { templateDigest } = await env.api<{ templateDigest: string }>(base + '/config')
  await env.api(base + '/permit', { configVersion, tier: 'execute', templateDigest })
  await env.api(base + '/participation', { configVersion }, { actor: colleague })
  const slotUrl = base + '/slots/' + slotId
  const { catalog } = await env.api<{ catalog: { digest: string; entries: { taskId: string }[] } }>(
    slotUrl,
  )
  const verification = await env.api<{ eligibleEmpty: boolean }>(slotUrl + '/verify', {
    catalogDigest: catalog.digest,
    complete: true,
    entries: catalog.entries.map(({ taskId }) => ({ taskId, coverage: 'not_covered' })),
  })
  assert(verification.eligibleEmpty)
  replay.stage = 'discovery'
  const idempotencyKey = randomUUID()
  const source = await env.api<{ id: string }>(
    `/tasks/${discussion.id}/comments`,
    { body: sourceBody },
    { actor: colleague, idempotencyKey },
  )
  const repeated = await env.api<{ id: string }>(
    `/tasks/${discussion.id}/comments`,
    { body: sourceBody },
    { actor: colleague, idempotencyKey },
  )
  assert.equal(source.id, repeated.id)
  const application = await until(
    'discovery automatically created a new task',
    async () => {
      replay.assertHealthy()
      const [row] = await db
        .select()
        .from(schema.discoveryApplications)
        .where(eq(schema.discoveryApplications.sourceId, source.id))
      return row
    },
    60_000,
  )
  assert.equal(application.status, 'applied')
  assert(application.taskId && application.workId)
  const executionUrl = base + '/applications/' + application.id + '/execution'
  const basis = await env.api<DiscoveryExecutionBasis>(executionUrl)
  assert(basis.eligible && basis.execution === null)
  replay.slow.allowedSources = basis.sources.map((entry) => ({
    ...entry,
    body: entry.kind === 'task_message' ? sourceBody : replay.slow.fixturePublicBody,
    title: entry.kind === 'task_message' ? 'Authorized discussion' : 'Published evidence',
  }))
  return {
    base,
    configVersion,
    slotId,
    catalogDigest: catalog.digest,
    source,
    repeated,
    application,
    executionUrl,
    basis,
  }
}

export function executorIdentity(origin: string) {
  return {
    provider: 'deepseek-official',
    model: 'deepseek-v4-flash',
    endpoint: new URL('/chat/completions', origin).toString(),
    account: 'acceptance-replay',
    policyGeneration: 1,
  }
}

export async function readStatus(env: ProductionAcceptance, path: string, actor?: AcceptanceActor) {
  const response = await env.request(path, undefined, actor ? { actor } : {})
  const body = await response.text()
  return { status: response.status, body }
}
