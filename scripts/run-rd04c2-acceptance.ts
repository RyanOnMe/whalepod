#!/usr/bin/env tsx
/** RD-04c2: real Hub, PostgreSQL, Node and DSH; only loopback model replies are replayed. */
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { lstat, mkdir, readdir, rm, writeFile } from 'node:fs/promises'
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
import { Rd04c2Replay, privateMarker, toolErrorMarker } from './lib/rd04c2-replay.js'
import { bindToolErrorFollowup } from './lib/rd04c2-tool-error.js'
import {
  prepareDiscoveryDraftFixture,
  type DiscoveryExecutionBasis as Basis,
} from './lib/discovery-draft-fixture.js'
import { verifyRd04c2 } from './verify-rd04c2-acceptance.js'

const toolErrorFollowup = process.argv.includes('--tool-error-followup')
const revokeBeforeRead = process.argv.includes('--revoke-before-read')
assert(!(toolErrorFollowup && revokeBeforeRead), 'follow-up and revocation are separate scenarios')
const followupBinding = toolErrorFollowup ? await bindToolErrorFollowup(repoRoot) : undefined
const replay = new Rd04c2Replay(undefined, undefined, toolErrorFollowup)
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
const out = join(
  repoRoot,
  'artifacts/evidence/rd04c2',
  ...(followupBinding
    ? ['tool-error-followup', followupBinding.commit]
    : revokeBeforeRead
      ? ['revoke-before-read']
      : []),
)
const resultPath = join(out, 'result.json')
const eventsPath = join(out, 'events.jsonl')

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
  const {
    colleague,
    project,
    venue,
    discussion,
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
  } = await prepareDiscoveryDraftFixture(env, replay)
  assert(env.providerOrigin)
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
  const surfaces = ['http', 'ws_live', 'ws_replay']
  const visibility = [httpBodies, live.frames, history.frames].map((items, index) => ({
    observed: items.length,
    leaks: items.filter((item) => item.includes(privateMarker)).length,
    ...(toolErrorFollowup
      ? {
          surface: surfaces[index],
          toolErrorLeaks: items.filter((item) => item.includes(toolErrorMarker)).length,
        }
      : {}),
  }))
  assert(visibility.every((surface) => surface.observed > 0 && surface.leaks === 0))
  if (toolErrorFollowup) assert(visibility.every((surface) => surface.toolErrorLeaks === 0))
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
    ...(toolErrorFollowup
      ? replay.toolErrors.map((error) => ({
          component: 'acceptance.replay',
          type: 'tool_error.observed',
          runId: run.id,
          ...error,
        }))
      : []),
  ]
  return {
    events,
    result: {
      schemaVersion: toolErrorFollowup ? 2 : 1,
      mode: toolErrorFollowup ? 'loopback_tool_error_followup' : 'loopback_model_replay',
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
        ...(toolErrorFollowup ? { toolErrors: replay.toolErrors } : {}),
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
let ownsOutput = false
try {
  if (followupBinding) {
    await mkdir(join(out, '..'), { recursive: true })
    await mkdir(out)
    ownsOutput = true
  } else {
    await mkdir(out, { recursive: true })
    ownsOutput = true
    await Promise.all(
      [resultPath, eventsPath, join(out, 'failure.log')].map((path) => rm(path, { force: true })),
    )
  }
  const assemblyDigest = await fingerprintProductionAssembly(repoRoot)
  const { result, events } = await drive()
  assert.equal(
    await fingerprintProductionAssembly(repoRoot),
    assemblyDigest,
    'production packages changed during acceptance',
  )
  if (followupBinding)
    assert.deepEqual(
      await bindToolErrorFollowup(repoRoot),
      followupBinding,
      'follow-up harness changed',
    )
  const eventBytes = events.map((event) => JSON.stringify(event)).join('\n') + '\n'
  await writeFile(eventsPath, eventBytes, { flag: followupBinding ? 'wx' : 'w' })
  await writeFile(
    resultPath,
    JSON.stringify(
      {
        ...result,
        provenance: { assemblyDigest, eventsDigest: sha256(eventBytes), ...followupBinding },
      },
      null,
      2,
    ) + '\n',
  )
  await verifyRd04c2(resultPath, assemblyDigest, followupBinding)
  console.log('RD-04c2 production acceptance PASS')
} catch (error) {
  const message = env.redact(error instanceof Error ? error.message : String(error))
  if (ownsOutput) {
    await rm(resultPath, { force: true })
    await writeFile(join(out, 'failure.log'), message + '\n' + env.diagnostics() + '\n')
  }
  console.error(message)
  process.exitCode = 1
} finally {
  await stop()
}
