import { describe, expect, it } from 'vitest'
import { emptyHandoffNarrative, type HandoffInputManifest } from '@whalepod/protocol'
import { buildExecutionContext } from '../src/modules/run/execution-context.js'

describe('#396 固定上下文装配', () => {
  it('无 Artifact 仍传正文和理解；历史未知不补造', () => {
    const handoff: HandoffInputManifest = {
      upstreamTaskId: 'up',
      upstreamTaskTitle: '上游',
      receiptId: 'receipt',
      revisionId: 'fixed-v1',
      revisionNumber: 1,
      artifacts: [],
      context: {
        content: {
          system: { sourceRunId: 'source', specRevision: null, artifacts: [] },
          narrative: {
            ...emptyHandoffNarrative(),
            interfaces: [{ text: 'GET /orders', verified: false, refs: [] }],
          },
        },
        understanding: '接入订单列表',
        differences: '不改后端',
      },
    }
    const text = buildExecutionContext(
      {
        revisionNumber: 2,
        content: {
          goal: '交付导出',
          constraints: '不增依赖',
          acceptance: '用例通过',
          openQuestions: '格式待定',
        },
      },
      handoff,
    )
    for (const expected of [
      'v2',
      '交付导出',
      '不增依赖',
      '用例通过',
      '格式待定',
      'fixed-v1',
      'GET /orders',
      '接入订单列表',
      '不改后端',
      '待核实',
    ])
      expect(text).toContain(expected)
    expect(buildExecutionContext(null, null)).toBe('')
    delete handoff.context
    expect(buildExecutionContext(null, handoff)).toContain('历史快照未记录')
  })
})
