#!/usr/bin/env tsx
/** #532: production comment → discovery → owner-only candidate, with only the provider reply replayed. */
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { join } from 'node:path'
import { schema } from '@whalepod/db'
import { eq } from 'drizzle-orm'
import { WebSocket } from 'ws'
import { fingerprintProductionAssembly } from './lib/acceptance-provenance.js'
import { ProductionAcceptance, repoRoot, until } from './lib/production-acceptance.js'
import { setupRd04aFixture } from './lib/rd04a-fixture.js'
import { verifyRd04a, type Rd04aEvidence } from './verify-rd04a-acceptance.js'

const output = join(repoRoot, 'artifacts/evidence/rd04a')
const candidateCanary = `candidate-private-${randomUUID()}`
const sourceBody =
  'The station has no step-free route to the event venue. The survey in the confirmed venue agreement backs this up. We have no work covering accessible shuttle alternatives.'
const providerCalls: Rd04aEvidence['shadow']['providerCalls'] = []
const providerErrors: string[] = []

async function reply(request: IncomingMessage, response: ServerResponse): Promise<void> {
  try {
    assert.equal(request.url, '/chat/completions')
    assert.equal(request.method, 'POST')
    const parts: Buffer[] = []
    for await (const part of request) parts.push(Buffer.from(part))
    const wire = JSON.parse(Buffer.concat(parts).toString('utf8')) as {
      messages: { role: string; content: string }[]
      tools?: unknown[]
    }
    const message = wire.messages.find((item) => item.role === 'user')
    assert(message, 'missing user manifest')
    const prompt = JSON.parse(message.content) as {
      entries: { id: string; kind: string; body: string }[]
      coverageComplete: boolean
    }
    const source = prompt.entries.find((entry) => entry.kind === 'source')
    const slot = prompt.entries.find((entry) => entry.kind === 'slot')
    const evidence = prompt.entries.find((entry) => /^[AE][1-9]\d*$/.test(entry.id))
    providerCalls.push({
      aliases: prompt.entries.map((entry) => entry.id),
      sourceMatched: source?.body === sourceBody,
      heldTools: wire.tools?.length ?? 0,
    })
    assert(
      source && slot && evidence && prompt.coverageComplete,
      'expected bounded discovery prompt',
    )
    const proposal = {
      classification: 'independent_gap',
      source: source.id,
      slot: slot.id,
      citations: prompt.entries
        .filter((entry) => /^[AEW][1-9]\d*$/.test(entry.id))
        .map((entry) => entry.id),
      reason: candidateCanary,
    }
    response.writeHead(200, { 'content-type': 'application/json' }).end(
      JSON.stringify({
        choices: [
          {
            finish_reason: 'stop',
            message: { role: 'assistant', content: JSON.stringify(proposal) },
          },
        ],
        usage: { prompt_tokens: 150, completion_tokens: 48 },
      }),
    )
  } catch (error) {
    providerErrors.push(error instanceof Error ? error.message : 'invalid model request')
    response.writeHead(400).end('model replay rejected')
  }
}

const env = new ProductionAcceptance((request, response) => void reply(request, response))
const sockets: WebSocket[] = []

async function observeWs(cookie: string) {
  const url = new URL('/ws/v1/client?cursor=0', env.origin)
  url.protocol = 'ws:'
  const socket = new WebSocket(url, { headers: { cookie, origin: env.origin } })
  sockets.push(socket)
  const frames: string[] = []
  socket.on('message', (message) => frames.push(message.toString()))
  await new Promise<void>((resolve, reject) => {
    socket.once('open', resolve)
    socket.once('error', reject)
  })
  return frames
}

function surface(name: Rd04aEvidence['visibility']['surfaces'][number]['name'], values: string[]) {
  return {
    name,
    observations: values.length,
    leaks: values.filter((value) => value.includes(candidateCanary)).length,
  }
}

type Candidate = Rd04aEvidence['shadow']['candidate'] & { reason: string }

async function drive(assemblyDigest: string): Promise<Rd04aEvidence> {
  const { project, task, work, subscription, discussion, colleague } = await setupRd04aFixture(env)
  const { db } = env.database
  const counts = async () => ({
    tasks: await db.$count(schema.tasks),
    works: await db.$count(schema.works),
    specs: await db.$count(schema.taskSpecRevisions),
    questions: await db.$count(schema.workQuestions),
    intents: await db.$count(schema.dispatchIntents),
    runs: await db.$count(schema.runs),
  })
  const before = await counts()
  const post = (id: string, body: string, key = randomUUID()) =>
    env.api<{ id: string }>(
      `/tasks/${id}/comments`,
      { body },
      { actor: colleague, idempotencyKey: key },
    )
  const live = await observeWs(colleague.cookie)
  const config = await env.api<{ configVersion: number }>(
    `/projects/${project.id}/discovery/config`,
    {
      enabled: true,
      entryTaskId: discussion.id,
      principalUserId: env.owner.userId,
      activity: 'Event accessibility',
      slot: 'Accessible shuttle alternatives',
      templateVersion: 'pilot-v1',
      maxCalls: 3,
      maxTokens: 50_000,
      maxCostMicros: 1000,
      expiresAt: new Date(Date.now() + 3600_000).toISOString(),
      agreementTaskIds: [task.id],
    },
  )
  await env.api(`/projects/${project.id}/discovery/permit`, { configVersion: config.configVersion })
  await env.api(
    `/projects/${project.id}/discovery/participation`,
    { configVersion: config.configVersion },
    { actor: colleague },
  )
  const fast = await post(task.id, 'Please reserve two extra accessible seats.')
  const key = randomUUID()
  const source = await post(discussion.id, sourceBody, key)
  const replayed = await post(discussion.id, sourceBody, key)
  const candidatePath = `/projects/${project.id}/discovery/candidates`
  const candidateRead = await until(
    'authorized discovery candidate',
    async () => {
      const response = await env.request(candidatePath)
      assert.equal(response.status, 200)
      const wire = (await response.json()) as { ok: boolean; data: Candidate[] }
      assert(wire.ok && Array.isArray(wire.data))
      const candidate = wire.data.find((item) => item.sourceId === source.id)
      if (candidate)
        return { candidate, status: response.status, cache: response.headers.get('cache-control') }
      assert.equal(providerErrors.length, 0, providerErrors.join('; '))
      return undefined
    },
    45_000,
  )
  const readByColleague = await env.request(candidatePath, undefined, { actor: colleague })
  const publicControl = await env.request(`/projects/${project.id}/tasks`, undefined, {
    actor: colleague,
  })
  await env.api(`/projects/${project.id}/discovery/permit`, undefined, { method: 'DELETE' })
  const revoked = await env.request(candidatePath)
  const off = await post(
    discussion.id,
    'Separate shuttle question after the permit has been withdrawn.',
  )
  const replay = await observeWs(colleague.cookie)
  await until(
    'live WS reached post-revocation public comment',
    async () => live.some((frame) => frame.includes(off.id)) || undefined,
  )
  await until(
    'WS replay reached post-revocation public comment',
    async () => replay.some((frame) => frame.includes(off.id)) || undefined,
  )
  const admissions = await db
    .select()
    .from(schema.workEntryAdmissions)
    .where(eq(schema.workEntryAdmissions.sourceId, fast.id))
  const inbox = await db
    .select()
    .from(schema.workInboxItems)
    .where(eq(schema.workInboxItems.sourceId, fast.id))
  const teamEvents = await db.select().from(schema.teamEvents)
  const routes = await env.database.sql<
    {
      source_id: string
      route: string
      reason: string
      evaluation_id: string | null
    }[]
  >`
    select source_id, route, reason, evaluation_id from discovery_admission
      where project_id = ${project.id}
  `
  const evaluations = (
    await db
      .select()
      .from(schema.coordinationEvaluations)
      .where(eq(schema.coordinationEvaluations.projectId, project.id))
  )
    .filter((row) => row.purpose !== 'inference')
    .map((row) => ({
      id: row.id,
      purpose: row.purpose,
      status: row.status,
      workKey: row.workKey,
      inferenceEntryId: row.inferenceEntryId,
      readEntryIds: row.readEntryIds,
      manifestIds: (row.inputManifest.entries as { id: string }[]).map((entry) => entry.id),
    }))
  const ledger = await db
    .select()
    .from(schema.coordinationUsageLedger)
    .where(eq(schema.coordinationUsageLedger.projectId, project.id))
  assert.equal(providerErrors.length, 0, providerErrors.join('; '))
  const { reason, ...candidate } = candidateRead.candidate
  return {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    assemblyDigest,
    modelQuality: 'not_run',
    fast: {
      sourceId: fast.id,
      workKey: work.workKey,
      subscriptionId: subscription.id,
      admissions: admissions.map(({ sourceId, inboxItemId, outcome, reason, routerInvoked }) => ({
        sourceId,
        inboxItemId,
        outcome,
        reason,
        routerInvoked,
      })),
      inbox: inbox.map(({ id, sourceId, workKey, subscriptionId }) => ({
        id,
        sourceId,
        workKey,
        subscriptionId,
      })),
      routerCalls: await db.$count(
        schema.workEntryRouterCalls,
        eq(schema.workEntryRouterCalls.sourceId, fast.id),
      ),
    },
    shadow: {
      sourceId: source.id,
      replayId: replayed.id,
      offSourceId: off.id,
      routes: routes.map(({ source_id, route, reason, evaluation_id }) => ({
        sourceId: source_id,
        route,
        reason,
        evaluationId: evaluation_id,
      })),
      providerCalls,
      evaluations,
      candidate: {
        id: candidate.id,
        evaluationId: candidate.evaluationId,
        sourceId: candidate.sourceId,
        classification: candidate.classification,
      },
      ledger: ledger.map(({ evaluationId, workKey, phase, chargeMode, attempt }) => ({
        evaluationId,
        workKey,
        phase,
        chargeMode,
        attempt,
      })),
    },
    visibility: {
      publicHttp: publicControl.status,
      ownerHttp: candidateRead.status,
      ownerCache: candidateRead.cache,
      colleagueHttp: readByColleague.status,
      revokedOwnerHttp: revoked.status,
      outputCanaryOnAuthorizedRead: reason.includes(candidateCanary),
      surfaces: [
        surface('ws_live', live),
        surface('ws_replay', replay),
        surface(
          'team_event',
          teamEvents.map((row) => JSON.stringify(row)),
        ),
        surface(
          'log',
          env.events.map((event) => JSON.stringify(event)),
        ),
        surface(
          'http',
          await Promise.all([publicControl.text(), readByColleague.text(), revoked.text()]),
        ),
      ],
    },
    effects: { before, after: await counts() },
  }
}

try {
  await mkdir(output, { recursive: true })
  const resultPath = join(output, 'result.json')
  await rm(resultPath, { force: true })
  const assemblyDigest = await fingerprintProductionAssembly(repoRoot)
  const evidence = await drive(assemblyDigest)
  assert.equal(
    await fingerprintProductionAssembly(repoRoot),
    assemblyDigest,
    'assembly changed during verification',
  )
  verifyRd04a(evidence)
  await writeFile(resultPath, JSON.stringify(evidence, null, 2) + '\n', { mode: 0o600 })
  console.log('RD-04a production replay: PASS (real model quality not_run)')
} catch (error) {
  console.error(env.redact(error instanceof Error ? error.message : String(error)))
  console.error(env.diagnostics())
  process.exitCode = 1
} finally {
  for (const socket of sockets) socket.terminate()
  await env.stop()
}
