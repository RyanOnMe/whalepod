import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import {
  CreateArtifactRevisionRoundRequestSchema,
  ReviewInputManifestSchema,
} from '../src/review-round.js'

function artifact() {
  return {
    artifactId: randomUUID(),
    runId: randomUUID(),
    title: '接口约定.md',
    mediaType: 'text/markdown',
    byteSize: 10,
    sha256: 'a'.repeat(64),
    publishedAt: '2026-10-23T00:00:00.000Z',
  }
}

describe('artifact revision round contract (#430)', () => {
  it('创建批次至少选一条批注，最多 50 条；方向有上限', () => {
    expect(
      CreateArtifactRevisionRoundRequestSchema.safeParse({
        sourceArtifactId: randomUUID(),
        commentIds: [],
      }).success,
    ).toBe(false)
    expect(
      CreateArtifactRevisionRoundRequestSchema.safeParse({
        sourceArtifactId: randomUUID(),
        commentIds: [randomUUID()],
        direction: 'x'.repeat(10_001),
      }).success,
    ).toBe(false)
    expect(
      CreateArtifactRevisionRoundRequestSchema.safeParse({
        sourceArtifactId: randomUUID(),
        commentIds: [randomUUID()],
      }).success,
    ).toBe(true)
  })

  it('输入快照必须带原稿与至少一条选定意见；回复随线程', () => {
    expect(
      ReviewInputManifestSchema.safeParse({
        roundId: randomUUID(),
        sourceArtifact: artifact(),
        direction: null,
        comments: [],
        references: [],
        frozenAt: '2026-10-23T00:00:00.000Z',
      }).success,
    ).toBe(false)
    expect(
      ReviewInputManifestSchema.safeParse({
        roundId: randomUUID(),
        sourceArtifact: artifact(),
        direction: '统一命名',
        comments: [
          {
            commentId: randomUUID(),
            authorUserId: randomUUID(),
            kind: 'whole',
            anchor: null,
            body: '整体可以。',
            createdAt: '2026-10-23T00:00:00.000Z',
            replies: [],
          },
        ],
        references: [artifact()],
        frozenAt: '2026-10-23T00:00:00.000Z',
      }).success,
    ).toBe(true)
  })
})
