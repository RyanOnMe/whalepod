/**
 * 派生预览仓库（#431；ADR-0021 §2）。
 *
 * 只做持久化；原件可见性、设备归属、source sha 绑定与「ready 不降级为 failed」
 * 都在 Hub 命令层判定。一件原件至多一行：重转换覆盖同一行。
 */
import { eq } from 'drizzle-orm'
import type { DbHandle } from '../client.js'
import { artifactPreviews } from '../schema/preview.js'

export type ArtifactPreviewRow = typeof artifactPreviews.$inferSelect

export async function getArtifactPreview(
  handle: DbHandle,
  artifactId: string,
): Promise<ArtifactPreviewRow | undefined> {
  const [row] = await handle
    .select()
    .from(artifactPreviews)
    .where(eq(artifactPreviews.artifactId, artifactId))
    .limit(1)
  return row
}

export interface ReadyArtifactPreviewInput {
  artifactId: string
  sourceSha256: string
  converter: string
  storageKey: string
  sha256: string
  byteSize: number
  updatedAt?: Date
}

export async function upsertArtifactPreviewReady(
  handle: DbHandle,
  input: ReadyArtifactPreviewInput,
): Promise<ArtifactPreviewRow> {
  const [row] = await handle
    .insert(artifactPreviews)
    .values({
      artifactId: input.artifactId,
      status: 'ready',
      sourceSha256: input.sourceSha256,
      converter: input.converter,
      storageKey: input.storageKey,
      sha256: input.sha256,
      byteSize: input.byteSize,
      mediaType: 'application/pdf',
      failureReason: null,
      ...(input.updatedAt === undefined ? {} : { updatedAt: input.updatedAt }),
    })
    .onConflictDoUpdate({
      target: artifactPreviews.artifactId,
      set: {
        status: 'ready',
        sourceSha256: input.sourceSha256,
        converter: input.converter,
        storageKey: input.storageKey,
        sha256: input.sha256,
        byteSize: input.byteSize,
        mediaType: 'application/pdf',
        failureReason: null,
        updatedAt: input.updatedAt ?? new Date(),
      },
    })
    .returning()
  if (row === undefined) throw new Error('upsert artifact preview returned no row')
  return row
}

export interface FailedArtifactPreviewInput {
  artifactId: string
  sourceSha256: string
  converter: string
  reason: string
  updatedAt?: Date
}

export async function upsertArtifactPreviewFailed(
  handle: DbHandle,
  input: FailedArtifactPreviewInput,
): Promise<ArtifactPreviewRow> {
  const [row] = await handle
    .insert(artifactPreviews)
    .values({
      artifactId: input.artifactId,
      status: 'failed',
      sourceSha256: input.sourceSha256,
      converter: input.converter,
      storageKey: null,
      sha256: null,
      byteSize: null,
      mediaType: null,
      failureReason: input.reason,
      ...(input.updatedAt === undefined ? {} : { updatedAt: input.updatedAt }),
    })
    .onConflictDoUpdate({
      target: artifactPreviews.artifactId,
      set: {
        status: 'failed',
        sourceSha256: input.sourceSha256,
        converter: input.converter,
        storageKey: null,
        sha256: null,
        byteSize: null,
        mediaType: null,
        failureReason: input.reason,
        updatedAt: input.updatedAt ?? new Date(),
      },
    })
    .returning()
  if (row === undefined) throw new Error('upsert artifact preview returned no row')
  return row
}
