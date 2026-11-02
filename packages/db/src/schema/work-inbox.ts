import { sql } from 'drizzle-orm'
import {
  char,
  check,
  index,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core'
import type { AnyPgColumn } from 'drizzle-orm/pg-core'
import { projects, tasks } from './project.js'
import { works, workSourceType } from './work.js'

// ADR-0028（RD-02a-1，Issue #489）：工作收件箱条目。交付/消费由 RD-02a-2 追加。
export const workInboxItemStatus = pgEnum('work_inbox_item_status', [
  'pending',
  'returned',
  'superseded',
  'retracted',
  'expired',
])
export const workInboxReturnReason = pgEnum('work_inbox_return_reason', [
  'irrelevant',
  'new_gap',
  'conflict',
  'permission_invalid',
  'incomplete',
])

export const workInboxItems = pgTable(
  'work_inbox_item',
  {
    id: uuid('id').primaryKey(),
    workId: uuid('work_id')
      .notNull()
      .references(() => works.id),
    workKey: varchar('work_key', { length: 64 }).notNull(),
    taskId: uuid('task_id')
      .notNull()
      .references(() => tasks.id),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id),
    sourceType: workSourceType('source_type').notNull(),
    sourceId: uuid('source_id').notNull(),
    sourceVersion: varchar('source_version', { length: 200 }).notNull(),
    sourceDigest: char('source_digest', { length: 64 }).notNull(),
    authorizationGeneration: varchar('authorization_generation', { length: 128 }).notNull(),
    title: varchar('title', { length: 200 }).notNull(),
    body: text('body').notNull().default(''),
    bodyDigest: char('body_digest', { length: 64 }).notNull(),
    refs: jsonb('refs').$type<Record<string, unknown>>().notNull().default({}),
    supersedesId: uuid('supersedes_id').references((): AnyPgColumn => workInboxItems.id),
    status: workInboxItemStatus('status').notNull().default('pending'),
    statusReason: varchar('status_reason', { length: 500 }),
    returnReason: workInboxReturnReason('return_reason'),
    returnNote: varchar('return_note', { length: 1000 }),
    statusAt: timestamp('status_at', { withTimezone: true }).notNull().defaultNow(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    check(
      'work_inbox_item_work_key_format',
      sql`${table.workKey} ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'`,
    ),
    check(
      'work_inbox_item_source_version_length',
      sql`length(btrim(${table.sourceVersion})) between 1 and 200`,
    ),
    check(
      'work_inbox_item_digests',
      sql`${table.sourceDigest} ~ '^[0-9a-f]{64}$' and ${table.bodyDigest} ~ '^[0-9a-f]{64}$'`,
    ),
    check('work_inbox_item_title_length', sql`length(btrim(${table.title})) between 1 and 200`),
    check('work_inbox_item_body_size', sql`octet_length(${table.body}) <= 65536`),
    check('work_inbox_item_refs_object', sql`jsonb_typeof(${table.refs}) = 'object'`),
    check('work_inbox_item_refs_size', sql`octet_length(${table.refs}::text) <= 4096`),
    check(
      'work_inbox_item_return_fields',
      sql`(${table.status} = 'returned' and ${table.returnReason} is not null) or (${table.status} <> 'returned' and ${table.returnReason} is null and ${table.returnNote} is null)`,
    ),
    check(
      'work_inbox_item_self_supersede',
      sql`${table.supersedesId} is null or ${table.supersedesId} <> ${table.id}`,
    ),
    uniqueIndex('work_inbox_item_identity_unique').on(
      table.workId,
      table.sourceType,
      table.sourceId,
      table.sourceVersion,
      table.sourceDigest,
    ),
    // 同一来源至多一条 pending：应用层 supersede 漏掉时由 DB 直接拒绝。
    uniqueIndex('work_inbox_item_source_pending_unique')
      .on(table.workId, table.sourceType, table.sourceId)
      .where(sql`${table.status} = 'pending'`),
    index('work_inbox_item_source_retracted_idx')
      .on(table.workId, table.sourceType, table.sourceId)
      .where(sql`${table.status} = 'retracted'`),
    index('work_inbox_item_work_created_idx').on(table.workId, table.createdAt.desc(), table.id),
    index('work_inbox_item_work_status_created_idx').on(
      table.workId,
      table.status,
      table.createdAt.desc(),
      table.id,
    ),
    index('work_inbox_item_work_source_idx').on(
      table.workId,
      table.sourceType,
      table.sourceId,
      table.createdAt.desc(),
    ),
  ],
)

export type WorkInboxItemRow = typeof workInboxItems.$inferSelect
export type NewWorkInboxItemRow = typeof workInboxItems.$inferInsert
