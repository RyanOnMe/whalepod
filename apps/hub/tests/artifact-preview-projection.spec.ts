/** Legacy rows/receipts are mocked at the repository seam; no runtime state is forged. */
import { asUserId } from '@whalepod/domain'
import type { Database, DbHandle } from '@whalepod/db'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  getArtifactPreviewInfo,
  recordArtifactPreview,
  recordArtifactPreviewFailure,
} from '../src/modules/artifact/preview.js'
import type { ArtifactStore } from '../src/modules/artifact/store.js'

const reads = vi.hoisted(() => ({
  artifact: vi.fn(),
  run: vi.fn(),
  preview: vi.fn(),
  transact: vi.fn(),
}))
vi.mock('@whalepod/db', () => ({
  getArtifact: reads.artifact,
  getRun: reads.run,
  getArtifactPreview: reads.preview,
  transactCommand: reads.transact,
  appendTeamEvent: vi.fn(),
  schema: {},
  upsertArtifactPreviewFailed: vi.fn(),
  upsertArtifactPreviewReady: vi.fn(),
}))

const ID = '00000000-0000-4000-8000-000000000441'
const SHA = 'a'.repeat(64)
const PRIVATE_DETAIL = 'workspace/private.docx credential=fixture-sensitive-value'
const database = { db: {} } as Database
const row = {
  artifactId: ID,
  status: 'failed',
  sourceSha256: SHA,
  converter: PRIVATE_DETAIL,
  failureReason: PRIVATE_DETAIL,
  mediaType: null,
  byteSize: null,
  updatedAt: new Date('2026-10-26T00:00:00.000Z'),
}
const oldReceipt = { ...row, updatedAt: row.updatedAt.toISOString() }
beforeEach(() => {
  vi.resetAllMocks()
  reads.artifact.mockResolvedValue({
    id: ID,
    runId: ID,
    ownerUserId: ID,
    status: 'published',
    sha256: SHA,
  })
  reads.run.mockResolvedValue({ deviceId: ID })
})

describe('preview legacy metadata disclosure', () => {
  it('normalizes old persisted diagnostics at the Session read boundary', async () => {
    reads.preview.mockResolvedValue(row)
    const view = await getArtifactPreviewInfo(
      {} as DbHandle,
      { userId: asUserId(ID), role: 'member' },
      ID,
    )
    expect(view).toMatchObject({ converter: 'unknown', failureReason: 'CONVERT_FAILED' })
    expect(JSON.stringify(view)).not.toContain(PRIVATE_DETAIL)
  })

  it('normalizes an old failed command receipt even when the command callback is skipped', async () => {
    reads.transact.mockResolvedValue(oldReceipt)
    const view = await recordArtifactPreviewFailure(
      database,
      { deviceId: ID, artifactId: ID },
      { sourceSha256: SHA, converter: 'libreoffice', reason: 'CONVERT_TIMEOUT' },
      'old-key',
    )
    expect(view).toMatchObject({ converter: 'unknown', failureReason: 'CONVERT_FAILED' })
    expect(JSON.stringify(view)).not.toContain(PRIVATE_DETAIL)
  })

  it('normalizes an old ready command receipt as well', async () => {
    reads.transact.mockResolvedValue({
      ...oldReceipt,
      status: 'ready',
      failureReason: null,
      mediaType: 'application/pdf',
      byteSize: 5,
    })
    const store = {
      saveUpload: vi.fn().mockResolvedValue({ storageKey: 'safe', sha256: SHA, byteSize: 5 }),
    } as unknown as ArtifactStore
    const view = await recordArtifactPreview(
      database,
      store,
      { deviceId: ID, artifactId: ID },
      { sourceSha256: SHA, sha256: SHA, byteSize: 5, converter: 'libreoffice' },
      Buffer.from('%PDF-'),
      'old-key',
    )
    expect(view).toMatchObject({ converter: 'unknown', failureReason: null })
    expect(JSON.stringify(view)).not.toContain(PRIVATE_DETAIL)
  })
})
