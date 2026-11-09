#!/usr/bin/env tsx
/** M1R-A: real Hub, Node, Runtime and PostgreSQL; only provider replies are replayed. */
import assert from 'node:assert/strict'
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { join } from 'node:path'
import { schema } from '@whalepod/db'
import { and, asc, eq, inArray } from 'drizzle-orm'
import { ProductionAcceptance, repoRoot, until } from './lib/production-acceptance.js'
import { bindM1RAProvenance, fingerprintProductionAssembly } from './lib/acceptance-provenance.js'

const output = join(repoRoot, 'artifacts/evidence/m1r-a')
const resultPath = join(output, 'result.json')
const eventPath = join(output, 'events.jsonl')
const firstSource = 'M1R_A_INITIAL: First plan needs accessible signage.'
const secondSource = 'M1R_A_SUPPLEMENT: Shuttle vehicles must support boarding by wheelchair.'
const firstDraft = '# Site plan\nAccessible signage is planned.\n'
const secondDraft = '# Updated plan\n' + secondSource + '\n'
const hash = (value: string) => createHash('sha256').update(value).digest('hex')

interface Message {
  role: string
  content?: string
  tool_call_id?: string
}
interface CompletionRequest {
  stream?: boolean
  tools?: { function: { name: string } }[]
  messages: Message[]
}
interface ToolCall {
  id: string
  name: string
  args: object
}

function replyStream(response: ServerResponse, result: { text: string } | ToolCall): void {
  const finish = 'text' in result ? 'stop' : 'tool_calls'
  const delta =
    'text' in result
      ? { role: 'assistant', content: result.text }
      : {
          role: 'assistant',
          tool_calls: [
            {
              index: 0,
              id: result.id,
              type: 'function',
              function: { name: result.name, arguments: JSON.stringify(result.args) },
            },
          ],
        }
  const chunks = [
    { choices: [{ index: 0, delta, finish_reason: null }] },
    { choices: [{ index: 0, delta: {}, finish_reason: finish }] },
    { choices: [], usage: { prompt_tokens: 200, completion_tokens: 50, total_tokens: 250 } },
  ]
  response
    .writeHead(200, { 'content-type': 'text/event-stream' })
    .end(chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join('') + 'data: [DONE]\n\n')
}

const replay = {
  routerCalls: [] as { decision: string; sources: number; evidence: number }[],
  executorCalls: [] as { phase: number; name: string; inboxItemId?: string; bodyDigest?: string }[],
  firstFinal: undefined as ServerResponse | undefined,
  failures: [] as string[],
}

function routerReply(request: CompletionRequest, response: ServerResponse) {
  assert.equal(request.tools?.length ?? 0, 0, 'Router cannot request tools')
  const prompt = JSON.parse(
    request.messages.find((message) => message.role === 'user')!.content!,
  ) as {
    entries: { id: string; kind: string; body: string }[]
  }
  assert.deepEqual(Object.keys(prompt), ['entries'])
  const sources = prompt.entries.filter((entry) => entry.kind === 'source')
  const evidence = prompt.entries.filter((entry) => entry.kind === 'evidence')
  assert(sources.every((entry) => /^S[1-9]\d*$/.test(entry.id)))
  assert(evidence.every((entry) => /^E[1-9]\d*$/.test(entry.id)))
  assert.equal(
    evidence.some((entry) => entry.body.includes(secondSource)),
    false,
  )
  const index = replay.routerCalls.length
  assert(index < 2, 'unexpected Router invocation')
  assert.equal(sources.length, index === 0 ? 2 : 1)
  if (index === 0)
    assert(
      sources.some((entry) => entry.body === firstSource) &&
        sources.some((entry) => entry.body === secondSource),
      'the boundary must include both observed source revisions',
    )
  else
    assert(sources[0]!.body === secondSource, 'second boundary must keep the supplemental source')
  assert.equal(evidence.length, 1)
  const original = evidence.find((entry) => entry.body === firstDraft)
  assert(original, 'only the owner-published first draft is a valid outcome citation')
  const decision = index === 1 ? 'wait' : 'dispatch'
  replay.routerCalls.push({ decision, sources: sources.length, evidence: evidence.length })
  const proposal = {
    decision,
    summary: index === 1 ? 'No published outcome proves the supplement was covered' : 'Draft plan',
    citations: sources.map((entry) => entry.id),
    coverage: sources.map((entry) => {
      const covered = index === 0 && entry.body === firstSource
      return {
        source: entry.id,
        status: index === 1 ? 'unknown' : covered ? 'covered' : 'uncovered',
        evidence: covered ? [original.id] : [],
      }
    }),
    ...(decision === 'dispatch' ? { actionClass: 'draft' } : { reason: 'upstream_pending' }),
  }
  response.writeHead(200, { 'content-type': 'application/json' }).end(
    JSON.stringify({
      choices: [
        {
          finish_reason: 'stop',
          message: { role: 'assistant', content: JSON.stringify(proposal) },
        },
      ],
      usage: { prompt_tokens: 200, completion_tokens: 100 },
    }),
  )
}

const itemIds = { first: '', second: '' }
function executorReply(request: CompletionRequest, response: ServerResponse) {
  assert.equal(request.stream, true)
  const user = request.messages.find((message) => message.role === 'user')?.content ?? ''
  const match = /"inboxItemId":"([0-9a-f-]{36})"/.exec(user)
  assert(match, 'executor must receive a frozen work input manifest')
  const inboxItemId = match[1]!
  assert(
    !user.includes(firstSource) && !user.includes(secondSource),
    'input body must arrive via tool',
  )
  const phase = inboxItemId === itemIds.first ? 1 : inboxItemId === itemIds.second ? 2 : 0
  assert(phase > 0, 'executor manifest must identify one observed inbox item')
  const toolResults = request.messages.filter((message) => message.role === 'tool')
  const step = toolResults.length
  assert(step <= 3, 'unexpected executor call')
  const tools = new Set(request.tools?.map((tool) => tool.function.name))
  for (const name of ['read_work_input', 'write', 'publish_artifact']) assert(tools.has(name))
  const path = `.whalepod/drafts/m1r-a-${phase}.md`
  if (step === 0) {
    replay.executorCalls.push({ phase, name: 'read_work_input', inboxItemId })
    return replyStream(response, {
      id: `read-${phase}`,
      name: 'read_work_input',
      args: { inboxItemId },
    })
  }
  const expected = phase === 1 ? firstSource : secondSource
  const read = toolResults.find((message) => message.tool_call_id === `read-${phase}`)
  const content = read?.content
  assert(typeof content === 'string', 'next model request lacks the actual tool result')
  const separator = content.indexOf('\n\n')
  assert(separator >= 0, 'work input response lacks the header/body delimiter')
  const readDigest = hash(content.slice(separator + 2))
  assert(readDigest === hash(expected), 'next model request has the wrong tool result digest')
  if (step === 1) {
    replay.executorCalls.push({ phase, name: 'write', bodyDigest: readDigest })
    return replyStream(response, {
      id: `write-${phase}`,
      name: 'write',
      args: { file_path: path, content: phase === 1 ? firstDraft : secondDraft },
    })
  }
  if (step === 2) {
    replay.executorCalls.push({ phase, name: 'publish_artifact' })
    return replyStream(response, {
      id: `candidate-${phase}`,
      name: 'publish_artifact',
      args: { relativePath: path, title: `Acceptance draft ${phase}`, mediaType: 'text/markdown' },
    })
  }
  replay.executorCalls.push({ phase, name: 'stop' })
  if (phase === 1) {
    assert.equal(replay.firstFinal, undefined)
    // Keep the first real Run active while the owner publishes its actual artifact candidate.
    replay.firstFinal = response
    return
  }
  return replyStream(response, { text: 'Second draft available for owner review.' })
}

async function modelOutlet(incoming: IncomingMessage, response: ServerResponse) {
  try {
    assert.equal(incoming.method, 'POST')
    const chunks: Buffer[] = []
    for await (const chunk of incoming) chunks.push(Buffer.from(chunk))
    const body = JSON.parse(Buffer.concat(chunks).toString()) as CompletionRequest
    if (incoming.url === '/router/chat/completions') routerReply(body, response)
    else {
      assert.equal(incoming.url, '/chat/completions')
      executorReply(body, response)
    }
  } catch (error) {
    replay.failures.push(error instanceof Error ? error.message : String(error))
    response.writeHead(400).end('fixture request rejected')
  }
}

const env = new ProductionAcceptance((request, response) => void modelOutlet(request, response))

function assertReplayHealthy(): void {
  assert.equal(replay.failures.length, 0, replay.failures.join('; '))
}

async function drive() {
  await env.start()
  assert(env.providerOrigin)
  const colleague = await env.inviteMember('acceptance-colleague')
  const project = await env.api<{ id: string }>('/projects', {
    name: 'M1R-A Production Acceptance',
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
  const executorCredential = randomBytes(24).toString('base64url')
  await env.cli(
    ['secret', 'set', 'deepseek-official', 'acceptance', '--state-dir', env.stateDir],
    executorCredential + '\n',
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
    'router-replay',
    '--slot',
    'acceptance',
    '--endpoint',
    `${env.providerOrigin}/router/chat/completions`,
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
  await until('workspace inventory from production Node', async () => {
    const workspaces = await env.api<{ name: string }[]>('/workspaces')
    return workspaces.find((workspace) => workspace.name === 'acceptance')
  })
  await env.api(`/projects/${project.id}/router/config`, {
    enabled: true,
    deviceId: env.deviceId,
    operatorUserId: env.owner.userId,
    billingUserId: env.owner.userId,
    credentialSlot: 'acceptance',
    credentialConfigRevision: configRevision,
    provider: 'replay',
    model: 'router-replay',
    teamDailyCallLimit: 20,
    projectDailyCallLimit: 20,
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
    maxRetries: 1,
  })
  const pack = (await env.api<{ id: string; name: string }[]>('/plugin-packs')).find(
    (row) => row.name === 'core-empty',
  )
  assert(pack, 'team setup must provision the core-empty plugin pack')
  const agent = await env.api<{ id: string }>('/agents', {
    name: 'Acceptance draft executor',
    persona: 'Read current work inputs and draft an accessible event plan.',
    provider: 'deepseek-official',
    model: 'deepseek-v4-flash',
    credentialSlot: 'acceptance',
    pluginPackId: pack.id,
    maxTokens: 2048,
    inputPriceMicrosPerMillionTokens: 1,
    outputPriceMicrosPerMillionTokens: 1,
  })
  const task = await env.api<{ id: string }>(`/projects/${project.id}/tasks`, {
    title: 'Accessible event plan',
    assigneeUserId: env.owner.userId,
  })
  await env.api(`/tasks/${task.id}/accept`, {})
  const agreement = await env.api<{ draftVersion: number }>(`/tasks/${task.id}/agreement/draft`, {
    content: {
      goal: 'Maintain the event plan',
      constraints: 'Draft only',
      acceptance: 'Traceable evidence',
      openQuestions: 'None',
    },
  })
  await env.api(`/tasks/${task.id}/agreement/confirm`, { draftVersion: agreement.draftVersion })
  const work = await env.api<{ workKey: string }>(`/tasks/${task.id}/works`, {
    goal: 'Maintain an accessible event plan',
  })
  const mandate = await env.api<{ id: string; version: number }>(
    `/works/${work.workKey}/mandates`,
    {
      autoDispatch: 'existing_task',
      allowedAgentIds: [agent.id],
      allowedToolNames: ['write'],
      allowedActionClasses: ['draft'],
      allowedSourceTypes: ['task_message'],
      maxRunsPerWork: 3,
      maxAttempts: 3,
      expiresAt: new Date(Date.now() + 3600_000).toISOString(),
    },
  )
  const subscription = await env.api<{ id: string }>(`/works/${work.workKey}/subscriptions`, {
    targetType: 'task',
    targetRef: task.id,
  })
  const { db } = env.database
  const admissions = async () =>
    db
      .select()
      .from(schema.workEntryAdmissions)
      .where(eq(schema.workEntryAdmissions.workKey, work.workKey))
  const inbox = async () =>
    db.select().from(schema.workInboxItems).where(eq(schema.workInboxItems.workKey, work.workKey))
  const runRows = async () =>
    db
      .select()
      .from(schema.runs)
      .where(eq(schema.runs.taskId, task.id))
      .orderBy(asc(schema.runs.createdAt))
  const inboxFor = async (sourceId: string) =>
    (await inbox()).find((row) => row.sourceId === sourceId)
  const entryFor = async (sourceId: string) =>
    (await admissions()).find((row) => row.sourceId === sourceId)
  const postComment = (body: string, idempotencyKey = randomUUID()) =>
    env.api<{ id: string }>(
      `/tasks/${task.id}/comments`,
      { body },
      { actor: colleague, idempotencyKey },
    )
  const first = await postComment(firstSource)
  const duplicateKey = randomUUID()
  const second = await postComment(secondSource, duplicateKey)
  const duplicate = await postComment(secondSource, duplicateKey)
  assert.equal(duplicate.id, second.id)
  const firstItem = await inboxFor(first.id)
  const secondItem = await inboxFor(second.id)
  const secondAdmission = await entryFor(second.id)
  assert(firstItem && secondItem && secondAdmission)
  assert.equal(secondAdmission.outcome, 'deliver')
  assert.equal(secondAdmission.reason, 'subscription_match')
  assert.equal(secondAdmission.inboxItemId, secondItem.id)
  assert.equal(secondAdmission.subscriptionId, subscription.id)
  assert.equal(secondAdmission.routerInvoked, false)
  assert.equal(secondItem.status, 'pending')
  assert.equal(secondItem.subscriptionId, subscription.id)
  const fast = {
    sourceId: second.id,
    itemId: secondItem.id,
    subscriptionId: secondItem.subscriptionId,
    outcome: secondAdmission.outcome,
    reason: secondAdmission.reason,
    admissionItemId: secondAdmission.inboxItemId,
    admissionSubscriptionId: secondAdmission.subscriptionId,
    status: secondItem.status,
    routerInvoked: secondAdmission.routerInvoked,
    routerCalls: replay.routerCalls.length,
    routerRows: (await db.select().from(schema.workEntryRouterCalls)).length,
    runCount: (await runRows()).length,
    replayedMessageId: duplicate.id,
    admissionCount: (await admissions()).filter((row) => row.sourceId === second.id).length,
  }
  assert.equal(fast.routerCalls, 0)
  assert.equal(fast.routerRows, 0)
  assert.equal(fast.runCount, 0)
  itemIds.first = firstItem.id
  itemIds.second = secondItem.id

  // The owner authorizes the bootstrap source only via the ordinary admission endpoint.
  // The measured second Run gets no evaluate, run, followup, approve, or dispatch request.
  const bootstrap = await env.api<{
    proposedIntent: {
      id: string
      runId: string
      status: string
      statusReason: string | null
      exclusionReasons: { kind: string; reason: string }[]
    }
  }>(`/works/${work.workKey}/admission-checks`, { sourceType: 'task_message', sourceId: first.id })
  assert.equal(
    bootstrap.proposedIntent?.status,
    'dispatched',
    `bootstrap intent: ${bootstrap.proposedIntent?.statusReason ?? 'no status reason'}; exclusions=${bootstrap.proposedIntent?.exclusionReasons.map(({ kind, reason }) => `${kind}:${reason}`).join(',')}`,
  )
  const running = await until(
    'first live Runtime awaiting final model reply',
    async () => {
      assertReplayHealthy()
      const [row] = await runRows()
      if (row?.status === 'failed') throw new Error(`first Runtime failed: ${row.failureCode}`)
      return replay.firstFinal && row?.status === 'running' ? row : undefined
    },
    45_000,
  )
  assert.equal(running.origin, 'mandate')
  assert.equal(running.id, bootstrap.proposedIntent.runId)
  const stillPending = await inboxFor(second.id)
  assert.equal(stillPending?.status, 'pending')
  assert.equal(replay.routerCalls.length, 0)
  const candidateFor = async (runId: string) =>
    (await db.select().from(schema.artifacts).where(eq(schema.artifacts.runId, runId)))[0]
  const firstCandidate = await until('first artifact through Runtime, Node collector and Hub', () =>
    candidateFor(running.id),
  )
  assert.equal(firstCandidate.status, 'candidate')
  await env.api(`/artifacts/${firstCandidate.id}/publish`, {})
  const publishedResponse = await env.request(
    `/artifacts/${firstCandidate.id}/content`,
    undefined,
    {
      actor: colleague,
    },
  )
  assert.equal(publishedResponse.status, 200, 'the comparison member can read published evidence')
  assert(
    hash(await publishedResponse.text()) === firstCandidate.sha256,
    'the comparison member received different published bytes',
  )
  replyStream(replay.firstFinal!, { text: 'Initial draft prepared.' })

  const next = await until(
    'automatic next real Runtime completed',
    async () => {
      assertReplayHealthy()
      const rows = await runRows()
      assert(rows.length <= 2, 'Run boundary must not dispatch repeatedly')
      if (rows[1]?.status === 'failed')
        throw new Error(`second Runtime failed: ${rows[1].failureCode}`)
      return rows[1]?.status === 'completed' ? rows[1] : undefined
    },
    60_000,
  )
  const draft = await until('second real artifact candidate', () => candidateFor(next.id))
  assert.equal(draft.status, 'candidate')
  const artifactPath = `/artifacts/${draft.id}/content`
  const ownerResponse = await env.request(artifactPath)
  assert.equal(ownerResponse.status, 200)
  const ownerBytes = await ownerResponse.text()
  assert(hash(ownerBytes) === hash(secondDraft), 'owner downloaded different draft bytes')
  const otherResponse = await env.request(artifactPath, undefined, { actor: colleague })
  assert.equal(otherResponse.status, 404)
  await otherResponse.body?.cancel()

  const [guard] = await until(
    'private-only new result produces an applied wait, with no third Run',
    async () => {
      assertReplayHealthy()
      const rows = await runRows()
      assert.equal(rows.length, 2)
      const wait = await db
        .select()
        .from(schema.workWaits)
        .where(eq(schema.workWaits.workKey, work.workKey))
      return wait.length === 1 && wait[0]!.status === 'open' ? wait : undefined
    },
    35_000,
  )
  assert(guard)
  const finishedRuns = await runRows()
  const runIds = finishedRuns.map((row) => row.id)
  const [
    boundaries,
    receipts,
    consumptions,
    intents,
    applications,
    evaluations,
    projected,
    executorUsage,
    tasks,
  ] = await Promise.all([
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
      .from(schema.routerApplications)
      .where(eq(schema.routerApplications.workKey, work.workKey)),
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
      .from(schema.runEvents)
      .where(inArray(schema.runEvents.runId, runIds))
      .orderBy(asc(schema.runEvents.seq)),
    db
      .select()
      .from(schema.executorUsageLedger)
      .where(inArray(schema.executorUsageLedger.runId, runIds)),
    db
      .select({ id: schema.tasks.id })
      .from(schema.tasks)
      .where(eq(schema.tasks.projectId, project.id)),
  ])
  const events = projected.flatMap((event) => {
    const payload = event.payload as { callId?: string; toolName?: string; outcome?: string }
    if (!['tool.started', 'tool.finished', 'runtime.ready', 'run.completed'].includes(event.type))
      return []
    return [
      {
        component: 'hub.run',
        runId: event.runId,
        seq: event.seq,
        audience: event.audience,
        type: event.type,
        ...(payload.callId ? { callId: payload.callId } : {}),
        ...(payload.toolName ? { toolName: payload.toolName } : {}),
        ...(payload.outcome ? { outcome: payload.outcome } : {}),
      },
    ]
  })
  const runtimeEvents = env.events.flatMap((event) => {
    if (
      !['hub.dispatch', 'hub.router', 'node.coordination', 'runtime.bridge.coordination'].includes(
        String(event.component),
      )
    )
      return []
    return [
      Object.fromEntries(
        Object.entries(event).filter(([key]) =>
          [
            'component',
            'msg',
            'action',
            'runId',
            'evaluationId',
            'workKey',
            'status',
            'readCount',
          ].includes(key),
        ),
      ),
    ]
  })
  const published = await candidateFor(running.id)
  const result = {
    schemaVersion: 2,
    generatedAt: new Date().toISOString(),
    assembly: {
      hub: 'production-package-bin',
      node: 'production-package-replay-assembly',
      runtime: 'production-dsh-package-bin',
      database: 'postgresql',
      model: 'loopback-http-replay',
    },
    modelQuality: 'not_run',
    taskId: task.id,
    workKey: work.workKey,
    mandateId: mandate.id,
    ownerUserId: env.owner.userId,
    colleagueUserId: colleague.userId,
    subscriptionId: subscription.id,
    bootstrapIntentId: bootstrap.proposedIntent.id,
    fast,
    statusBeforeBoundary: stillPending?.status,
    firstSnapshot: running.workInputManifestDigest,
    firstEvidence: {
      id: firstCandidate.id,
      runId: firstCandidate.runId,
      sha256: firstCandidate.sha256,
      status: published?.status,
      publishedAt: published?.publishedAt,
      colleagueStatus: publishedResponse.status,
    },
    finishedRuns: finishedRuns.map((row) => ({
      id: row.id,
      status: row.status,
      origin: row.origin,
      workKey: row.workKey,
      dshSessionId: row.dshSessionId,
      dispatchIntentId: row.dispatchIntentId,
      manifestDigest: row.workInputManifestDigest,
      itemIds: row.workInputManifest?.entries.map((item) => item.inboxItemId),
      startedAt: row.startedAt,
      finishedAt: row.finishedAt,
    })),
    boundaries: boundaries.map((row) => ({
      runId: row.runId,
      evaluationId: row.evaluationId,
      status: row.status,
      triggerKey: row.triggerKey,
    })),
    receipts: receipts.map(
      ({ id, runId, manifestDigest, entriesRead, readEvents, digestVerified }) => ({
        id,
        runId,
        manifestDigest,
        entriesRead,
        digestVerified,
        readEvents: readEvents.map((event) =>
          Object.fromEntries(
            Object.entries(event).filter(([key]) =>
              ['inboxItemId', 'at', 'digestVerified'].includes(key),
            ),
          ),
        ),
      }),
    ),
    consumptions: consumptions.map(
      ({ receiptId, runId, inboxItemId, kind, manifestDigest, readAt }) => ({
        receiptId,
        runId,
        inboxItemId,
        kind,
        manifestDigest,
        readAt,
      }),
    ),
    inbox: (await inbox()).map(({ id, sourceId, status, bodyDigest }) => ({
      id,
      sourceId,
      status,
      bodyDigest,
    })),
    intents: intents.map(({ id, runId, status, approvalBasis, mandateId }) => ({
      id,
      runId,
      status,
      approvalBasis,
      mandateId,
    })),
    applications: applications.map(
      ({ evaluationId, decision, status, runId, intentId, waitId }) => ({
        evaluationId,
        decision,
        status,
        runId,
        intentId,
        waitId,
      }),
    ),
    evaluations: evaluations.map(({ id, status, routerProposal, readEntryIds, inputManifest }) => ({
      id,
      status,
      decision: routerProposal?.decision,
      coverage: routerProposal?.coverage,
      readEntryIds,
      entries: (
        inputManifest.entries as { id: string; kind: string; sourceId: string; digest: string }[]
      ).map(({ id, kind, sourceId, digest }) => ({ id, kind, sourceId, digest })),
    })),
    executorUsage: executorUsage.map(({ runId, phase, chargeMode }) => ({
      runId,
      phase,
      chargeMode,
    })),
    draft: {
      id: draft.id,
      runId: draft.runId,
      ownerUserId: draft.ownerUserId,
      status: draft.status,
      sha256: draft.sha256,
      downloadedSha256: hash(ownerBytes),
      ownerStatus: ownerResponse.status,
      colleagueStatus: otherResponse.status,
    },
    wait: { id: guard.id, evaluationId: guard.evaluationId, status: guard.status },
    replay: { routerCalls: replay.routerCalls, executorCalls: replay.executorCalls },
    totalTasks: tasks.length,
  }
  return { result, events: [...runtimeEvents, ...events] }
}

let stopped = false
async function cleanup() {
  if (stopped) return
  stopped = true
  await env.stop()
}
process.once('SIGTERM', () => void cleanup().finally(() => process.exit(143)))
process.once('SIGINT', () => void cleanup().finally(() => process.exit(130)))
try {
  await mkdir(output, { recursive: true })
  await Promise.all(
    [resultPath, eventPath, join(output, 'failure.log')].map((path) => rm(path, { force: true })),
  )
  const assemblyDigest = await fingerprintProductionAssembly(repoRoot)
  const { result, events } = await drive()
  assert.equal(
    await fingerprintProductionAssembly(repoRoot),
    assemblyDigest,
    'assembly changed during M1R-A replay',
  )
  const eventBytes = events.map((event) => JSON.stringify(event)).join('\n') + '\n'
  await writeFile(eventPath, eventBytes)
  await writeFile(
    resultPath,
    JSON.stringify({ ...result, ...bindM1RAProvenance(assemblyDigest, eventBytes) }, null, 2) +
      '\n',
  )
  const { verifyM1RA } = await import('./verify-m1r-a-acceptance.js')
  await verifyM1RA(resultPath, assemblyDigest)
  console.log('M1R-A production acceptance PASS')
} catch (error) {
  await rm(resultPath, { force: true })
  const summary = env.redact(error instanceof Error ? error.message : String(error))
  await writeFile(join(output, 'failure.log'), `${summary}\n${env.diagnostics()}\n`)
  console.error(summary)
  process.exitCode = 1
} finally {
  await cleanup()
}
