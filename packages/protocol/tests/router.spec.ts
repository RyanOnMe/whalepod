import { describe, expect, it } from 'vitest'
import {
  CoordinationRequestPayloadSchema,
  RouterProposalSchema,
  ConfigureProjectRouterRequestSchema,
  coordinationUsageCost,
  coordinationInputTokenEstimate,
} from '../src/router.js'
import { RouterReevaluateRequestSchema } from '../src/router-application.js'

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
    expect(
      RouterProposalSchema.safeParse({ ...base, decision: 'ignore', reason: 'noise', runId: id })
        .success,
    ).toBe(false)
    expect(
      RouterProposalSchema.safeParse({
        ...base,
        decision: 'ignore',
        reason: 'covered',
        coverage: [{ inputId: citation, status: 'covered', evidenceIds: [] }],
      }).success,
    ).toBe(false)
  })

  it('requires explicit ownership, billing, limits and local credential revision', () => {
    expect(ConfigureProjectRouterRequestSchema.safeParse({ enabled: true }).success).toBe(false)
    expect(CoordinationRequestPayloadSchema.safeParse({ evaluationId: id }).success).toBe(false)
  })
})

describe('Router bounded input and cost arithmetic', () => {
  it('uses an integer ceiling for fractional micro-costs without floating-point rounding', () => {
    expect(
      coordinationUsageCost({
        inputTokens: 1,
        outputTokens: 1,
        inputPriceMicrosPerMillionTokens: 1,
        outputPriceMicrosPerMillionTokens: 1,
      }),
    ).toBe(1)
    expect(() =>
      coordinationUsageCost({
        inputTokens: -1,
        outputTokens: 0,
        inputPriceMicrosPerMillionTokens: 1,
        outputPriceMicrosPerMillionTokens: 1,
      }),
    ).toThrow('nonnegative safe integers')
    expect(() =>
      coordinationUsageCost({
        inputTokens: Number.MAX_SAFE_INTEGER,
        outputTokens: 0,
        inputPriceMicrosPerMillionTokens: Number.MAX_SAFE_INTEGER,
        outputPriceMicrosPerMillionTokens: 1,
      }),
    ).toThrow('safe range')
  })
  it('checks only the cost fields when callers pass a structurally compatible config', () => {
    const config = {
      inputTokens: 100,
      outputTokens: 20,
      inputPriceMicrosPerMillionTokens: 1000,
      outputPriceMicrosPerMillionTokens: 1000,
      provider: 'test',
      model: 'model',
      enabled: true,
    }
    expect(coordinationUsageCost(config)).toBe(1)
  })
  it('accounts for worst-case JSON body escaping and manifest bytes', () => {
    const manifest = [
      {
        id,
        kind: 'source' as const,
        sourceId: id,
        version: 'v1',
        digest: 'a'.repeat(64),
        byteSize: 100,
        authorizationGeneration: 'internal',
      },
    ]
    expect(coordinationInputTokenEstimate(manifest)).toBe(
      600 + new TextEncoder().encode(JSON.stringify(manifest)).byteLength * 2 + 16384,
    )
  })
  it('rejects duplicate ask options or a recommendation outside the options', () => {
    const ask = {
      ...base,
      decision: 'ask',
      questionType: 'choose_option',
      blockedDecision: 'dispatch',
      options: [{ id: 'wait', label: 'Wait' }],
      recommendedOptionId: 'missing',
    }
    expect(RouterProposalSchema.safeParse(ask).success).toBe(false)
    expect(
      RouterProposalSchema.safeParse({
        ...ask,
        recommendedOptionId: 'wait',
        options: [
          { id: 'wait', label: 'Wait' },
          { id: 'wait', label: 'Retry' },
        ],
      }).success,
    ).toBe(false)
  })
})

describe('Router application contracts', () => {
  it('requires exactly one re-evaluation identity', () => {
    expect(RouterReevaluateRequestSchema.safeParse({ waitId: id }).success).toBe(true)
    expect(RouterReevaluateRequestSchema.safeParse({ evaluationId: id }).success).toBe(true)
    expect(RouterReevaluateRequestSchema.safeParse({}).success).toBe(false)
    expect(RouterReevaluateRequestSchema.safeParse({ waitId: id, evaluationId: id }).success).toBe(
      false,
    )
  })
})
