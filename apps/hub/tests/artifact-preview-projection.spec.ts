/** Legacy rows/receipts are mocked at the repository seam; no runtime state is forged. */
import { asUserId } from '@whalepod/domain'
import type { Database, DbHandle } from '@whalepod/db'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  getArtifactPreviewInfo,
  readArtifactPreview,
  recordArtifactPreview,
  recordArtifactPreviewFailure,
} from '../src/modules/artifact/preview.js'
import type { ArtifactStore } from '../src/modules/artifact/store.js'

const reads = vi.hoisted(() => ({
  artifact: vi.fn(),
  run: vi.fn(),
  preview: vi.fn(),
  transact: vi.fn(),
  failed: vi.fn(),
}))
vi.mock('@whalepod/db', () => ({
  getArtifact: reads.artifact,
  getRun: reads.run,
  getArtifactPreview: reads.preview,
  transactCommand: reads.transact,
  appendTeamEvent: vi.fn(),
  schema: { artifacts: { id: 'artifact-id' } },
  upsertArtifactPreviewFailed: reads.failed,
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
    expect(view).toMatchObject({ converter: 'unknown', failureReason: 'ISOLATION_REQUIRED' })
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
    expect(view).toMatchObject({ converter: 'unknown', failureReason: 'ISOLATION_REQUIRED' })
    expect(JSON.stringify(view)).not.toContain(PRIVATE_DETAIL)
  })
})

describe('preview isolation suspension includes historical data', () => {
  it('does not expose any legacy ready PDF or its metadata', async () => {
    reads.preview.mockResolvedValue({
      ...row,
      status: 'ready',
      failureReason: null,
      mediaType: 'application/pdf',
      byteSize: 5,
      storageKey: 'safe',
      sha256: SHA,
    })
    const view = await getArtifactPreviewInfo(
      {} as DbHandle,
      { userId: asUserId(ID), role: 'member' },
      ID,
    )
    expect(view).toMatchObject({
      status: 'failed',
      sourceSha256: SHA,
      converter: 'unknown',
      failureReason: 'ISOLATION_REQUIRED',
      mediaType: null,
      byteSize: null,
      updatedAt: null,
    })
    const store = {
      readVerified: vi.fn().mockResolvedValue(Buffer.from('%PDF-')),
    } as unknown as ArtifactStore
    await expect(
      readArtifactPreview({} as DbHandle, store, { userId: asUserId(ID), role: 'member' }, ID),
    ).rejects.toMatchObject({ code: 'PREVIEW_UNAVAILABLE' })
    expect(store.readVerified).not.toHaveBeenCalled()
  })
  it('rejects old ready command receipts before storing or replaying unisolated bytes', async () => {
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
    await expect(
      recordArtifactPreview(
        database,
        store,
        { deviceId: ID, artifactId: ID },
        { sourceSha256: SHA, sha256: SHA, byteSize: 5, converter: 'libreoffice' },
        Buffer.from('%PDF-'),
        'old-key',
      ),
    ).rejects.toMatchObject({ code: 'PREVIEW_UNAVAILABLE' })
    expect(store.saveUpload).not.toHaveBeenCalled()
    expect(reads.transact).not.toHaveBeenCalled()
  })
})

it('retains a historical ready record when a failure report arrives during suspension', async () => {
  const artifact = { id: ID, runId: ID, ownerUserId: ID, status: 'published', sha256: SHA }
  const oldReady = {
    ...row,
    status: 'ready',
    failureReason: null,
    mediaType: 'application/pdf',
    byteSize: 5,
    storageKey: 'old-pdf',
    sha256: SHA,
  }
  reads.preview.mockResolvedValue(oldReady)
  reads.transact.mockImplementation(
    async (_database: unknown, _key: string, work: (tx: DbHandle) => Promise<unknown>) =>
      work({
        select: () => ({ from: () => ({ where: () => ({ for: async () => [artifact] }) }) }),
      } as unknown as DbHandle),
  )
  const view = await recordArtifactPreviewFailure(
    database,
    { deviceId: ID, artifactId: ID },
    { sourceSha256: SHA, converter: 'unknown', reason: 'ISOLATION_REQUIRED' },
    'new-key',
  )
  expect(view).toMatchObject({ status: 'failed', failureReason: 'ISOLATION_REQUIRED' })
  expect(reads.failed).not.toHaveBeenCalled()
  expect(oldReady).toMatchObject({ status: 'ready', storageKey: 'old-pdf', sha256: SHA })
})
