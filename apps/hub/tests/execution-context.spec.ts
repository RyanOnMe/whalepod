import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import {
  HandoffInputManifestSchema,
  emptyHandoffNarrative,
  type HandoffInputManifest,
} from '@whalepod/protocol'
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

  it('装配结果超过 wire 上限时明确失败，不让合法输入变成 500', () => {
    // 每张文量单看都合法（约定 4×10000、正文叙述 ≤24KiB、理解/差异各 10000），
    // 但拼起来会越过 executionContext 的 100000 字符 wire 上限。
    const agreement = {
      revisionNumber: 1,
      content: {
        goal: 'g'.repeat(10_000),
        constraints: 'c'.repeat(10_000),
        acceptance: 'a'.repeat(10_000),
        openQuestions: 'q'.repeat(10_000),
      },
    }
    const handoff: HandoffInputManifest = {
      upstreamTaskId: randomUUID(),
      upstreamTaskTitle: '上游',
      receiptId: randomUUID(),
      revisionId: randomUUID(),
      revisionNumber: 1,
      artifacts: [],
      context: {
        content: {
          system: {
            sourceRunId: randomUUID(),
            specRevision: null,
            artifacts: Array.from({ length: 64 }, () => ({
              artifactId: randomUUID(),
              title: 't'.repeat(200),
              sha256: 'a'.repeat(64),
              byteSize: 1,
              status: 'published' as const,
            })),
          },
          narrative: {
            ...emptyHandoffNarrative(),
            completed: Array.from({ length: 8 }, () => ({
              text: 'x'.repeat(2_000),
              verified: false,
              refs: [],
            })),
          },
        },
        understanding: 'u'.repeat(10_000),
        differences: 'd'.repeat(10_000),
      },
    }
    // 形状本身是合法的（正文总容量是发布路径的另一条约束），因此不能靠 schema 兜底。
    expect(HandoffInputManifestSchema.safeParse(handoff).success).toBe(true)
    try {
      buildExecutionContext(agreement, handoff)
      throw new Error('expected buildExecutionContext to reject oversized context')
    } catch (error) {
      expect(error).toMatchObject({ code: 'VALIDATION_FAILED' })
      expect((error as Error).message).toContain('执行上下文上限')
    }
  })
})
