/** Shadow discovery quality: normal project comments drive the packaged Hub, Node and Runtime. */
import assert from 'node:assert/strict'
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { lstat } from 'node:fs/promises'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { join } from 'node:path'
import { getEvaluation, schema } from '@whalepod/db'
import {
  CoordinationCredentialSlotSchema,
  CoordinationInputEntrySchema,
  coordinationUsageCost,
  type CoordinationInputEntry,
  type TaskSpecRevisionView,
} from '@whalepod/protocol'
import { desc, eq, gt } from 'drizzle-orm'
import {
  getDiscoveryQualityCases,
  type DiscoveryQualityAgreement,
  type DiscoveryQualityCase,
  type DiscoveryQualitySplit,
} from './discovery-quality-cases.js'
import {
  DISCOVERY_QUALITY_MAX_CASE_COST_MICROS,
  DISCOVERY_QUALITY_MAX_INPUT_TOKENS,
  DISCOVERY_QUALITY_MAX_OUTPUT_TOKENS,
  DISCOVERY_QUALITY_MAX_SPLIT_COST_MICROS,
  DISCOVERY_QUALITY_PRICING,
  type DiscoveryQualityCaseResult,
} from './discovery-quality-score.js'
import { ProductionAcceptance, until, type AcceptanceActor } from './production-acceptance.js'

export const DISCOVERY_QUALITY_REAL_CONFIGURATION = {
  provider: 'command-code',
  model: 'deepseek/deepseek-v4.1-flash',
  endpoint: 'https://api.commandcode.ai/provider/v1/chat/completions',
  slot: 'discovery-quality',
  maxInputTokens: DISCOVERY_QUALITY_MAX_INPUT_TOKENS,
  maxOutputTokens: DISCOVERY_QUALITY_MAX_OUTPUT_TOKENS,
  maxCostMicros: DISCOVERY_QUALITY_MAX_CASE_COST_MICROS,
  ...DISCOVERY_QUALITY_PRICING,
  timeoutSeconds: 65,
  maxRetries: 0,
} as const

export interface DiscoveryQualityDriverOptions {
  split: DiscoveryQualitySplit
  mode: 'real_model' | 'replay' | 'prepare_only'
  key?: string
  onCase?: (result: DiscoveryQualityDriverCaseResult) => void | Promise<void>
}

export interface DiscoveryQualityDriverCaseResult extends DiscoveryQualityCaseResult {
  provenance: {
    taskId: string
    sourceId: string
    sourceVersion: string
    sourceDigest: string
    evaluationDigest: string
    resultDigest: string | null
    rulesVersion: string
    promptVersion: string
    status: string
    failureCode: string | null
    chargeMode: string | null
    attempt: number
    durationMs: number
    manifest: CoordinationInputEntry[]
    omissions: string[]
    candidateId: string | null
    ownerHttp: number
    ownerCache: string | null
    colleagueHttp: number
    publicControlHttp: number
    nodeAttemptDirGone: boolean
    replayRequests: number | null
  }
  review?: { reason: string }
}

const digest = (body: string) => createHash('sha256').update(body).digest('hex')
const terminal = new Set(['completed', 'failed', 'cancelled', 'stale', 'skipped'])
const failureCode = (value: string | null) =>
  value === null || /^[a-z][a-z0-9_]{0,63}$/.test(value) ? value : 'unclassified'

// Only the local replay responder uses the gold labels. Real requests are built by Runtime.
async function respondToReplay(
  active: { scenario: DiscoveryQualityCase; requests: number },
  request: IncomingMessage,
  response: ServerResponse,
) {
  assert(request.method === 'POST' && request.url === '/chat/completions', 'wrong replay route')
  active.requests++
  assert.equal(active.requests, 1, 'more than one replay request for one comment')
  const chunks: Buffer[] = []
  for await (const chunk of request) chunks.push(Buffer.from(chunk))
  const wire = JSON.parse(Buffer.concat(chunks).toString('utf8')) as {
    stream?: boolean
    tools?: unknown[]
    messages: { role: string; content: string }[]
  }
  assert(wire.stream === false && !wire.tools?.length, 'discovery broker request is not bounded')
  const message = wire.messages.find((item) => item.role === 'user')
  assert(message, 'discovery prompt missing')
  const prompt = JSON.parse(message.content) as {
    coverageComplete: boolean
    entries: { id: string; kind: string; body: string }[]
  }
  const { scenario } = active
  const source = prompt.entries.find((entry) => entry.kind === 'source')
  const slot = prompt.entries.find((entry) => entry.kind === 'slot')
  const work = prompt.entries.find((entry) => entry.kind === 'work')
  assert(source?.body === scenario.comment && slot && work, 'wrong replay source or missing scope')
  assert.equal(
    prompt.coverageComplete,
    scenario.expected.coverageComplete,
    'wrong catalog coverage',
  )
  const agreement = (fixture: DiscoveryQualityAgreement | undefined) =>
    fixture &&
    prompt.entries.find(
      (entry) => entry.kind === 'agreement' && entry.body === canonicalRecord(fixture.content),
    )
  const entries = {
    agreement: agreement(scenario.agreement),
    secondaryAgreement: agreement(scenario.secondaryAgreement),
    work,
  }
  assert(entries.agreement, 'primary approved agreement missing in replay')
  if (scenario.secondaryAgreement)
    assert.equal(Boolean(entries.secondaryAgreement), !scenario.omitSecondaryAgreement)
  const proposal = {
    classification: scenario.expected.classification,
    source: source.id,
    slot: scenario.expected.classification === 'independent_gap' ? slot.id : null,
    citations: scenario.expected.requiredCitations.map((key) => {
      const entry = entries[key]
      assert(entry, 'replay citation missing from production prompt')
      return entry.id
    }),
    reason: '合成回放仅用于检验装配和取证。',
  }
  response.writeHead(200, { 'content-type': 'application/json' }).end(
    JSON.stringify({
      choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(proposal) } }],
      usage: { prompt_tokens: 300, completion_tokens: 70 },
    }),
  )
}

function canonicalRecord(value: Record<string, unknown>): string {
  return JSON.stringify(
    Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, value[key]]),
    ),
  )
}

async function configureDevice(h: ProductionAcceptance, options: DiscoveryQualityDriverOptions) {
  const real = options.mode === 'real_model'
  const profile = DISCOVERY_QUALITY_REAL_CONFIGURATION
  const provider = real ? profile.provider : 'replay'
  const model = real ? profile.model : 'discovery-quality-replay'
  const endpoint = real ? profile.endpoint : `${h.providerOrigin}/chat/completions`
  const key = real ? options.key : randomBytes(24).toString('base64url')
  assert(key && /^[\x21-\x7e]{8,4096}$/.test(key), 'coordination credential is missing or invalid')
  await h.cli([
    'coordination',
    'configure',
    '--state-dir',
    h.stateDir,
    '--owner-user-id',
    h.owner.userId,
    '--billing-user-id',
    h.owner.userId,
    '--provider',
    provider,
    '--model',
    model,
    '--slot',
    profile.slot,
    '--endpoint',
    endpoint,
  ])
  const response = await h.cli(
    ['coordination', 'secret', 'set', provider, profile.slot, '--state-dir', h.stateDir],
    `${key}\n`,
  )
  const revision = /revision=([a-f0-9-]{36})\b/.exec(response)?.[1]
  assert(revision, 'missing revision from dedicated coordination setup')
  h.startNode()
  await until('exact discovery capability and dedicated credential inventory', async () => {
    const [device] = await h.database.db
      .select()
      .from(schema.devices)
      .where(eq(schema.devices.id, h.deviceId))
    const caps = device?.capabilities as
      | {
          coordinationCapabilities?: string[]
          coordinationCredentialSlots?: unknown[]
        }
      | undefined
    return caps?.coordinationCapabilities?.includes('discovery.v1') &&
      caps.coordinationCapabilities.includes('coordination.v1') &&
      caps.coordinationCredentialSlots?.some((entry) => {
        const parsed = CoordinationCredentialSlotSchema.safeParse(entry)
        return (
          parsed.success &&
          parsed.data.provider === provider &&
          parsed.data.model === model &&
          parsed.data.slot === profile.slot &&
          parsed.data.configRevision === revision &&
          parsed.data.ownerUserId === h.owner.userId &&
          parsed.data.billingUserId === h.owner.userId
        )
      })
      ? true
      : undefined
  })
  return { provider, model, revision }
}

async function prepareAgreement(
  h: ProductionAcceptance,
  projectId: string,
  fixture: DiscoveryQualityAgreement,
) {
  const task = await h.api<{ id: string }>(
    `/projects/${projectId}/tasks`,
    {
      title: fixture.title,
      assigneeUserId: h.owner.userId,
    },
    { expected: 201 },
  )
  await h.api(`/tasks/${task.id}/accept`, {})
  const draft = await h.api<TaskSpecRevisionView>(`/tasks/${task.id}/agreement/draft`, {
    content: fixture.content,
  })
  const confirmed = await h.api<TaskSpecRevisionView>(`/tasks/${task.id}/agreement/confirm`, {
    draftVersion: draft.draftVersion,
  })
  assert(
    confirmed.status === 'confirmed' &&
      confirmed.confirmedByUserId === h.owner.userId &&
      confirmed.revisionNumber !== null &&
      canonicalRecord(confirmed.content) === canonicalRecord(fixture.content),
    'approved agreement differs from its synthetic fixture',
  )
  await h.api(`/tasks/${task.id}/works`, { goal: fixture.content.goal })
  return { taskId: task.id, spec: confirmed }
}

async function prepareCase(
  h: ProductionAcceptance,
  colleague: AcceptanceActor,
  scenario: DiscoveryQualityCase,
  device: Awaited<ReturnType<typeof configureDevice>>,
  caseCount: number,
) {
  const project = await h.api<{ id: string }>(
    '/projects',
    { name: scenario.activity },
    { expected: 201 },
  )
  const primary = await prepareAgreement(h, project.id, scenario.agreement)
  const secondary = scenario.secondaryAgreement
    ? await prepareAgreement(h, project.id, scenario.secondaryAgreement)
    : undefined
  const discussion = await h.api<{ id: string }>(
    `/projects/${project.id}/tasks`,
    {
      title: '筹备讨论',
      assigneeUserId: h.owner.userId,
    },
    { expected: 201 },
  )
  const profile = DISCOVERY_QUALITY_REAL_CONFIGURATION
  const maxTokens = profile.maxInputTokens + profile.maxOutputTokens
  await h.api(`/projects/${project.id}/router/config`, {
    enabled: true,
    deviceId: h.deviceId,
    operatorUserId: h.owner.userId,
    billingUserId: h.owner.userId,
    credentialSlot: profile.slot,
    credentialConfigRevision: device.revision,
    provider: device.provider,
    model: device.model,
    teamDailyCallLimit: caseCount,
    projectDailyCallLimit: 1,
    teamDailyTokenLimit: maxTokens * caseCount,
    projectDailyTokenLimit: maxTokens,
    teamDailyCostMicrosLimit: DISCOVERY_QUALITY_MAX_SPLIT_COST_MICROS,
    projectDailyCostMicrosLimit: profile.maxCostMicros,
    maxInputTokens: profile.maxInputTokens,
    maxOutputTokens: profile.maxOutputTokens,
    maxCostMicros: profile.maxCostMicros,
    ...DISCOVERY_QUALITY_PRICING,
    timeoutSeconds: profile.timeoutSeconds,
    maxRetries: profile.maxRetries,
  })
  const base = `/projects/${project.id}/discovery`
  const { configVersion } = await h.api<{ configVersion: number }>(`${base}/config`, {
    enabled: true,
    entryTaskId: discussion.id,
    principalUserId: h.owner.userId,
    activity: scenario.activity,
    slot: scenario.slot,
    templateVersion: 'quality-v1',
    expiresAt: new Date(Date.now() + 60 * 60_000).toISOString(),
    maxCalls: 1,
    maxTokens,
    maxCostMicros: profile.maxCostMicros,
    agreementTaskIds: [
      primary.taskId,
      ...(secondary && !scenario.omitSecondaryAgreement ? [secondary.taskId] : []),
    ],
  })
  await h.api(`${base}/permit`, { configVersion })
  await h.api(`${base}/participation`, { configVersion }, { actor: colleague })
  return { projectId: project.id, taskId: discussion.id, primary, secondary, base }
}

async function effects(h: ProductionAcceptance) {
  const { db } = h.database
  const [tasks, agreements, works, questions, dispatchIntents, runs] = await Promise.all([
    db.$count(schema.tasks),
    db.$count(schema.taskSpecRevisions),
    db.$count(schema.works),
    db.$count(schema.workQuestions),
    db.$count(schema.dispatchIntents),
    db.$count(schema.runs),
  ])
  return { tasks, agreements, works, questions, dispatchIntents, runs }
}

async function observeCase(
  h: ProductionAcceptance,
  colleague: AcceptanceActor,
  scenario: DiscoveryQualityCase,
  prepared: Awaited<ReturnType<typeof prepareCase>>,
  replay: { requests: number } | undefined,
): Promise<DiscoveryQualityDriverCaseResult> {
  const { db } = h.database
  const before = await effects(h)
  const [cursor] = await db
    .select({ id: schema.teamEvents.id })
    .from(schema.teamEvents)
    .orderBy(desc(schema.teamEvents.id))
    .limit(1)
  const started = performance.now()
  const key = randomUUID()
  const comment = () =>
    h.api<{ id: string }>(
      `/tasks/${prepared.taskId}/comments`,
      { body: scenario.comment },
      { actor: colleague, idempotencyKey: key, expected: 201 },
    )
  const source = await comment()
  assert.equal((await comment()).id, source.id, 'ordinary comment replay changed source identity')
  const { admission, row, ledger } = await until(
    'discovery terminal row and settlement',
    async () => {
      const [admission] = await db
        .select()
        .from(schema.discoveryAdmissions)
        .where(eq(schema.discoveryAdmissions.sourceId, source.id))
      assert(admission?.route === 'discovery', 'ordinary comment not admitted to discovery')
      if (!admission.evaluationId) {
        assert(
          admission.processedAt === null,
          `discovery refused before dispatch: ${failureCode(admission.processingReason)}`,
        )
        return undefined
      }
      const row = await getEvaluation(db, admission.evaluationId)
      assert(
        row?.purpose === 'discovery' && row.discoverySourceId === source.id,
        'wrong discovery evaluation binding',
      )
      if (!terminal.has(row.status)) return undefined
      assert(
        row.reservedTokens !== null,
        `discovery ended without reservation: ${failureCode(row.failureCode)}`,
      )
      const ledger = await db
        .select()
        .from(schema.coordinationUsageLedger)
        .where(eq(schema.coordinationUsageLedger.projectId, prepared.projectId))
      if (!ledger.some((entry) => entry.evaluationId === row.id && entry.phase === 'settled'))
        return undefined
      return { admission, row, ledger }
    },
    (DISCOVERY_QUALITY_REAL_CONFIGURATION.timeoutSeconds + 20) * 1_000,
  )
  const manifest = CoordinationInputEntrySchema.array().parse(row.inputManifest['entries'])
  const sourceEntry = manifest.find(
    (entry) => entry.kind === 'source' && entry.sourceId === source.id,
  )
  const slot = manifest.find((entry) => entry.kind === 'slot')
  const work = manifest.find(
    (entry) => entry.kind === 'work' && entry.sourceId === prepared.projectId,
  )
  assert(
    sourceEntry?.version === admission.sourceVersion &&
      sourceEntry.digest === digest(scenario.comment),
    'wrong ordinary comment version or bytes in manifest',
  )
  assert(
    slot?.version === 'quality-v1' &&
      slot.digest ===
        digest(canonicalRecord({ activity: scenario.activity, deliverable: scenario.slot })) &&
      work,
    'registered slot or project catalog missing',
  )
  const findAgreement = (spec: TaskSpecRevisionView) =>
    manifest.find(
      (entry) =>
        entry.kind === 'agreement' &&
        entry.sourceId === spec.id &&
        entry.version === `${spec.id}:${spec.revisionNumber}` &&
        entry.digest === digest(canonicalRecord(spec.content)),
    )
  const agreement = findAgreement(prepared.primary.spec)
  const secondary = prepared.secondary && findAgreement(prepared.secondary.spec)
  assert(
    agreement &&
      Boolean(secondary) === Boolean(prepared.secondary && !scenario.omitSecondaryAgreement),
    'approved agreement version or consent binding missing',
  )
  assert(manifest.length === (secondary ? 5 : 4), 'unexpected discovery material in manifest')
  assert(
    row.evaluationDigest && row.workKey === null && row.inferenceEntryId === null,
    'discovery used business or inference identity',
  )
  assert(
    typeof row.inputManifest['coverageComplete'] === 'boolean',
    'missing catalog coverage evidence',
  )
  const omissions = row.inputManifest['omissions']
  assert(
    Array.isArray(omissions) &&
      omissions.every((value) => typeof value === 'string' && /^[a-z_]+$/.test(value)),
    'missing catalog omission evidence',
  )
  const reservations = ledger.filter((entry) => entry.phase === 'reserved')
  const settlements = ledger.filter((entry) => entry.phase === 'settled')
  const reserved = reservations[0]
  const settled = settlements[0]
  assert(
    reserved?.evaluationId === row.id &&
      settled?.evaluationId === row.id &&
      reserved.attempt === row.attempt &&
      settled.attempt === row.attempt &&
      reserved.workKey === null &&
      settled.workKey === null &&
      reserved.utcDate === settled.utcDate,
    'discovery ledger is not bound to the same evaluation and UTC budget day',
  )
  const proposal = row.discoveryObservation
  const usage = row.usage
  if (usage)
    assert(
      usage.provider === row.configSnapshot?.provider && usage.model === row.configSnapshot?.model,
      'usage disagrees with the configured provider',
    )
  if (row.status === 'completed')
    assert(
      settled.chargeMode === 'actual' &&
        usage &&
        settled.usage &&
        canonicalRecord(settled.usage) === canonicalRecord(usage),
      'completed discovery did not settle the exact reported usage as actual',
    )
  const owned = await h.request(`${prepared.base}/candidates`)
  const other = await h.request(`${prepared.base}/candidates`, undefined, { actor: colleague })
  const publicControl = await h.request(`/projects/${prepared.projectId}/tasks`, undefined, {
    actor: colleague,
  })
  const candidates = (await owned.json()) as {
    data?: {
      id: string
      evaluationId: string
      sourceId: string
      sourceVersion: string
      classification: string
      reason: string
      citations: Pick<CoordinationInputEntry, 'id' | 'kind' | 'sourceId' | 'version' | 'digest'>[]
    }[]
  }
  const [candidate] = candidates.data ?? []
  const candidateRows = await db
    .select()
    .from(schema.discoveryCandidates)
    .where(eq(schema.discoveryCandidates.evaluationId, row.id))
  const cache = owned.headers.get('cache-control')
  assert(
    owned.status === 200 &&
      cache?.includes('private') &&
      cache.includes('no-store') &&
      other.status === 404 &&
      publicControl.status === 200,
    'candidate read crossed its private audience',
  )
  const shouldDisplay =
    proposal?.classification === 'independent_gap' || proposal?.classification === 'insufficient'
  assert(
    (candidates.data?.length ?? -1) === Number(shouldDisplay) &&
      candidateRows.length === Number(shouldDisplay),
    'candidate count does not match the accepted classification',
  )
  if (candidate) {
    const stored = candidateRows[0]?.proposal
    assert(
      candidate.id === candidateRows[0]?.id &&
        candidate.evaluationId === row.id &&
        candidate.sourceId === source.id &&
        candidate.sourceVersion === admission.sourceVersion &&
        proposal &&
        stored &&
        candidate.classification === proposal.classification &&
        stored.classification === proposal.classification &&
        stored.source === proposal.source &&
        stored.slot === proposal.slot &&
        JSON.stringify(stored.citations) === JSON.stringify(proposal.citations) &&
        candidate.reason === stored.reason,
      'owner candidate has wrong result binding',
    )
    const cited = new Set([proposal.source, proposal.slot, ...proposal.citations].filter(Boolean))
    assert(
      Array.isArray(candidate.citations) &&
        candidate.citations.length === cited.size &&
        candidate.citations.every(
          (entry) =>
            cited.delete(entry.id) &&
            manifest.some(
              (item) =>
                item.id === entry.id &&
                item.kind === entry.kind &&
                item.sourceId === entry.sourceId &&
                item.version === entry.version &&
                item.digest === entry.digest,
            ),
        ),
      'owner candidate citations differ from the accepted manifest binding',
    )
  }
  const nodeAttemptDirGone = await until('discovery attempt directory cleanup', async () => {
    try {
      await lstat(join(h.stateDir, 'coordination-home', row.id, String(row.attempt)))
      return undefined
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return true
      throw error
    }
  })
  const after = await effects(h)
  const events = await db
    .select()
    .from(schema.teamEvents)
    .where(gt(schema.teamEvents.id, cursor?.id ?? 0))
  const commentEvents = events.filter((event) => {
    const payload = event.payload as { commentId?: string; taskId?: string; authorUserId?: string }
    return (
      event.type === 'comment.created' &&
      payload.commentId === source.id &&
      payload.taskId === prepared.taskId &&
      payload.authorUserId === colleague.userId
    )
  })
  assert.equal(commentEvents.length, 1, 'the ordinary comment must emit exactly one team event')
  const admissions = await db.$count(
    schema.discoveryAdmissions,
    eq(schema.discoveryAdmissions.projectId, prepared.projectId),
  )
  const evaluations = (
    await db
      .select({ purpose: schema.coordinationEvaluations.purpose })
      .from(schema.coordinationEvaluations)
      .where(eq(schema.coordinationEvaluations.projectId, prepared.projectId))
  ).filter((item) => item.purpose !== 'inference').length
  return {
    caseId: scenario.id,
    projectId: prepared.projectId,
    evaluationId: row.id,
    coverageComplete: row.inputManifest['coverageComplete'],
    entries: {
      source: sourceEntry.id,
      slot: slot.id,
      agreement: agreement.id,
      ...(secondary ? { secondaryAgreement: secondary.id } : {}),
      work: work.id,
    },
    proposal,
    evidence: {
      admissions,
      evaluations,
      modelStarts: Number(row.modelStartedAt !== null),
      // Parsed provider usage evidences a response even if its proposal failed validation.
      // Hub authorization alone isn't proof of HTTP egress.
      providerResponses: Number(usage !== null),
      reservations: reservations.length,
      settlements: settlements.length,
      readCount: row.readEntryIds.length,
      downloadCount: row.discoveryDownloadedIds.length,
      readEntryIds: row.readEntryIds,
      downloadedIds: row.discoveryDownloadedIds,
      usage: usage
        ? {
            inputTokens: usage.inputTokens,
            outputTokens: usage.outputTokens,
            costMicros: usage.costMicros,
          }
        : null,
      reservedCostMicros: reserved.reservedCostMicros,
      settledCostMicros:
        settled.chargeMode === 'actual'
          ? (settled.usage?.costMicros ?? -1)
          : settled.chargeMode === 'reserved'
            ? settled.reservedCostMicros
            : 0,
      businessWrites: {
        tasks: after.tasks - before.tasks,
        agreements: after.agreements - before.agreements,
        works: after.works - before.works,
        questions: after.questions - before.questions,
        // The only permitted team event is the human's comment.created. Count everything else.
        notifications: events.length - commentEvents.length,
        dispatchIntents: after.dispatchIntents - before.dispatchIntents,
        runs: after.runs - before.runs,
      },
    },
    provenance: {
      taskId: prepared.taskId,
      sourceId: source.id,
      sourceVersion: admission.sourceVersion,
      sourceDigest: admission.sourceDigest,
      evaluationDigest: row.evaluationDigest,
      resultDigest: row.resultDigest,
      rulesVersion: row.rulesVersion,
      promptVersion: row.processorVersion,
      status: row.status,
      failureCode: failureCode(row.failureCode),
      chargeMode: settled.chargeMode,
      attempt: row.attempt,
      durationMs: Math.round(performance.now() - started),
      manifest,
      omissions,
      candidateId: candidate?.id ?? null,
      ownerHttp: owned.status,
      ownerCache: cache,
      colleagueHttp: other.status,
      publicControlHttp: publicControl.status,
      nodeAttemptDirGone,
      replayRequests: replay?.requests ?? null,
    },
    ...(candidate ? { review: { reason: h.redact(candidate.reason) } } : {}),
  }
}

export async function runDiscoveryQualityDriver(
  options: DiscoveryQualityDriverOptions,
): Promise<DiscoveryQualityDriverCaseResult[]> {
  assert(
    Boolean(options.key) === (options.mode === 'real_model'),
    'only real model mode accepts a key',
  )
  const cases = getDiscoveryQualityCases(options.split)
  const config = DISCOVERY_QUALITY_REAL_CONFIGURATION
  assert(
    cases.length > 0 &&
      cases.length * config.maxCostMicros <= DISCOVERY_QUALITY_MAX_SPLIT_COST_MICROS,
    'split exceeds campaign cost ceiling',
  )
  assert(
    coordinationUsageCost({
      ...config,
      inputTokens: config.maxInputTokens,
      outputTokens: config.maxOutputTokens,
    }) <= config.maxCostMicros,
    'model ceiling exceeds case budget',
  )
  let replay: { scenario: DiscoveryQualityCase; requests: number } | undefined
  let replayFailed = false
  const h = new ProductionAcceptance(
    options.mode === 'real_model'
      ? undefined
      : (request, response) => {
          if (!replay) {
            replayFailed = true
            response.writeHead(400).end('unexpected replay request')
            return
          }
          void respondToReplay(replay, request, response).catch(() => {
            replayFailed = true
            response.writeHead(400).end('discovery fixture mismatch')
          })
        },
  )
  if (options.key) h.protect(options.key)
  let phase = 'start'
  try {
    await h.start()
    phase = 'device_configuration'
    const device = await configureDevice(h, options)
    const colleague = await h.inviteMember('discovery-quality-colleague')
    const prepared = []
    for (const scenario of cases) {
      phase = `prepare:${scenario.id}`
      prepared.push(await prepareCase(h, colleague, scenario, device, cases.length))
    }
    if (options.mode === 'prepare_only') {
      assert(
        !replayFailed && (await h.database.db.$count(schema.discoveryAdmissions)) === 0,
        'prepare-only activity unexpectedly started discovery',
      )
      return []
    }
    const results: DiscoveryQualityDriverCaseResult[] = []
    for (const [index, scenario] of cases.entries()) {
      phase = `evaluate:${scenario.id}`
      const item = prepared[index]
      assert(item, 'missing prepared case')
      if (options.mode === 'replay') replay = { scenario, requests: 0 }
      const result = await observeCase(h, colleague, scenario, item, replay)
      if (replay)
        assert(!replayFailed && replay.requests === 1, 'fixture did not witness one replay request')
      replay = undefined
      results.push(result)
      await options.onCase?.(result)
      if (result.provenance.failureCode === 'provider_request_failed')
        throw new Error('provider refused request; stopping remaining cases')
    }
    return results
  } catch (error) {
    const message = error instanceof Error ? error.message : 'unexpected driver failure'
    throw new Error(h.redact(`discovery quality ${phase}: ${message}`))
  } finally {
    await h.stop()
  }
}
