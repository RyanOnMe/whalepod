import { describe, expect, it } from 'vitest'
import { verifyOfficePreviewLoopEvidence } from './office-preview-loop-evidence.js'
const ID = '00000000-0000-4000-8000-000000000441'
const USER = '00000000-0000-4000-8000-000000000442'
const SHA = 'a'.repeat(64)
const DOCX = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
function good(): Record<string, unknown> {
  const original = { status: 200, mediaType: DOCX, byteSize: 128, signature: 'PK123', sha256: SHA }
  const info = {
    artifactId: ID,
    status: 'failed',
    sourceSha256: SHA,
    converter: 'unknown',
    mediaType: null,
    byteSize: null,
    failureReason: 'ISOLATION_REQUIRED',
    updatedAt: null,
  }
  return {
    component: 'web.office-preview-loop',
    source: 'production-hub-node-runtime',
    policy: 'isolation-required',
    artifactId: ID,
    taskId: '00000000-0000-4000-8000-000000000443',
    runId: '00000000-0000-4000-8000-000000000444',
    sourceSha: SHA,
    statusBeforePublish: 'candidate',
    statusAfterPublish: 'published',
    original,
    ownerDownload: { ...original, urlPath: `/api/v1/artifacts/${ID}/content` },
    memberDownload: { ...original, urlPath: `/api/v1/artifacts/${ID}/content` },
    memberOriginal: { ...original },
    ownerInfo: info,
    memberInfo: { ...info },
    ownerPreview: { status: 404, code: 'PREVIEW_UNAVAILABLE' },
    memberPreview: { status: 404, code: 'PREVIEW_UNAVAILABLE' },
    ownerIframeCount: 0,
    memberIframeCount: 0,
    ownerFallbackVisible: true,
    memberFallbackVisible: true,
    privacy: { original: 404, preview: 404, info: 404 },
    finalArtifactId: ID,
    finalArtifactSha: SHA,
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
function changed(section: string, key: string, value: unknown) {
  const e = good()
  ;(e[section] as Record<string, unknown>)[key] = value
  return e
}
describe('Office isolation fallback independent evidence', () => {
  it('accepts denied PDF access with unchanged original and a real whole comment', () =>
    expect(verifyOfficePreviewLoopEvidence(good()).ok).toBe(true))
  it.each([undefined, null, {}, []])('rejects missing evidence %j', (value) =>
    expect(verifyOfficePreviewLoopEvidence(value).ok).toBe(false),
  )
  it('does not treat an old successful PDF report as current acceptance', () => {
    const e = good()
    delete e['policy']
    e['ownerPdf'] = { status: 200 }
    expect(verifyOfficePreviewLoopEvidence(e).ok).toBe(false)
  })
  it.each(['ownerPreview', 'memberPreview'])(
    'rejects directly readable historical PDF: %s',
    (section) =>
      expect(verifyOfficePreviewLoopEvidence(changed(section, 'status', 200)).ok).toBe(false),
  )
  it.each(['ownerInfo', 'memberInfo'])('rejects ready preview metadata: %s', (section) =>
    expect(verifyOfficePreviewLoopEvidence(changed(section, 'status', 'ready')).ok).toBe(false),
  )
  it('rejects leaking a historical PDF digest or MIME', () =>
    expect(
      verifyOfficePreviewLoopEvidence(changed('memberInfo', 'mediaType', 'application/pdf')).ok,
    ).toBe(false))
  it('rejects private preview metadata exposure', () =>
    expect(verifyOfficePreviewLoopEvidence(changed('privacy', 'info', 200)).ok).toBe(false))
  it('rejects a changed downloaded original', () =>
    expect(
      verifyOfficePreviewLoopEvidence(changed('memberOriginal', 'sha256', 'b'.repeat(64))).ok,
    ).toBe(false))
  it('requires the owner visible download to return the correct file', () =>
    expect(
      verifyOfficePreviewLoopEvidence(changed('ownerDownload', 'sha256', 'b'.repeat(64))).ok,
    ).toBe(false))
  it('requires the member visible download to use this artifact route', () =>
    expect(
      verifyOfficePreviewLoopEvidence(changed('memberDownload', 'urlPath', '/wrong-file')).ok,
    ).toBe(false))
  it('rejects an unavailable original', () =>
    expect(verifyOfficePreviewLoopEvidence(changed('memberOriginal', 'status', 404)).ok).toBe(
      false,
    ))
  it('rejects an iframe despite an unavailable API', () => {
    const e = good()
    e['memberIframeCount'] = 1
    expect(verifyOfficePreviewLoopEvidence(e).ok).toBe(false)
  })
  it('requires visible fallback information', () => {
    const e = good()
    e['ownerFallbackVisible'] = false
    expect(verifyOfficePreviewLoopEvidence(e).ok).toBe(false)
  })
  it('requires the actual reviewer and original version on the saved comment', () => {
    const e = good()
    e['commentAuthorUserId'] = ID
    expect(verifyOfficePreviewLoopEvidence(e).ok).toBe(false)
  })
  it('rejects a missing root comment', () => {
    const e = good()
    delete e['commentId']
    expect(verifyOfficePreviewLoopEvidence(e).ok).toBe(false)
  })
})
