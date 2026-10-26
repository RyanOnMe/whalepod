import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import {
  HandoffInputManifestSchema,
  emptyHandoffNarrative,
  ReviewInputManifestSchema,
  type HandoffInputManifest,
  type ReviewInputManifest,
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

  it('#430 本轮审阅修订：原稿、方向、选定意见与回复进入固定上下文', () => {
    const review: ReviewInputManifest = ReviewInputManifestSchema.parse({
      roundId: randomUUID(),
      sourceArtifact: {
        artifactId: randomUUID(),
        runId: randomUUID(),
        title: '接口约定.md',
        mediaType: 'text/markdown',
        byteSize: 12,
        sha256: 'a'.repeat(64),
        publishedAt: '2026-10-23T00:00:00.000Z',
      },
      direction: '优先统一字段命名',
      comments: [
        {
          commentId: randomUUID(),
          authorUserId: randomUUID(),
          kind: 'text',
          anchor: { quote: 'orderId', prefix: '', suffix: '', start: 0, end: 7 },
          body: '字段名要统一。',
          createdAt: '2026-10-23T00:00:00.000Z',
          replies: [
            {
              commentId: randomUUID(),
              authorUserId: randomUUID(),
              body: '本轮处理。',
              createdAt: '2026-10-23T00:00:00.000Z',
            },
          ],
        },
      ],
      references: [
        {
          artifactId: randomUUID(),
          runId: randomUUID(),
          title: '命名规范.md',
          mediaType: 'text/markdown',
          byteSize: 10,
          sha256: 'b'.repeat(64),
          publishedAt: '2026-10-23T00:00:00.000Z',
        },
      ],
      frozenAt: '2026-10-23T00:00:00.000Z',
    })
    const text = buildExecutionContext(null, null, review)
    for (const expected of [
      '本轮交付物审阅修订',
      '接口约定.md',
      '优先统一字段命名',
      '原文「orderId」',
      '字段名要统一。',
      '本轮处理。',
      '命名规范.md',
      '不会自动关闭批注',
    ])
      expect(text).toContain(expected)
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
