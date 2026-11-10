import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { coordinationUsageCost } from '@whalepod/protocol'
import {
  DISCOVERY_QUALITY_CASES,
  DISCOVERY_QUALITY_RUBRIC_VERSION,
  getDiscoveryQualityCases,
  type DiscoveryQualityCase,
  type DiscoveryQualityCitation,
  type DiscoveryQualityClassification,
  type DiscoveryQualitySplit,
} from './discovery-quality-cases.js'

export const DISCOVERY_QUALITY_MAX_INPUT_TOKENS = 32_768
export const DISCOVERY_QUALITY_MAX_OUTPUT_TOKENS = 4_096
export const DISCOVERY_QUALITY_MAX_CASE_COST_MICROS = 15_000
export const DISCOVERY_QUALITY_MAX_SPLIT_COST_MICROS = 90_000
export const DISCOVERY_QUALITY_PRICING = {
  inputPriceMicrosPerMillionTokens: 300_000,
  outputPriceMicrosPerMillionTokens: 1_200_000,
} as const
export const discoveryQualityDatasetDigest = createHash('sha256')
  .update(JSON.stringify(DISCOVERY_QUALITY_CASES))
  .digest('hex')

export type DiscoveryQualityMode = 'real_model' | 'replay'
export type DiscoveryQualityEntries = Record<'source' | 'slot' | 'agreement' | 'work', string> & {
  secondaryAgreement?: string
}
export interface DiscoveryQualityProposal {
  classification: DiscoveryQualityClassification
  source: string
  slot: string | null
  citations: string[]
}
const evidenceCounts = [
  'admissions',
  'evaluations',
  'modelStarts',
  'providerResponses',
  'reservations',
  'settlements',
] as const
const businessCounts = [
  'tasks',
  'agreements',
  'works',
  'questions',
  'notifications',
  'dispatchIntents',
  'runs',
] as const

export interface DiscoveryQualityEvidence extends Record<(typeof evidenceCounts)[number], number> {
  readCount: number
  downloadCount: number
  readEntryIds: string[]
  downloadedIds: string[]
  usage: { inputTokens: number; outputTokens: number; costMicros: number } | null
  reservedCostMicros: number
  settledCostMicros: number
  businessWrites: Record<(typeof businessCounts)[number], number>
}
export interface DiscoveryQualityCaseResult {
  caseId: string
  projectId: string
  evaluationId: string
  coverageComplete: boolean
  entries: DiscoveryQualityEntries
  proposal: DiscoveryQualityProposal | null
  evidence: DiscoveryQualityEvidence
}
export interface DiscoveryQualityReport {
  schemaVersion: 1
  split: DiscoveryQualitySplit
  mode: DiscoveryQualityMode
  cases: DiscoveryQualityCaseResult[]
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function isId(value: unknown): value is string {
  return typeof value === 'string' && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(value)
}

function isCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}

function exactReceipts(value: unknown, manifest: ReadonlySet<string>) {
  return (
    Array.isArray(value) &&
    value.length === manifest.size &&
    new Set(value).size === manifest.size &&
    value.every((id: unknown) => isId(id) && manifest.has(id))
  )
}

function scoreCase(fixture: DiscoveryQualityCase, row: DiscoveryQualityCaseResult) {
  const engineeringErrors: string[] = []
  const semanticErrors: string[] = []
  const entries = row.entries
  const secondaryPresent =
    fixture.secondaryAgreement !== undefined && !fixture.omitSecondaryAgreement
  const roles = [
    'source',
    'slot',
    'agreement',
    'work',
    ...(secondaryPresent ? ['secondaryAgreement'] : []),
  ]
  const manifest = new Set<string>()
  if (!record(entries) || Object.keys(entries).length !== roles.length) {
    engineeringErrors.push('manifest_roles')
  } else {
    for (const role of roles) {
      const id = entries[role as keyof DiscoveryQualityEntries]
      if (isId(id)) manifest.add(id)
    }
    if (manifest.size !== roles.length) engineeringErrors.push('manifest_roles')
  }
  if (row.coverageComplete !== fixture.expected.coverageComplete) engineeringErrors.push('coverage')
  const e = row.evidence
  if (!record(e)) {
    engineeringErrors.push('missing_evidence')
  } else {
    for (const count of evidenceCounts) if (e[count] !== 1) engineeringErrors.push(count)
    if (
      e.readCount !== roles.length ||
      manifest.size !== roles.length ||
      !exactReceipts(e.readEntryIds, manifest)
    )
      engineeringErrors.push('read_receipts')
    if (
      e.downloadCount !== roles.length ||
      manifest.size !== roles.length ||
      !exactReceipts(e.downloadedIds, manifest)
    )
      engineeringErrors.push('download_receipts')
    if (!record(e.businessWrites) || businessCounts.some((key) => e.businessWrites[key] !== 0))
      engineeringErrors.push('business_writes')
    const usage = e.usage
    if (
      !record(usage) ||
      !isCount(usage.inputTokens) ||
      usage.inputTokens === 0 ||
      usage.inputTokens > DISCOVERY_QUALITY_MAX_INPUT_TOKENS ||
      !isCount(usage.outputTokens) ||
      usage.outputTokens === 0 ||
      usage.outputTokens > DISCOVERY_QUALITY_MAX_OUTPUT_TOKENS ||
      !isCount(usage.costMicros) ||
      usage.costMicros !==
        coordinationUsageCost({
          ...DISCOVERY_QUALITY_PRICING,
          inputTokens: usage.inputTokens,
          outputTokens: usage.outputTokens,
        }) ||
      !isCount(e.reservedCostMicros) ||
      e.reservedCostMicros < usage.costMicros ||
      e.reservedCostMicros > DISCOVERY_QUALITY_MAX_CASE_COST_MICROS ||
      e.settledCostMicros !== usage.costMicros
    )
      engineeringErrors.push('actual_cost')
  }

  const expected = fixture.expected
  const proposal = row.proposal
  if (!record(proposal)) {
    semanticErrors.push('missing_proposal')
  } else {
    if (proposal.classification !== expected.classification) semanticErrors.push('classification')
    if (!isId(proposal.source) || proposal.source !== entries?.source) semanticErrors.push('source')
    if (expected.classification === 'independent_gap') {
      if (!isId(proposal.slot) || proposal.slot !== entries?.slot) semanticErrors.push('slot')
    } else if (proposal.slot !== null) {
      semanticErrors.push('slot')
    }
    const toId = (label: DiscoveryQualityCitation) => entries?.[label]
    const allowed = new Set(expected.allowedCitations.map(toId).filter(isId))
    if (
      !Array.isArray(proposal.citations) ||
      new Set(proposal.citations).size !== proposal.citations.length ||
      proposal.citations.some((id: unknown) => !isId(id) || !allowed.has(id))
    )
      semanticErrors.push('irrelevant_or_invalid_citations')
    if (
      expected.requiredCitations.some((label) => {
        const id = toId(label)
        return !isId(id) || !Array.isArray(proposal.citations) || !proposal.citations.includes(id)
      })
    )
      semanticErrors.push('missing_required_citations')
  }
  return { caseId: fixture.id, engineeringErrors, semanticErrors }
}

/** Score durable observations against fixed labels. Narrative factuality needs separate human review. */
export function verifyDiscoveryQuality(raw: unknown, expectedMode?: DiscoveryQualityMode) {
  assert(record(raw) && raw.schemaVersion === 1, 'unsupported discovery quality report')
  const { split, mode, cases } = raw
  assert(split === 'development' || split === 'holdout', 'unknown discovery quality split')
  assert(mode === 'real_model' || mode === 'replay', 'unknown discovery quality mode')
  assert(expectedMode === undefined || mode === expectedMode, 'discovery quality mode mismatch')
  const fixtures = getDiscoveryQualityCases(split)
  assert(
    Array.isArray(cases) && cases.length === fixtures.length,
    'missing or extra discovery cases',
  )
  const byId = new Map<string, DiscoveryQualityCaseResult>()
  const fixtureIds = new Set(fixtures.map((fixture) => fixture.id))
  const projects = new Set<string>()
  const evaluations = new Set<string>()
  for (const row of cases) {
    assert(record(row) && typeof row['caseId'] === 'string', 'malformed discovery case')
    const id = row['caseId']
    assert(fixtureIds.has(id) && !byId.has(id), 'wrong split or repeated discovery case')
    assert(
      isId(row['projectId']) &&
        !projects.has(row['projectId']) &&
        isId(row['evaluationId']) &&
        !evaluations.has(row['evaluationId']),
      'missing or repeated discovery case binding',
    )
    projects.add(row['projectId'])
    evaluations.add(row['evaluationId'])
    byId.set(id, row as unknown as DiscoveryQualityCaseResult)
  }
  const scored = fixtures.map((fixture) => scoreCase(fixture, byId.get(fixture.id)!))
  const costs = [...byId.values()].map((row) => row.evidence?.settledCostMicros)
  const totalCostMicros = costs.every(isCount) ? costs.reduce((a, b) => a + b, 0) : null
  const engineeringStatus =
    totalCostMicros !== null &&
    totalCostMicros <= DISCOVERY_QUALITY_MAX_SPLIT_COST_MICROS &&
    scored.every((row) => row.engineeringErrors.length === 0)
      ? 'pass'
      : 'fail'
  const matches = scored.filter((row) => row.semanticErrors.length === 0).length
  const status = engineeringStatus === 'pass' && matches === fixtures.length ? 'pass' : 'fail'
  return {
    split,
    mode,
    status,
    engineeringStatus,
    modelQuality: mode === 'replay' ? 'not_run' : status,
    humanReview: 'not_run' as const,
    datasetDigest: discoveryQualityDatasetDigest,
    rubricVersion: DISCOVERY_QUALITY_RUBRIC_VERSION,
    totalCostMicros,
    matches,
    cases: scored,
  } as const
}
