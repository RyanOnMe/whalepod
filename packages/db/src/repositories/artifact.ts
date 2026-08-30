import { and, asc, count, eq } from 'drizzle-orm'
import type { DbHandle } from '../client.js'
import { artifacts } from '../schema/artifact.js'

export type ArtifactRow = typeof artifacts.$inferSelect

export interface NewArtifact {
  id: string
  taskId: string
  runId: string
  ownerUserId: string
  title: string
  mediaType: string
  /** 0–52,428,800（50 MiB），CHECK 兜底；超限在 Hub 先报 ARTIFACT_TOO_LARGE。 */
  byteSize: number
  sha256: string
  storageKey: string
  sourceRelativePath?: string
}

export async function insertArtifact(
  handle: DbHandle,
  artifact: NewArtifact,
): Promise<ArtifactRow> {
  const [row] = await handle.insert(artifacts).values(artifact).returning()
  if (row === undefined) throw new Error('insert artifact returned no row')
  return row
}

export async function getArtifact(handle: DbHandle, id: string): Promise<ArtifactRow | undefined> {
  const [row] = await handle.select().from(artifacts).where(eq(artifacts.id, id)).limit(1)
  return row
}

/**
 * 终态迁移（03 §3.4：candidate -> published | rejected）。
 * 合法性由 Hub 经 domain.transitionArtifact 判定后调用；这里只落库。
 */
export async function setArtifactStatus(
  handle: DbHandle,
  id: string,
  status: 'published' | 'rejected',
  publishedAt?: Date,
): Promise<ArtifactRow | undefined> {
  const [row] = await handle
    .update(artifacts)
    .set(status === 'published' ? { status, publishedAt: publishedAt ?? new Date() } : { status })
    .where(eq(artifacts.id, id))
    .returning()
  return row
}

/** Task 的全部 Artifact（Task Room 聚合用；按创建时间）。 */
export async function listArtifactsByTask(
  handle: DbHandle,
  taskId: string,
): Promise<ArtifactRow[]> {
  return handle
    .select()
    .from(artifacts)
    .where(eq(artifacts.taskId, taskId))
    .orderBy(asc(artifacts.createdAt))
}

/** Task 是否已有至少一个 published Artifact（submit-review 守卫，03 §3.1）。 */
export async function hasPublishedArtifactByTask(
  handle: DbHandle,
  taskId: string,
): Promise<boolean> {
  const [row] = await handle
    .select({ value: count() })
    .from(artifacts)
    .where(and(eq(artifacts.taskId, taskId), eq(artifacts.status, 'published')))
  return (row?.value ?? 0) > 0
}

/** Task 的已发布 Artifact（Reviewer 输入 manifest 源，P1-15；按创建时间）。 */
export async function listPublishedArtifactsByTask(
  handle: DbHandle,
  taskId: string,
): Promise<ArtifactRow[]> {
  return handle
    .select()
    .from(artifacts)
    .where(and(eq(artifacts.taskId, taskId), eq(artifacts.status, 'published')))
    .orderBy(asc(artifacts.createdAt))
}
