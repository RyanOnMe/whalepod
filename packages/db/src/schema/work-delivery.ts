import {
  char,
  check,
  index,
  integer,
  pgEnum,
  pgTable,
  timestamp,
  unique,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core'
import { sql } from 'drizzle-orm'
import { projects, tasks } from './project.js'
import { runs } from './run.js'
import { works } from './work.js'
import { workInboxItems } from './work-inbox.js'

// ADR-0028（RD-02a-2a）：收件箱条目的交付尝试与消费对账。item 上的 delivery_*
// 字段是当前交付指针，本表保留每次尝试历史；消费写入由 RD-02a-2b 启用。
export const workInboxDeliveryStatus = pgEnum('work_inbox_delivery_status', [
  'sent',
  'unconfirmed',
  'returned',
  'consumed',
  'duplicate',
  'duplicate_consumption',
  'withdrawn',
])

export const workInputConsumptionKind = pgEnum('work_input_consumption_kind', [
  'consumed',
  'duplicate',
  'duplicate_consumption',
])

export const workInboxDeliveries = pgTable(
  'work_inbox_delivery',
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
    inboxItemId: uuid('inbox_item_id')
      .notNull()
      .references(() => workInboxItems.id),
    runId: uuid('run_id')
      .notNull()
      .references(() => runs.id),
    manifestDigest: char('manifest_digest', { length: 64 }).notNull(),
    attempt: integer('attempt').notNull(),
    status: workInboxDeliveryStatus('status').notNull().default('sent'),
    sentAt: timestamp('sent_at', { withTimezone: true }).notNull(),
    ackedAt: timestamp('acked_at', { withTimezone: true }),
    failedAt: timestamp('failed_at', { withTimezone: true }),
    settledAt: timestamp('settled_at', { withTimezone: true }),
    failureReason: varchar('failure_reason', { length: 200 }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    check('work_inbox_delivery_attempt_positive', sql`${table.attempt} > 0`),
    check('work_inbox_delivery_manifest_digest', sql`${table.manifestDigest} ~ '^[a-f0-9]{64}$'`),
    unique('work_inbox_delivery_attempt_unique').on(table.inboxItemId, table.runId, table.attempt),
    index('work_inbox_delivery_run_status_idx').on(table.runId, table.status),
  ],
)

export const workInputConsumptions = pgTable(
  'work_input_consumption',
  {
    id: uuid('id').primaryKey(),
    inboxItemId: uuid('inbox_item_id')
      .notNull()
      .references(() => workInboxItems.id),
    workId: uuid('work_id')
      .notNull()
      .references(() => works.id),
    workKey: varchar('work_key', { length: 64 }).notNull(),
    runId: uuid('run_id')
      .notNull()
      .references(() => runs.id),
    manifestDigest: char('manifest_digest', { length: 64 }).notNull(),
    kind: workInputConsumptionKind('kind').notNull(),
    receiptId: uuid('receipt_id'),
    readAt: timestamp('read_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    check(
      'work_input_consumption_manifest_digest',
      sql`${table.manifestDigest} ~ '^[a-f0-9]{64}$'`,
    ),
    index('work_input_consumption_run_idx').on(table.runId, table.kind),
  ],
)

export type WorkInboxDeliveryRow = typeof workInboxDeliveries.$inferSelect
export type NewWorkInboxDeliveryRow = typeof workInboxDeliveries.$inferInsert
export type WorkInputConsumptionRow = typeof workInputConsumptions.$inferSelect
export type NewWorkInputConsumptionRow = typeof workInputConsumptions.$inferInsert
