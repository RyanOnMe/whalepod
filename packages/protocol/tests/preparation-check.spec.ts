import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { NodeDownstreamSchema, NodeUpstreamSchema } from '../src/node-wire.js'
const frame = (type: string, payload: unknown) => ({
  protocolVersion: 1,
  messageId: randomUUID(),
  sentAt: new Date().toISOString(),
  type,
  payload,
})
const request = {
  requestId: randomUUID(),
  workspaceId: randomUUID(),
  provider: 'deepseek-official',
  credentialSlot: 'default',
}
describe('本机准备只读探针（#320）', () => {
  it('接受有界请求与脱敏结果', () => {
    expect(NodeDownstreamSchema.safeParse(frame('node.preparation_check', request)).success).toBe(
      true,
    )
    expect(
      NodeUpstreamSchema.safeParse(
        frame('node.preparation_result', {
          requestId: request.requestId,
          workspace: 'available',
          credential: 'configured',
        }),
      ).success,
    ).toBe(true)
  })
  it.each([{ secret: 'fixture-secret' }, { path: '/private-fixture' }, { model: 'tested' }])(
    '结果不得夹带秘密、路径或调用证明',
    (extra) => {
      expect(
        NodeUpstreamSchema.safeParse(
          frame('node.preparation_result', {
            requestId: request.requestId,
            workspace: 'available',
            credential: 'configured',
            ...extra,
          }),
        ).success,
      ).toBe(false)
    },
  )
})
