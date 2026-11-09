import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import {
  CoordinationInputEntrySchema,
  CoordinationUsageSchema,
  RouterProposalSchema,
  type CoordinationInputEntry,
  type CoordinationUsage,
  type RouterProposal,
} from '@whalepod/protocol'
import {
  ROUTER_QUALITY_CASES,
  ROUTER_QUALITY_RUBRIC_VERSION,
  type QualitySplit,
} from './router-quality-cases.js'

export const QUALITY_PROVIDER = 'command-code'
export const QUALITY_ENDPOINT = 'https://api.commandcode.ai/provider/v1/chat/completions'
export const QUALITY_MODEL = 'deepseek/deepseek-v4.1-flash'
export const QUALITY_SLOT = 'router-quality'
// Hub's shared estimator already adds 16,384 overhead before counting any input bytes.
export const QUALITY_MAX_INPUT = 32_768
export const QUALITY_MAX_OUTPUT = 4_096
export const QUALITY_MAX_CASE_COST_MICROS = 15_000
export const QUALITY_MAX_SPLIT_COST_MICROS = 90_000
export const QUALITY_ASSEMBLY = {
  hub: 'package-production-server',
  node: 'package-cli-bin',
  runtime: 'package-bin-isolated-worker',
  database: 'postgresql',
  transport: 'pinned-provider-https',
} as const

export function digest(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}
export const qualityDatasetDigest = digest(JSON.stringify(ROUTER_QUALITY_CASES))
export { ROUTER_QUALITY_RUBRIC_VERSION }

export interface QualityCaseResult {
  caseId: string
  taskId: string
  workKey: string
  triggerSourceId: string
  publishedEvidenceId?: string
  evaluationId: string
  evaluationDigest: string
  rulesVersion: string
  promptVersion: string
  modelStarted: boolean
  attempt: number
  durationMs: number
  status: 'completed' | 'failed' | 'cancelled' | 'stale' | 'skipped'
  failureCode: string | null
  manifest: CoordinationInputEntry[]
  readEntryIds: string[]
  usage: CoordinationUsage | null
  settlement: {
    reserved: number
    settled: number
    mode: 'actual' | 'reserved' | 'zero'
    costMicros: number
  }
  proposal: RouterProposal | null
  applicationStatus: 'applied' | 'rejected' | 'stale' | null
  applicationRunId: string | null
  businessRunsAfterTrigger: number
  newTasksAfterTrigger: number
}

export interface QualityResult {
  schemaVersion: 1
  split: QualitySplit
  generatedAt: string
  assembly: typeof QUALITY_ASSEMBLY
  endpoint: typeof QUALITY_ENDPOINT
  provider: typeof QUALITY_PROVIDER
  model: typeof QUALITY_MODEL
  datasetDigest: string
  rubricVersion: typeof ROUTER_QUALITY_RUBRIC_VERSION
  sourceRevision: string
  sourceDigest: string
  engineeringEvidenceDigest: string
  pricing: { input: number; output: number }
  cases: QualityCaseResult[]
}

export interface QualityFreeze {
  schemaVersion: 1
  developmentDigest: string
  datasetDigest: string
  sourceRevision: string
  sourceDigest: string
  engineeringEvidenceDigest: string
  profileDigest: string
  minimumMatching: number
}

export function qualityProfileDigest(value: QualityResult): string {
  return digest(
    JSON.stringify({
      provider: value.provider,
      model: value.model,
      endpoint: value.endpoint,
      pricing: [value.pricing.input, value.pricing.output],
      prompts: [...new Set(value.cases.map((x) => x.promptVersion))].sort(),
      rules: [...new Set(value.cases.map((x) => x.rulesVersion))].sort(),
      maxInput: QUALITY_MAX_INPUT,
      maxOutput: QUALITY_MAX_OUTPUT,
      caseCap: QUALITY_MAX_CASE_COST_MICROS,
      splitCap: QUALITY_MAX_SPLIT_COST_MICROS,
    }),
  )
}

const isDigest = (value: unknown): value is string =>
  typeof value === 'string' && /^[a-f0-9]{64}$/.test(value)
const isId = (value: unknown): value is string =>
  typeof value === 'string' && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(value)
const isCount = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
const isVersion = (value: unknown): value is string =>
  typeof value === 'string' && /^[a-z0-9.]{3,40}$/.test(value)

/** Verify from durable Hub facts and fixed labels. Narrative factuality is separately reviewed. */
export function verifyRouterQuality(raw: unknown, freeze?: QualityFreeze) {
  const report = raw as QualityResult
  assert(report && report.schemaVersion === 1, 'unsupported quality report')
  assert(report.split === 'development' || report.split === 'holdout', 'unknown split')
  assert.deepEqual(report.assembly, QUALITY_ASSEMBLY, 'not real provider assembly')
  assert.equal(report.endpoint, QUALITY_ENDPOINT, 'provider endpoint does not match')
  assert.equal(report.provider, QUALITY_PROVIDER, 'provider does not match')
  assert.equal(report.model, QUALITY_MODEL, 'model does not match')
  assert.equal(report.datasetDigest, qualityDatasetDigest, 'dataset does not match')
  assert.equal(report.rubricVersion, ROUTER_QUALITY_RUBRIC_VERSION, 'rubric does not match')
  assert(
    typeof report.sourceRevision === 'string' && /^[a-f0-9]{40}$/.test(report.sourceRevision),
    'missing source revision',
  )
  assert(isDigest(report.sourceDigest), 'missing exact source fingerprint')
  assert(isDigest(report.engineeringEvidenceDigest), 'missing M1R-A evidence fingerprint')
  assert(Number.isFinite(Date.parse(report.generatedAt)), 'missing evidence time')
  assert(isCount(report.pricing?.input) && report.pricing.input > 0, 'missing input price')
  assert(isCount(report.pricing?.output) && report.pricing.output > 0, 'missing output price')
  const expected = ROUTER_QUALITY_CASES.filter((x) => x.split === report.split)
  assert(
    Array.isArray(report.cases) && report.cases.length === expected.length,
    'case evidence missing',
  )
  assert.deepEqual(
    report.cases.map((x) => x.caseId).sort(),
    expected.map((x) => x.id).sort(),
    'wrong or duplicate cases',
  )
  assert.equal(
    new Set(report.cases.map((x) => x.evaluationId)).size,
    expected.length,
    'duplicate evaluation',
  )
  assert.equal(
    new Set(report.cases.map((x) => x.evaluationDigest)).size,
    expected.length,
    'duplicate evaluation digest',
  )
  assert.equal(new Set(report.cases.map((x) => x.taskId)).size, expected.length, 'duplicate task')
  assert.equal(new Set(report.cases.map((x) => x.workKey)).size, expected.length, 'duplicate work')
  assert.equal(new Set(report.cases.map((x) => x.promptVersion)).size, 1, 'mixed prompts')
  assert.equal(new Set(report.cases.map((x) => x.rulesVersion)).size, 1, 'mixed rules')
  if (report.split === 'holdout') {
    assert(freeze && freeze.schemaVersion === 1, 'holdout requires frozen development result')
    assert(isDigest(freeze.developmentDigest), 'missing development fingerprint')
    assert.equal(freeze.datasetDigest, report.datasetDigest, 'holdout dataset changed')
    assert.equal(freeze.sourceRevision, report.sourceRevision, 'holdout source revision changed')
    assert.equal(freeze.sourceDigest, report.sourceDigest, 'holdout source files changed')
    assert.equal(
      freeze.engineeringEvidenceDigest,
      report.engineeringEvidenceDigest,
      'holdout engineering evidence changed',
    )
    assert.equal(
      freeze.profileDigest,
      qualityProfileDigest(report),
      'holdout configuration changed',
    )
    assert(
      isCount(freeze.minimumMatching) &&
        freeze.minimumMatching >= 4 &&
        freeze.minimumMatching <= expected.length,
      'invalid holdout threshold',
    )
  } else assert(!freeze, 'development evidence must not use holdout threshold')

  const scored = report.cases.map((row) => {
    const scenario = expected.find((item) => item.id === row.caseId)!
    const label = scenario.expected
    const errors: string[] = []
    const fail = (kind: string) => errors.push(kind)
    assert(
      isId(row.evaluationId) && isId(row.workKey) && isId(row.taskId) && isId(row.triggerSourceId),
      'invalid evidence identity',
    )
    assert(
      isDigest(row.evaluationDigest) && isVersion(row.rulesVersion) && isVersion(row.promptVersion),
      'missing evaluation binding',
    )
    assert.equal(row.attempt, 1, 'one attempt per scenario')
    assert(isCount(row.durationMs), 'missing duration')
    assert(
      ['completed', 'failed', 'cancelled', 'stale', 'skipped'].includes(row.status),
      'invalid result status',
    )
    const manifest = CoordinationInputEntrySchema.array().nonempty().parse(row.manifest)
    const sources = manifest.filter((entry) => entry.kind === 'source')
    const evidence = manifest.filter((entry) => entry.kind === 'evidence')
    assert.equal(
      new Set(manifest.map((entry) => entry.id)).size,
      manifest.length,
      'duplicate input identity',
    )
    assert.equal(sources.length, 1, 'each case must have one real trigger source')
    assert.equal(sources[0]?.sourceId, `task_message:${row.triggerSourceId}`, 'wrong input source')
    assert.equal(sources[0]?.digest, digest(scenario.message), 'wrong source content')
    assert.equal(sources[0]?.byteSize, Buffer.byteLength(scenario.message), 'wrong source size')
    assert.equal(
      manifest.filter((entry) => entry.kind === 'agreement').length,
      1,
      'missing agreement',
    )
    assert.equal(
      manifest.filter((entry) => entry.kind === 'work').length,
      1,
      'missing work/Mandate',
    )
    if (scenario.evidence) {
      assert(isId(row.publishedEvidenceId), 'missing published artifact identity')
      assert.equal(evidence.length, 1, 'expected exactly one published artifact')
      assert.equal(evidence[0]?.sourceId, row.publishedEvidenceId, 'wrong artifact identity')
      assert.equal(evidence[0]?.digest, digest(scenario.evidence.body), 'wrong artifact version')
      assert.equal(evidence[0]?.version, evidence[0]?.digest, 'wrong artifact version pin')
      assert.equal(
        evidence[0]?.byteSize,
        Buffer.byteLength(scenario.evidence.body),
        'wrong artifact size',
      )
    } else {
      assert.equal(evidence.length, 0, 'unexpected published artifact')
      assert.equal(row.publishedEvidenceId, undefined, 'unexpected artifact identity')
    }
    assert(
      Array.isArray(row.readEntryIds) &&
        row.readEntryIds.every((id) => manifest.some((entry) => entry.id === id)),
      'invalid read set',
    )
    assert.equal(row.settlement.reserved, 1, 'missing usage reservation')
    assert.equal(row.settlement.settled, 1, 'missing or duplicate usage settlement')
    assert(
      isCount(row.settlement.costMicros) &&
        row.settlement.costMicros <= QUALITY_MAX_CASE_COST_MICROS,
      'invalid case cost',
    )
    assert(['actual', 'reserved', 'zero'].includes(row.settlement.mode), 'unknown settlement mode')
    const usage = row.usage === null ? null : CoordinationUsageSchema.parse(row.usage)
    if (usage) {
      assert.equal(usage.model, report.model, 'usage model mismatch')
      assert.equal(usage.provider, report.provider, 'usage provider mismatch')
      assert(
        usage.inputTokens <= QUALITY_MAX_INPUT && usage.outputTokens <= QUALITY_MAX_OUTPUT,
        'usage exceeded configured ceiling',
      )
      assert(
        usage.costMicros <= QUALITY_MAX_CASE_COST_MICROS,
        'usage cost exceeded configured ceiling',
      )
    }
    const protocolAccepted = row.status === 'completed' && row.failureCode === null
    const proposal = row.proposal === null ? null : RouterProposalSchema.parse(row.proposal)
    if (!protocolAccepted) {
      fail('provider_or_protocol_failure')
      assert.equal(proposal, null, 'failed evaluation nevertheless produced an accepted proposal')
    }
    if (protocolAccepted) {
      assert(
        row.modelStarted === true && usage && usage.inputTokens > 0 && usage.outputTokens > 0,
        'no real usage evidence',
      )
      assert.equal(
        row.settlement.mode,
        'actual',
        'completed evaluation did not settle actual usage',
      )
      assert.equal(row.settlement.costMicros, usage.costMicros, 'ledger and result costs differ')
      assert.deepEqual(
        [...row.readEntryIds].sort(),
        manifest.map((entry) => entry.id).sort(),
        'not all input entries were read',
      )
      assert(proposal, 'missing accepted proposal')
      assert(
        ['applied', 'rejected', 'stale'].includes(row.applicationStatus ?? ''),
        'missing application outcome',
      )
      if (row.applicationStatus !== 'applied') fail('application_refused')
      const coverage = proposal.coverage.find((item) => item.inputId === sources[0]!.id)
      const ignoresUnconfirmed =
        label.allowIgnoreWithoutClaim &&
        proposal.decision === 'ignore' &&
        coverage?.status === 'uncovered'
      if (!label.decisions.includes(proposal.decision) && !ignoresUnconfirmed) fail('decision')
      if (
        proposal.coverage.length !== 1 ||
        !coverage ||
        (coverage.status !== label.coverage && !ignoresUnconfirmed)
      )
        fail('coverage')
      if (
        !proposal.citations.includes(sources[0]!.id) ||
        proposal.citations.some((id) => !manifest.some((entry) => entry.id === id))
      )
        fail('source_citations')
      if (
        coverage?.status === 'covered' &&
        (!scenario.evidence?.matching ||
          !evidence[0] ||
          !coverage.evidenceIds.includes(evidence[0].id) ||
          !proposal.citations.includes(evidence[0].id))
      )
        fail('coverage_evidence')
      if (
        proposal.decision === 'dispatch' &&
        (proposal.workKey !== row.workKey || !label.actionClasses?.includes(proposal.actionClass))
      )
        fail('action_scope')
      if (proposal.decision === 'ask' && proposal.questionType !== 'choose_option')
        fail('unexpected_scope_request')
    }
    assert(
      isCount(row.businessRunsAfterTrigger) && isCount(row.newTasksAfterTrigger),
      'missing side-effect counts',
    )
    if (
      row.applicationRunId !== null ||
      row.businessRunsAfterTrigger > 0 ||
      row.newTasksAfterTrigger > 0
    )
      fail('business_side_effect')
    const critical =
      errors.includes('business_side_effect') ||
      (label.highRisk === true &&
        errors.some(
          (kind) => kind !== 'provider_or_protocol_failure' && kind !== 'application_refused',
        ))
    return {
      caseId: row.caseId,
      theme: scenario.theme,
      expected: label,
      observed: proposal?.decision ?? null,
      observedCoverage: proposal?.coverage[0]?.status ?? null,
      protocolAccepted,
      applicationStatus: row.applicationStatus,
      errors,
      critical,
      ...(row.failureCode ? { failureCode: row.failureCode } : {}),
    }
  })
  const calls = report.cases.filter((row) => row.modelStarted).length
  const inputTokens = report.cases.reduce((sum, row) => sum + (row.usage?.inputTokens ?? 0), 0)
  const outputTokens = report.cases.reduce((sum, row) => sum + (row.usage?.outputTokens ?? 0), 0)
  const costMicros = report.cases.reduce((sum, row) => sum + row.settlement.costMicros, 0)
  assert(costMicros <= QUALITY_MAX_SPLIT_COST_MICROS, 'split cost exceeded ceiling')
  const matches = scored.filter((row) => row.errors.length === 0).length
  const critical = scored.filter((row) => row.critical).length
  const providerFailures = scored.filter((row) => !row.protocolAccepted).length
  const truePositive = scored.filter(
    (row) =>
      row.observed === 'dispatch' &&
      row.expected.decisions.includes('dispatch') &&
      row.errors.length === 0,
  ).length
  const proposedDispatches = scored.filter((row) => row.observed === 'dispatch').length
  const expectedDispatches = scored.filter((row) =>
    row.expected.decisions.includes('dispatch'),
  ).length
  const minimumMatching = freeze?.minimumMatching ?? null
  const status =
    critical > 0 || providerFailures > 0 || (minimumMatching !== null && matches < minimumMatching)
      ? 'fail'
      : 'scored'
  return {
    split: report.split,
    status,
    matches,
    total: scored.length,
    critical,
    providerFailures,
    minimumMatching,
    dispatchPrecision: proposedDispatches ? truePositive / proposedDispatches : null,
    dispatchRecall: expectedDispatches ? truePositive / expectedDispatches : null,
    calls,
    inputTokens,
    outputTokens,
    costMicros,
    durationMs: report.cases.map((row) => row.durationMs),
    humanFactualityReview: 'pending',
    cases: scored,
  }
}

/** Record observed development result before holdout; high-risk rules never soften. */
export function freezeRouterQuality(raw: string): QualityFreeze {
  const result = JSON.parse(raw) as QualityResult
  assert.equal(result.split, 'development', 'freeze from development only')
  const score = verifyRouterQuality(result)
  assert.equal(score.status, 'scored', 'development transport or critical checks failed')
  assert(score.matches >= 4, 'development had fewer than four matching cases')
  return {
    schemaVersion: 1,
    developmentDigest: digest(raw),
    datasetDigest: result.datasetDigest,
    sourceRevision: result.sourceRevision,
    sourceDigest: result.sourceDigest,
    engineeringEvidenceDigest: result.engineeringEvidenceDigest,
    profileDigest: qualityProfileDigest(result),
    minimumMatching: score.matches,
  }
}
