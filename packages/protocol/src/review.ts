/**
 * 交付物审阅协议（#429；ADR-0021 §2-4）。
 *
 * 批注与邀请永远锚定一个不可变 Artifact 版本（artifact_id + sha256）；整件批注
 * 是所有格式的基础能力，文本锚点只表达「在该版本内容中的哪一段」。
 */
import { z } from 'zod'

/** 文本锚点：quote + 前后文用于消歧，start/end 是版本内 UTF-16 偏移。 */
export const ArtifactCommentAnchorSchema = z
  .strictObject({
    quote: z.string().min(1).max(2000),
    prefix: z.string().max(200),
    suffix: z.string().max(200),
    start: z.number().int().nonnegative(),
    end: z.number().int().nonnegative(),
  })
  .refine((anchor) => anchor.end - anchor.start === anchor.quote.length, {
    message: 'anchor offsets must match the quoted text length',
  })
export type ArtifactCommentAnchor = z.infer<typeof ArtifactCommentAnchorSchema>

/**
 * 在版本正文中复核锚点：偏移命中优先；否则按 quote + 前后文重新定位。
 * 只有唯一命中才返回（重复文字无上下文 → null，调用方必须明确报「无法定位」）。
 * 服务端创建批注与 Web 端回跳共用这一份语义，避免两边判定不一致。
 */
export function locateArtifactCommentAnchor(
  text: string,
  raw: ArtifactCommentAnchor,
): ArtifactCommentAnchor | null {
  const prefixOk = (start: number): boolean =>
    raw.prefix === '' || text.slice(Math.max(0, start - raw.prefix.length), start) === raw.prefix
  const suffixOk = (end: number): boolean =>
    raw.suffix === '' || text.slice(end, end + raw.suffix.length) === raw.suffix
  const directEnd = raw.start + raw.quote.length
  if (
    raw.start >= 0 &&
    directEnd <= text.length &&
    text.slice(raw.start, directEnd) === raw.quote &&
    prefixOk(raw.start) &&
    suffixOk(directEnd)
  ) {
    return { ...raw, end: directEnd }
  }
  const matches: number[] = []
  let at = text.indexOf(raw.quote)
  while (at !== -1) {
    if (prefixOk(at) && suffixOk(at + raw.quote.length)) matches.push(at)
    at = text.indexOf(raw.quote, at + 1)
  }
  if (matches.length !== 1) return null
  const start = matches[0]!
  return { ...raw, start, end: start + raw.quote.length }
}

export const ArtifactCommentKindSchema = z.enum(['whole', 'text'])

export const ArtifactCommentViewSchema = z
  .strictObject({
    id: z.uuid(),
    artifactId: z.uuid(),
    authorUserId: z.uuid(),
    parentCommentId: z.uuid().nullable(),
    kind: ArtifactCommentKindSchema,
    anchor: ArtifactCommentAnchorSchema.nullable(),
    body: z.string().min(1).max(10000),
    createdAt: z.iso.datetime(),
  })
  .refine(
    (comment) => (comment.kind === 'whole' ? comment.anchor === null : comment.anchor !== null),
    'comment kind must match its anchor',
  )
export type ArtifactCommentView = z.infer<typeof ArtifactCommentViewSchema>

export const CreateArtifactCommentRequestSchema = z
  .strictObject({
    body: z.string().min(1).max(10000),
    parentCommentId: z.uuid().optional(),
    /** 缺省 = 对整件文件发表评论。 */
    anchor: ArtifactCommentAnchorSchema.optional(),
  })
  .refine((value) => value.body.trim().length > 0, { message: 'comment body is required' })
export type CreateArtifactCommentRequest = z.infer<typeof CreateArtifactCommentRequestSchema>

export const ArtifactReviewInvitationStatusSchema = z.enum(['pending', 'submitted'])

export const ArtifactReviewInvitationViewSchema = z.strictObject({
  id: z.uuid(),
  artifactId: z.uuid(),
  inviterUserId: z.uuid(),
  reviewerUserId: z.uuid(),
  focus: z.string().max(2000).nullable(),
  status: ArtifactReviewInvitationStatusSchema,
  /** 提交时是否明确选择了「本轮无意见」。 */
  noComment: z.boolean(),
  createdAt: z.iso.datetime(),
  submittedAt: z.iso.datetime().nullable(),
})
export type ArtifactReviewInvitationView = z.infer<typeof ArtifactReviewInvitationViewSchema>

export const CreateArtifactReviewInvitationsRequestSchema = z.strictObject({
  reviewerUserIds: z.array(z.uuid()).min(1).max(20),
  focus: z.string().max(2000).optional(),
})
export type CreateArtifactReviewInvitationsRequest = z.infer<
  typeof CreateArtifactReviewInvitationsRequestSchema
>

/**
 * 提交本轮意见：noComment=true 表示「本轮无意见」；否则要求该审阅人在此版本上
 * 至少发表过一条批注。两者都收敛为 submitted，可追加后再次提交。
 */
export const SubmitArtifactReviewRequestSchema = z.strictObject({
  noComment: z.boolean(),
})
export type SubmitArtifactReviewRequest = z.infer<typeof SubmitArtifactReviewRequestSchema>

/** 审阅页读取面：Artifact 版本身份 + 批注线程 + 邀请（服务端按身份裁剪）。 */
export const ArtifactReviewViewSchema = z.strictObject({
  artifact: z.strictObject({
    id: z.uuid(),
    taskId: z.uuid(),
    title: z.string().min(1).max(200),
    mediaType: z.string().min(1).max(200),
    byteSize: z.number().int().nonnegative(),
    sha256: z.string().length(64),
    status: z.enum(['candidate', 'published', 'rejected']),
    ownerUserId: z.uuid(),
    publishedAt: z.iso.datetime().nullable(),
  }),
  comments: z.array(ArtifactCommentViewSchema),
  invitations: z.array(ArtifactReviewInvitationViewSchema),
  /** 阅读方式：text 可页内选择文字；unsupported 仅整件批注与下载。 */
  reading: z.enum(['text', 'unsupported']),
  /** 页内文本上限（与服务端锚点校验同一预算）；超过时只接受整件批注。 */
  textPreviewMaxBytes: z.number().int().positive(),
  capabilities: z.strictObject({
    canInvite: z.boolean(),
    canSubmitReview: z.boolean(),
    canComment: z.boolean(),
  }),
})
export type ArtifactReviewView = z.infer<typeof ArtifactReviewViewSchema>
