import type { HandoffContent } from '@whalepod/protocol'
import { sql } from 'drizzle-orm'
import {
  check,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core'
import { runs } from './run.js'
import { taskSpecRevisions, tasks } from './project.js'
import { userAccounts } from './identity.js'

// 交接草稿与交接版本域表（#379；ADR-0017 §3-4），字段语义以 03 文档同名节为准。
export const handoffDraftStatus = pgEnum('handoff_draft_status', ['ready', 'failed', 'published'])
export const handoffDraftOrigin = pgEnum('handoff_draft_origin', ['auto', 'manual'])

/**
 * 交接草稿：源 Run 收尾自动生成（auto）或 owner 手工创建/编辑（manual）。
 * 仅源 Run owner 可见可编辑；每来源 Run 至多一条未发布草稿（部分唯一索引）。
 */
export const handoffDrafts = pgTable(
  'handoff_draft',
  {
    id: uuid('id').primaryKey(),
    taskId: uuid('task_id')
      .notNull()
      .references(() => tasks.id),
    sourceRunId: uuid('source_run_id')
      .notNull()
      .references(() => runs.id),
    specRevisionId: uuid('spec_revision_id').references(() => taskSpecRevisions.id),
    status: handoffDraftStatus('status').notNull(),
    /** 仅 status='failed' 时有值（「交接草稿未生成」的原因）。 */
    failureReason: varchar('failure_reason', { length: 1000 }),
    /** {system, narrative}；null 仅当 failed。 */
    content: jsonb('content').$type<HandoffContent>(),
    /** 编辑并发令牌：每次落盘 +1（不匹配的编辑被拒）。 */
    draftVersion: integer('draft_version').notNull().default(1),
    origin: handoffDraftOrigin('origin').notNull(),
    createdBy: uuid('created_by')
      .notNull()
      .references(() => userAccounts.id),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    /** 发布后的版本指针（draft 保留作审计）；仅 status='published' 非空。 */
    publishedRevisionId: uuid('published_revision_id'),
  },
  (table) => [
    check('handoff_draft_draft_version_positive', sql`${table.draftVersion} >= 1`),
    check(
      'handoff_draft_content_size',
      sql`${table.content} is null or octet_length(${table.content}::text) <= 32768`,
    ),
    check(
      'handoff_draft_fields',
      sql`(${table.status} = 'failed' and ${table.content} is null and ${table.failureReason} is not null and ${table.publishedRevisionId} is null) or (${table.status} = 'ready' and ${table.content} is not null and ${table.failureReason} is null and ${table.publishedRevisionId} is null) or (${table.status} = 'published' and ${table.content} is not null and ${table.publishedRevisionId} is not null and ${table.failureReason} is null)`,
    ),
    uniqueIndex('handoff_draft_one_open_per_run')
      .on(table.sourceRunId)
      .where(sql`${table.status} in ('ready', 'failed')`),
  ],
)

/** 已发布交接版本：Task 级编号单调递增、发布后不可变（修改产生新草稿新版本）。 */
export const handoffRevisions = pgTable(
  'handoff_revision',
  {
    id: uuid('id').primaryKey(),
    taskId: uuid('task_id')
      .notNull()
      .references(() => tasks.id),
    revisionNumber: integer('revision_number').notNull(),
    sourceRunId: uuid('source_run_id')
      .notNull()
      .references(() => runs.id),
    specRevisionId: uuid('spec_revision_id').references(() => taskSpecRevisions.id),
    content: jsonb('content').$type<HandoffContent>().notNull(),
    createdFromDraftId: uuid('created_from_draft_id').references(() => handoffDrafts.id),
    publishedBy: uuid('published_by')
      .notNull()
      .references(() => userAccounts.id),
    publishedAt: timestamp('published_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    check('handoff_revision_number_positive', sql`${table.revisionNumber} >= 1`),
    check('handoff_revision_content_size', sql`octet_length(${table.content}::text) <= 32768`),
    unique('handoff_revision_number_unique').on(table.taskId, table.revisionNumber),
  ],
)
