/**
 * 交付物审阅命令/读取面（#429；ADR-0021 §2-4）。
 *
 * - 批注与邀请永远锚定不可变 Artifact 版本；候选只有拥有者可见，团队审阅只针对
 *   已发布版本。
 * - 批注创建/回复/邀请/提交意见都不启动 Run、不改任务状态；只发 artifact.changed
 *   让房间与待办刷新。
 * - 文本锚点在服务端复核：所选文字必须真在该版本内容中；重复文字靠前后文消歧，
 *   仍不唯一则明确拒绝，不猜位置。
 * - 权限一律按当前可见性重判；历史邀请不授予任何读取或执行权。
 */
import type { Actor } from '@whalepod/domain'
import { asUserId, authorize } from '@whalepod/domain'
import type { ArtifactRow, Database, DbHandle } from '@whalepod/db'
import {
  appendTeamEvent,
  countArtifactCommentsByAuthor,
  getArtifact,
  getArtifactComment,
  getArtifactReviewInvitation,
  getEnabledMember,
  getTask,
  getTeam,
  insertArtifactComment,
  insertArtifactReviewInvitationIfAbsent,
  listArtifactComments,
  listArtifactReviewInvitations,
  lockArtifactReviewInvitation,
  markArtifactReviewInvitationSubmitted,
  reopenArtifactReviewInvitation,
  transactCommand,
} from '@whalepod/db'
import {
  ArtifactReviewViewSchema,
  locateArtifactCommentAnchor,
  type ArtifactCommentAnchor,
  type ArtifactCommentView,
  type ArtifactReviewInvitationView,
  type ArtifactReviewView,
  type CreateArtifactCommentRequest,
  type CreateArtifactReviewInvitationsRequest,
  type SubmitArtifactReviewRequest,
} from '@whalepod/protocol'
import { randomUUID } from 'node:crypto'
import { ApiError } from '../shared/http-error.js'
import type { ArtifactStore } from '../artifact/store.js'

/** 页内文本与锚点校验共用预算：超过它的文本只接受整件批注。 */
export const REVIEW_TEXT_MAX_BYTES = 512 * 1024

export function isReviewText(mediaType: string, byteSize: number): boolean {
  if (byteSize > REVIEW_TEXT_MAX_BYTES) return false
  const base = mediaType.split(';')[0]?.trim().toLowerCase() ?? ''
  if (base.startsWith('text/')) return true
  return (
    base === 'application/json' ||
    base === 'application/xml' ||
    (base.startsWith('application/') && (base.endsWith('+json') || base.endsWith('+xml')))
  )
}

function toCommentView(
  row: Awaited<ReturnType<typeof listArtifactComments>>[number],
): ArtifactCommentView {
  return {
    id: row.id,
    artifactId: row.artifactId,
    authorUserId: row.authorUserId,
    parentCommentId: row.parentCommentId,
    kind: row.kind,
    anchor: row.anchor ?? null,
    body: row.body,
    createdAt: row.createdAt.toISOString(),
  }
}

function toInvitationView(
  row: Awaited<ReturnType<typeof listArtifactReviewInvitations>>[number],
): ArtifactReviewInvitationView {
  return {
    id: row.id,
    artifactId: row.artifactId,
    inviterUserId: row.inviterUserId,
    reviewerUserId: row.reviewerUserId,
    focus: row.focus,
    status: row.status,
    noComment: row.noComment,
    createdAt: row.createdAt.toISOString(),
    submittedAt: row.submittedAt?.toISOString() ?? null,
  }
}

/** 可读性：候选仅拥有者；已发布项目成员；不可见与不存在同作 404。 */
export async function requireReadableArtifact(
  handle: DbHandle,
  actor: Actor,
  artifactId: string,
): Promise<ArtifactRow> {
  const row = await getArtifact(handle, artifactId.toLowerCase())
  if (row === undefined) throw new ApiError(404, 'NOT_FOUND', 'artifact not found')
  const allowed = authorize(
    { userId: asUserId(actor.userId), role: actor.role },
    'read_artifact_content',
    { ownerUserId: asUserId(row.ownerUserId), artifactStatus: row.status },
  )
  if (!allowed) throw new ApiError(404, 'NOT_FOUND', 'artifact not found')
  return row
}

async function textOf(
  handle: DbHandle,
  store: ArtifactStore,
  artifact: ArtifactRow,
): Promise<string | null> {
  if (!isReviewText(artifact.mediaType, artifact.byteSize)) return null
  const bytes = await store.readVerified(artifact.storageKey, artifact.sha256)
  // 浏览器 Response.text() 会按规范吃掉 UTF-8 BOM，Node 的 toString 会保留；
  // 两边都去 BOM 才能让同一段文字算出同一组偏移。
  return bytes.toString('utf8').replace(/^\uFEFF/, '')
}

export async function getArtifactReviewView(
  handle: DbHandle,
  actor: Actor,
  artifactId: string,
): Promise<ArtifactReviewView> {
  const artifact = await requireReadableArtifact(handle, actor, artifactId)
  const task = await getTask(handle, artifact.taskId)
  if (task === undefined) throw new ApiError(404, 'NOT_FOUND', 'task not found')
  const [commentRows, invitationRows] = await Promise.all([
    listArtifactComments(handle, artifact.id),
    listArtifactReviewInvitations(handle, artifact.id),
  ])
  const own = invitationRows.find((row) => row.reviewerUserId === actor.userId)
  const seesAll = actor.userId === task.assigneeUserId || actor.userId === artifact.ownerUserId
  return ArtifactReviewViewSchema.parse({
    artifact: {
      id: artifact.id,
      taskId: artifact.taskId,
      title: artifact.title,
      mediaType: artifact.mediaType,
      byteSize: artifact.byteSize,
      sha256: artifact.sha256,
      status: artifact.status,
      ownerUserId: artifact.ownerUserId,
      publishedAt: artifact.publishedAt?.toISOString() ?? null,
    },
    comments: commentRows.map(toCommentView),
    invitations: (seesAll
      ? invitationRows
      : invitationRows.filter((row) => row.reviewerUserId === actor.userId)
    ).map(toInvitationView),
    reading: isReviewText(artifact.mediaType, artifact.byteSize) ? 'text' : 'unsupported',
    textPreviewMaxBytes: REVIEW_TEXT_MAX_BYTES,
    capabilities: {
      canInvite:
        artifact.status === 'published' &&
        (actor.userId === task.assigneeUserId || actor.userId === artifact.ownerUserId),
      canSubmitReview: own !== undefined,
      canComment: true,
    },
  })
}

async function appendReviewChanged(
  handle: DbHandle,
  artifact: ArtifactRow,
  change: 'comment' | 'invitation' | 'submission',
): Promise<void> {
  await appendTeamEvent(handle, {
    type: 'artifact.changed',
    payload: {
      artifactId: artifact.id,
      taskId: artifact.taskId,
      runId: artifact.runId,
      status: artifact.status,
      change,
    },
  })
}

async function requireParent(
  handle: DbHandle,
  artifactId: string,
  parentId: string,
): Promise<void> {
  const parent = await getArtifactComment(handle, parentId)
  if (parent === undefined || parent.artifactId !== artifactId) {
    throw new ApiError(404, 'NOT_FOUND', 'comment not found')
  }
  // 线程只有一层：回复不能被回复成新线程（否则「逐条复核」会失去边界）。
  if (parent.parentCommentId !== null) {
    throw new ApiError(400, 'VALIDATION_FAILED', 'replies cannot be nested')
  }
}

export async function createArtifactComment(
  database: Database,
  store: ArtifactStore,
  actor: Actor,
  artifactId: string,
  input: CreateArtifactCommentRequest,
  idempotencyKey: string,
): Promise<ArtifactCommentView> {
  const artifact = await requireReadableArtifact(database.db, actor, artifactId)
  if (input.body.trim().length === 0) {
    throw new ApiError(400, 'VALIDATION_FAILED', 'comment body is required')
  }
  let anchor: ArtifactCommentAnchor | null = null
  if (input.parentCommentId !== undefined) {
    if (input.anchor !== undefined) {
      throw new ApiError(400, 'VALIDATION_FAILED', 'replies inherit their thread position')
    }
    await requireParent(database.db, artifact.id, input.parentCommentId)
  } else if (input.anchor !== undefined) {
    const text = await textOf(database.db, store, artifact)
    if (text === null) {
      throw new ApiError(400, 'ANCHOR_UNSUPPORTED', '该格式或体积不支持原位批注，请使用整件批注')
    }
    const located = locateArtifactCommentAnchor(text, input.anchor)
    if (located === null) {
      throw new ApiError(
        400,
        'ANCHOR_NOT_FOUND',
        '所选文字不在该版本内容中或无法唯一定位，请改为整件批注',
      )
    }
    anchor = located
  }
  // 台账存的是**已序列化的视图**：同一 Idempotency-Key 重放时返回 JSONB 反序列化
  // 结果（日期已是字符串），再调 toCommentView 的 toISOString 会 500。
  return transactCommand(
    database,
    `artifact.comment.create:${actor.userId}:${artifact.id}:${idempotencyKey}`,
    async (tx) => {
      // 与「提交本轮意见」共用同一把邀请行锁：避免「无意见」与「追加批注」并发后
      // 同时成立。追加批注即撤回上一轮的「无意见/已提交」，待办重新出现。
      const invitation = await lockArtifactReviewInvitation(tx, artifact.id, actor.userId)
      const comment = await insertArtifactComment(tx, {
        id: randomUUID(),
        artifactId: artifact.id,
        authorUserId: actor.userId,
        ...(input.parentCommentId === undefined ? {} : { parentCommentId: input.parentCommentId }),
        kind: anchor === null ? 'whole' : 'text',
        anchor,
        body: input.body.trim(),
      })
      if (invitation !== undefined && invitation.status === 'submitted') {
        await reopenArtifactReviewInvitation(tx, invitation.id)
      }
      await appendReviewChanged(tx, artifact, 'comment')
      return toCommentView(comment)
    },
  )
}

export async function inviteReviewers(
  database: Database,
  actor: Actor,
  artifactId: string,
  input: CreateArtifactReviewInvitationsRequest,
  idempotencyKey: string,
): Promise<ArtifactReviewInvitationView[]> {
  const artifact = await requireReadableArtifact(database.db, actor, artifactId)
  if (artifact.status !== 'published') {
    throw new ApiError(409, 'CONFLICT', '只有已发布交付物可以邀请团队审阅')
  }
  const task = await getTask(database.db, artifact.taskId)
  if (task === undefined) throw new ApiError(404, 'NOT_FOUND', 'task not found')
  if (actor.userId !== task.assigneeUserId && actor.userId !== artifact.ownerUserId) {
    throw new ApiError(403, 'FORBIDDEN', 'only the task assignee or artifact owner can invite')
  }
  const team = await getTeam(database.db)
  if (team === undefined) throw new ApiError(500, 'INTERNAL_ERROR', 'team not initialized')
  const focus = input.focus?.trim()
  const reviewerIds = [...new Set(input.reviewerUserIds.map((id) => id.toLowerCase()))]
  for (const reviewerId of reviewerIds) {
    const member = await getEnabledMember(database.db, team.id, reviewerId)
    if (member === undefined) {
      throw new ApiError(400, 'VALIDATION_FAILED', 'reviewer is not an active team member')
    }
  }
  return transactCommand(
    database,
    `artifact.review.invite:${actor.userId}:${artifact.id}:${idempotencyKey}`,
    async (tx) => {
      const rows: ArtifactReviewInvitationView[] = []
      let inserted = false
      for (const reviewerId of reviewerIds) {
        const outcome = await insertArtifactReviewInvitationIfAbsent(tx, {
          id: randomUUID(),
          artifactId: artifact.id,
          inviterUserId: actor.userId,
          reviewerUserId: reviewerId,
          ...(focus === undefined || focus === '' ? {} : { focus }),
        })
        inserted ||= outcome.inserted
        rows.push(toInvitationView(outcome.row))
      }
      if (inserted) await appendReviewChanged(tx, artifact, 'invitation')
      return rows
    },
  )
}

export async function submitArtifactReview(
  database: Database,
  actor: Actor,
  artifactId: string,
  input: SubmitArtifactReviewRequest,
  idempotencyKey: string,
): Promise<ArtifactReviewInvitationView> {
  const artifact = await requireReadableArtifact(database.db, actor, artifactId)
  const invitation = await getArtifactReviewInvitation(database.db, artifact.id, actor.userId)
  if (invitation === undefined) {
    throw new ApiError(404, 'NOT_FOUND', 'review invitation not found')
  }
  return transactCommand(
    database,
    `artifact.review.submit:${actor.userId}:${artifact.id}:${idempotencyKey}`,
    async (tx) => {
      // 前置校验也在事务内、且在邀请行锁之后：同键重放直接回放首次结果；并发追加
      // 批注与「无意见」由同一把行锁串行化。
      const locked = await lockArtifactReviewInvitation(tx, artifact.id, actor.userId)
      if (locked === undefined) throw new ApiError(404, 'NOT_FOUND', 'review invitation not found')
      const authored = await countArtifactCommentsByAuthor(tx, artifact.id, actor.userId)
      if (!input.noComment && authored === 0) {
        throw new ApiError(400, 'NO_COMMENTS', '还没有发表意见；如无意见请选择「本轮无意见」')
      }
      if (input.noComment && authored > 0) {
        throw new ApiError(400, 'VALIDATION_FAILED', '已经发表过意见，不能选择「本轮无意见」')
      }
      const updated = await markArtifactReviewInvitationSubmitted(
        tx,
        locked.id,
        new Date(),
        input.noComment,
      )
      if (updated === undefined) throw new ApiError(404, 'NOT_FOUND', 'review invitation not found')
      await appendReviewChanged(tx, artifact, 'submission')
      return toInvitationView(updated)
    },
  )
}
