#!/usr/bin/env tsx
/** RD-04c2: real Hub, PostgreSQL, Node and DSH; only loopback model replies are replayed. */
import assert from 'node:assert/strict'
import { randomBytes, randomUUID } from 'node:crypto'
import { lstat, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { schema } from '@whalepod/db'
import { eq } from 'drizzle-orm'
import WebSocket from 'ws'
import { fingerprintProductionAssembly, sha256 } from './lib/acceptance-provenance.js'
import {
  ProductionAcceptance,
  repoRoot,
  until,
  type AcceptanceActor,
} from './lib/production-acceptance.js'
import {
  Rd04c2Replay,
  publicBody,
  sourceBody,
  publicPrompt,
  privateMarker,
} from './lib/rd04c2-replay.js'
import { verifyRd04c2 } from './verify-rd04c2-acceptance.js'

const replay = new Rd04c2Replay()
const executor = (origin: string) => ({
  provider: 'deepseek-official',
  model: 'deepseek-v4-flash',
  endpoint: new URL('/chat/completions', origin).toString(),
  account: 'acceptance-replay',
  policyGeneration: 1,
})
const env = new ProductionAcceptance(
  (request, response) => void replay.respond(request, response),
  executor,
)
const sockets: WebSocket[] = []
const afterRun = 'RD04C2_PUBLIC_SENTINEL_AFTER'
const beforeRun = 'RD04C2_PUBLIC_SENTINEL_BEFORE'
const revokeBeforeRead = process.argv.includes('--revoke-before-read')
const out = join(
  repoRoot,
  'artifacts/evidence/rd04c2',
  ...(revokeBeforeRead ? ['revoke-before-read'] : []),
)
const resultPath = join(out, 'result.json')
const eventsPath = join(out, 'events.jsonl')

type ExactSource = {
  kind: 'task_message' | 'artifact' | 'receipt'
  sourceId: string
  sourceVersion: string
  sourceDigest: string
  authorizationGeneration: string
}
interface Basis {
  eligible: boolean
  sourceManifestDigest: string
  sources: ExactSource[]
  execution: null | {
    id: string
    status: string
    purpose: string
    sourceManifestDigest: string
  }
}

async function browserSocket(member: AcceptanceActor, cursor = 0) {
  const url = env.origin.replace(/^http:/, 'ws:') + '/ws/v1/client?cursor=' + cursor
  const socket = new WebSocket(url, {
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

async function privateDirectoryNames(runId: string): Promise<string[]> {
  try {
    return (await readdir(join(env.stateDir, 'runtime-home', runId))).filter(
      (name) => name.startsWith('discovery-workspace-') || name.startsWith('discovery-inputs-'),
    )
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw error
  }
}

async function checkPrivateWorkspaceCleanup(runId: string) {
  await assert.rejects(lstat(join(env.workspaceDir, '.whalepod', 'drafts', runId + '.md')), {
    code: 'ENOENT',
  })
  await until('private Run directories removed after child exit', async () =>
    (await privateDirectoryNames(runId)).length === 0 ? true : undefined,
  )
  return true
}

async function drive() {
  await env.start()
  assert(env.providerOrigin)
  const colleague = await env.inviteMember('acceptance-colleague')
  const project = await env.api<{ id: string }>('/projects', { name: 'RD-04c2 Acceptance' })
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
  env.startNode(env.providerOrigin)
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
    model: executor(env.providerOrigin).model,
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
  assert.equal(publicDigest, sha256(publicBody))

  await env.api(`/projects/${project.id}/router/config`, {
    enabled: true,
    deviceId: env.deviceId,
    operatorUserId: env.owner.userId,
    billingUserId: env.owner.userId,
    credentialSlot: 'acceptance',
    credentialConfigRevision: configRevision,
    provider: 'replay',
    model: 'discovery-replay',
    teamDailyCallLimit: 20,
    projectDailyCallLimit: 20,
    teamDailyTokenLimit: 500_000,
    projectDailyTokenLimit: 500_000,
    teamDailyCostMicrosLimit: 10_000,
    projectDailyCostMicrosLimit: 10_000,
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
  await env.api(base + '/permit', { configVersion, tier: 'execute', templateDigest })
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
  const source = await post(sourceBody)
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
  const basis = await env.api<Basis>(executionUrl)
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
      return { ...entry, body: sourceBody, title: 'Authorized discussion' }
    }
    assert.equal(entry.sourceId, publicArtifact.id)
    assert.equal(entry.sourceVersion, publicDigest)
    assert.equal(entry.sourceDigest, publicDigest)
    return { ...entry, body: publicBody, title: 'Published evidence' }
  })
  const authorization = {
    sourceManifestDigest: basis.sourceManifestDigest,
    executor: executor(env.providerOrigin),
    expiresAt: new Date(Date.now() + 30 * 60_000).toISOString(),
    confirmsPrivateDraft: true,
  }
  const unauthorized = await env.request(executionUrl, authorization, { actor: colleague })
  assert.equal(unauthorized.status, 404)
  await unauthorized.body?.cancel()
  const wrongRoute = await env.request(executionUrl, {
    ...authorization,
    executor: { ...authorization.executor, account: 'unapproved-replay-account' },
  })
  assert.equal(wrongRoute.status, 409)
  await wrongRoute.body?.cancel()
  const before = await rowsForTask(application.taskId)
  assert.equal(before.length, 0, 'the new task must not run before authorization')
  const live = await browserSocket(colleague)
  const beforeSentinel = await post(beforeRun, venue.id)
  await until('member observed the public before-run sentinel over WebSocket', async () =>
    live.frames.some(
      (frame) => frame.includes('"comment.created"') && frame.includes(beforeSentinel.id),
    )
      ? true
      : undefined,
  )
  let negative: { runId: string; delivery: number; correctionHttp: number } | undefined
  let privateDirectoriesObserved = 0
  replay.beforePrivateRead = async () => {
    const [run] = await rowsForTask(application.taskId)
    assert(run, 'replay must belong to a committed Run')
    privateDirectoriesObserved = (await privateDirectoryNames(run.id)).length
    assert.equal(
      privateDirectoriesObserved,
      2,
      'Run must use separate private scratch and input directories',
    )
    if (revokeBeforeRead) {
      const delivered = await until(
        'actual DSH delivery before source correction',
        async () => {
          const [run] = await rowsForTask(application.taskId)
          if (!run) return undefined
          const rows = await db
            .select()
            .from(schema.runWorkInputReceipts)
            .where(eq(schema.runWorkInputReceipts.runId, run.id))
          const receipt = rows.find(
            (entry) => entry.entriesDelivered.length === basis.sources.length,
          )
          return receipt ? { runId: run.id, delivery: receipt.entriesDelivered.length } : undefined
        },
        10_000,
      )
      const correction = await env.request(
        base + '/sources/' + source.id + '/correct',
        {
          body: 'RD04C2_CORRECTED: The ramp position has changed. Do not reuse the previous survey instruction.',
        },
        { actor: colleague },
      )
      assert.equal(correction.status, 200, 'production correction was refused')
      await correction.body?.cancel()
      negative = { ...delivered, correctionHttp: correction.status }
    }
  }
  replay.phase = 'private'
  const idempotencyKey = randomUUID()
  const [authorized, concurrent] = await Promise.all([
    env.api<Basis>(executionUrl, authorization, { idempotencyKey }),
    env.api<Basis>(executionUrl, authorization, { idempotencyKey }),
  ])
  assert(authorized.execution, 'no execution authorization was persisted')
  assert.equal(concurrent.execution?.id, authorized.execution.id)
  if (revokeBeforeRead) {
    const run = await until(
      'revoked discovery Run stopped without draft',
      async () => {
        replay.assertHealthy()
        const rows = await rowsForTask(application.taskId)
        assert(rows.length <= 1)
        const [row] = rows
        assert(row?.status !== 'completed', 'revoked discovery Run completed')
        return row && ['failed', 'cancelled'].includes(row.status) ? row : undefined
      },
      60_000,
    )
    assert(negative && negative.runId === run.id)
    const receipts = await db
      .select()
      .from(schema.runWorkInputReceipts)
      .where(eq(schema.runWorkInputReceipts.runId, run.id))
    const [basisAfter, drafts] = await Promise.all([
      env.api<Basis>(executionUrl),
      artifactsFor(run.id),
    ])
    const reads = receipts.flatMap((row) => row.entriesRead)
    return {
      result: {
        schemaVersion: 1,
        mode: 'revoke_before_first_read',
        ...negative,
        runStatus: run.status,
        executionId: run.discoveryExecutionId,
        executionStatus: basisAfter.execution?.status,
        authorizedExecutionId: authorized.execution.id,
        privateRequests: replay.privateRequests,
        toolResults: replay.privateReads.length,
        drafts: drafts.length,
        reads: reads.length,
        privateDirectoriesObserved,
        workspaceClean: await checkPrivateWorkspaceCleanup(run.id),
      },
      events: receipts.map((row) => ({
        component: 'hub.work_input',
        type: 'work_input.receipt',
        runId: row.runId,
        delivered: row.entriesDelivered,
        read: row.entriesRead,
        digestVerified: row.digestVerified,
        missing: row.missing,
      })),
    }
  }
  const authorizedAgain = await env.api<Basis>(executionUrl, authorization, { idempotencyKey })
  assert.equal(authorizedAgain.execution?.id, authorized.execution.id)
  const run = await until(
    'authorized new task auto-dispatched and completed',
    async () => {
      replay.assertHealthy()
      const rows = await rowsForTask(application.taskId)
      assert(rows.length <= 1, 'authorization replay dispatched more than one Run')
      const [row] = rows
      if (row?.status === 'failed' || row?.status === 'cancelled')
        throw new Error('private Run ended as ' + row.status + ': ' + row.failureCode)
      return row?.status === 'completed' ? row : undefined
    },
    60_000,
  )
  assert.equal(run.origin, 'mandate')
  assert.equal(run.onBehalfOfUserId, env.owner.userId)
  assert(
    run.dispatchIntentId && run.mandateId && run.workInputManifest && run.workInputManifestDigest,
  )
  assert.equal(run.specRevisionId, application.specRevisionId)
  const receipts = await until('all exact source reads recorded by Hub', async () => {
    const rows = await db
      .select()
      .from(schema.runWorkInputReceipts)
      .where(eq(schema.runWorkInputReceipts.runId, run.id))
    return rows.some((row) => row.entriesRead.length === basis.sources.length) ? rows : undefined
  })
  const [draft] = await artifactsFor(run.id)
  assert(draft?.status === 'candidate', 'DSH did not produce an unpublished candidate')
  const draftPath = `/artifacts/${draft.id}/content`
  const draftResponse = await env.request(draftPath)
  assert.equal(draftResponse.status, 200)
  const draftCache = draftResponse.headers.get('cache-control')
  assert.equal(draftCache, 'private, no-store')
  const draftDigest = sha256(await draftResponse.text())
  assert.equal(draftDigest, replay.privateDraftDigest)
  const hidden = await env.request(draftPath, undefined, { actor: colleague })
  assert.equal(hidden.status, 404)
  await hidden.body?.cancel()
  const http = await Promise.all([
    env.request(`/runs/${run.id}`, undefined, { actor: colleague }),
    env.request(`/runs/${run.id}/events`, undefined, { actor: colleague }),
    env.request(`/tasks/${application.taskId}`, undefined, { actor: colleague }),
  ])
  const httpBodies = await Promise.all(http.map((item) => item.text()))
  const memberHttp = http.map((response) => response.status)
  assert.deepEqual(memberHttp, [404, 404, 200])
  const ownerChecks = await Promise.all([
    env.request(`/runs/${run.id}`),
    env.request(`/runs/${run.id}/events`),
    env.request(`/artifacts/${draft.id}/preview-info`),
    env.request(`/runs/${run.id}/handoff-draft`),
  ])
  const ownerHttp = ownerChecks.map((response) => response.status)
  assert.deepEqual(ownerHttp, [200, 404, 404, 404])
  await Promise.all(ownerChecks.map((response) => response.body?.cancel()))
  const publish = await env.request(`/artifacts/${draft.id}/publish`, {})
  assert(
    [403, 404, 409].includes(publish.status),
    'private candidate must not be formally publishable',
  )
  await publish.body?.cancel()
  const afterSentinel = await post(afterRun, venue.id)
  await until('member observed the public after-run sentinel over WebSocket', async () =>
    live.frames.some(
      (frame) => frame.includes('"comment.created"') && frame.includes(afterSentinel.id),
    )
      ? true
      : undefined,
  )
  const history = await browserSocket(colleague)
  await until('member observed both sentinels on replay', async () =>
    [beforeSentinel.id, afterSentinel.id].every((marker) =>
      history.frames.some((frame) => frame.includes(marker)),
    )
      ? true
      : undefined,
  )
  const sawRun = (frames: string[]) =>
    frames.some((frame) => frame.includes('"run.changed"') && frame.includes(run.id))
  assert(
    sawRun(live.frames) && sawRun(history.frames),
    'missing private Run status control on WebSocket',
  )
  const visibility = [httpBodies, live.frames, history.frames].map((items) => ({
    observed: items.length,
    leaks: items.filter((item) => item.includes(privateMarker)).length,
  }))
  assert(visibility.every((surface) => surface.observed > 0 && surface.leaks === 0))
  const workspaceClean = await checkPrivateWorkspaceCleanup(run.id)
  const revoke = await env.request(executionUrl, undefined, { method: 'DELETE' })
  assert.equal(revoke.status, 200)
  await revoke.body?.cancel()
  const hiddenAfterRevoke = await env.request(draftPath)
  assert.equal(hiddenAfterRevoke.status, 404)
  await hiddenAfterRevoke.body?.cancel()
  const roomAfterRevoke = await env.request(`/tasks/${application.taskId}`)
  assert.equal(roomAfterRevoke.status, 200)
  const ownerRoomHasRevokedTitle = (await roomAfterRevoke.text()).includes(privateMarker)
  assert.equal(ownerRoomHasRevokedTitle, false)
  replay.assertHealthy()
  const finalRows = await rowsForTask(application.taskId)
  assert.equal(finalRows.length, 1)
  const projected = await db
    .select()
    .from(schema.runEvents)
    .where(eq(schema.runEvents.runId, run.id))
  const events = [
    ...receipts.map((row) => ({
      component: 'hub.work_input',
      runId: row.runId,
      type: 'work_input.receipt',
      manifestDigest: row.manifestDigest,
      digestVerified: row.digestVerified,
      receiptSeq: row.receiptSeq,
      delivered: row.entriesDelivered,
      read: row.entriesRead,
      readEvents: row.readEvents,
      missing: row.missing,
    })),
    ...projected.map((row) => ({
      component: 'hub.run',
      runId: row.runId,
      type: row.type,
      audience: row.audience,
      seq: row.seq,
    })),
  ]
  return {
    events,
    result: {
      schemaVersion: 1,
      mode: 'loopback_model_replay',
      projectId: project.id,
      discussionTaskId: discussion.id,
      comparisonTaskId: venue.id,
      taskId: application.taskId,
      specRevisionId: application.specRevisionId,
      applicationId: application.id,
      evaluationId: application.evaluationId,
      sourceId: source.id,
      beforeAuthorizationRuns: before.length,
      unauthorizedHttp: unauthorized.status,
      unapprovedRouteHttp: wrongRoute.status,
      authorization: authorized.execution,
      repeatExecutionId: authorizedAgain.execution?.id,
      concurrentExecutionId: concurrent.execution?.id,
      authorizedSources: basis.sources,
      run: {
        count: finalRows.length,
        id: run.id,
        taskId: run.taskId,
        origin: run.origin,
        status: run.status,
        dispatchIntentId: run.dispatchIntentId,
        mandateId: run.mandateId,
        specRevisionId: run.specRevisionId,
        manifestDigest: run.workInputManifestDigest,
        approvalPolicy: run.approvalPolicy,
        executionId: run.discoveryExecutionId,
        entries: run.workInputManifest.entries.map((entry) => ({
          inboxItemId: entry.inboxItemId,
          sourceType: entry.sourceType,
          sourceId: entry.sourceId,
          sourceVersion: entry.sourceVersion,
          sourceDigest: entry.sourceDigest,
          bodyDigest: entry.bodyDigest,
          authorizationGeneration: entry.authorizationGeneration,
        })),
      },
      replay: {
        publicRequests: replay.publicRequests,
        discoveryRequests: replay.discoveryRequests,
        privateRequests: replay.privateRequests,
        reads: replay.privateReads,
        draftDigest: replay.privateDraftDigest,
      },
      publicArtifact: {
        id: publicArtifact.id,
        memberHttp: publicResponse.status,
        sha256: publicDigest,
      },
      draft: {
        id: draft.id,
        runId: draft.runId,
        status: draft.status,
        sha256: draft.sha256,
        ownerDownloadDigest: draftDigest,
        ownerHttp: draftResponse.status,
        cacheControl: draftCache,
        memberHttp: hidden.status,
        publishHttp: publish.status,
      },
      ownerHttp,
      memberHttp,
      visibility,
      privateDirectoriesObserved,
      workspaceClean,
      revocation: { ownerHttp: hiddenAfterRevoke.status, ownerRoomHasRevokedTitle },
    },
  }
}

let stopping = false
async function stop() {
  if (stopping) return
  stopping = true
  for (const socket of sockets) socket.terminate()
  await env.stop()
}
process.once('SIGTERM', () => void stop().finally(() => process.exit(143)))
process.once('SIGINT', () => void stop().finally(() => process.exit(130)))
try {
  await mkdir(out, { recursive: true })
  await Promise.all(
    [resultPath, eventsPath, join(out, 'failure.log')].map((path) => rm(path, { force: true })),
  )
  const assemblyDigest = await fingerprintProductionAssembly(repoRoot)
  const { result, events } = await drive()
  assert.equal(
    await fingerprintProductionAssembly(repoRoot),
    assemblyDigest,
    'production packages changed during acceptance',
  )
  const eventBytes = events.map((event) => JSON.stringify(event)).join('\n') + '\n'
  await writeFile(eventsPath, eventBytes)
  await writeFile(
    resultPath,
    JSON.stringify(
      {
        ...result,
        provenance: { assemblyDigest, eventsDigest: sha256(eventBytes) },
      },
      null,
      2,
    ) + '\n',
  )
  await verifyRd04c2(resultPath, assemblyDigest)
  console.log('RD-04c2 production acceptance PASS')
} catch (error) {
  await rm(resultPath, { force: true })
  const message = env.redact(error instanceof Error ? error.message : String(error))
  await writeFile(join(out, 'failure.log'), message + '\n' + env.diagnostics() + '\n')
  console.error(message)
  process.exitCode = 1
} finally {
  await stop()
}
