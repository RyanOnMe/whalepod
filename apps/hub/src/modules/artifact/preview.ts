/**
 * Office 只读 PDF 预览（#431；ADR-0021 §2「预览绑定」）。
 *
 * - 派生件由产出原件的设备上传；`sourceSha256` 必须等于不可变的 Artifact
 *   sha256，防止旧预览/错文件挂到新版本。
 * - 预览权限永远继承原件：候选只有拥有者能看，发布后才是团队读面；这里不建立
 *   第二条授权路径。
 * - ready 不降级：已成功的预览不会因为一次迟到的失败上报变成 failed；failed
 *   可以在重转换后覆盖为 ready。
 * - 转换失败只登记失败原因，不改变 Artifact 状态，也不阻止原件下载。
 */
import { asUserId, authorize } from '@whalepod/domain'
import type { Actor } from '@whalepod/domain'
import type { ArtifactRow, Database, DbHandle } from '@whalepod/db'
import {
  appendTeamEvent,
  getArtifact,
  getArtifactPreview,
  getRun,
  schema,
  upsertArtifactPreviewFailed,
  upsertArtifactPreviewReady,
  type ArtifactPreviewRow,
} from '@whalepod/db'
import {
  ARTIFACT_PREVIEW_MAX_BYTES,
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

/** 只有产出该原件的设备可以写它的派生预览；其他设备与不存在同作 404。 */
async function requireDeviceArtifact(
  database: Database,
  deviceId: string,
  artifactId: string,
): Promise<ArtifactRow> {
  const artifact = await getArtifact(database.db, artifactId.toLowerCase())
  if (artifact === undefined) throw new ApiError(404, 'NOT_FOUND', 'artifact not found')
  const run = await getRun(database.db, artifact.runId)
  if (run === undefined || run.deviceId !== deviceId) {
    throw new ApiError(404, 'NOT_FOUND', 'artifact not found')
  }
  return artifact
}

/** 事务内复验：锁原件行后，设备归属与 source digest 仍必须成立。 */
async function lockDeviceArtifact(
  tx: DbHandle,
  deviceId: string,
  artifactId: string,
  sourceSha256: string,
): Promise<ArtifactRow> {
  const [artifact] = await tx
    .select()
    .from(schema.artifacts)
    .where(eq(schema.artifacts.id, artifactId))
    .for('update')
  if (artifact === undefined) throw new ApiError(404, 'NOT_FOUND', 'artifact not found')
  const run = await getRun(tx, artifact.runId)
  if (run === undefined || run.deviceId !== deviceId) {
    throw new ApiError(404, 'NOT_FOUND', 'artifact not found')
  }
  if (artifact.sha256 !== sourceSha256) {
    throw new ApiError(409, 'CONFLICT', '预览绑定的原件摘要与当前版本不一致')
  }
  return artifact
}

function toPreviewView(
  artifactId: string,
  row: ArtifactPreviewRow | undefined,
): ArtifactPreviewView {
  if (row === undefined) {
    return {
      artifactId,
      status: 'none',
      sourceSha256: null,
      converter: null,
      mediaType: null,
      byteSize: null,
      failureReason: null,
      updatedAt: null,
    }
  }
  return {
    artifactId,
    status: row.status,
    sourceSha256: row.sourceSha256,
    converter: row.converter,
    mediaType: row.mediaType,
    byteSize: row.byteSize,
    failureReason: row.failureReason,
    updatedAt: row.updatedAt.toISOString(),
  }
}

async function appendPreviewChanged(
  handle: DbHandle,
  artifact: ArtifactRow,
  status: 'ready' | 'failed',
): Promise<void> {
  // 候选只有拥有者可见：不产生团队事件（与 candidate 上传同一防泄漏口径）。
  if (artifact.status !== 'published') return
  await appendTeamEvent(handle, {
    type: 'artifact.changed',
    payload: {
      artifactId: artifact.id,
      taskId: artifact.taskId,
      runId: artifact.runId,
      status: artifact.status,
      change: 'preview',
      previewStatus: status,
    },
  })
}

export async function recordArtifactPreview(
  database: Database,
  store: ArtifactStore,
  binding: PreviewSourceBinding,
  metadata: ArtifactPreviewUploadMetadata,
  bytes: Uint8Array,
): Promise<ArtifactPreviewView> {
  const artifact = await requireDeviceArtifact(database, binding.deviceId, binding.artifactId)
  if (artifact.sha256 !== metadata.sourceSha256) {
    throw new ApiError(409, 'CONFLICT', '预览绑定的原件摘要与当前版本不一致')
  }
  const existing = await getArtifactPreview(database.db, artifact.id)
  if (existing?.status === 'ready') {
    if (existing.sourceSha256 !== metadata.sourceSha256) {
      throw new ApiError(409, 'CONFLICT', '该原件已有绑定其他版本的预览')
    }
    // 重试幂等：首次成功的预览就是稳定阅读副本，不再随重试替换。
    return toPreviewView(artifact.id, existing)
  }
  if (bytes.byteLength > ARTIFACT_PREVIEW_MAX_BYTES) {
    throw new ApiError(413, 'ARTIFACT_TOO_LARGE', 'preview content exceeds the size limit')
  }
  const blob = await store.saveUpload(metadata.sha256, bytes)
  return database.transaction(async (tx) => {
    const locked = await lockDeviceArtifact(
      tx,
      binding.deviceId,
      binding.artifactId,
      metadata.sourceSha256,
    )
    const current = await getArtifactPreview(tx, locked.id)
    if (current?.status === 'ready') {
      if (current.sourceSha256 !== metadata.sourceSha256) {
        throw new ApiError(409, 'CONFLICT', '该原件已有绑定其他版本的预览')
      }
      return toPreviewView(locked.id, current)
    }
    const row = await upsertArtifactPreviewReady(tx, {
      artifactId: locked.id,
      sourceSha256: metadata.sourceSha256,
      converter: metadata.converter,
      storageKey: blob.storageKey,
      sha256: blob.sha256,
      byteSize: blob.byteSize,
    })
    await appendPreviewChanged(tx, locked, 'ready')
    return toPreviewView(locked.id, row)
  })
}

export async function recordArtifactPreviewFailure(
  database: Database,
  binding: PreviewSourceBinding,
  request: ArtifactPreviewFailureRequest,
): Promise<ArtifactPreviewView> {
  const artifact = await requireDeviceArtifact(database, binding.deviceId, binding.artifactId)
  if (artifact.sha256 !== request.sourceSha256) {
    throw new ApiError(409, 'CONFLICT', '预览绑定的原件摘要与当前版本不一致')
  }
  return database.transaction(async (tx) => {
    const locked = await lockDeviceArtifact(
      tx,
      binding.deviceId,
      binding.artifactId,
      request.sourceSha256,
    )
    const current = await getArtifactPreview(tx, locked.id)
    if (current?.status === 'ready') {
      if (current.sourceSha256 !== request.sourceSha256) {
        throw new ApiError(409, 'CONFLICT', '该原件已有绑定其他版本的预览')
      }
      return toPreviewView(locked.id, current)
    }
    const row = await upsertArtifactPreviewFailed(tx, {
      artifactId: locked.id,
      sourceSha256: request.sourceSha256,
      converter: request.converter,
      reason: request.reason,
    })
    await appendPreviewChanged(tx, locked, 'failed')
    return toPreviewView(locked.id, row)
  })
}

/** 可读原件即可读预览信息；不可见与不存在同作 404（不泄漏候选）。 */
export async function getArtifactPreviewInfo(
  handle: DbHandle,
  actor: Actor,
  artifactId: string,
): Promise<ArtifactPreviewView> {
  const artifact = await getArtifact(handle, artifactId.toLowerCase())
  if (artifact === undefined) throw new ApiError(404, 'NOT_FOUND', 'artifact not found')
  const allowed = authorize(
    { userId: asUserId(actor.userId), role: actor.role },
    'read_artifact_content',
    { ownerUserId: asUserId(artifact.ownerUserId), artifactStatus: artifact.status },
  )
  if (!allowed) throw new ApiError(404, 'NOT_FOUND', 'artifact not found')
  const row = await getArtifactPreview(handle, artifact.id)
  return toPreviewView(artifact.id, row)
}

export interface ReadablePreview {
  readonly bytes: Buffer
  readonly row: ArtifactPreviewRow
}

/** 读 PDF 字节；权限与原件相同，没有 ready 预览时明确返回 PREVIEW_UNAVAILABLE。 */
export async function readArtifactPreview(
  handle: DbHandle,
  store: ArtifactStore,
  actor: Actor,
  artifactId: string,
): Promise<ReadablePreview> {
  const artifact = await getArtifact(handle, artifactId.toLowerCase())
  if (artifact === undefined) throw new ApiError(404, 'NOT_FOUND', 'artifact not found')
  const allowed = authorize(
    { userId: asUserId(actor.userId), role: actor.role },
    'read_artifact_content',
    { ownerUserId: asUserId(artifact.ownerUserId), artifactStatus: artifact.status },
  )
  if (!allowed) throw new ApiError(404, 'NOT_FOUND', 'artifact not found')
  const row = await getArtifactPreview(handle, artifact.id)
  if (
    row === undefined ||
    row.status !== 'ready' ||
    row.storageKey === null ||
    row.sha256 === null
  ) {
    throw new ApiError(404, 'PREVIEW_UNAVAILABLE', '该交付物没有可用的只读预览，请下载原件')
  }
  const bytes = await store.readVerified(row.storageKey, row.sha256)
  return { bytes, row }
}
