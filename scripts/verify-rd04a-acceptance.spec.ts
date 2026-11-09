import { describe, expect, it } from 'vitest'
import { verifyRd04a, type Rd04aEvidence } from './verify-rd04a-acceptance.js'

function receipt(): Rd04aEvidence {
  const baseline = { tasks: 2, works: 1, specs: 1, questions: 0, intents: 0, runs: 0 }
  return {
    schemaVersion: 1,
    generatedAt: '2026-11-09T13:30:00.000Z',
    assemblyDigest: 'a'.repeat(64),
    modelQuality: 'not_run',
    fast: {
      sourceId: 'venue-comment',
      workKey: 'venue-work',
      subscriptionId: 'subscription',
      admissions: [
        {
          sourceId: 'venue-comment',
          inboxItemId: 'inbox',
          outcome: 'deliver',
          reason: 'subscription_match',
          routerInvoked: false,
        },
      ],
      inbox: [
        {
          id: 'inbox',
          sourceId: 'venue-comment',
          workKey: 'venue-work',
          subscriptionId: 'subscription',
        },
      ],
      routerCalls: 0,
    },
    shadow: {
      sourceId: 'shuttle-comment',
      replayId: 'shuttle-comment',
      offSourceId: 'off-comment',
      routes: [
        {
          sourceId: 'venue-comment',
          route: 'existing_work',
          reason: 'current_work',
          evaluationId: null,
        },
        {
          sourceId: 'shuttle-comment',
          route: 'discovery',
          reason: 'eligible',
          evaluationId: 'evaluation',
        },
        {
          sourceId: 'off-comment',
          route: 'rejected',
          reason: 'permit_required',
          evaluationId: null,
        },
      ],
      providerCalls: [{ aliases: ['S1', 'L1', 'E1'], sourceMatched: true, heldTools: 0 }],
      evaluations: [
        {
          id: 'evaluation',
          purpose: 'discovery',
          status: 'completed',
          workKey: null,
          inferenceEntryId: null,
          manifestIds: ['source', 'slot', 'evidence'],
          readEntryIds: ['source', 'slot', 'evidence'],
        },
      ],
      candidate: {
        id: 'candidate',
        evaluationId: 'evaluation',
        sourceId: 'shuttle-comment',
        classification: 'independent_gap',
      },
      ledger: [
        {
          evaluationId: 'evaluation',
          workKey: null,
          phase: 'reserved',
          chargeMode: null,
          attempt: 1,
        },
        {
          evaluationId: 'evaluation',
          workKey: null,
          phase: 'settled',
          chargeMode: 'actual',
          attempt: 1,
        },
      ],
    },
    visibility: {
      publicHttp: 200,
      ownerHttp: 200,
      ownerCache: 'private, no-store',
      colleagueHttp: 404,
      revokedOwnerHttp: 404,
      outputCanaryOnAuthorizedRead: true,
      surfaces: ['ws_live', 'ws_replay', 'team_event', 'log', 'http'].map((name) => ({
        name: name as Rd04aEvidence['visibility']['surfaces'][number]['name'],
        observations: 2,
        leaks: 0,
      })),
    },
    effects: { before: { ...baseline }, after: { ...baseline } },
  }
}

describe('RD-04a production receipt judge', () => {
  it('accepts bound receipts for a fast-path delivery and one private discovery', () => {
    expect(() => verifyRd04a(receipt())).not.toThrow()
  })

  const negatives: [string, (evidence: Rd04aEvidence) => void, string][] = [
    [
      'slow evaluation on the fast path',
      (e) => {
        e.fast.routerCalls = 1
      },
      'fast comment invoked Router',
    ],
    [
      'receipt for the wrong source',
      (e) => {
        e.shadow.candidate.sourceId = e.fast.sourceId
      },
      'candidate cites the wrong triggering source',
    ],
    [
      'missing exact input read',
      (e) => {
        e.shadow.evaluations[0]!.readEntryIds.pop()
      },
      'missing/extra read receipts',
    ],
    [
      'duplicate model billing',
      (e) => {
        e.shadow.ledger.push(e.shadow.ledger[1]!)
      },
      'one reserve/settle pair',
    ],
    [
      'unauthorized HTTP read',
      (e) => {
        e.visibility.colleagueHttp = 200
      },
      'another member could read the candidate',
    ],
    [
      'missing replay observation',
      (e) => {
        e.visibility.surfaces[1]!.observations = 0
      },
      'no observations for ws_replay',
    ],
    [
      'private content in WebSocket replay',
      (e) => {
        e.visibility.surfaces[1]!.leaks = 1
      },
      'private candidate leaked to ws_replay',
    ],
    [
      'unexpected Run',
      (e) => {
        e.effects.after.runs = 1
      },
      'shadow path produced a business write: runs',
    ],
  ]
  it.each(negatives)('rejects %s', (_, mutate, expected) => {
    const evidence = receipt()
    mutate(evidence)
    expect(() => verifyRd04a(evidence)).toThrow(expected)
  })
})
