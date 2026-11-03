import { sql } from 'drizzle-orm'
import {
  boolean,
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
import { projects } from './project.js'
import { runs } from './run.js'
import { works, workSourceType } from './work.js'
import { workSubscriptions } from './work-subscription.js'

// ADR-0028（RD-02a-1，Issue #489）：工作收件箱条目。交付/消费由 RD-02a-2 追加。
export const workInboxItemStatus = pgEnum('work_inbox_item_status', [
  'pending',
  'delivered',
  'unconfirmed',
  'consumed',
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
    // task_id 是 work.task_id 的不可变冗余，不建 FK：入口准入在 Work 锁内插入，
    // 若 FK 再对 task 取 KEY SHARE，会与既有 Task→Work 锁序形成反向边并 40P01。
    taskId: uuid('task_id').notNull(),
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
    // RD-02b：业务引用订阅的合并身份。同一 businessRef + sourceKind 的新版本替换旧
    // pending；correction 保持独立项，不能被版本推进吞掉。
    businessRef: varchar('business_ref', { length: 300 }),
    sourceKind: varchar('source_kind', { length: 64 }),
    supersedesId: uuid('supersedes_id').references((): AnyPgColumn => workInboxItems.id),
    // RD-02b：快路径交付的来源订阅；显式关联为空。撤销订阅只清理该订阅交付的未读副本。
    subscriptionId: uuid('subscription_id').references(() => workSubscriptions.id),
    // RD-02b：wait 自动保留的副本。生命周期清理只收口自动副本，RD-02a 的人工显式
    // 关联条目仍按原语义保留给 assignee 手工处置。
    autoAdmitted: boolean('auto_admitted').notNull().default(false),
    // 区分来源级撤权（tombstone，阻止同来源重投）与订阅副本撤回（可重新订阅）。
    retractionScope: varchar('retraction_scope', { length: 16 }),
    status: workInboxItemStatus('status').notNull().default('pending'),
    statusReason: varchar('status_reason', { length: 500 }),
    returnReason: workInboxReturnReason('return_reason'),
    returnNote: varchar('return_note', { length: 1000 }),
    deliveryRunId: uuid('delivery_run_id').references(() => runs.id),
    deliveredAt: timestamp('delivered_at', { withTimezone: true }),
    unconfirmedAt: timestamp('unconfirmed_at', { withTimezone: true }),
    consumedAt: timestamp('consumed_at', { withTimezone: true }),
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
      'work_inbox_item_business_ref_length',
      sql`${table.businessRef} is null or length(btrim(${table.businessRef})) between 1 and 300`,
    ),
    check(
      'work_inbox_item_source_kind_length',
      sql`${table.sourceKind} is null or length(btrim(${table.sourceKind})) between 1 and 64`,
    ),
    check(
      'work_inbox_item_retraction_scope_fields',
      sql`(${table.status} = 'retracted' and ${table.retractionScope} in ('source', 'subscription', 'lifecycle')) or (${table.status} <> 'retracted' and ${table.retractionScope} is null)`,
    ),
    check(
      'work_inbox_item_delivery_fields',
      sql`((${table.status} in ('delivered', 'unconfirmed', 'consumed')) and ${table.deliveryRunId} is not null and ${table.deliveredAt} is not null) or ((${table.status} in ('pending', 'returned', 'superseded', 'retracted', 'expired')) and ${table.deliveryRunId} is null and ${table.deliveredAt} is null and ${table.unconfirmedAt} is null and ${table.consumedAt} is null)`,
    ),
    check(
      'work_inbox_item_unconfirmed_fields',
      sql`(${table.status} = 'unconfirmed' and ${table.unconfirmedAt} is not null) or (${table.status} <> 'unconfirmed' and ${table.unconfirmedAt} is null)`,
    ),
    check(
      'work_inbox_item_consumed_fields',
      sql`(${table.status} = 'consumed' and ${table.consumedAt} is not null) or (${table.status} <> 'consumed' and ${table.consumedAt} is null)`,
    ),
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
    index('work_inbox_item_subscription_idx')
      .on(table.subscriptionId, table.status)
      .where(sql`${table.subscriptionId} is not null`),
    index('work_inbox_item_business_ref_idx')
      .on(table.workId, table.businessRef, table.sourceKind, table.status)
      .where(sql`${table.businessRef} is not null`),
    index('work_inbox_item_auto_admitted_idx')
      .on(table.workId, table.status)
      .where(sql`${table.autoAdmitted} = true`),
    index('work_inbox_item_delivery_run_idx')
      .on(table.deliveryRunId, table.status)
      .where(sql`${table.deliveryRunId} is not null`),
    index('work_inbox_item_unconfirmed_due_idx')
      .on(table.unconfirmedAt)
      .where(sql`${table.status} = 'unconfirmed'`),
  ],
)

export type WorkInboxItemRow = typeof workInboxItems.$inferSelect
export type NewWorkInboxItemRow = typeof workInboxItems.$inferInsert
