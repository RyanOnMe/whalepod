import { describe, expect, it } from 'vitest'
import {
  ArtifactPreviewFailureRequestSchema,
  ArtifactPreviewUploadMetadataSchema,
  ArtifactPreviewViewSchema,
} from '../src/preview.js'

const SHA = 'a'.repeat(64)
const PRIVATE_DETAIL = 'workspace/private.docx credential=fixture-sensitive-value'

describe('artifact preview public metadata', () => {
  it('normalizes untrusted diagnostics before either failure or ready metadata can be persisted', () => {
    expect(ArtifactPreviewFailureRequestSchema.parse({
      sourceSha256: SHA, converter: PRIVATE_DETAIL, reason: PRIVATE_DETAIL,
    })).toEqual({ sourceSha256: SHA, converter: 'unknown', reason: 'CONVERT_FAILED' })
    expect(ArtifactPreviewUploadMetadataSchema.parse({
      sourceSha256: SHA, sha256: SHA, byteSize: 12, converter: PRIVATE_DETAIL,
    }).converter).toBe('unknown')
  })

  it.each(['libreoffice', 'soffice', 'soffice/26.8.1', 'LibreOffice 26.8.1.1'])(
    'accepts known converter identifier %s without exposing a supplied suffix', (converter) => {
      expect(ArtifactPreviewFailureRequestSchema.parse({
        sourceSha256: SHA, converter, reason: 'CONVERTER_UNAVAILABLE',
      }).converter).toBe('libreoffice')
    },
  )

  it('public view rejects arbitrary raw reason and converter fields', () => {
    const view = { artifactId: '00000000-0000-4000-8000-000000000441', status: 'failed',
      sourceSha256: SHA, converter: 'libreoffice', failureReason: 'CONVERT_FAILED',
      mediaType: null, byteSize: null, updatedAt: '2026-10-26T00:00:00.000Z' }
    expect(ArtifactPreviewViewSchema.safeParse({ ...view, converter: PRIVATE_DETAIL }).success).toBe(false)
    expect(ArtifactPreviewViewSchema.safeParse({ ...view, failureReason: PRIVATE_DETAIL }).success).toBe(false)
  })
})
