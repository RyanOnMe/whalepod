import { describe, expect, it } from 'vitest'
import {
  CoordinationRequestPayloadSchema,
  RouterProposalSchema,
  ConfigureProjectRouterRequestSchema,
} from '../src/router.js'

const id = '01940000-0000-7000-8000-000000000001'
const citation = '01940000-0000-7000-8000-000000000002'
const base = {
  summary: 'An existing requirement needs a new draft.',
  citations: [citation],
  coverage: [{ inputId: citation, status: 'uncovered', evidenceIds: [] }],
}

describe('Router evaluation contracts', () => {
  it.each([
    { ...base, decision: 'dispatch', workKey: id, actionClass: 'draft' },
    { ...base, decision: 'wait', reason: 'upstream_missing', deadlineAt: '2026-11-04T04:00:00Z' },
    { ...base, decision: 'ignore', reason: 'already_covered' },
    {
      ...base,
      decision: 'ask',
      questionType: 'choose_option',
      blockedDecision: 'dispatch',
      options: [{ id: 'wait', label: 'Wait for evidence' }],
      recommendedOptionId: 'wait',
    },
  ])('accepts the $decision proposal', (value) => {
    expect(RouterProposalSchema.parse(value)).toEqual(value)
  })

  it('rejects invented fields and covered claims without evidence', () => {
    expect(RouterProposalSchema.safeParse({ ...base, decision: 'ignore', reason: 'noise', runId: id }).success).toBe(false)
    expect(RouterProposalSchema.safeParse({ ...base, decision: 'ignore', reason: 'covered', coverage: [{ inputId: citation, status: 'covered', evidenceIds: [] }] }).success).toBe(false)
  })

  it('requires explicit ownership, billing, limits and local credential revision', () => {
    expect(ConfigureProjectRouterRequestSchema.safeParse({ enabled: true }).success).toBe(false)
    expect(CoordinationRequestPayloadSchema.safeParse({ evaluationId: id }).success).toBe(false)
  })
})
