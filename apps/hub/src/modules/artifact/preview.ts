/**
 * Office preview safety suspension (ADR-0023).
 * Raw converters may include files or URLs outside the run's workspace. No existing
 * preview has verifiable isolation provenance, so new uploads and all PDF reads are
 * disabled. Original artifact permission checks still run; historical rows are retained.
 */
import { asUserId, authorize, type Actor } from '@whalepod/domain'
import type { ArtifactRow, ArtifactPreviewRow, Database, DbHandle } from '@whalepod/db'
import {
  appendTeamEvent,
  getArtifact,
  getArtifactPreview,
  getRun,
  schema,
  transactCommand,
  upsertArtifactPreviewFailed,
} from '@whalepod/db'
import {
  normalizeArtifactPreviewConverter,
  normalizeArtifactPreviewFailureCode,
  type ArtifactPreviewFailureRequest,
  type ArtifactPreviewUploadMetadata,
  type ArtifactPreviewView,
} from '@whalepod/protocol'
import { eq } from 'drizzle-orm'
import { ApiError } from '../shared/http-error.js'
import type { ArtifactStore } from './store.js'

export interface PreviewSourceBinding {
  readonly deviceId: string
  readonly artifactId: string
}

function isolationView(artifact: ArtifactRow): ArtifactPreviewView {
  return {
    artifactId: artifact.id,
    status: 'failed',
    sourceSha256: artifact.sha256,
    converter: 'unknown',
    mediaType: null,
    byteSize: null,
    failureReason: 'ISOLATION_REQUIRED',
    updatedAt: null,
  }
}

async function requireDeviceArtifact(
  database: Database,
  deviceId: string,
  artifactId: string,
): Promise<ArtifactRow> {
  const artifact = await getArtifact(database.db, artifactId.toLowerCase())
  if (artifact === undefined) throw new ApiError(404, 'NOT_FOUND', 'artifact not found')
  const run = await getRun(database.db, artifact.runId)
  if (run === undefined || run.deviceId !== deviceId)
    throw new ApiError(404, 'NOT_FOUND', 'artifact not found')
  return artifact
}

async function readableArtifact(
  handle: DbHandle,
  actor: Actor,
  artifactId: string,
): Promise<ArtifactRow> {
  const artifact = await getArtifact(handle, artifactId.toLowerCase())
  if (
    artifact === undefined ||
    !authorize({ userId: asUserId(actor.userId), role: actor.role }, 'read_artifact_content', {
      ownerUserId: asUserId(artifact.ownerUserId),
      artifactStatus: artifact.status,
    })
  )
    throw new ApiError(404, 'NOT_FOUND', 'artifact not found')
  return artifact
}

function assertSource(artifact: ArtifactRow, sourceSha256: string): void {
  if (artifact.sha256 !== sourceSha256)
    throw new ApiError(409, 'CONFLICT', '预览绑定的原件摘要与当前版本不一致')
}

/** Reject before blob writes or command receipt replay, including legacy successful receipts. */
export async function recordArtifactPreview(
  database: Database,
  _store: ArtifactStore,
  binding: PreviewSourceBinding,
  metadata: ArtifactPreviewUploadMetadata,
  _bytes: Uint8Array,
  _idempotencyKey: string,
): Promise<ArtifactPreviewView> {
  const artifact = await requireDeviceArtifact(database, binding.deviceId, binding.artifactId)
  assertSource(artifact, metadata.sourceSha256)
  throw new ApiError(409, 'PREVIEW_UNAVAILABLE', 'Office 隔离转换尚未开放，请下载原件查看并批注。')
}

/** Keep stable diagnostics only, without replacing historical ready rows or exposing their bytes. */
export async function recordArtifactPreviewFailure(
  database: Database,
  binding: PreviewSourceBinding,
  request: ArtifactPreviewFailureRequest,
  idempotencyKey: string,
): Promise<ArtifactPreviewView> {
  const artifact = await requireDeviceArtifact(database, binding.deviceId, binding.artifactId)
  assertSource(artifact, request.sourceSha256)
  await transactCommand(
    database,
    `artifact.preview.failed:${binding.deviceId}:${artifact.id}:${idempotencyKey}`,
    async (tx) => {
      const [locked] = await tx
        .select()
        .from(schema.artifacts)
        .where(eq(schema.artifacts.id, artifact.id))
        .for('update')
      if (locked === undefined) throw new ApiError(404, 'NOT_FOUND', 'artifact not found')
      const run = await getRun(tx, locked.runId)
      if (run === undefined || run.deviceId !== binding.deviceId)
        throw new ApiError(404, 'NOT_FOUND', 'artifact not found')
      assertSource(locked, request.sourceSha256)
      const current = await getArtifactPreview(tx, locked.id)
      // Preserve historical data: suspension is a read/write policy, not a destructive migration.
      if (current?.status === 'ready') return { artifactId: locked.id }
      await upsertArtifactPreviewFailed(tx, {
        artifactId: locked.id,
        sourceSha256: request.sourceSha256,
        converter: normalizeArtifactPreviewConverter(request.converter),
        reason: normalizeArtifactPreviewFailureCode(request.reason),
      })
      if (locked.status === 'published')
        await appendTeamEvent(tx, {
          type: 'artifact.changed',
          payload: {
            artifactId: locked.id,
            taskId: locked.taskId,
            runId: locked.runId,
            status: locked.status,
            change: 'preview',
            previewStatus: 'failed',
          },
        })
      return { artifactId: locked.id }
    },
  )
  // Deliberately ignore cached result data: old receipts may contain unisolated ready metadata.
  return isolationView(artifact)
}

export async function getArtifactPreviewInfo(
  handle: DbHandle,
  actor: Actor,
  artifactId: string,
): Promise<ArtifactPreviewView> {
  return isolationView(await readableArtifact(handle, actor, artifactId))
}

export interface ReadablePreview {
  readonly bytes: Buffer
  readonly row: ArtifactPreviewRow
}

/** An authorized caller still cannot read historical or newly supplied unisolated PDF bytes. */
export async function readArtifactPreview(
  handle: DbHandle,
  _store: ArtifactStore,
  actor: Actor,
  artifactId: string,
): Promise<ReadablePreview> {
  await readableArtifact(handle, actor, artifactId)
  throw new ApiError(404, 'PREVIEW_UNAVAILABLE', 'Office 隔离转换尚未开放，请下载原件查看并批注。')
}
