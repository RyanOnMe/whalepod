import type { ArtifactCommentAnchor } from '@whalepod/protocol'
import { sql } from 'drizzle-orm'
import {
  check,
  index,
  jsonb,
  pgEnum,
  boolean,
  pgTable,
  timestamp,
  unique,
  uuid,
  varchar,
  type AnyPgColumn,
} from 'drizzle-orm/pg-core'
import { userAccounts } from './identity.js'
import { artifacts } from './artifact.js'

// 交付物审阅域表（#429；ADR-0021 §2-4）：批注永远锚定不可变 Artifact 版本。
export const artifactCommentKind = pgEnum('artifact_comment_kind', ['whole', 'text'])

export const artifactComments = pgTable(
  'artifact_comment',
  {
    id: uuid('id').primaryKey(),
    artifactId: uuid('artifact_id')
      .notNull()
      .references(() => artifacts.id),
    authorUserId: uuid('author_user_id')
      .notNull()
      .references(() => userAccounts.id),
    /** 回复的顶层批注；线程只有一层（回复不能再被回复成新线程）。 */
    parentCommentId: uuid('parent_comment_id').references((): AnyPgColumn => artifactComments.id),
    kind: artifactCommentKind('kind').notNull(),
    anchor: jsonb('anchor').$type<ArtifactCommentAnchor | null>(),
    body: varchar('body', { length: 10000 }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    check('artifact_comment_body_length', sql`length(btrim(${table.body})) between 1 and 10000`),
    check(
      'artifact_comment_anchor_matches_kind',
      sql`(${table.kind} = 'whole' and ${table.anchor} is null) or (${table.kind} = 'text' and ${table.anchor} is not null and jsonb_typeof(${table.anchor}) = 'object')`,
    ),
    // 纵深防御：服务端不会生成 id==parent 的行；真正的「不跨版本、不嵌套」在命令层。
    check(
      'artifact_comment_not_self_reply',
      sql`${table.parentCommentId} is null or ${table.parentCommentId} <> ${table.id}`,
    ),
    index('artifact_comment_by_artifact').on(table.artifactId, table.createdAt, table.id),
    index('artifact_comment_by_author').on(table.artifactId, table.authorUserId),
  ],
)

export const artifactReviewInvitationStatus = pgEnum('artifact_review_invitation_status', [
  'pending',
  'submitted',
])

export const artifactReviewInvitations = pgTable(
  'artifact_review_invitation',
  {
    id: uuid('id').primaryKey(),
    artifactId: uuid('artifact_id')
      .notNull()
      .references(() => artifacts.id),
    inviterUserId: uuid('inviter_user_id')
      .notNull()
      .references(() => userAccounts.id),
    reviewerUserId: uuid('reviewer_user_id')
      .notNull()
      .references(() => userAccounts.id),
    focus: varchar('focus', { length: 2000 }),
    status: artifactReviewInvitationStatus('status').notNull().default('pending'),
    /** 提交时是否明确选择了「本轮无意见」；pending 恒 false。 */
    noComment: boolean('no_comment').notNull().default(false),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    submittedAt: timestamp('submitted_at', { withTimezone: true }),
  },
  (table) => [
    check(
      'artifact_review_invitation_focus_length',
      sql`${table.focus} is null or length(btrim(${table.focus})) between 1 and 2000`,
    ),
    check(
      'artifact_review_invitation_fields',
      sql`(${table.status} = 'pending' and ${table.submittedAt} is null and ${table.noComment} = false) or (${table.status} = 'submitted' and ${table.submittedAt} is not null)`,
    ),
    unique('artifact_review_invitation_unique_per_reviewer').on(
      table.artifactId,
      table.reviewerUserId,
    ),
    index('artifact_review_invitation_by_reviewer').on(table.reviewerUserId, table.status),
    index('artifact_review_invitation_by_artifact').on(table.artifactId, table.createdAt),
  ],
)
