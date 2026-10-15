import { and, asc, eq, inArray } from 'drizzle-orm'
import { schema, type RunRow, type Tx } from '@whalepod/db'
import {
  ArtifactInputManifestSchema,
  ARTIFACT_INPUT_MANIFEST_MAX_ENTRIES,
  type ArtifactInputManifest,
} from '@whalepod/protocol'
import { toManifestEntry } from '../artifact/queries.js'
import { RunCommandError } from './errors.js'

/** Caller owns the Task lock. One published query fixes the input set before any dispatch. */
export async function snapshotRunInputs(
  tx: Tx,
  taskId: string,
  selectedIds: string[] | undefined,
  source?: RunRow,
): Promise<ArtifactInputManifest> {
  // PostgreSQL UUID identities are case insensitive and are returned in lowercase.
  // Internal command callers also pass through here, beyond HTTP schema normalization.
  const ids = selectedIds?.map((id) => id.toLowerCase())
  if (ids === undefined && source !== undefined) {
    if (source.artifactInputManifest === null)
      throw new RunCommandError(
        'CONFLICT',
        '来源执行的历史输入无法确认；请明确选择本次材料或开始新执行',
      )
    const pinned = ArtifactInputManifestSchema.parse(source.artifactInputManifest)
    if (pinned.taskId !== taskId)
      throw new RunCommandError('CONFLICT', 'source input task mismatch')
    return pinned
  }
  if (ids?.length === 0) return { taskId, artifacts: [] }
  const rows = await tx
    .select()
    .from(schema.artifacts)
    .where(
      and(
        eq(schema.artifacts.taskId, taskId),
        eq(schema.artifacts.status, 'published'),
        ...(ids === undefined ? [] : [inArray(schema.artifacts.id, ids)]),
      ),
    )
    .orderBy(asc(schema.artifacts.createdAt), asc(schema.artifacts.id))
    .limit(ARTIFACT_INPUT_MANIFEST_MAX_ENTRIES + 1)
  if (rows.length > ARTIFACT_INPUT_MANIFEST_MAX_ENTRIES)
    throw new RunCommandError(
      'ARTIFACT_INPUT_MANIFEST_TOO_LARGE',
      '已发布材料超过64项，请明确选择本次输入',
    )
  if (ids !== undefined && rows.length !== ids.length)
    throw new RunCommandError('NOT_FOUND', '所选材料不在本任务的已发布交付物中')
  const byId = new Map(rows.map((row) => [row.id, row]))
  return ArtifactInputManifestSchema.parse({
    taskId,
    artifacts: (ids === undefined ? rows : ids.map((id) => byId.get(id)!)).map(toManifestEntry),
  })
}

/** NULL is unknown history, not permission to substitute current Task materials. */
export function savedRunInputs(run: RunRow): ArtifactInputManifest | null {
  if (run.artifactInputManifest === null) return null
  const manifest = ArtifactInputManifestSchema.parse(run.artifactInputManifest)
  if (manifest.taskId !== run.taskId)
    throw new RunCommandError('CONFLICT', 'saved input task mismatch')
  return manifest
}
