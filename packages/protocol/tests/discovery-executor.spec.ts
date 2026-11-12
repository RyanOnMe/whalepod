import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import {
  DiscoveryExecutorAttemptSettleSchema,
  DiscoveryPermitRequestSchema,
  RunStartWorkInputSchema,
} from '../src/index.js'

describe('discovery executor protocol', () => {
  const digest = 'b'.repeat(64)
  const replay = { discoveryReplayEndpoint: 'http://127.0.0.1:9900/chat/completions' }
  const live = {
    discoveryLiveExecutor: {
      provider: 'command-code',
      model: 'deepseek/deepseek-v4.1-flash',
      endpoint: 'https://api.commandcode.ai/provider/v1/chat/completions',
      account: 'rd04c3-acceptance',
      credentialDigest: digest,
      policyGeneration: 1,
    },
  }
  const entry = {
    inboxItemId: randomUUID(),
    sourceType: 'discovery_source',
    sourceId: randomUUID(),
    sourceVersion: 'v1',
    sourceDigest: digest,
    bodyDigest: digest,
    byteSize: 1,
    authorizationGeneration: '1',
    title: 'Bound source',
  }
  const discovery = {
    discoveryExecutionId: randomUUID(),
    manifestDigest: digest,
    manifest: { version: 'rd02a2.v1', workKey: randomUUID(), entries: [entry] },
  }

  it('does not negotiate a replay fallback for a live discovery Run', () => {
    expect(RunStartWorkInputSchema.safeParse({ ...discovery, ...live }).success).toBe(true)
    expect(RunStartWorkInputSchema.safeParse({ ...discovery, ...replay }).success).toBe(true)
    expect(RunStartWorkInputSchema.safeParse({ ...discovery, ...replay, ...live }).success).toBe(
      false,
    )
    expect(RunStartWorkInputSchema.safeParse(discovery).success).toBe(false)
    expect(
      RunStartWorkInputSchema.safeParse({
        ...live,
        manifestDigest: digest,
        manifest: { ...discovery.manifest, entries: [{ ...entry, sourceType: 'task_message' }] },
      }).success,
    ).toBe(false)
  })

  it('requires explicit execute tier before assigning paid model limits', () => {
    const executorLimits = { dispatches: 1, calls: 4, tokens: 1_000_000, costMicros: 500_000 }
    expect(
      DiscoveryPermitRequestSchema.safeParse({ configVersion: 1, tier: 'execute', executorLimits })
        .success,
    ).toBe(true)
    expect(
      DiscoveryPermitRequestSchema.safeParse({ configVersion: 1, tier: 'create', executorLimits })
        .success,
    ).toBe(false)
    expect(
      DiscoveryPermitRequestSchema.safeParse({ configVersion: 1, executorLimits }).success,
    ).toBe(false)
  })

  it('accepts actual prompt-only usage while refusing a zero-input receipt', () => {
    const receipt = { attemptId: randomUUID(), requestDigest: digest }
    expect(
      DiscoveryExecutorAttemptSettleSchema.safeParse({
        ...receipt,
        outcome: { kind: 'actual', inputTokens: 19, outputTokens: 0 },
      }).success,
    ).toBe(true)
    expect(
      DiscoveryExecutorAttemptSettleSchema.safeParse({
        ...receipt,
        outcome: { kind: 'actual', inputTokens: 0, outputTokens: 0 },
      }).success,
    ).toBe(false)
  })
})
