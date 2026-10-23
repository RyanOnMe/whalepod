import type { ReviewInputManifest } from '@whalepod/protocol'
import { sql } from 'drizzle-orm'
import {
  check,
  index,
  jsonb,
  pgEnum,
  pgTable,
  primaryKey,
  timestamp,
  unique,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core'
import { artifacts } from './artifact.js'
import { artifactComments } from './review.js'
import { userAccounts } from './identity.js'
import { tasks } from './project.js'
import { runs } from './run.js'

// 交付物修订批次（#430；ADR-0021 §5）。input 是创建时点的不可变快照。
export const artifactRevisionRoundStatus = pgEnum('artifact_revision_round_status', [
  'preparing',
  'starting',
  'started',
  'cancelled',
])

export const artifactRevisionRounds = pgTable(
  'artifact_revision_round',
  {
    id: uuid('id').primaryKey(),
    taskId: uuid('task_id')
      .notNull()
      .references(() => tasks.id),
    sourceArtifactId: uuid('source_artifact_id')
      .notNull()
      .references(() => artifacts.id),
    ownerUserId: uuid('owner_user_id')
      .notNull()
      .references(() => userAccounts.id),
    status: artifactRevisionRoundStatus('status').notNull().default('preparing'),
    direction: varchar('direction', { length: 10000 }),
    input: jsonb('input').$type<ReviewInputManifest>().notNull(),
    runId: uuid('run_id').references(() => runs.id),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    startedAt: timestamp('started_at', { withTimezone: true }),
  },
  (table) => [
    check(
      'artifact_revision_round_direction_length',
      sql`${table.direction} is null or length(btrim(${table.direction})) between 1 and 10000`,
    ),
    check('artifact_revision_round_input_object', sql`jsonb_typeof(${table.input}) = 'object'`),
    check(
      'artifact_revision_round_fields',
      sql`(${table.status} in ('preparing', 'starting') and ${table.runId} is null and ${table.startedAt} is null) or (${table.status} = 'started' and ${table.runId} is not null and ${table.startedAt} is not null) or (${table.status} = 'cancelled')`,
    ),
    unique('artifact_revision_round_run_unique').on(table.runId),
    index('artifact_revision_round_by_task').on(table.taskId, table.createdAt),
    index('artifact_revision_round_by_source').on(table.sourceArtifactId, table.createdAt),
  ],
)

export const artifactRevisionRoundComments = pgTable(
  'artifact_revision_round_comment',
  {
    roundId: uuid('round_id')
      .notNull()
      .references(() => artifactRevisionRounds.id, { onDelete: 'cascade' }),
    commentId: uuid('comment_id')
      .notNull()
      .references(() => artifactComments.id),
  },
  (table) => [primaryKey({ columns: [table.roundId, table.commentId] })],
)

export const artifactRevisionLinks = pgTable('artifact_revision_link', {
  candidateArtifactId: uuid('candidate_artifact_id')
    .primaryKey()
    .references(() => artifacts.id),
  sourceArtifactId: uuid('source_artifact_id')
    .notNull()
    .references(() => artifacts.id),
  roundId: uuid('round_id')
    .notNull()
    .unique()
    .references(() => artifactRevisionRounds.id),
  linkedBy: uuid('linked_by')
    .notNull()
    .references(() => userAccounts.id),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
})

export const artifactCommentResolutionStatus = pgEnum('artifact_comment_resolution_status', [
  'resolved',
  'needs_work',
])

export const artifactCommentResolutions = pgTable(
  'artifact_comment_resolution',
  {
    id: uuid('id').primaryKey(),
    roundId: uuid('round_id')
      .notNull()
      .references(() => artifactRevisionRounds.id),
    commentId: uuid('comment_id')
      .notNull()
      .references(() => artifactComments.id),
    candidateArtifactId: uuid('candidate_artifact_id')
      .notNull()
      .references(() => artifacts.id),
    status: artifactCommentResolutionStatus('status').notNull(),
    resolvedBy: uuid('resolved_by')
      .notNull()
      .references(() => userAccounts.id),
    note: varchar('note', { length: 10000 }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    check(
      'artifact_comment_resolution_note_length',
      sql`${table.note} is null or length(btrim(${table.note})) between 1 and 10000`,
    ),
    unique('artifact_comment_resolution_unique').on(table.roundId, table.commentId),
    index('artifact_comment_resolution_by_comment').on(table.commentId, table.updatedAt),
  ],
)
