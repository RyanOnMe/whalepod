import assert from 'node:assert/strict'
import { join } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import { isSha256, sha256, type HoldoutAttempt } from './acceptance-provenance.js'
import type { DiscoveryQualityCampaign } from './discovery-quality-cases.js'
import { verifyDiscoveryQuality, type DiscoveryQualityReport } from './discovery-quality-score.js'

export interface DiscoveryCampaignBinding {
  campaign?: DiscoveryQualityCampaign
  assemblyDigest: string
  engineeringDigest: string | null
  campaignDigest: string
  providerConfigurationDigest: string
}

export interface DiscoveryCampaignReport {
  schemaVersion: 1
  generatedAt: string
  humanReview: 'not_run'
  binding: DiscoveryCampaignBinding
  report: DiscoveryQualityReport
  holdout?: { freezeDigest: string; attemptDigest: string }
}

export function discoveryCampaignPaths(repoRoot: string, campaign?: DiscoveryQualityCampaign) {
  const segment = campaign === undefined ? [] : [campaign]
  const evidenceRoot = join(repoRoot, 'artifacts/evidence/discovery-quality', ...segment)
  return {
    evidenceRoot,
    holdoutRoot: join(evidenceRoot, 'holdout'),
    freezeFile: join(evidenceRoot, 'freeze.json'),
    developmentFile: join(evidenceRoot, 'development/result.json'),
    developmentFailure: join(evidenceRoot, 'development/failure.json'),
    developmentLock: join(evidenceRoot, 'development.lock'),
    engineeringFile: join(repoRoot, 'artifacts/evidence/rd04a', ...segment, 'result.json'),
  }
}

export function scoreDiscoveryCampaign(raw: string, current: DiscoveryCampaignBinding) {
  const evidence = JSON.parse(raw) as DiscoveryCampaignReport
  assert.equal(evidence.schemaVersion, 1, 'invalid campaign evidence schema')
  assert.equal(evidence.humanReview, 'not_run', 'model evidence cannot attest human review')
  assert(Number.isFinite(Date.parse(evidence.generatedAt)), 'missing run timestamp')
  for (const key of ['assemblyDigest', 'campaignDigest', 'providerConfigurationDigest'] as const)
    assert(isSha256(current[key]), `invalid ${key}`)
  assert(isDeepStrictEqual(evidence.binding, current), 'campaign or production evidence changed')
  assert.equal(
    evidence.report.campaign,
    current.campaign,
    'report belongs to another discovery campaign',
  )
  if (evidence.report.mode === 'real_model')
    assert(isSha256(current.engineeringDigest), 'missing same-assembly engineering evidence')
  else assert(current.engineeringDigest === null, 'replay is not a real-model campaign')
  const score = verifyDiscoveryQuality(evidence.report)
  const expectedReplayRequests = evidence.report.mode === 'real_model' ? null : 1
  for (const row of evidence.report.cases) {
    const proof = (row as { provenance?: { replayRequests?: number | null } }).provenance
    assert(
      proof?.replayRequests === expectedReplayRequests,
      'provider mode contradicts the driver evidence',
    )
  }
  return { evidence, score }
}

export function freezeDiscoveryDevelopment(
  rawDevelopment: string,
  current: DiscoveryCampaignBinding,
  frozenAt: string,
) {
  const { evidence, score } = scoreDiscoveryCampaign(rawDevelopment, current)
  assert(
    evidence.report.split === 'development' &&
      evidence.report.mode === 'real_model' &&
      evidence.holdout === undefined &&
      score.status === 'pass',
    'only a passing real-model development result can freeze the holdout',
  )
  assert(Date.parse(frozenAt) > Date.parse(evidence.generatedAt), 'freeze must follow development')
  return { schemaVersion: 1 as const, frozenAt, developmentDigest: sha256(rawDevelopment), current }
}

export function validateDiscoveryFreeze(
  rawFreeze: string,
  rawDevelopment: string,
  current: DiscoveryCampaignBinding,
) {
  const observed = JSON.parse(rawFreeze) as ReturnType<typeof freezeDiscoveryDevelopment>
  const expected = freezeDiscoveryDevelopment(rawDevelopment, current, observed.frozenAt)
  assert(isDeepStrictEqual(observed, expected), 'freeze does not match the development evidence')
  return expected
}

export function validateDiscoveryHoldout(
  evidence: DiscoveryCampaignReport,
  rawFreeze: string,
  rawAttempt: string,
) {
  const freeze = JSON.parse(rawFreeze) as ReturnType<typeof freezeDiscoveryDevelopment>
  const attempt = JSON.parse(rawAttempt) as HoldoutAttempt
  assert(
    evidence.report.campaign === freeze.current.campaign &&
      isDeepStrictEqual(evidence.binding, freeze.current),
    'holdout belongs to another discovery campaign or production assembly',
  )
  assert(
    evidence.report.split === 'holdout' &&
      evidence.report.mode === 'real_model' &&
      evidence.holdout?.freezeDigest === sha256(rawFreeze) &&
      evidence.holdout.attemptDigest === sha256(rawAttempt) &&
      attempt.schemaVersion === 1 &&
      /^[0-9a-f-]{36}$/.test(attempt.id) &&
      attempt.freezeDigest === evidence.holdout.freezeDigest &&
      attempt.startedAt === evidence.generatedAt &&
      Date.parse(attempt.startedAt) > Date.parse(freeze.frozenAt),
    'holdout report does not match the frozen one-time attempt',
  )
}
