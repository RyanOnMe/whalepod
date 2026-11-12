import assert from 'node:assert/strict'
import { constants } from 'node:fs'
import { open, readFile, realpath, stat } from 'node:fs/promises'
import { isAbsolute, join, relative, sep } from 'node:path'
import {
  fingerprintAssemblyFiles,
  fingerprintProductionAssembly,
  isSha256,
  sha256,
  type HoldoutAttempt,
} from './acceptance-provenance.js'
import { repoRoot } from './production-acceptance.js'
import { checkRd04c2 } from '../verify-rd04c2-acceptance.js'
import { publicBody, sourceBody } from './rd04c2-replay.js'

/** Accepted fixture route, never used to configure a normal deployment. */
export const EXECUTOR_ROUTE = {
  provider: 'command-code',
  model: 'deepseek/deepseek-v4.1-flash',
  endpoint: 'https://api.commandcode.ai/provider/v1/chat/completions',
  account: 'rd04c3-acceptance',
  policyGeneration: 1,
} as const

export type BoundExecutorRoute = typeof EXECUTOR_ROUTE & { readonly credentialDigest: string }

export function boundExecutorRoute(credentialDigest: string): BoundExecutorRoute {
  assert(isSha256(credentialDigest), 'invalid credential binding')
  return { ...EXECUTOR_ROUTE, credentialDigest }
}

export function bindApprovedCredential(planRaw: string, key: string) {
  return {
    schemaVersion: 1,
    planDigest: sha256(planRaw),
    account: EXECUTOR_ROUTE.account,
    credentialDigest: sha256(key),
  } as const
}

export function parseCredentialBinding(bindingRaw: string, planRaw: string) {
  const binding = JSON.parse(bindingRaw) as ReturnType<typeof bindApprovedCredential>
  assert.equal(binding.schemaVersion, 1)
  assert.equal(binding.planDigest, sha256(planRaw))
  assert.equal(binding.account, EXECUTOR_ROUTE.account)
  assert(isSha256(binding.credentialDigest))
  return binding
}

/** Peak list prices, used as a conservative local tariff, not provider invoice evidence. */
export const EXECUTOR_POLICY = {
  route: EXECUTOR_ROUTE,
  maxInputTokens: 1_048_576,
  maxOutputTokens: 2048,
  inputPriceMicrosPerMillion: 300_000,
  outputPriceMicrosPerMillion: 1_200_000,
} as const

export const EXECUTOR_LIMITS = {
  dispatches: 1,
  calls: 8,
  tokens: 9_000_000,
  costMicros: 3_000_000,
} as const

const PRIVATE_MARKER_PREFIX = 'RD04C3_PRIVATE_DRAFT_ONLY_'
export const privateMarkerForRun = (runId: string) => PRIVATE_MARKER_PREFIX + runId
export const FIXTURE_FACT = 'The shuttle stop has no permanent boarding ramp.'
export const FIXTURE_RECOMMENDATION = 'portable boarding ramp'

export const EXECUTOR_PERSONA = [
  'Follow the task using the tools in this order, on separate turns.',
  'Read each item in the frozen discovery manifest using read_work_input and its inboxItemId.',
  'After reading both items, write a short Markdown plan to the exact private draft path supplied.',
  `Use a title formed by concatenating "${PRIVATE_MARKER_PREFIX}" and the UUID in the private draft path.`,
  'Quote the relevant factual survey finding verbatim. Give a practical boarding recommendation.',
  'Copy the inspection reference and the planned option reference exactly from their respective sources.',
  'Call publish_artifact for that exact file with the same title and text/markdown, then stop.',
].join('\n')

export function guardedFixtureWitnesses(attemptId: string) {
  const digest = (kind: string) => sha256(`rd04c3-acceptance:${attemptId}:${kind}`).slice(0, 12)
  const artifactCode = 'WPA-' + digest('artifact')
  const commentCode = 'WPC-' + digest('comment')
  return {
    artifactCode,
    commentCode,
    digest: sha256(JSON.stringify([artifactCode, commentCode])),
    publicBody: publicBody + `Inspection reference: ${artifactCode}.\n`,
    sourceBody:
      sourceBody + ` Planned option reference: ${commentCode}. Consider a portable boarding ramp.`,
  }
}

const relevantHarnessFiles = [
  'scripts/run-rd04c3-acceptance.ts',
  'scripts/verify-rd04c3-acceptance.ts',
  'scripts/lib/rd04c3-acceptance.ts',
  'scripts/lib/discovery-draft-fixture.ts',
  'scripts/lib/rd04c2-replay.ts',
  'scripts/lib/production-acceptance.ts',
  'scripts/lib/acceptance-provenance.ts',
  'scripts/run-rd04c2-acceptance.ts',
  'scripts/verify-rd04c2-acceptance.ts',
]

export interface GuardedAcceptancePlan {
  schemaVersion: 1
  preparedAt: string
  assemblyDigest: string
  harnessDigest: string
  c2EvidenceDigest: string
  guardEvidenceDigest: string
  policy: typeof EXECUTOR_POLICY
  limits: typeof EXECUTOR_LIMITS
}

export async function bindGuardedAssembly() {
  const [assemblyDigest, harnessDigest] = await Promise.all([
    fingerprintProductionAssembly(repoRoot),
    fingerprintAssemblyFiles(repoRoot, relevantHarnessFiles, []),
  ])
  return { assemblyDigest, harnessDigest }
}

async function bindC2Proof(assemblyDigest: string) {
  const proof = await Promise.all(
    ['', 'revoke-before-read'].map(async (dir) => {
      const root = join(repoRoot, 'artifacts/evidence/rd04c2', dir)
      const [result, events] = await Promise.all([
        readFile(join(root, 'result.json'), 'utf8'),
        readFile(join(root, 'events.jsonl'), 'utf8'),
      ])
      const parsed = JSON.parse(result)
      assert.equal(parsed.mode, dir ? 'revoke_before_first_read' : 'loopback_model_replay')
      checkRd04c2(parsed, events, assemblyDigest)
      return [sha256(result), sha256(events)]
    }),
  )
  return sha256(JSON.stringify(proof))
}

export interface GuardNegativeCase {
  kind: 'budget' | 'revoked_grant'
  terminal: 'failed' | 'cancelled' | 'no_run'
  authorizedHttp: number
  revokedHttp: number | null
  runCount: number
  attemptCount: number
  draftCount: number
  workBudgetRows: number
  wrongRouteHttp: number
  partialGrantHttp: number
  unauthorizedSourceGrantHttp: number
  executorReplayRequests: number
  observedEgress: number
  hubBeginStatuses: readonly number[]
  hubOnlineStatuses: readonly number[]
}

type GuardBinding = Awaited<ReturnType<typeof bindGuardedAssembly>>

export function checkGuardNegatives(
  proof: GuardBinding & { schemaVersion: number; cases: readonly GuardNegativeCase[] },
  binding: GuardBinding,
) {
  assert.equal(proof.schemaVersion, 1)
  assert.equal(proof.assemblyDigest, binding.assemblyDigest)
  assert.equal(proof.harnessDigest, binding.harnessDigest)
  assert.equal(proof.cases.length, 2)
  const [budget, revoked] = proof.cases
  assert(budget?.kind === 'budget' && revoked?.kind === 'revoked_grant')
  assert(budget.terminal === 'failed' || budget.terminal === 'cancelled')
  assert.equal(budget.authorizedHttp, 200)
  assert.equal(budget.revokedHttp, null)
  assert.equal(budget.runCount, 1)
  assert.equal(budget.workBudgetRows, 1)
  assert.deepEqual(budget.hubBeginStatuses, [409])
  assert(
    budget.hubOnlineStatuses.length > 0 &&
      budget.hubOnlineStatuses.every((status) => status === 204),
  )
  assert.equal(revoked.terminal, 'no_run')
  assert.equal(revoked.authorizedHttp, 409)
  assert.equal(revoked.revokedHttp, 204)
  assert.equal(revoked.runCount, 0)
  assert.equal(revoked.workBudgetRows, 0)
  assert.deepEqual(revoked.hubBeginStatuses, [])
  assert.deepEqual(revoked.hubOnlineStatuses, [])
  for (const row of proof.cases) {
    assert.equal(row.attemptCount, 0)
    assert.equal(row.draftCount, 0)
    assert.equal(row.wrongRouteHttp, 409)
    assert.equal(row.partialGrantHttp, 409)
    assert([403, 404].includes(row.unauthorizedSourceGrantHttp))
    assert.equal(row.executorReplayRequests, 0)
    assert.equal(row.observedEgress, 0)
  }
}

export async function bindGuardedAcceptancePlan(
  preparedAt: string,
): Promise<GuardedAcceptancePlan> {
  assert(Number.isFinite(Date.parse(preparedAt)), 'invalid preparation timestamp')
  const [binding, raw] = await Promise.all([
    bindGuardedAssembly(),
    readFile(join(repoRoot, 'artifacts/evidence/rd04c3/guard-negatives.json'), 'utf8'),
  ])
  checkGuardNegatives(JSON.parse(raw), binding)
  const c2EvidenceDigest = await bindC2Proof(binding.assemblyDigest)
  const worstPerCall = cost(EXECUTOR_POLICY.maxInputTokens, EXECUTOR_POLICY.maxOutputTokens)
  assert(EXECUTOR_LIMITS.calls * worstPerCall <= EXECUTOR_LIMITS.costMicros)
  assert(
    EXECUTOR_LIMITS.calls * (EXECUTOR_POLICY.maxInputTokens + EXECUTOR_POLICY.maxOutputTokens) <=
      EXECUTOR_LIMITS.tokens,
  )
  return {
    schemaVersion: 1,
    preparedAt,
    ...binding,
    c2EvidenceDigest,
    guardEvidenceDigest: sha256(raw),
    policy: EXECUTOR_POLICY,
    limits: EXECUTOR_LIMITS,
  }
}

/** A key enters only the packaged Node parent's stdin; never argv, env or evidence. */
export async function readPrivateAcceptanceCredential(path: string): Promise<string> {
  try {
    const resolved = await realpath(path)
    const within = relative(await realpath(repoRoot), resolved)
    assert(within === '..' || within.startsWith(`..${sep}`) || isAbsolute(within))
    const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
    try {
      const info = await file.stat()
      const canonical = await stat(resolved)
      assert(
        info.isFile() &&
          (info.mode & 0o777) === 0o600 &&
          info.uid === process.getuid?.() &&
          info.size <= 4096 &&
          info.ino === canonical.ino &&
          info.dev === canonical.dev &&
          (await realpath(path)) === resolved,
      )
      const key = (await file.readFile('utf8')).trim()
      assert(/^[\x21-\x7e]{8,4096}$/.test(key))
      return key
    } finally {
      await file.close()
    }
  } catch {
    throw new Error('use an authorized private 0600 Executor key file outside the repository')
  }
}

export interface ExecutorAttemptEvidence {
  readonly runId: string
  readonly attemptId: string
  readonly state: string
  readonly requestDigest: string
  readonly requestBytes: number
  readonly utcDate: string
  readonly maxInputTokens: number
  readonly maxOutputTokens: number
  readonly reservedCostMicros: number
  readonly inputTokens: number | null
  readonly outputTokens: number | null
  readonly costMicros: number | null
  readonly responseIdDigest: string | null
  readonly overage: boolean
  readonly createdAt: string
  readonly settledAt: string | null
}

export interface ExecutorEvent {
  readonly component: 'node.discovery_execution'
  readonly action: 'discovery.executor.sent' | 'discovery.executor.provider_usage'
  readonly runId: string
  readonly attemptId: string
  readonly at: string
  readonly transport: 'native_https'
  readonly responseIdDigest?: string
  readonly inputTokens?: number
  readonly outputTokens?: number
}

export interface ExecutorUsage {
  readonly calls: number
  readonly inputTokens: number
  readonly outputTokens: number
  readonly tokens: number
  readonly costMicros: number
}

export interface GuardedAcceptanceEvidence {
  readonly schemaVersion: 1
  readonly mode: 'guarded_live_model'
  readonly invoiceReconciliation: 'not_run'
  readonly attemptId: string
  readonly provider: typeof EXECUTOR_ROUTE
  readonly projectId: string
  readonly taskId: string
  readonly executionId: string
  readonly runId: string
  readonly runCount: number
  readonly runStatus: string
  readonly dispatch: {
    readonly policyGeneration: number
    readonly routeDigest: string
    readonly sourceGrantsDigest: string
    readonly idempotent: boolean
  }
  readonly grantCount: number
  readonly unauthorizedSourceGrantHttp: number
  readonly wrongRouteHttp: number
  readonly partialGrantHttp: number
  readonly beforeAuthorizationRuns: number
  readonly publicReplayRequests: number
  readonly discoveryReplayRequests: number
  readonly executorReplayRequests: number
  readonly sources: readonly {
    kind: string
    sourceId: string
    sourceVersion: string
    sourceDigest: string
    authorizationGeneration: string
  }[]
  readonly manifest: readonly {
    inboxItemId: string
    sourceId: string
    sourceVersion: string
    sourceDigest: string
    authorizationGeneration: string
  }[]
  readonly manifestDigest: string
  readonly readReceipts: readonly { inboxItemId: string; digestVerified: boolean }[]
  readonly draft: {
    ownerHttp: number
    memberHttp: number
    publicControlHttp: number
    formalPublishHttp: number
    privateNoStore: boolean
    bytesDigest: string
    metadataDigest: string
    fixtureFact: boolean
    recommendation: boolean
    privateMarker: boolean
    sourceWitnessesMatched: boolean
    sourceWitnessesDigest: string
  }
  readonly visibility: readonly { observed: number; leaks: number }[]
  readonly workspacesClean: boolean
  readonly calls: readonly ExecutorAttemptEvidence[]
  readonly usageByScope: {
    readonly team: ExecutorUsage
    readonly project: ExecutorUsage
    readonly parent: ExecutorUsage
    readonly work: ExecutorUsage
  }
  readonly provenance: {
    readonly planDigest: string
    readonly credentialBindingDigest: string
    readonly attemptDigest: string
    readonly eventsDigest: string
  }
}

const nonnegative = (n: unknown): n is number =>
  typeof n === 'number' && Number.isSafeInteger(n) && n >= 0
const validTime = (value: string | null | undefined): number => {
  const n = Date.parse(value ?? '')
  assert(Number.isFinite(n), 'invalid evidence timestamp')
  return n
}
const uuid = (value: unknown): boolean =>
  typeof value === 'string' && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(value)

function cost(inputTokens: number, outputTokens: number) {
  // Independent meter: add both token charges, then round up to one micro-dollar.
  return Math.ceil(
    (inputTokens * EXECUTOR_POLICY.inputPriceMicrosPerMillion +
      outputTokens * EXECUTOR_POLICY.outputPriceMicrosPerMillion) /
      1_000_000,
  )
}

/** Independent read-only judgment; missing, simulated or unmatched provider facts never pass. */
export function checkRd04c3(
  report: GuardedAcceptanceEvidence,
  eventsRaw: string,
  planRaw: string,
  attemptRaw: string,
  bindingRaw: string,
): ExecutorUsage {
  const plan = JSON.parse(planRaw) as GuardedAcceptancePlan
  const binding = parseCredentialBinding(bindingRaw, planRaw)
  const attempt = JSON.parse(attemptRaw) as HoldoutAttempt
  assert.equal(plan.schemaVersion, 1)
  assert.deepEqual(plan.policy, EXECUTOR_POLICY)
  assert.deepEqual(plan.limits, EXECUTOR_LIMITS)
  assert(
    [
      plan.assemblyDigest,
      plan.harnessDigest,
      plan.c2EvidenceDigest,
      plan.guardEvidenceDigest,
    ].every(isSha256),
  )
  assert.equal(attempt.schemaVersion, 1)
  assert(uuid(attempt.id))
  assert(validTime(attempt.startedAt) > validTime(plan.preparedAt))
  assert.equal(attempt.freezeDigest, sha256(planRaw + bindingRaw))
  assert.equal(report.schemaVersion, 1)
  assert.equal(report.mode, 'guarded_live_model')
  assert.equal(report.invoiceReconciliation, 'not_run')
  assert.equal(report.attemptId, attempt.id)
  assert.deepEqual(report.provider, EXECUTOR_ROUTE)
  assert.deepEqual(report.provenance, {
    planDigest: sha256(planRaw),
    credentialBindingDigest: sha256(bindingRaw),
    attemptDigest: sha256(attemptRaw),
    eventsDigest: sha256(eventsRaw),
  })
  assert([report.projectId, report.taskId, report.executionId, report.runId].every(uuid))
  assert.equal(report.runCount, 1)
  assert.equal(report.runStatus, 'completed')
  const route = {
    ...boundExecutorRoute(binding.credentialDigest),
    purpose: 'private_draft',
  } as const
  const sortedRoute = Object.fromEntries(
    (Object.keys(route) as (keyof typeof route)[]).sort().map((key) => [key, route[key]]),
  )
  assert.equal(report.dispatch.routeDigest, sha256(JSON.stringify(sortedRoute)))
  assert.equal(report.dispatch.policyGeneration, EXECUTOR_ROUTE.policyGeneration)
  assert(isSha256(report.dispatch.sourceGrantsDigest) && report.dispatch.idempotent === true)
  assert.equal(report.beforeAuthorizationRuns, 0)
  assert.equal(report.grantCount, 2)
  assert([403, 404].includes(report.unauthorizedSourceGrantHttp))
  assert.equal(report.wrongRouteHttp, 409)
  assert.equal(report.partialGrantHttp, 409)
  assert.equal(report.publicReplayRequests, 3)
  assert.equal(report.discoveryReplayRequests, 1)
  assert.equal(report.executorReplayRequests, 0)

  assert.deepEqual(report.sources.map(({ kind }) => kind).sort(), ['artifact', 'task_message'])
  assert.equal(report.manifest.length, report.sources.length)
  assert(isSha256(report.manifestDigest))
  const sourceIdentities = report.sources
    .map(({ sourceId, sourceVersion, sourceDigest, authorizationGeneration }) => {
      assert(uuid(sourceId) && isSha256(sourceDigest))
      assert(sourceVersion.length > 0 && authorizationGeneration.length > 0)
      return JSON.stringify([sourceId, sourceVersion, sourceDigest, authorizationGeneration])
    })
    .sort()
  assert.deepEqual(
    report.manifest
      .map(({ inboxItemId, sourceId, sourceVersion, sourceDigest, authorizationGeneration }) => {
        assert(uuid(inboxItemId))
        return JSON.stringify([sourceId, sourceVersion, sourceDigest, authorizationGeneration])
      })
      .sort(),
    sourceIdentities,
  )
  assert.equal(
    new Set(report.manifest.map((entry) => entry.inboxItemId)).size,
    report.manifest.length,
  )
  assert(report.readReceipts.every((row) => row.digestVerified))
  assert.deepEqual(
    [...new Set(report.readReceipts.map((row) => row.inboxItemId))].sort(),
    report.manifest.map((row) => row.inboxItemId).sort(),
  )
  const draft = report.draft
  assert.equal(draft.ownerHttp, 200)
  assert.equal(draft.memberHttp, 404)
  assert.equal(draft.publicControlHttp, 200)
  assert.equal(draft.formalPublishHttp, 404)
  assert(draft.privateNoStore && draft.fixtureFact && draft.recommendation && draft.privateMarker)
  assert.equal(draft.sourceWitnessesMatched, true)
  assert.equal(draft.sourceWitnessesDigest, guardedFixtureWitnesses(attempt.id).digest)
  assert(isSha256(draft.bytesDigest) && draft.bytesDigest === draft.metadataDigest)
  assert(report.workspacesClean)
  assert.equal(report.visibility.length, 3)
  assert(report.visibility.every((row) => row.observed > 0 && row.leaks === 0))

  const events = eventsRaw
    .trim()
    .split('\n')
    .map((row) => JSON.parse(row) as ExecutorEvent)
  assert.equal(events.length, report.calls.length * 2)
  assert(
    events.every(
      (event) =>
        event.component === 'node.discovery_execution' &&
        event.runId === report.runId &&
        event.transport === 'native_https',
    ),
  )
  assert(report.calls.length >= 2 && report.calls.length <= plan.limits.calls)
  assert.equal(new Set(report.calls.map((row) => row.attemptId)).size, report.calls.length)
  assert.equal(new Set(report.calls.map((row) => row.responseIdDigest)).size, report.calls.length)
  const totals = {
    calls: report.calls.length,
    inputTokens: 0,
    outputTokens: 0,
    tokens: 0,
    costMicros: 0,
  }
  let lastSettled = validTime(attempt.startedAt)
  for (const call of report.calls) {
    assert.equal(call.runId, report.runId)
    assert(uuid(call.attemptId))
    assert.equal(call.state, 'actual')
    assert.equal(call.overage, false)
    assert(isSha256(call.requestDigest) && isSha256(call.responseIdDigest))
    assert(nonnegative(call.requestBytes) && call.requestBytes > 0)
    assert(
      nonnegative(call.maxInputTokens) &&
        call.maxInputTokens > 0 &&
        call.maxInputTokens <= plan.policy.maxInputTokens,
    )
    assert(
      nonnegative(call.maxOutputTokens) &&
        call.maxOutputTokens > 0 &&
        call.maxOutputTokens <= plan.policy.maxOutputTokens,
    )
    assert(
      nonnegative(call.inputTokens) &&
        call.inputTokens > 0 &&
        call.inputTokens <= call.maxInputTokens,
    )
    assert(
      nonnegative(call.outputTokens) &&
        call.outputTokens > 0 &&
        call.outputTokens <= call.maxOutputTokens,
    )
    assert.equal(call.reservedCostMicros, cost(call.maxInputTokens, call.maxOutputTokens))
    assert.equal(call.costMicros, cost(call.inputTokens, call.outputTokens))
    const matching = events.filter((event) => event.attemptId === call.attemptId)
    assert.deepEqual(
      matching.map((event) => event.action),
      ['discovery.executor.sent', 'discovery.executor.provider_usage'],
    )
    const [sent, usage] = matching
    assert(sent && usage)
    const created = validTime(call.createdAt)
    const settled = validTime(call.settledAt)
    assert(
      created >= lastSettled &&
        validTime(sent.at) >= created &&
        validTime(usage.at) >= validTime(sent.at) &&
        settled >= validTime(usage.at),
      'reservation must precede dispatch and measured provider usage must precede settlement',
    )
    assert.equal(call.utcDate, new Date(created).toISOString().slice(0, 10))
    assert.equal(usage.responseIdDigest, call.responseIdDigest)
    assert.equal(usage.inputTokens, call.inputTokens)
    assert.equal(usage.outputTokens, call.outputTokens)
    lastSettled = settled
    totals.inputTokens += call.inputTokens
    totals.outputTokens += call.outputTokens
    totals.tokens += call.inputTokens + call.outputTokens
    totals.costMicros += call.costMicros
  }
  assert(totals.tokens <= plan.limits.tokens && totals.costMicros <= plan.limits.costMicros)
  for (const scope of ['team', 'project', 'parent', 'work'] as const)
    assert.deepEqual(report.usageByScope[scope], totals, `wrong settled ${scope} charge`)
  return totals
}
