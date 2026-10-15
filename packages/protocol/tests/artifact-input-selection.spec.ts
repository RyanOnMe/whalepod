import { describe, expect, it } from 'vitest'
import { CreateRunRequestSchema, SendInstructionRequestSchema } from '../src/index.js'
const id = '00000000-0000-4000-8000-000000000001'
const base = { agentId: id, deviceId: id, workspaceId: id, prompt: 'review' }
describe('explicit artifact input selection (#325)', () => {
  it('new execution accepts an exact or empty selection', () => {
    expect(CreateRunRequestSchema.safeParse({ ...base, artifactInputIds: [id] }).success).toBe(true)
    expect(
      SendInstructionRequestSchema.safeParse({
        text: 'review',
        agentId: id,
        intent: { kind: 'new' },
        artifactInputIds: [],
      }).success,
    ).toBe(true)
  })
  it('rejects duplicate, oversized and invalid identity selections', () => {
    for (const artifactInputIds of [[id, id], Array.from({ length: 65 }, () => id), ['invalid']])
      expect(CreateRunRequestSchema.safeParse({ ...base, artifactInputIds }).success).toBe(false)
  })
  it('cannot silently discard input changes as an active followup or implicit instruction', () => {
    for (const intent of [undefined, { kind: 'followup', runId: id }])
      expect(
        SendInstructionRequestSchema.safeParse({
          text: 'review',
          artifactInputIds: [],
          ...(intent ? { intent } : {}),
        }).success,
      ).toBe(false)
  })
  it('resume may explicitly select newly published feedback for its new record', () => {
    expect(
      SendInstructionRequestSchema.safeParse({
        text: 'revise',
        intent: { kind: 'resume', runId: id },
        artifactInputIds: [id],
      }).success,
    ).toBe(true)
  })
})
