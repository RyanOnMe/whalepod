/**
 * #442: judge the Office browser loop independently of its driver assertions.
 * Reader hashes measure each visible iframe's Blob; HTTP facts alone cannot prove reading.
 * Missing facts fail rather than allowing undefined values to compare equal.
 */
export interface OfficePreviewLoopVerification {
  ok: boolean
  failures: string[]
  checks: number
}

const DOCX = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
const MAX_BYTES = 52_428_800
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i
const SHA256 = /^[a-f0-9]{64}$/

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function verifyOfficePreviewLoopEvidence(input: unknown): OfficePreviewLoopVerification {
  const failures: string[] = []
  let checks = 0
  const check = (condition: boolean, message: string): void => {
    checks += 1
    if (!condition) failures.push(message)
  }
  const string = (value: unknown, label: string): string | undefined => {
    const valid = typeof value === 'string' && value.trim().length > 0
    check(valid, `${label} must be a non-empty string`)
    return valid ? value : undefined
  }
  const identity = (value: unknown, label: string): string | undefined => {
    const text = string(value, label)
    check(text !== undefined && UUID.test(text), `${label} must be a UUID`)
    return text !== undefined && UUID.test(text) ? text : undefined
  }
  const digest = (value: unknown, label: string): string | undefined => {
    const text = string(value, label)
    check(text !== undefined && SHA256.test(text), `${label} must be a lowercase sha256 digest`)
    return text !== undefined && SHA256.test(text) ? text : undefined
  }
  const byteSize = (value: unknown, label: string): number | undefined => {
    const valid =
      typeof value === 'number' && Number.isInteger(value) && value > 0 && value <= MAX_BYTES
    check(valid, `${label} must be a positive byte count within the artifact limit`)
    return valid ? value : undefined
  }
  const section = (record: Record<string, unknown>, key: string) => {
    const value = record[key]
    check(isRecord(value), `missing section: ${key}`)
    return isRecord(value) ? value : undefined
  }
  const same = (left: unknown, right: unknown, message: string): void => {
    check(left !== undefined && right !== undefined && left === right, message)
  }

  if (!isRecord(input)) return { ok: false, failures: ['evidence is not an object'], checks: 1 }
  check(
    input['component'] === 'web.office-preview-loop',
    'component must be web.office-preview-loop',
  )
  check(
    input['source'] === 'production-hub-node-runtime',
    'source must name the production Hub/Node/Runtime assembly',
  )
  const artifactId = identity(input['artifactId'], 'artifactId')
  identity(input['taskId'], 'taskId')
  identity(input['runId'], 'runId')
  const sourceSha = digest(input['sourceSha'], 'sourceSha')
  const previewSourceSha = digest(input['previewSourceSha'], 'previewSourceSha')
  same(previewSourceSha, sourceSha, 'previewSourceSha must bind the preview to sourceSha')
  const previewBytes = byteSize(input['previewByteSize'], 'previewByteSize')
  check(input['statusBeforePublish'] === 'candidate', 'statusBeforePublish must be candidate')
  check(input['statusAfterPublish'] === 'published', 'statusAfterPublish must be published')
  check(input['previewStatus'] === 'ready', 'previewStatus must be ready')

  const originals = ['original', 'memberOriginal'] as const
  const originalBytes: Array<number | undefined> = []
  for (const name of originals) {
    const original = section(input, name)
    if (original === undefined) continue
    check(original['status'] === 200, `${name}.status must be 200`)
    check(original['mediaType'] === DOCX, `${name}.mediaType must identify the original DOCX`)
    check(
      typeof original['signature'] === 'string' && original['signature'].startsWith('PK'),
      `${name}.signature must identify an OpenXML ZIP`,
    )
    const bytes = byteSize(original['byteSize'], `${name}.byteSize`)
    originalBytes.push(bytes)
    same(
      digest(original['sha256'], `${name}.sha256`),
      sourceSha,
      `${name}.sha256 must equal sourceSha`,
    )
  }
  same(originalBytes[0], originalBytes[1], 'memberOriginal.byteSize must equal original.byteSize')

  const ownerPdf = section(input, 'ownerPdf')
  const expectedPdfSha =
    ownerPdf === undefined ? undefined : digest(ownerPdf['sha256'], 'ownerPdf.sha256')
  check(
    expectedPdfSha !== undefined && sourceSha !== undefined && expectedPdfSha !== sourceSha,
    'ownerPdf.sha256 must identify derived PDF bytes rather than the original Office bytes',
  )
  for (const name of ['ownerPdf', 'memberPdf', 'ownerReader', 'memberReader'] as const) {
    const fact = name === 'ownerPdf' ? ownerPdf : section(input, name)
    if (fact === undefined) continue
    if (name === 'ownerReader' || name === 'memberReader') {
      check(fact['visible'] === true, `${name}.visible must prove a visible iframe`)
      check(fact['sourceScheme'] === 'blob:', `${name}.sourceScheme must be the reader Blob`)
    } else check(fact['status'] === 200, `${name}.status must be 200`)
    check(fact['mediaType'] === 'application/pdf', `${name}.mediaType must be application/pdf`)
    check(fact['signature'] === '%PDF-', `${name}.signature must be %PDF-`)
    same(
      byteSize(fact['byteSize'], `${name}.byteSize`),
      previewBytes,
      `${name}.byteSize must equal previewByteSize`,
    )
    const sha = name === 'ownerPdf' ? expectedPdfSha : digest(fact['sha256'], `${name}.sha256`)
    same(sha, expectedPdfSha, `${name}.sha256 must equal the owner HTTP PDF digest`)
  }
  const privacy = section(input, 'privacy')
  if (privacy !== undefined) {
    for (const key of ['original', 'preview', 'info']) {
      check(privacy[key] === 404, `privacy.${key} must be 404 before publication`)
    }
  }

  same(
    identity(input['finalArtifactId'], 'finalArtifactId'),
    artifactId,
    'finalArtifactId must remain the original artifactId',
  )
  same(
    digest(input['finalArtifactSha'], 'finalArtifactSha'),
    sourceSha,
    'finalArtifactSha must remain sourceSha',
  )
  identity(input['commentId'], 'commentId')
  string(input['comment'], 'comment')
  check(input['commentKind'] === 'whole', 'commentKind must be whole')
  same(
    identity(input['commentArtifactId'], 'commentArtifactId'),
    artifactId,
    'commentArtifactId must bind to the original artifactId',
  )
  const expectedReviewer = identity(input['expectedReviewerUserId'], 'expectedReviewerUserId')
  same(
    identity(input['commentAuthorUserId'], 'commentAuthorUserId'),
    expectedReviewer,
    'commentAuthorUserId must equal expectedReviewerUserId',
  )
  check(
    input['commentAnchor'] === null,
    'commentAnchor must be explicitly null for a whole comment',
  )
  check(
    input['commentParentCommentId'] === null,
    'commentParentCommentId must be explicitly null for a root comment',
  )
  return { ok: failures.length === 0, failures, checks }
}
