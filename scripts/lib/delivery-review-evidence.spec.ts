import { describe, expect, it } from 'vitest'
import { verifyDeliveryReviewEvidence } from './delivery-review-evidence.js'
const good = () => ({
  sourceArtifactId: 'original',
  sourceRunId: 'source-run',
  sourceSha256: 'a'.repeat(64),
  commentId: 'comment',
  comment: 'fix error handling',
  direction: 'show status',
  lateComment: 'late opinion',
  revisionRunId: 'revision-run',
  output: 'fix error handling show status',
  candidateId: 'new',
  candidateSha256: 'b'.repeat(64),
  reviewerUserId: 'reviewer',
  beforeHumanResolutions: [],
  privateContentStatus: 404,
  hiddenCandidate: null,
  publishedContentStatus: 200,
  sourceCopy: {
    artifactId: 'original',
    sha256: 'a'.repeat(64),
    fileSha256: 'a'.repeat(64),
    byteSize: 12,
  },
  runtimeContext: `original ${'a'.repeat(64)} comment fix error handling show status`,
  round: {
    sourceArtifact: { artifactId: 'original', sha256: 'a'.repeat(64), byteSize: 12 },
    runId: 'revision-run',
    candidate: { artifactId: 'new', publishedAt: '2026-10-26T00:00:00Z' },
    comments: [{ commentId: 'comment', body: 'fix error handling' }],
    direction: 'show status',
    resolutions: [{ commentId: 'comment', status: 'resolved', resolvedBy: 'reviewer' }],
  },
  basis: {
    artifactId: 'original',
    sourceRun: { id: 'source-run' },
    agreement: { status: 'bound', revision: { revisionNumber: 1 } },
  },
})
describe('delivery review independent evidence verdict', () => {
  it('accepts cross-consistent evidence', () =>
    expect(verifyDeliveryReviewEvidence(good()).ok).toBe(true))
  it('fails closed without evidence', () =>
    expect(verifyDeliveryReviewEvidence(undefined).ok).toBe(false))
  it.each([
    [
      'changed original',
      (e: ReturnType<typeof good>) => {
        e.sourceSha256 = 'c'.repeat(64)
      },
    ],
    [
      'late comment leaked',
      (e: ReturnType<typeof good>) => {
        e.runtimeContext += ' late opinion'
      },
    ],
    [
      'model ignored feedback',
      (e: ReturnType<typeof good>) => {
        e.output = 'all done'
      },
    ],
    [
      'private candidate exposed',
      (e: ReturnType<typeof good>) => {
        e.privateContentStatus = 200
      },
    ],
    [
      'no human resolution',
      (e: ReturnType<typeof good>) => {
        e.round.resolutions = []
      },
    ],
    [
      'missing source copy',
      (e: ReturnType<typeof good>) => {
        e.sourceCopy.artifactId = ''
      },
    ],
    [
      'corrupt downloaded source',
      (e: ReturnType<typeof good>) => {
        e.sourceCopy.fileSha256 = 'c'.repeat(64)
      },
    ],
    [
      'wrong basis',
      (e: ReturnType<typeof good>) => {
        e.basis.sourceRun.id = 'different-run'
      },
    ],
  ] as const)('rejects %s', (_label, mutate) => {
    const e = good()
    mutate(e)
    expect(verifyDeliveryReviewEvidence(e).ok).toBe(false)
  })
})
