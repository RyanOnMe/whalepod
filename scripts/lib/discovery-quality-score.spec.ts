import { describe, expect, it } from 'vitest'
import { sha256 } from './acceptance-provenance.js'
import {
  freezeDiscoveryDevelopment,
  scoreDiscoveryCampaign,
  validateDiscoveryFreeze,
  validateDiscoveryHoldout,
  type DiscoveryCampaignBinding,
  type DiscoveryCampaignReport,
} from './discovery-quality-campaign.js'
import { getDiscoveryQualityCases, type DiscoveryQualitySplit } from './discovery-quality-cases.js'
import {
  DISCOVERY_QUALITY_MAX_CASE_COST_MICROS,
  verifyDiscoveryQuality,
  type DiscoveryQualityCaseResult,
  type DiscoveryQualityEntries,
  type DiscoveryQualityMode,
  type DiscoveryQualityReport,
} from './discovery-quality-score.js'

const id = (value: number) => `00000000-0000-4000-8000-${String(value).padStart(12, '0')}`

function fixture(
  split: DiscoveryQualitySplit,
  mode: DiscoveryQualityMode = 'real_model',
): DiscoveryQualityReport {
  const cases = getDiscoveryQualityCases(split).map((item, index): DiscoveryQualityCaseResult => {
    const base = (split === 'development' ? 100 : 200) + index * 10
    const entries: DiscoveryQualityEntries = {
      source: id(base + 1),
      slot: id(base + 2),
      agreement: id(base + 3),
      work: id(base + 4),
      ...(item.secondaryAgreement && !item.omitSecondaryAgreement
        ? { secondaryAgreement: id(base + 5) }
        : {}),
    }
    const receipts = Object.values(entries)
    const { classification, requiredCitations, coverageComplete } = item.expected
    return {
      caseId: item.id,
      projectId: id(base + 6),
      evaluationId: id(base + 7),
      entries,
      coverageComplete,
      proposal: {
        classification,
        source: entries.source,
        slot: classification === 'independent_gap' ? entries.slot : null,
        citations: requiredCitations.map((ref) => entries[ref]!),
      },
      evidence: {
        admissions: 1,
        evaluations: 1,
        modelStarts: 1,
        providerResponses: 1,
        reservations: 1,
        settlements: 1,
        readCount: receipts.length,
        downloadCount: receipts.length,
        readEntryIds: [...receipts],
        downloadedIds: [...receipts],
        usage: { inputTokens: 100, outputTokens: 10, costMicros: 42 },
        reservedCostMicros: 100,
        settledCostMicros: 42,
        businessWrites: {
          tasks: 0,
          agreements: 0,
          works: 0,
          questions: 0,
          notifications: 0,
          dispatchIntents: 0,
          runs: 0,
        },
      },
    }
  })
  return { schemaVersion: 1, split, mode, cases }
}

describe('RD-04a campaign provenance', () => {
  const binding: DiscoveryCampaignBinding = {
    assemblyDigest: sha256('assembly'),
    engineeringDigest: sha256('engineering'),
    campaignDigest: sha256('campaign'),
    providerConfigurationDigest: sha256('provider'),
  }
  const developmentTime = '2026-11-10T01:00:00.000Z'
  const frozenAt = '2026-11-10T01:30:00.000Z'
  const startedAt = '2026-11-10T02:00:00.000Z'
  function campaign(split: DiscoveryQualitySplit, mode: DiscoveryQualityMode, generatedAt: string) {
    const report = fixture(split, mode)
    return {
      schemaVersion: 1,
      generatedAt,
      humanReview: 'not_run',
      binding: {
        ...binding,
        engineeringDigest: mode === 'real_model' ? binding.engineeringDigest : null,
      },
      report: {
        ...report,
        cases: report.cases.map((row) => ({
          ...row,
          provenance: { replayRequests: mode === 'replay' ? 1 : null },
        })),
      },
    } satisfies DiscoveryCampaignReport
  }

  it('refuses to freeze replay or relabel a recorded loopback as real', () => {
    const replay = campaign('development', 'replay', developmentTime)
    expect(() =>
      freezeDiscoveryDevelopment(JSON.stringify(replay), replay.binding, frozenAt),
    ).toThrow('passing real-model development')
    const relabeled = { ...replay, binding, report: { ...replay.report, mode: 'real_model' } }
    expect(() => scoreDiscoveryCampaign(JSON.stringify(relabeled), binding)).toThrow(
      'provider mode contradicts',
    )
  })

  it('binds a passing real development result to the exact campaign and one holdout attempt', () => {
    const development = JSON.stringify(campaign('development', 'real_model', developmentTime))
    const freeze = freezeDiscoveryDevelopment(development, binding, frozenAt)
    const rawFreeze = JSON.stringify(freeze)
    expect(validateDiscoveryFreeze(rawFreeze, development, binding)).toEqual(freeze)
    expect(() => validateDiscoveryFreeze(rawFreeze, `${development}\n`, binding)).toThrow(
      'freeze does not match',
    )
    expect(() =>
      validateDiscoveryFreeze(rawFreeze, development, {
        ...binding,
        assemblyDigest: sha256('changed'),
      }),
    ).toThrow('campaign or production evidence changed')
    const rawAttempt = JSON.stringify({
      schemaVersion: 1,
      id: id(2),
      startedAt,
      freezeDigest: sha256(rawFreeze),
    })
    const holdout = {
      ...campaign('holdout', 'real_model', startedAt),
      holdout: { freezeDigest: sha256(rawFreeze), attemptDigest: sha256(rawAttempt) },
    }
    expect(() => validateDiscoveryHoldout(holdout, rawFreeze, rawAttempt)).not.toThrow()
    expect(() => validateDiscoveryHoldout(holdout, rawFreeze, `${rawAttempt}\n`)).toThrow(
      'frozen one-time attempt',
    )
  })
})

describe('RD-04a quality score', () => {
  it('scores distinct six-case splits without using replay as model or human evidence', () => {
    const development = getDiscoveryQualityCases('development')
    const holdout = getDiscoveryQualityCases('holdout')
    expect(development).toHaveLength(6)
    expect(holdout).toHaveLength(6)
    expect(new Set([...development, ...holdout].map((row) => row.id)).size).toBe(12)
    expect(new Set([...development, ...holdout].map((row) => row.comment)).size).toBe(12)
    const replay = fixture('development', 'replay')
    expect(verifyDiscoveryQuality(replay)).toMatchObject({
      status: 'pass',
      engineeringStatus: 'pass',
      modelQuality: 'not_run',
      humanReview: 'not_run',
      matches: 6,
    })
    expect(() => verifyDiscoveryQuality(replay, 'real_model')).toThrow('mode mismatch')
    expect(verifyDiscoveryQuality(fixture('holdout'), 'real_model')).toMatchObject({
      status: 'pass',
      modelQuality: 'pass',
      humanReview: 'not_run',
      totalCostMicros: 252,
    })
  })

  it('rejects incomplete, extra, repeated, cross-split, or reused case evidence', () => {
    const base = fixture('development')
    const [first, second, ...others] = base.cases
    expect(() => verifyDiscoveryQuality({ ...base, cases: [second, ...others] })).toThrow(
      'missing or extra',
    )
    expect(() => verifyDiscoveryQuality({ ...base, cases: [...base.cases, first] })).toThrow(
      'missing or extra',
    )
    expect(() => verifyDiscoveryQuality({ ...base, cases: [first, first, ...others] })).toThrow(
      'repeated discovery case',
    )
    expect(() => verifyDiscoveryQuality({ ...base, split: 'holdout' })).toThrow('wrong split')
    expect(() =>
      verifyDiscoveryQuality({
        ...base,
        cases: [first, { ...second, projectId: first!.projectId }, ...others],
      }),
    ).toThrow('case binding')
    expect(() =>
      verifyDiscoveryQuality({
        ...base,
        cases: [first, { ...second, evaluationId: first!.evaluationId }, ...others],
      }),
    ).toThrow('case binding')
  })

  it('rejects a wrong classification even when the production evidence is sound', () => {
    const report = fixture('holdout')
    report.cases[0]!.proposal!.classification = 'covered'
    expect(verifyDiscoveryQuality(report)).toMatchObject({
      status: 'fail',
      engineeringStatus: 'pass',
      modelQuality: 'fail',
      matches: 5,
      cases: [
        expect.objectContaining({ semanticErrors: ['classification'] }),
        ...report.cases.slice(1).map(() => expect.anything()),
      ],
    })
  })

  it('rejects known but irrelevant citations in both positive categories', () => {
    const report = fixture('development')
    const gap = report.cases[0]!
    const covered = report.cases[1]!
    gap.proposal!.citations.push(gap.entries.secondaryAgreement!)
    covered.proposal!.citations = [covered.entries.agreement]
    const scored = verifyDiscoveryQuality(report)
    expect(scored.cases[0]?.semanticErrors).toEqual(['irrelevant_or_invalid_citations'])
    expect(scored.cases[1]?.semanticErrors).toEqual([
      'irrelevant_or_invalid_citations',
      'missing_required_citations',
    ])
  })

  it.each(['agreement', 'work'] as const)('requires the independent gap %s anchor', (label) => {
    const report = fixture('development')
    const gap = report.cases[0]!
    gap.proposal!.citations = gap.proposal!.citations.filter((ref) => ref !== gap.entries[label])
    expect(verifyDiscoveryQuality(report).cases[0]?.semanticErrors).toEqual([
      'missing_required_citations',
    ])
  })

  it('checks exact source and slot identities and forbids a slot on non-gap proposals', () => {
    const report = fixture('development')
    const gap = report.cases[0]!
    const covered = report.cases[1]!
    gap.proposal!.source = gap.entries.agreement
    gap.proposal!.slot = gap.entries.work
    covered.proposal!.slot = covered.entries.slot
    const scored = verifyDiscoveryQuality(report)
    expect(scored.cases[0]?.semanticErrors).toEqual(['source', 'slot'])
    expect(scored.cases[1]?.semanticErrors).toEqual(['slot'])
  })

  it('rejects mismatched receipt sets, duplicate counts, hidden writes, and unverifiable costs', () => {
    const report = fixture('development', 'replay')
    const row = report.cases[0]!
    row.evidence.readEntryIds[0] = row.evidence.readEntryIds[1]!
    row.evidence.downloadedIds[0] = report.cases[1]!.entries.source
    row.evidence.modelStarts = 2
    row.evidence.providerResponses = 0
    row.evidence.businessWrites.runs = 1
    row.evidence.reservedCostMicros = DISCOVERY_QUALITY_MAX_CASE_COST_MICROS + 1
    row.evidence.settledCostMicros = 0
    const scored = verifyDiscoveryQuality(report)
    expect(scored).toMatchObject({
      status: 'fail',
      engineeringStatus: 'fail',
      modelQuality: 'not_run',
    })
    expect(scored.cases[0]?.engineeringErrors).toEqual([
      'modelStarts',
      'providerResponses',
      'read_receipts',
      'download_receipts',
      'business_writes',
      'actual_cost',
    ])
  })

  it('does not treat missing counters or terminal failure without proposal as a successful run', () => {
    const report = fixture('holdout')
    const row = report.cases[2]!
    Reflect.deleteProperty(row.evidence.businessWrites, 'notifications')
    row.proposal = null
    row.evidence.usage = null
    expect(verifyDiscoveryQuality(report).cases[2]).toMatchObject({
      engineeringErrors: ['business_writes', 'actual_cost'],
      semanticErrors: ['missing_proposal'],
    })
  })

  it('rejects claimed complete coverage when a confirmed agreement is omitted', () => {
    const report = fixture('holdout')
    const row = report.cases[2]!
    row.coverageComplete = true
    expect(verifyDiscoveryQuality(report).cases[2]?.engineeringErrors).toEqual(['coverage'])
  })
})
