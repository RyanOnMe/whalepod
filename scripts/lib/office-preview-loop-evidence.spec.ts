import { describe, expect, it } from 'vitest'
import { verifyOfficePreviewLoopEvidence } from './office-preview-loop-evidence.js'

const SOURCE_SHA = 'a'.repeat(64)
const PDF_SHA = 'b'.repeat(64)
const OTHER_SHA = 'c'.repeat(64)
const ID = '00000000-0000-4000-8000-000000000441'
const USER = '00000000-0000-4000-8000-000000000442'
const DOCX = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'

function goodEvidence(): Record<string, unknown> {
  const original = {
    status: 200,
    mediaType: DOCX,
    byteSize: 128,
    signature: 'PK123',
    sha256: SOURCE_SHA,
  }
  const pdf = {
    status: 200,
    mediaType: 'application/pdf',
    byteSize: 64,
    signature: '%PDF-',
    sha256: PDF_SHA,
  }
  const reader = {
    visible: true,
    sourceScheme: 'blob:',
    mediaType: 'application/pdf',
    byteSize: 64,
    signature: '%PDF-',
    sha256: PDF_SHA,
  }
  return {
    component: 'web.office-preview-loop',
    source: 'production-hub-node-runtime',
    artifactId: ID,
    taskId: '00000000-0000-4000-8000-000000000443',
    runId: '00000000-0000-4000-8000-000000000444',
    sourceSha: SOURCE_SHA,
    previewSourceSha: SOURCE_SHA,
    previewByteSize: 64,
    statusBeforePublish: 'candidate',
    statusAfterPublish: 'published',
    previewStatus: 'ready',
    original,
    ownerReader: { ...reader },
    ownerPdf: { ...pdf },
    privacy: { original: 404, preview: 404, info: 404 },
    memberReader: { ...reader },
    memberOriginal: { ...original },
    memberPdf: { ...pdf },
    finalArtifactId: ID,
    finalArtifactSha: SOURCE_SHA,
    commentId: '00000000-0000-4000-8000-000000000445',
    comment: '请补充表格边界条件。',
    commentKind: 'whole',
    commentAuthorUserId: USER,
    expectedReviewerUserId: USER,
    commentArtifactId: ID,
    commentAnchor: null,
    commentParentCommentId: null,
  }
}

function changed(path: string[], value: unknown, remove = false): Record<string, unknown> {
  const evidence = goodEvidence()
  let node = evidence
  for (const key of path.slice(0, -1)) node = node[key] as Record<string, unknown>
  const key = path.at(-1)!
  if (remove) delete node[key]
  else node[key] = value
  return evidence
}

describe('#442 Office preview independent evidence verdict', () => {
  it('passes complete, cross-consistent browser, HTTP, privacy and whole-comment facts', () => {
    const verdict = verifyOfficePreviewLoopEvidence(goodEvidence())
    expect(verdict.ok).toBe(true)
    expect(verdict.failures).toEqual([])
    expect(verdict.checks).toBeGreaterThan(50)
  })

  it.each([null, undefined, [], '', 1, true, {}])(
    'fails malformed or empty evidence %j',
    (value) => {
      expect(verifyOfficePreviewLoopEvidence(value).ok).toBe(false)
    },
  )

  it.each(Object.keys(goodEvidence()))('fails when required root evidence %s is absent', (key) => {
    const verdict = verifyOfficePreviewLoopEvidence(changed([key], undefined, true))
    expect(verdict.ok).toBe(false)
    expect(verdict.failures.some((failure) => failure.includes(key))).toBe(true)
  })

  const missingFields = [
    ...['original', 'ownerPdf', 'memberOriginal', 'memberPdf'].flatMap((section) =>
      ['status', 'mediaType', 'byteSize', 'signature', 'sha256'].map((key) => [section, key]),
    ),
    ...['ownerReader', 'memberReader'].flatMap((section) =>
      ['visible', 'sourceScheme', 'mediaType', 'byteSize', 'signature', 'sha256'].map((key) => [
        section,
        key,
      ]),
    ),
    ...['original', 'preview', 'info'].map((key) => ['privacy', key]),
  ]
  it.each(missingFields.map((path) => [path.join('.'), path] as const))(
    'fails missing measured fact %s',
    (_label, path) => {
      const verdict = verifyOfficePreviewLoopEvidence(changed(path, undefined, true))
      expect(verdict.ok).toBe(false)
      expect(verdict.failures.some((failure) => failure.includes(path.join('.')))).toBe(true)
    },
  )

  const negatives: Array<[string, string[], unknown]> = [
    ['wrong component', ['component'], 'web.other-loop'],
    ['stub assembly', ['source'], 'unit-test-stub'],
    ['invalid source hash', ['sourceSha'], 'not-a-digest'],
    ['preview bound to another source', ['previewSourceSha'], OTHER_SHA],
    ['private artifact already published', ['statusBeforePublish'], 'published'],
    ['publication never happened', ['statusAfterPublish'], 'candidate'],
    ['conversion failed', ['previewStatus'], 'failed'],
    ['original cannot be downloaded', ['original', 'status'], 403],
    ['source is not DOCX', ['original', 'mediaType'], 'application/pdf'],
    ['source is not an OpenXML ZIP', ['original', 'signature'], '%PDF-'],
    ['original differs from artifact digest', ['original', 'sha256'], OTHER_SHA],
    ['member sees changed original', ['memberOriginal', 'sha256'], OTHER_SHA],
    ['member original byte count changed', ['memberOriginal', 'byteSize'], 129],
    ['owner reader is hidden', ['ownerReader', 'visible'], false],
    ['member reader is hidden', ['memberReader', 'visible'], false],
    ['reader bypasses controlled Blob', ['ownerReader', 'sourceScheme'], 'https:'],
    ['member reader bypasses controlled Blob', ['memberReader', 'sourceScheme'], 'https:'],
    ['HTML response masquerades as preview', ['ownerPdf', 'mediaType'], 'text/html'],
    ['reader has non PDF bytes', ['memberReader', 'signature'], 'PK123'],
    ['metadata byte count is zero', ['previewByteSize'], 0],
    ['metadata byte count is text', ['previewByteSize'], '64'],
    ['metadata byte count is fractional', ['previewByteSize'], 64.5],
    ['metadata byte count is nonfinite', ['previewByteSize'], Number.NaN],
    ['reader is empty', ['ownerReader', 'byteSize'], 0],
    ['reader exceeds size limit', ['ownerReader', 'byteSize'], 52_428_801],
    ['owner reader hash differs from HTTP bytes', ['ownerReader', 'sha256'], OTHER_SHA],
    ['member reader hash differs from owner PDF', ['memberReader', 'sha256'], OTHER_SHA],
    ['member HTTP PDF differs from owner PDF', ['memberPdf', 'sha256'], OTHER_SHA],
    ['owner HTTP preview is unavailable', ['ownerPdf', 'status'], 404],
    ['published member PDF unavailable', ['memberPdf', 'status'], 404],
    ['published member original unavailable', ['memberOriginal', 'status'], 404],
    ['original leaks before publication', ['privacy', 'original'], 200],
    ['PDF leaks before publication', ['privacy', 'preview'], 200],
    ['preview metadata leaks before publication', ['privacy', 'info'], 200],
    ['privacy check substitutes forbidden for hidden', ['privacy', 'info'], 403],
    ['final review is another artifact', ['finalArtifactId'], USER],
    ['review source hash drifted', ['finalArtifactSha'], OTHER_SHA],
    ['missing whole-comment body', ['comment'], '  '],
    ['comment ID malformed', ['commentId'], 'comment'],
    ['comment belongs to another artifact', ['commentArtifactId'], USER],
    ['comment author is not expected reviewer', ['commentAuthorUserId'], ID],
    ['comment is text anchor instead of whole', ['commentKind'], 'text'],
    ['whole comment carries an anchor', ['commentAnchor'], { start: 0 }],
    ['comment is merely a reply', ['commentParentCommentId'], ID],
  ]
  it.each(negatives)('negative control: %s', (_label, path, value) => {
    const verdict = verifyOfficePreviewLoopEvidence(changed(path, value))
    expect(verdict.ok).toBe(false)
    expect(verdict.failures.length).toBeGreaterThan(0)
  })

  it.each(['ownerReader', 'ownerPdf', 'memberReader', 'memberPdf'])(
    'requires %s byte count to match preview metadata',
    (section) => {
      expect(verifyOfficePreviewLoopEvidence(changed([section, 'byteSize'], 65)).ok).toBe(false)
    },
  )

  it('rejects original Office bytes masquerading as all four matching PDF readings', () => {
    const evidence = goodEvidence()
    for (const key of ['ownerReader', 'ownerPdf', 'memberReader', 'memberPdf']) {
      ;(evidence[key] as Record<string, unknown>)['sha256'] = SOURCE_SHA
    }
    expect(verifyOfficePreviewLoopEvidence(evidence).ok).toBe(false)
  })
})
