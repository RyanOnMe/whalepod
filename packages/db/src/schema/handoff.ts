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

/** 接收关系状态（#380）：pending = 已交付待确认；confirmed = 接收方已填理解。 */
export const handoffReceiptStatus = pgEnum('handoff_receipt_status', ['pending', 'confirmed'])

/**
 * 接收关系（#380；ADR-0017 §5）：已发布交接版本 × 同项目下游 Task。
 * 确认 ≠ 接受 Task、不启动 Run；上游新版本由接收方 adopt 产生**新** receipt，
 * 旧 receipt 永远保留原版本（(downstream_task_id, revision_id) 唯一兜底幂等）。
 */
export const handoffReceipts = pgTable(
  'handoff_receipt',
  {
    id: uuid('id').primaryKey(),
    revisionId: uuid('revision_id')
      .notNull()
      .references(() => handoffRevisions.id),
    upstreamTaskId: uuid('upstream_task_id')
      .notNull()
      .references(() => tasks.id),
    downstreamTaskId: uuid('downstream_task_id')
      .notNull()
      .references(() => tasks.id),
    receiverUserId: uuid('receiver_user_id')
      .notNull()
      .references(() => userAccounts.id),
    deliveredBy: uuid('delivered_by')
      .notNull()
      .references(() => userAccounts.id),
    status: handoffReceiptStatus('status').notNull().default('pending'),
    /** 「本次准备做什么」——confirmed 时非空（字段组合即状态语义）。 */
    understanding: varchar('understanding', { length: 10000 }),
    /** 可选差异原文（同一内容同时作为讨论消息落上游 Task）。 */
    differences: varchar('differences', { length: 10000 }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    confirmedAt: timestamp('confirmed_at', { withTimezone: true }),
  },
  (table) => [
    check(
      'handoff_receipt_distinct_tasks',
      sql`${table.upstreamTaskId} <> ${table.downstreamTaskId}`,
    ),
    check(
      'handoff_receipt_fields',
      sql`(${table.status} = 'pending' and ${table.understanding} is null and ${table.confirmedAt} is null) or (${table.status} = 'confirmed' and ${table.understanding} is not null and ${table.confirmedAt} is not null)`,
    ),
    unique('handoff_receipt_unique_per_version').on(table.downstreamTaskId, table.revisionId),
  ],
)
