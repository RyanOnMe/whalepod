/**
 * Artifact 命令面（P1-15；03 §3.4 状态机、§4 权限表）。
 *
 * publish：事务内（行锁）→ 存在性 → authorize(publish_artifact)（仅 Run owner，
 * G6-05）→ transitionArtifact（candidate→published，非法边抛
 * INVALID_ARTIFACT_TRANSITION）→ 落库 → artifact.changed Team Event（03 §3.4：
 * 发布不自动完成 Task，只产生发布事件；candidate 不发事件——不泄漏给其他成员）。
 */
import { eq } from 'drizzle-orm'
import { asUserId, authorize, transitionArtifact } from '@project311/domain'
import { appendTeamEvent, getArtifact, schema, setArtifactStatus } from '@project311/db'
import type { Database, Tx } from '@project311/db'
import type { ArtifactRow } from '@project311/db'
import { ApiError } from '../shared/http-error.js'

export interface PublishArtifactInput {
  readonly artifactId: string
  readonly actorUserId: string
  readonly actorRole: 'owner' | 'admin' | 'member'
}

export async function publishArtifact(
  database: Database,
  input: PublishArtifactInput,
): Promise<ArtifactRow> {
  return database.transaction(async (tx: Tx) => {
    const [row] = await tx
      .select()
      .from(schema.artifacts)
      .where(eq(schema.artifacts.id, input.artifactId))
      .for('update')
    if (row === undefined) throw new ApiError(404, 'NOT_FOUND', 'artifact not found')
    const allowed = authorize(
      { userId: asUserId(input.actorUserId), role: input.actorRole },
      'publish_artifact',
      { ownerUserId: asUserId(row.ownerUserId) },
    )
    if (!allowed) {
      throw new ApiError(403, 'FORBIDDEN', 'only the run owner can publish this artifact')
    }
    // 非法边（published/rejected 再发布）→ DomainError INVALID_ARTIFACT_TRANSITION
    // → app 级错误处理映射 409（03 §10）。
    transitionArtifact({ status: row.status }, { type: 'publish' })
    const updated = await setArtifactStatus(tx, row.id, 'published', new Date())
    if (updated === undefined) throw new ApiError(404, 'NOT_FOUND', 'artifact not found')
    await appendTeamEvent(tx, {
      type: 'artifact.changed',
      payload: {
        artifactId: updated.id,
        taskId: updated.taskId,
        runId: updated.runId,
        status: 'published',
      },
    })
    return updated
  })
}

/** 元数据守卫视图（下载/manifest 共用）：不存在的行折叠成同一 404。 */
export async function requireArtifactRow(
  database: Database,
  artifactId: string,
): Promise<ArtifactRow> {
  const row = await getArtifact(database.db, artifactId)
  if (row === undefined) throw new ApiError(404, 'NOT_FOUND', 'artifact not found')
  return row
}
