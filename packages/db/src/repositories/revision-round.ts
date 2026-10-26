/**
 * 交付物修订批次仓库（#430；ADR-0021 §5）。
 *
 * round.input 是创建时点的不可变 ReviewInputManifest；这里只做落库与状态迁移，
 * 权限/材料可见性/快照内容在 Hub 命令层判定。
 */
import type { ReviewInputManifest } from '@whalepod/protocol'
import { and, asc, eq, sql } from 'drizzle-orm'
import type { DbHandle } from '../client.js'
import { runs } from '../schema/run.js'

type RunRow = typeof runs.$inferSelect
import {
  artifactCommentResolutions,
  artifactRevisionLinks,
  artifactRevisionRoundComments,
  artifactRevisionRounds,
} from '../schema/review-round.js'

export type ArtifactRevisionRoundRow = typeof artifactRevisionRounds.$inferSelect
export type ArtifactRevisionLinkRow = typeof artifactRevisionLinks.$inferSelect
export type ArtifactCommentResolutionRow = typeof artifactCommentResolutions.$inferSelect

export interface NewArtifactRevisionRound {
  id: string
  taskId: string
  sourceArtifactId: string
  ownerUserId: string
  direction?: string
  input: ReviewInputManifest
  createdAt?: Date
}

export async function insertArtifactRevisionRound(
  handle: DbHandle,
  input: NewArtifactRevisionRound,
): Promise<ArtifactRevisionRoundRow> {
  const [row] = await handle
    .insert(artifactRevisionRounds)
    .values({
      id: input.id,
      taskId: input.taskId,
      sourceArtifactId: input.sourceArtifactId,
      ownerUserId: input.ownerUserId,
      ...(input.direction === undefined ? {} : { direction: input.direction }),
      input: input.input,
      ...(input.createdAt === undefined ? {} : { createdAt: input.createdAt }),
    })
    .returning()
  if (row === undefined) throw new Error('insert revision round returned no row')
  return row
}

export async function insertArtifactRevisionRoundComments(
  handle: DbHandle,
  roundId: string,
  commentIds: readonly string[],
): Promise<void> {
  if (commentIds.length === 0) return
  await handle
    .insert(artifactRevisionRoundComments)
    .values(commentIds.map((commentId) => ({ roundId, commentId })))
}

export async function getArtifactRevisionRound(
  handle: DbHandle,
  id: string,
): Promise<ArtifactRevisionRoundRow | undefined> {
  const [row] = await handle
    .select()
    .from(artifactRevisionRounds)
    .where(eq(artifactRevisionRounds.id, id))
    .limit(1)
  return row
}

export async function listArtifactRevisionRoundsByTask(
  handle: DbHandle,
  taskId: string,
): Promise<ArtifactRevisionRoundRow[]> {
  return handle
    .select()
    .from(artifactRevisionRounds)
    .where(eq(artifactRevisionRounds.taskId, taskId))
    .orderBy(asc(artifactRevisionRounds.createdAt), asc(artifactRevisionRounds.id))
}

export async function listArtifactRevisionRoundCommentIds(
  handle: DbHandle,
  roundId: string,
): Promise<string[]> {
  const rows = await handle
    .select({ commentId: artifactRevisionRoundComments.commentId })
    .from(artifactRevisionRoundComments)
    .where(eq(artifactRevisionRoundComments.roundId, roundId))
  return rows.map((row) => row.commentId)
}

/** preparing → starting：启动入口的串行化认领，只有一次请求能去建 Run。 */
export async function claimArtifactRevisionRoundStart(
  handle: DbHandle,
  id: string,
): Promise<ArtifactRevisionRoundRow | undefined> {
  const [row] = await handle
    .update(artifactRevisionRounds)
    .set({ status: 'starting' })
    .where(and(eq(artifactRevisionRounds.id, id), eq(artifactRevisionRounds.status, 'preparing')))
    .returning()
  return row
}

/** 建 Run 失败时把认领退回，允许责任人修正目标后重试。 */
export async function releaseArtifactRevisionRoundStart(
  handle: DbHandle,
  id: string,
): Promise<void> {
  await handle
    .update(artifactRevisionRounds)
    .set({ status: 'preparing' })
    .where(and(eq(artifactRevisionRounds.id, id), eq(artifactRevisionRounds.status, 'starting')))
}

/** 崩溃恢复：认领后已建出 Run 的批次，按 run.review_input.roundId 找回来。 */
export async function findRunByReviewRoundId(
  handle: DbHandle,
  roundId: string,
): Promise<RunRow | undefined> {
  const [row] = await handle
    .select()
    .from(runs)
    .where(sql`${runs.reviewInput}->>'roundId' = ${roundId}`)
    .limit(1)
  return row
}

/** starting → started；并发/重复启动时只有一次能把 run_id 写进去。 */
export async function markArtifactRevisionRoundStarted(
  handle: DbHandle,
  id: string,
  runId: string,
  startedAt: Date,
): Promise<ArtifactRevisionRoundRow | undefined> {
  const [row] = await handle
    .update(artifactRevisionRounds)
    .set({ status: 'started', runId, startedAt })
    .where(and(eq(artifactRevisionRounds.id, id), eq(artifactRevisionRounds.status, 'starting')))
    .returning()
  return row
}

export interface NewArtifactRevisionLink {
  candidateArtifactId: string
  sourceArtifactId: string
  roundId: string
  linkedBy: string
  createdAt?: Date
}

export async function insertArtifactRevisionLinkIfAbsent(
  handle: DbHandle,
  input: NewArtifactRevisionLink,
): Promise<ArtifactRevisionLinkRow | undefined> {
  const [row] = await handle
    .insert(artifactRevisionLinks)
    .values({
      candidateArtifactId: input.candidateArtifactId,
      sourceArtifactId: input.sourceArtifactId,
      roundId: input.roundId,
      linkedBy: input.linkedBy,
      ...(input.createdAt === undefined ? {} : { createdAt: input.createdAt }),
    })
    .onConflictDoNothing()
    .returning()
  return row
}

export async function getArtifactRevisionLinkByRound(
  handle: DbHandle,
  roundId: string,
): Promise<ArtifactRevisionLinkRow | undefined> {
  const [row] = await handle
    .select()
    .from(artifactRevisionLinks)
    .where(eq(artifactRevisionLinks.roundId, roundId))
    .limit(1)
  return row
}

export interface UpsertArtifactCommentResolution {
  id: string
  roundId: string
  commentId: string
  candidateArtifactId: string
  status: 'resolved' | 'needs_work'
  resolvedBy: string
  note?: string
  now: Date
}

export async function upsertArtifactCommentResolution(
  handle: DbHandle,
  input: UpsertArtifactCommentResolution,
): Promise<ArtifactCommentResolutionRow> {
  const [row] = await handle
    .insert(artifactCommentResolutions)
    .values({
      id: input.id,
      roundId: input.roundId,
      commentId: input.commentId,
      candidateArtifactId: input.candidateArtifactId,
      status: input.status,
      resolvedBy: input.resolvedBy,
      ...(input.note === undefined ? {} : { note: input.note }),
      createdAt: input.now,
      updatedAt: input.now,
    })
    .onConflictDoUpdate({
      target: [artifactCommentResolutions.roundId, artifactCommentResolutions.commentId],
      set: {
        candidateArtifactId: input.candidateArtifactId,
        status: input.status,
        resolvedBy: input.resolvedBy,
        note: input.note ?? null,
        updatedAt: input.now,
      },
    })
    .returning()
  if (row === undefined) throw new Error('upsert comment resolution returned no row')
  return row
}

export async function listArtifactCommentResolutionsByRound(
  handle: DbHandle,
  roundId: string,
): Promise<ArtifactCommentResolutionRow[]> {
  return handle
    .select()
    .from(artifactCommentResolutions)
    .where(eq(artifactCommentResolutions.roundId, roundId))
    .orderBy(asc(artifactCommentResolutions.updatedAt), asc(artifactCommentResolutions.id))
}
