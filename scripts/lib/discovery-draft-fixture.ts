/** Shared c2/c3 setup: discovery and published controls always use real Hub/Node/DSH with local replay. */
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { schema } from '@whalepod/db'
import { eq } from 'drizzle-orm'
import { sha256 } from './acceptance-provenance.js'
import { type ProductionAcceptance, until } from './production-acceptance.js'
import { type Rd04c2Replay, publicPrompt } from './rd04c2-replay.js'

export type ExactDiscoverySource = {
  kind: 'task_message' | 'artifact' | 'receipt'
  sourceId: string
  sourceVersion: string
  sourceDigest: string
  authorizationGeneration: string
}
export interface DiscoveryExecutionBasis {
  eligible: boolean
  sourceManifestDigest: string
  sources: ExactDiscoverySource[]
  execution: null | {
    id: string
    status: string
    purpose: string
    sourceManifestDigest: string
  }
}

interface FixtureOptions {
  readonly projectName?: string
  readonly startNode?: (loopbackOrigin: string) => void
  readonly dailyLimits?: {
    readonly calls: number
    readonly tokens: number
    readonly costMicros: number
  }
  readonly permitLimits?: {
    readonly executorLimits: {
      readonly dispatches: number
      readonly calls: number
      readonly tokens: number
      readonly costMicros: number
    }
  }
}

export async function prepareDiscoveryDraftFixture(
  env: ProductionAcceptance,
  replay: Rd04c2Replay,
  options: FixtureOptions = {},
) {
  await env.start()
  assert(env.providerOrigin)
  const colleague = await env.inviteMember('acceptance-colleague')
  const project = await env.api<{ id: string }>('/projects', {
    name: options.projectName ?? 'RD-04c2 Acceptance',
  })
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
    'discovery-replay',
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
  if (options.startNode) options.startNode(env.providerOrigin)
  else env.startNode(env.providerOrigin)
  await env.waitCoordinationInventory()
  const workspace = await until('packaged Node workspace', async () =>
    (await env.api<{ workspaceId: string; deviceId: string; name: string }[]>('/workspaces')).find(
      (item) => item.name === 'acceptance',
    ),
  )
  const pack = (await env.api<{ id: string; name: string }[]>('/plugin-packs')).find(
    (entry) => entry.name === 'core-empty',
  )
  assert(pack, 'core-empty production pack missing')
  const agent = await env.api<{ id: string }>('/agents', {
    name: 'Acceptance draft executor',
    persona: 'Prepare a short draft using only the exact available inputs.',
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
  const venue = await task('Existing venue seating')
  const discussion = await task('Planning discussion')
  await env.api(`/tasks/${venue.id}/accept`, {})
  // Only the control artifact uses an explicit human Run; keep the discovery profile's
  // mandatory approval_required default while avoiding a manual write approval here.
  await env.api(`/tasks/${venue.id}`, { approvalPolicy: 'full_access' }, { method: 'PATCH' })
  const spec = await env.api<{ draftVersion: number }>(`/tasks/${venue.id}/agreement/draft`, {
    content: {
      goal: 'Plan venue seating',
      constraints: 'Only manage the existing venue seating',
      acceptance: 'Seat map recorded',
      openQuestions: '',
    },
  })
  await env.api(`/tasks/${venue.id}/agreement/confirm`, { draftVersion: spec.draftVersion })
  const { db } = env.database
  const rowsForTask = (taskId: string) =>
    db.select().from(schema.runs).where(eq(schema.runs.taskId, taskId))
  const artifactsFor = (runId: string) =>
    db.select().from(schema.artifacts).where(eq(schema.artifacts.runId, runId))
  const publicRun = await env.api<{ id: string }>(
    `/tasks/${venue.id}/runs`,
    {
      agentId: agent.id,
      deviceId: env.deviceId,
      workspaceId: workspace.workspaceId,
      prompt: publicPrompt,
    },
    { expected: 201 },
  )
  const publicArtifact = await until(
    'public artifact through the Runtime tool',
    async () => {
      replay.assertHealthy()
      const [run] = await rowsForTask(venue.id)
      if (run?.status === 'failed') {
        const evidence = await db
          .select()
          .from(schema.runEvents)
          .where(eq(schema.runEvents.runId, run.id))
        const failed = evidence.find((row) => row.type === 'run.failed')
        const detail = failed?.payload as
          | { message?: string; error?: { message?: string }; reason?: string }
          | undefined
        throw new Error(
          'public Run failed: ' +
            JSON.stringify({
              code: run.failureCode,
              replayRequests: replay.publicRequests,
              reason:
                run.failureSummary ?? detail?.message ?? detail?.error?.message ?? detail?.reason,
              projectedTypes: evidence.map((row) => row.type),
            }),
        )
      }
      if (run?.status !== 'completed') return undefined
      assert.equal(run.id, publicRun.id)
      const artifacts = await artifactsFor(run.id)
      assert.equal(artifacts.length, 1, 'public comparison must produce one candidate')
      return artifacts[0]!
    },
    60_000,
  )
  await env.api(`/artifacts/${publicArtifact.id}/publish`, {})
  const publicResponse = await env.request(`/artifacts/${publicArtifact.id}/content`, undefined, {
    actor: colleague,
  })
  assert.equal(publicResponse.status, 200)
  const publicDigest = sha256(await publicResponse.text())
  assert.equal(publicDigest, publicArtifact.sha256)
  assert.equal(publicDigest, sha256(replay.fixturePublicBody))

  await env.api(`/projects/${project.id}/router/config`, {
    enabled: true,
    deviceId: env.deviceId,
    operatorUserId: env.owner.userId,
    billingUserId: env.owner.userId,
    credentialSlot: 'acceptance',
    credentialConfigRevision: configRevision,
    provider: 'replay',
    model: 'discovery-replay',
    teamDailyCallLimit: options.dailyLimits?.calls ?? 20,
    projectDailyCallLimit: options.dailyLimits?.calls ?? 20,
    teamDailyTokenLimit: options.dailyLimits?.tokens ?? 500_000,
    projectDailyTokenLimit: options.dailyLimits?.tokens ?? 500_000,
    teamDailyCostMicrosLimit: options.dailyLimits?.costMicros ?? 10_000,
    projectDailyCostMicrosLimit: options.dailyLimits?.costMicros ?? 10_000,
    maxInputTokens: 32_000,
    maxOutputTokens: 512,
    maxCostMicros: 100,
    inputPriceMicrosPerMillionTokens: 1,
    outputPriceMicrosPerMillionTokens: 1,
    timeoutSeconds: 30,
    maxRetries: 0,
  })
  const base = `/projects/${project.id}/discovery`
  const expiresAt = new Date(Date.now() + 3600_000).toISOString()
  const { configVersion, slotId } = await env.api<{ configVersion: number; slotId: string }>(
    base + '/config',
    {
      enabled: true,
      entryTaskId: discussion.id,
      principalUserId: env.owner.userId,
      activity: 'Accessible event',
      slot: 'Shuttle boarding draft',
      templateVersion: 'acceptance-v1',
      expiresAt,
      maxCalls: 6,
      maxTokens: 200_000,
      maxCostMicros: 1000,
      agreementTaskIds: [venue.id],
      evidenceArtifactIds: [publicArtifact.id],
      tier: 'execute',
      template: {
        goal: 'Prepare {{slot}} for {{activity}}',
        constraints: 'Use the approved source {{sourceId}}',
        acceptance: 'Produce the private {{slot}}',
        openQuestions: '',
      },
      verifierUserIds: [env.owner.userId],
      maxCreations: 1,
    },
  )
  const { templateDigest } = await env.api<{ templateDigest: string }>(base + '/config')
  await env.api(base + '/permit', {
    configVersion,
    tier: 'execute',
    templateDigest,
    ...options.permitLimits,
  })
  await env.api(base + '/participation', { configVersion }, { actor: colleague })
  const slotUrl = base + '/slots/' + slotId
  const { catalog } = await env.api<{ catalog: { digest: string; entries: { taskId: string }[] } }>(
    slotUrl,
  )
  const { eligibleEmpty } = await env.api<{ eligibleEmpty: boolean }>(slotUrl + '/verify', {
    catalogDigest: catalog.digest,
    complete: true,
    entries: catalog.entries.map(({ taskId }) => ({ taskId, coverage: 'not_covered' })),
  })
  assert(eligibleEmpty, 'catalog was not verified empty for the distinct slot')
  replay.phase = 'discovery'
  const post = (body: string, taskId = discussion.id) =>
    env.api<{ id: string }>(
      `/tasks/${taskId}/comments`,
      { body },
      { actor: colleague, expected: 201 },
    )
  const source = await post(replay.fixtureSourceBody)
  const application = await until(
    'ordinary comment produced an automatic application',
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
  assert.notEqual(application.taskId, discussion.id)
  assert.notEqual(application.taskId, venue.id)
  assert.equal(application.verification.kind, 'published_evidence')
  assert.deepEqual(
    application.verification.evidence.map((entry) => entry.artifactId),
    [publicArtifact.id],
  )
  const executionUrl = base + '/applications/' + application.id + '/execution'
  const basis = await env.api<DiscoveryExecutionBasis>(executionUrl)
  assert(basis.eligible && basis.execution === null)
  assert.deepEqual(basis.sources.map((entry) => entry.kind).sort(), ['artifact', 'task_message'])
  replay.allowedSources = basis.sources.map((entry) => {
    if (entry.kind === 'task_message') {
      assert.equal(entry.sourceId, source.id)
      assert.equal(entry.sourceVersion, application.sourceVersion)
      assert.equal(
        entry.sourceDigest,
        application.sourceDigest,
        'comment identity differs from application',
      )
      return { ...entry, body: replay.fixtureSourceBody, title: 'Authorized discussion' }
    }
    assert.equal(entry.sourceId, publicArtifact.id)
    assert.equal(entry.sourceVersion, publicDigest)
    assert.equal(entry.sourceDigest, publicDigest)
    return { ...entry, body: replay.fixturePublicBody, title: 'Published evidence' }
  })
  return {
    colleague,
    project,
    venue,
    discussion,
    workspace,
    pack,
    db,
    rowsForTask,
    artifactsFor,
    publicArtifact,
    publicDigest,
    publicResponse,
    base,
    post,
    source,
    application,
    executionUrl,
    basis,
  }
}
