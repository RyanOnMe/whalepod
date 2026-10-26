/** #442: independently judge the fail-closed Office policy and preserved review path. */
export interface OfficePreviewLoopVerification {
  ok: boolean
  failures: string[]
  checks: number
}
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i
const SHA = /^[a-f0-9]{64}$/
const DOCX = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
export function verifyOfficePreviewLoopEvidence(input: unknown): OfficePreviewLoopVerification {
  let checks = 0
  const failures: string[] = []
  const check = (ok: boolean, message: string) => {
    checks++
    if (!ok) failures.push(message)
  }
  const object = (v: unknown): Record<string, unknown> =>
    v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {}
  const root = object(input)
  const identity = (v: unknown) => typeof v === 'string' && UUID.test(v)
  check(root['component'] === 'web.office-preview-loop', 'missing Office component')
  check(root['source'] === 'production-hub-node-runtime', 'must use production assembly')
  check(
    root['policy'] === 'isolation-required',
    'old successful conversion evidence cannot validate current policy',
  )
  for (const key of ['artifactId', 'taskId', 'runId', 'commentId', 'expectedReviewerUserId'])
    check(identity(root[key]), `${key} must be a UUID`)
  const artifactId = root['artifactId']
  const sourceSha = root['sourceSha']
  check(typeof sourceSha === 'string' && SHA.test(sourceSha), 'invalid source digest')
  check(
    root['statusBeforePublish'] === 'candidate' && root['statusAfterPublish'] === 'published',
    'must explicitly publish the original',
  )
  for (const key of ['original', 'memberOriginal']) {
    const row = object(root[key])
    check(row['status'] === 200, `${key} download unavailable`)
    check(
      row['mediaType'] === DOCX &&
        typeof row['signature'] === 'string' &&
        row['signature'].startsWith('PK'),
      `${key} is not the original DOCX`,
    )
    check(
      typeof row['byteSize'] === 'number' &&
        Number.isInteger(row['byteSize']) &&
        row['byteSize'] > 0 &&
        row['byteSize'] <= 52_428_800,
      `${key} invalid byte count`,
    )
    check(
      typeof sourceSha === 'string' && row['sha256'] === sourceSha,
      `${key} digest differs from the artifact`,
    )
  }
  check(
    object(root['original'])['byteSize'] === object(root['memberOriginal'])['byteSize'],
    'original byte count changed after publication',
  )
  for (const key of ['ownerDownload', 'memberDownload']) {
    const row = object(root[key])
    check(
      row['urlPath'] === `/api/v1/artifacts/${String(artifactId)}/content`,
      `${key} did not use the visible original route`,
    )
    check(
      typeof sourceSha === 'string' && row['sha256'] === sourceSha,
      `${key} bytes differ from the original`,
    )
    check(
      row['byteSize'] === object(root['original'])['byteSize'] &&
        typeof row['signature'] === 'string' &&
        row['signature'].startsWith('PK'),
      `${key} did not produce the complete original file`,
    )
  }
  for (const key of ['ownerInfo', 'memberInfo']) {
    const row = object(root[key])
    check(
      row['artifactId'] === artifactId && row['sourceSha256'] === sourceSha,
      `${key} original identity mismatch`,
    )
    check(
      row['status'] === 'failed' && row['failureReason'] === 'ISOLATION_REQUIRED',
      `${key} must report isolation required`,
    )
    check(
      row['converter'] === 'unknown' &&
        row['mediaType'] === null &&
        row['byteSize'] === null &&
        row['updatedAt'] === null,
      `${key} must hide untrusted historical preview metadata`,
    )
  }
  for (const key of ['ownerPreview', 'memberPreview']) {
    const row = object(root[key])
    check(
      row['status'] === 404 && row['code'] === 'PREVIEW_UNAVAILABLE',
      `${key} must deny old or new PDF bytes`,
    )
  }
  check(
    root['ownerIframeCount'] === 0 && root['memberIframeCount'] === 0,
    'an untrusted PDF reader remains mounted',
  )
  check(
    root['ownerFallbackVisible'] === true && root['memberFallbackVisible'] === true,
    'both users must see the isolation fallback',
  )
  const privacy = object(root['privacy'])
  for (const key of ['original', 'preview', 'info'])
    check(privacy[key] === 404, `private ${key} leaked`)
  check(
    root['finalArtifactId'] === artifactId && root['finalArtifactSha'] === sourceSha,
    'review original identity drifted',
  )
  check(
    typeof root['comment'] === 'string' && root['comment'].trim().length > 0,
    'missing comment body',
  )
  check(
    root['commentKind'] === 'whole' && root['commentArtifactId'] === artifactId,
    'whole comment must bind to the original',
  )
  check(
    identity(root['commentAuthorUserId']) &&
      root['commentAuthorUserId'] === root['expectedReviewerUserId'],
    'comment author is not the expected reviewer',
  )
  check(
    root['commentAnchor'] === null && root['commentParentCommentId'] === null,
    'whole root comment is missing',
  )
  return { ok: failures.length === 0, failures, checks }
}
