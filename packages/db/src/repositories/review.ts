/**
 * 交付物审阅仓库（#429；ADR-0021 §2）：批注线程与审阅邀请。
 *
 * 只做持久化；权限、可见性、锚点内容校验在 Hub 命令层。批注按版本不可变：
 * 没有 update/delete 入口。
 */
import type { ArtifactCommentAnchor } from '@whalepod/protocol'
import { and, asc, count, eq } from 'drizzle-orm'
import type { DbHandle } from '../client.js'
import { artifactComments, artifactReviewInvitations } from '../schema/review.js'

export type ArtifactCommentRow = typeof artifactComments.$inferSelect
export type ArtifactReviewInvitationRow = typeof artifactReviewInvitations.$inferSelect

export interface NewArtifactComment {
  id: string
  artifactId: string
  authorUserId: string
  parentCommentId?: string
  kind: 'whole' | 'text'
  anchor: ArtifactCommentAnchor | null
  body: string
  createdAt?: Date
}

export async function insertArtifactComment(
  handle: DbHandle,
  input: NewArtifactComment,
): Promise<ArtifactCommentRow> {
  const [row] = await handle
    .insert(artifactComments)
    .values({
      id: input.id,
      artifactId: input.artifactId,
      authorUserId: input.authorUserId,
      ...(input.parentCommentId === undefined ? {} : { parentCommentId: input.parentCommentId }),
      kind: input.kind,
      anchor: input.anchor,
      body: input.body,
      ...(input.createdAt === undefined ? {} : { createdAt: input.createdAt }),
    })
    .returning()
  if (row === undefined) throw new Error('insert artifact comment returned no row')
  return row
}

export async function getArtifactComment(
  handle: DbHandle,
  id: string,
): Promise<ArtifactCommentRow | undefined> {
  const [row] = await handle
    .select()
    .from(artifactComments)
    .where(eq(artifactComments.id, id))
    .limit(1)
  return row
}

export async function listArtifactComments(
  handle: DbHandle,
  artifactId: string,
): Promise<ArtifactCommentRow[]> {
  return handle
    .select()
    .from(artifactComments)
    .where(eq(artifactComments.artifactId, artifactId))
    .orderBy(asc(artifactComments.createdAt), asc(artifactComments.id))
}

export async function countArtifactCommentsByAuthor(
  handle: DbHandle,
  artifactId: string,
  authorUserId: string,
): Promise<number> {
  const [row] = await handle
    .select({ value: count() })
    .from(artifactComments)
    .where(
      and(
        eq(artifactComments.artifactId, artifactId),
        eq(artifactComments.authorUserId, authorUserId),
      ),
    )
  return row?.value ?? 0
}

export interface NewArtifactReviewInvitation {
  id: string
  artifactId: string
  inviterUserId: string
  reviewerUserId: string
  focus?: string
  createdAt?: Date
}

/** 每人每版本一条：(artifact_id, reviewer_user_id) 冲突时返回既有行。 */
export async function insertArtifactReviewInvitationIfAbsent(
  handle: DbHandle,
  input: NewArtifactReviewInvitation,
): Promise<{ row: ArtifactReviewInvitationRow; inserted: boolean }> {
  const [inserted] = await handle
    .insert(artifactReviewInvitations)
    .values({
      id: input.id,
      artifactId: input.artifactId,
      inviterUserId: input.inviterUserId,
      reviewerUserId: input.reviewerUserId,
      ...(input.focus === undefined ? {} : { focus: input.focus }),
      ...(input.createdAt === undefined ? {} : { createdAt: input.createdAt }),
    })
    .onConflictDoNothing({
      target: [artifactReviewInvitations.artifactId, artifactReviewInvitations.reviewerUserId],
    })
    .returning()
  if (inserted !== undefined) return { row: inserted, inserted: true }
  const existing = await getArtifactReviewInvitation(handle, input.artifactId, input.reviewerUserId)
  if (existing === undefined) throw new Error('invitation conflict without an existing row')
  return { row: existing, inserted: false }
}

export async function getArtifactReviewInvitation(
  handle: DbHandle,
  artifactId: string,
  reviewerUserId: string,
): Promise<ArtifactReviewInvitationRow | undefined> {
  const [row] = await handle
    .select()
    .from(artifactReviewInvitations)
    .where(
      and(
        eq(artifactReviewInvitations.artifactId, artifactId),
        eq(artifactReviewInvitations.reviewerUserId, reviewerUserId),
      ),
    )
    .limit(1)
  return row
}

export async function getArtifactReviewInvitationById(
  handle: DbHandle,
  id: string,
): Promise<ArtifactReviewInvitationRow | undefined> {
  const [row] = await handle
    .select()
    .from(artifactReviewInvitations)
    .where(eq(artifactReviewInvitations.id, id))
    .limit(1)
  return row
}

export async function listArtifactReviewInvitations(
  handle: DbHandle,
  artifactId: string,
): Promise<ArtifactReviewInvitationRow[]> {
  return handle
    .select()
    .from(artifactReviewInvitations)
    .where(eq(artifactReviewInvitations.artifactId, artifactId))
    .orderBy(asc(artifactReviewInvitations.createdAt), asc(artifactReviewInvitations.id))
}

/** 提交本轮意见（含再次追加后的提交）：pending → submitted，或刷新提交时刻。 */
export async function markArtifactReviewInvitationSubmitted(
  handle: DbHandle,
  id: string,
  submittedAt: Date,
): Promise<ArtifactReviewInvitationRow | undefined> {
  const [row] = await handle
    .update(artifactReviewInvitations)
    .set({ status: 'submitted', submittedAt })
    .where(eq(artifactReviewInvitations.id, id))
    .returning()
  return row
}
