/**
 * 交付物修订批次协议（#430；ADR-0021 §5）。
 *
 * 批次在「整理本轮修订」时冻结：原稿版本、选定批注及回复、参考材料、责任人补充
 * 方向。启动后后来补充的批注不进入本轮；Run 的 review_input 快照永不回填。
 */
import { z } from 'zod'
import { ArtifactCommentAnchorSchema, ArtifactCommentKindSchema } from './review.js'

export const ArtifactRevisionRoundStatusSchema = z.enum([
  'preparing',
  'starting',
  'started',
  'cancelled',
])

/** 快照里的 Artifact 身份（已发布且摘要固定）。 */
export const ReviewRoundArtifactSchema = z.strictObject({
  artifactId: z.uuid(),
  runId: z.uuid(),
  title: z.string().min(1).max(200),
  mediaType: z.string().min(1).max(200),
  byteSize: z.number().int().min(0).max(52_428_800),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  publishedAt: z.iso.datetime(),
})
export type ReviewRoundArtifact = z.infer<typeof ReviewRoundArtifactSchema>

export const ReviewCommentReplySnapshotSchema = z.strictObject({
  commentId: z.uuid(),
  authorUserId: z.uuid(),
  body: z.string().min(1).max(10000),
  createdAt: z.iso.datetime(),
})

export const ReviewCommentSnapshotSchema = z.strictObject({
  commentId: z.uuid(),
  authorUserId: z.uuid(),
  kind: ArtifactCommentKindSchema,
  anchor: ArtifactCommentAnchorSchema.nullable(),
  body: z.string().min(1).max(10000),
  createdAt: z.iso.datetime(),
  /** 冻结时该线程下的全部回复（不可再嵌套）。 */
  replies: z.array(ReviewCommentReplySnapshotSchema).max(200),
})
export type ReviewCommentSnapshot = z.infer<typeof ReviewCommentSnapshotSchema>

/** run.review_input：本轮修订的执行依据；启动后不再变化。 */
export const ReviewInputManifestSchema = z.strictObject({
  roundId: z.uuid(),
  sourceArtifact: ReviewRoundArtifactSchema,
  direction: z.string().max(10000).nullable(),
  comments: z.array(ReviewCommentSnapshotSchema).min(1).max(50),
  references: z.array(ReviewRoundArtifactSchema).max(20),
  frozenAt: z.iso.datetime(),
})
export type ReviewInputManifest = z.infer<typeof ReviewInputManifestSchema>

export const ArtifactCommentResolutionStatusSchema = z.enum(['resolved', 'needs_work'])

export const ArtifactCommentResolutionViewSchema = z.strictObject({
  commentId: z.uuid(),
  status: ArtifactCommentResolutionStatusSchema,
  resolvedBy: z.uuid(),
  note: z.string().max(10000).nullable(),
  updatedAt: z.iso.datetime(),
})
export type ArtifactCommentResolutionView = z.infer<typeof ArtifactCommentResolutionViewSchema>

export const ArtifactRevisionCandidateViewSchema = z.strictObject({
  artifactId: z.uuid(),
  linkedAt: z.iso.datetime(),
  publishedAt: z.iso.datetime().nullable(),
})

export const ArtifactRevisionRoundViewSchema = z.strictObject({
  id: z.uuid(),
  taskId: z.uuid(),
  status: ArtifactRevisionRoundStatusSchema,
  sourceArtifact: ReviewRoundArtifactSchema,
  direction: z.string().max(10000).nullable(),
  comments: z.array(ReviewCommentSnapshotSchema),
  references: z.array(ReviewRoundArtifactSchema),
  runId: z.uuid().nullable(),
  candidate: ArtifactRevisionCandidateViewSchema.nullable(),
  resolutions: z.array(ArtifactCommentResolutionViewSchema),
  createdAt: z.iso.datetime(),
  startedAt: z.iso.datetime().nullable(),
})
export type ArtifactRevisionRoundView = z.infer<typeof ArtifactRevisionRoundViewSchema>

export const CreateArtifactRevisionRoundRequestSchema = z.strictObject({
  sourceArtifactId: z.uuid(),
  /** 顶层批注 id；回复随线程一起冻结。 */
  commentIds: z.array(z.uuid()).min(1).max(50),
  referenceArtifactIds: z.array(z.uuid()).max(20).optional(),
  direction: z.string().max(10000).optional(),
})
export type CreateArtifactRevisionRoundRequest = z.infer<
  typeof CreateArtifactRevisionRoundRequestSchema
>

export const StartArtifactRevisionRoundRequestSchema = z.strictObject({
  agentId: z.uuid(),
  deviceId: z.uuid(),
  workspaceId: z.uuid(),
  expectedApprovalPolicy: z.enum(['approval_required', 'full_access']).optional(),
  /** 缺省 = 新执行；显式给来源 Run 才续接原产出会话。 */
  resumeFromRunId: z.uuid().optional(),
  /** 缺省用 Hub 的固定说明；可替换为责任人自己的指令。 */
  prompt: z.string().min(1).max(20000).optional(),
})
export type StartArtifactRevisionRoundRequest = z.infer<
  typeof StartArtifactRevisionRoundRequestSchema
>

export const LinkArtifactRevisionCandidateRequestSchema = z.strictObject({
  candidateArtifactId: z.uuid(),
})
export type LinkArtifactRevisionCandidateRequest = z.infer<
  typeof LinkArtifactRevisionCandidateRequestSchema
>

export const ResolveArtifactCommentRequestSchema = z.strictObject({
  commentId: z.uuid(),
  status: ArtifactCommentResolutionStatusSchema,
  /** 非批注作者（责任人）代为收口时必填理由。 */
  note: z.string().max(10000).optional(),
})
export type ResolveArtifactCommentRequest = z.infer<typeof ResolveArtifactCommentRequestSchema>
