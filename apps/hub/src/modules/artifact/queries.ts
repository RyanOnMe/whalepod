/**
 * Artifact 视图与清单装配（P1-15）。
 *
 * 红线：REST 面与 manifest 一律不含 storageKey（内容寻址路径）与
 * sourceRelativePath（owner 本地工作区相对路径，03 §2.6）——owner 对来源路径
 * 的可见性只经由 Node→Hub 的 owner 受众 run_event（timeline）。
 */
import type { ArtifactRow } from '@project311/db'
import type { ArtifactManifestEntry } from '@project311/protocol'

export interface ArtifactView {
  readonly id: string
  readonly taskId: string
  readonly runId: string
  readonly ownerUserId: string
  readonly title: string
  readonly mediaType: string
  readonly byteSize: number
  readonly sha256: string
  readonly status: ArtifactRow['status']
  readonly createdAt: string
  readonly publishedAt: string | null
}

export function toArtifactView(row: ArtifactRow): ArtifactView {
  return {
    id: row.id,
    taskId: row.taskId,
    runId: row.runId,
    ownerUserId: row.ownerUserId,
    title: row.title,
    mediaType: row.mediaType,
    byteSize: Number(row.byteSize),
    sha256: row.sha256,
    status: row.status,
    createdAt: row.createdAt.toISOString(),
    publishedAt: row.publishedAt?.toISOString() ?? null,
  }
}

/** Reviewer 输入清单条目：内容寻址事实 + 展示元数据，无任何本地路径。 */
export function toManifestEntry(row: ArtifactRow): ArtifactManifestEntry {
  return {
    artifactId: row.id,
    runId: row.runId,
    title: row.title,
    mediaType: row.mediaType,
    byteSize: Number(row.byteSize),
    sha256: row.sha256,
    publishedAt: row.publishedAt?.toISOString() ?? '',
  }
}
