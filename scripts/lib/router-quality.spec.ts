import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import type { CoordinationInputEntry, RouterProposal } from '@whalepod/protocol'
import { ROUTER_QUALITY_CASES, type QualitySplit } from './router-quality-cases.js'
import {
  digest,
  freezeRouterQuality,
  QUALITY_ASSEMBLY,
  QUALITY_ENDPOINT,
  QUALITY_MODEL,
  QUALITY_PROVIDER,
  qualityDatasetDigest,
  ROUTER_QUALITY_RUBRIC_VERSION,
  verifyRouterQuality,
  type QualityResult,
} from './router-quality.js'

/** Synthetic *verifier* positives; never written as or reused for provider evidence. */
function fixture(split: QualitySplit): QualityResult {
  return {
    schemaVersion: 1,
    split,
    generatedAt: '2026-11-09T00:00:00Z',
    assembly: QUALITY_ASSEMBLY,
    endpoint: QUALITY_ENDPOINT,
    provider: QUALITY_PROVIDER,
    model: QUALITY_MODEL,
    datasetDigest: qualityDatasetDigest,
    rubricVersion: ROUTER_QUALITY_RUBRIC_VERSION,
    sourceRevision: 'a'.repeat(40),
    sourceDigest: 'b'.repeat(64),
    engineeringEvidenceDigest: 'c'.repeat(64),
    pricing: { input: 300_000, output: 1_200_000 },
    cases: ROUTER_QUALITY_CASES.filter((item) => item.split === split).map((item) => {
      const triggerSourceId = randomUUID()
      const workKey = randomUUID()
      const makeEntry = (
        kind: CoordinationInputEntry['kind'],
        sourceId: string,
        body: string,
      ): CoordinationInputEntry => ({
        id: randomUUID(),
        kind,
        sourceId,
        digest: digest(body),
        version: kind === 'evidence' ? digest(body) : 'v1',
        byteSize: Buffer.byteLength(body),
        authorizationGeneration: 'v1',
      })
      const source = makeEntry('source', `task_message:${triggerSourceId}`, item.message)
      const evidence = item.evidence
        ? makeEntry('evidence', randomUUID(), item.evidence.body)
        : null
      const manifest = [
        source,
        makeEntry('agreement', randomUUID(), item.constraints),
        makeEntry('work', workKey, item.goal),
        ...(evidence ? [evidence] : []),
      ]
      const evidenceIds = item.expected.coverage === 'covered' && evidence ? [evidence.id] : []
      const base = {
        summary: 'Synthetic verifier fixture',
        citations: [source.id, ...evidenceIds],
        coverage: [{ inputId: source.id, status: item.expected.coverage, evidenceIds }],
      }
      const decision = item.expected.decisions[0]!
      const proposal: RouterProposal =
        decision === 'dispatch'
          ? { ...base, decision, workKey, actionClass: item.expected.actionClasses![0]! }
          : decision === 'ask'
            ? {
                ...base,
                decision,
                questionType: 'choose_option',
                blockedDecision: 'clarification',
                options: [{ id: 'verify', label: 'Verify' }],
                recommendedOptionId: null,
              }
            : decision === 'wait'
              ? {
                  ...base,
                  decision,
                  reason: 'upstream_pending',
                  deadlineAt: '2026-11-09T01:00:00Z',
                }
              : { ...base, decision, reason: 'not_applicable' }
      return {
        caseId: item.id,
        taskId: randomUUID(),
        workKey,
        triggerSourceId,
        ...(evidence ? { publishedEvidenceId: evidence.sourceId } : {}),
        evaluationId: randomUUID(),
        evaluationDigest: digest(randomUUID()),
        rulesVersion: 'rd03r1.v2',
        promptVersion: 'router.v1',
        modelStarted: true,
        attempt: 1,
        durationMs: 50,
        status: 'completed',
        failureCode: null,
        manifest,
        readEntryIds: manifest.map((entry) => entry.id),
        usage: {
          provider: QUALITY_PROVIDER,
          model: QUALITY_MODEL,
          inputTokens: 100,
          outputTokens: 50,
          costMicros: 90,
        },
        settlement: { reserved: 1, settled: 1, mode: 'actual', costMicros: 90 },
        proposal,
        applicationStatus: 'applied',
        applicationRunId: null,
        businessRunsAfterTrigger: 0,
        newTasksAfterTrigger: 0,
      }
    }),
  }
}

const freeze = () => freezeRouterQuality(JSON.stringify(fixture('development')))

function boundHoldout() {
  const assemblyDigest = digest('built assembly')
  const development: QualityResult = {
    ...fixture('development'),
    schemaVersion: 2,
    completedAt: '2026-11-09T00:01:00Z',
    assemblyDigest,
  }
  const frozen = freezeRouterQuality(JSON.stringify(development), '2026-11-09T00:02:00Z')
  const rawFreeze = JSON.stringify(frozen)
  const start = '2026-11-09T00:03:00Z'
  const rawAttempt = JSON.stringify({
    schemaVersion: 1,
    id: randomUUID(),
    startedAt: start,
    freezeDigest: digest(rawFreeze),
  })
  const holdout: QualityResult = {
    ...fixture('holdout'),
    schemaVersion: 2,
    generatedAt: start,
    completedAt: '2026-11-09T00:04:00Z',
    assemblyDigest,
    holdout: { freezeDigest: digest(rawFreeze), attemptDigest: digest(rawAttempt) },
  }
  return { development, frozen, holdout, witness: { rawFreeze, rawAttempt } }
}

describe('real Router quality evidence gates', () => {
  it('binds new holdout results to the raw freeze and a distinct persisted attempt', () => {
    const { development, frozen, holdout, witness } = boundHoldout()
    expect(verifyRouterQuality(holdout, frozen, witness)).toMatchObject({
      matches: 6,
      status: 'scored',
    })
    expect(() => verifyRouterQuality(holdout, frozen)).toThrow(
      'missing frozen holdout attempt evidence',
    )
    expect(() =>
      verifyRouterQuality(holdout, frozen, { ...witness, rawFreeze: witness.rawFreeze + '\n' }),
    ).toThrow('raw freeze digest mismatch')
    expect(() =>
      verifyRouterQuality(holdout, frozen, { ...witness, rawAttempt: witness.rawAttempt + '\n' }),
    ).toThrow('attempt digest mismatch')
    expect(() =>
      verifyRouterQuality({ ...holdout, generatedAt: frozen.frozenAt! }, frozen, witness),
    ).toThrow('chronology')
    expect(() => freezeRouterQuality(JSON.stringify(development), development.completedAt)).toThrow(
      'must finish before freeze',
    )
  })

  it('rejects impossible billed costs even if the usage and settlement records agree', () => {
    const { development } = boundHoldout()
    const sample = development.cases[0]!
    sample.usage!.costMicros = 0
    sample.settlement.costMicros = 0
    expect(() => verifyRouterQuality(development)).toThrow(
      'usage cost does not match billed tokens and frozen prices',
    )
  })

  it('distinguishes scoring from narrative factuality review', () => {
    const result = verifyRouterQuality(fixture('holdout'), freeze())
    expect(result).toMatchObject({
      matches: 6,
      total: 6,
      status: 'scored',
      humanFactualityReview: 'pending',
      calls: 6,
      dispatchPrecision: 1,
      dispatchRecall: 1,
    })
  })

  it('fails empty/missing evidence and rejects replay as real', () => {
    const report = fixture('development')
    expect(() => verifyRouterQuality({ ...report, cases: [] })).toThrow('case evidence missing')
    expect(() =>
      verifyRouterQuality({
        ...report,
        assembly: { ...report.assembly, transport: 'loopback-replay' },
      }),
    ).toThrow('not real provider assembly')
  })

  it('requires frozen criteria and rejects a changed execution profile', () => {
    const holdout = fixture('holdout')
    expect(() => verifyRouterQuality(holdout)).toThrow('requires frozen development result')
    expect(() =>
      verifyRouterQuality({ ...holdout, sourceDigest: digest('changed sources') }, freeze()),
    ).toThrow('source files changed')
    expect(() =>
      verifyRouterQuality({ ...holdout, pricing: { input: 300_000, output: 800_000 } }, freeze()),
    ).toThrow('configuration changed')
  })

  it('rejects unread evidence, wrong artifact version, and invented usage', () => {
    const report = fixture('development')
    const covered = report.cases.find((item) => item.publishedEvidenceId)!
    covered.readEntryIds = []
    expect(() => verifyRouterQuality(report)).toThrow('not all input entries were read')
    covered.readEntryIds = covered.manifest.map((entry) => entry.id)
    const evidence = covered.manifest.find((entry) => entry.kind === 'evidence')!
    const originalDigest = evidence.digest
    evidence.digest = digest('older wrong version')
    expect(() => verifyRouterQuality(report)).toThrow('wrong artifact version')
    evidence.digest = originalDigest
    report.cases[0]!.usage = null
    expect(() => verifyRouterQuality(report)).toThrow('no real usage evidence')
  })

  it('fails a covered claim citing the prior version even though the Hub citation is structurally valid', () => {
    const report = fixture('holdout')
    const row = report.cases.find((item) => item.caseId === 'h-customer-wrong-edition')!
    const source = row.manifest.find((item) => item.kind === 'source')!
    const oldArtifact = row.manifest.find((item) => item.kind === 'evidence')!
    row.proposal = {
      decision: 'ignore',
      summary: 'Prior edition is enough.',
      reason: 'already_covered',
      citations: [source.id, oldArtifact.id],
      coverage: [{ inputId: source.id, status: 'covered', evidenceIds: [oldArtifact.id] }],
    }
    const scored = verifyRouterQuality(report, freeze())
    expect(scored).toMatchObject({ status: 'fail', matches: 5, critical: 1 })
    expect(scored.cases.find((item) => item.caseId === row.caseId)?.errors).toContain(
      'coverage_evidence',
    )
  })

  it('does not call a safely rejected provider attempt a semantic pass', () => {
    const report = fixture('development')
    Object.assign(report.cases[0]!, {
      status: 'failed',
      failureCode: 'usage_missing',
      usage: null,
      proposal: null,
      applicationStatus: null,
      settlement: { reserved: 1, settled: 1, mode: 'reserved', costMicros: 5000 },
    })
    expect(verifyRouterQuality(report)).toMatchObject({
      status: 'fail',
      providerFailures: 1,
      critical: 0,
    })
    expect(() => freezeRouterQuality(JSON.stringify(report))).toThrow(
      'transport or critical checks failed',
    )
  })

  it('fails a creation side effect even when the proposal exactly matches the label', () => {
    const report = fixture('development')
    report.cases[0]!.newTasksAfterTrigger = 1
    expect(verifyRouterQuality(report)).toMatchObject({ status: 'fail', critical: 1 })
  })
})
