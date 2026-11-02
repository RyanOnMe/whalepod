import { sql } from 'drizzle-orm'
import {
  boolean,
  char,
  check,
  foreignKey,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core'
import { userAccounts } from './identity.js'
import { projects } from './project.js'
import { runs } from './run.js'
import { contextCitationKind } from './context.js'

// ADR-0027（PC-05a）：Run 项目上下文快照。快照只在创建事务里冻结一次；
// 后续新版本/纠正/撤权不修改已冻结正文。来源撤销状态机与终态清理见 PC-05b。
export const runProjectContextStatus = pgEnum('run_project_context_status', [
  'frozen',
  'partially_unavailable',
  'invalidated',
])
export const runProjectContextEntryKind = pgEnum('run_project_context_entry_kind', [
  'observation',
  'decision',
])
export const runProjectContextEntryStatus = pgEnum('run_project_context_entry_status', [
  'frozen',
  'retracted',
  'source_tombstoned',
])

export const runProjectContexts = pgTable(
  'run_project_context',
  {
    id: uuid('id').primaryKey(),
    runId: uuid('run_id')
      .notNull()
      .unique()
      .references(() => runs.id),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id),
    selectionRuleVersion: varchar('selection_rule_version', { length: 64 }).notNull(),
    snapshotDigest: char('snapshot_digest', { length: 64 }).notNull(),
    headerText: text('header_text').notNull(),
    headerDigest: char('header_digest', { length: 64 }).notNull(),
    entryCount: integer('entry_count').notNull(),
    totalBytes: integer('total_bytes').notNull(),
    unselected: jsonb('unselected').$type<unknown[]>().notNull().default([]),
    // 超出逐条明细上限的未纳入项按原因聚合；与 unselected 合计才是全量。
    unselectedOmitted: jsonb('unselected_omitted')
      .$type<Partial<Record<string, number>>>()
      .notNull()
      .default({}),
    overrideReason: varchar('override_reason', { length: 1000 }),
    status: runProjectContextStatus('status').notNull().default('frozen'),
    deliveredAt: timestamp('delivered_at', { withTimezone: true }),
    consumedAt: timestamp('consumed_at', { withTimezone: true }),
    consumedAllAt: timestamp('consumed_all_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    check('run_project_context_digest', sql`${table.snapshotDigest} ~ '^[a-f0-9]{64}$'`),
    check('run_project_context_header_digest', sql`${table.headerDigest} ~ '^[a-f0-9]{64}$'`),
    check(
      'run_project_context_header_length',
      sql`char_length(${table.headerText}) between 1 and 4000`,
    ),
    check('run_project_context_entry_count', sql`${table.entryCount} between 0 and 32`),
    check('run_project_context_total_bytes', sql`${table.totalBytes} between 0 and 262144`),
    check(
      'run_project_context_unselected_array',
      sql`jsonb_typeof(${table.unselected}) = 'array' and octet_length(${table.unselected}::text) <= 16384`,
    ),
    check(
      'run_project_context_unselected_omitted_object',
      sql`jsonb_typeof(${table.unselectedOmitted}) = 'object'`,
    ),
    check(
      'run_project_context_consumed_order',
      sql`${table.consumedAllAt} is null or ${table.consumedAt} is not null`,
    ),
    index('run_project_context_project_created_idx').on(
      table.projectId,
      table.createdAt.desc(),
      table.id,
    ),
  ],
)

export const runProjectContextEntries = pgTable(
  'run_project_context_entry',
  {
    snapshotId: uuid('snapshot_id')
      .notNull()
      .references(() => runProjectContexts.id),
    entryId: uuid('entry_id').notNull(),
    entryVersion: varchar('entry_version', { length: 200 }).notNull(),
    kind: runProjectContextEntryKind('kind').notNull(),
    citation: contextCitationKind('citation').notNull(),
    sourceId: uuid('source_id'),
    revisionId: uuid('revision_id'),
    threadId: uuid('thread_id'),
    businessRef: varchar('business_ref', { length: 300 }),
    authorizationGeneration: varchar('authorization_generation', { length: 128 }),
    digest: char('digest', { length: 64 }).notNull(),
    byteSize: integer('byte_size').notNull(),
    title: varchar('title', { length: 200 }).notNull(),
    body: text('body').notNull().default(''),
    entryStatus: runProjectContextEntryStatus('entry_status').notNull().default('frozen'),
    statusReason: varchar('status_reason', { length: 500 }),
    permissionStateAtSelection: varchar('permission_state_at_selection', { length: 64 })
      .notNull()
      .default('authorized'),
    identityUnverified: boolean('identity_unverified').notNull().default(false),
    selectedByMemberId: uuid('selected_by_member_id').references(() => userAccounts.id),
    deliveredAt: timestamp('delivered_at', { withTimezone: true }),
    readAt: timestamp('read_at', { withTimezone: true }),
  },
  (table) => [
    primaryKey({ columns: [table.snapshotId, table.entryId] }),
    check(
      'run_project_context_entry_version',
      sql`length(btrim(${table.entryVersion})) between 1 and 200`,
    ),
    check('run_project_context_entry_digest', sql`${table.digest} ~ '^[a-f0-9]{64}$'`),
    check(
      'run_project_context_entry_size',
      sql`${table.byteSize} between 0 and 65536 and ${table.byteSize} = octet_length(${table.body}) and octet_length(${table.body}) <= 65536`,
    ),
    check('run_project_context_entry_title', sql`length(btrim(${table.title})) between 1 and 200`),
    check(
      'run_project_context_entry_read_after_delivery',
      sql`${table.readAt} is null or ${table.deliveredAt} is not null`,
    ),
    check(
      'run_project_context_entry_decision_fields',
      sql`${table.kind} <> 'decision' or (${table.businessRef} is not null and ${table.authorizationGeneration} is null and ${table.revisionId} is null)`,
    ),
    check(
      'run_project_context_entry_observation_fields',
      sql`${table.kind} <> 'observation' or ((${table.businessRef} is not null and ${table.revisionId} is null and ${table.authorizationGeneration} is null) or (${table.businessRef} is null and ${table.revisionId} is not null and ${table.authorizationGeneration} is not null))`,
    ),
    check(
      'run_project_context_entry_status_reason',
      sql`(${table.entryStatus} = 'frozen' and ${table.statusReason} is null) or (${table.entryStatus} <> 'frozen' and ${table.statusReason} is not null)`,
    ),
    index('run_project_context_entry_entry_idx').on(table.entryId),
  ],
)

export const runContextReceipts = pgTable(
  'run_context_receipt',
  {
    id: uuid('id').primaryKey(),
    runId: uuid('run_id')
      .notNull()
      .references(() => runs.id),
    snapshotId: uuid('snapshot_id')
      .notNull()
      .references(() => runProjectContexts.id),
    receiptSeq: integer('receipt_seq').notNull(),
    headerDigest: char('header_digest', { length: 64 }).notNull(),
    nonceMatched: boolean('nonce_matched').notNull(),
    entriesDelivered: jsonb('entries_delivered').$type<string[]>().notNull(),
    entriesRead: jsonb('entries_read').$type<string[]>().notNull(),
    readEvents: jsonb('read_events').$type<unknown[]>().notNull(),
    missing: jsonb('missing').$type<string[]>().notNull(),
    digestVerified: boolean('digest_verified').notNull(),
    at: timestamp('at', { withTimezone: true }).notNull(),
    receivedAt: timestamp('received_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    unique('run_context_receipt_run_snapshot_seq_unique').on(
      table.runId,
      table.snapshotId,
      table.receiptSeq,
    ),
    check('run_context_receipt_seq', sql`${table.receiptSeq} >= 1`),
    check('run_context_receipt_header_digest', sql`${table.headerDigest} ~ '^[a-f0-9]{64}$'`),
    check(
      'run_context_receipt_arrays',
      sql`jsonb_typeof(${table.entriesDelivered}) = 'array' and jsonb_typeof(${table.entriesRead}) = 'array' and jsonb_typeof(${table.readEvents}) = 'array' and jsonb_typeof(${table.missing}) = 'array'`,
    ),
    check(
      'run_context_receipt_size',
      sql`octet_length(${table.entriesDelivered}::text) <= 8192 and octet_length(${table.entriesRead}::text) <= 8192 and octet_length(${table.readEvents}::text) <= 16384 and octet_length(${table.missing}::text) <= 8192`,
    ),
  ],
)

export const runContextConsumptions = pgTable(
  'run_context_consumption',
  {
    snapshotId: uuid('snapshot_id').notNull(),
    entryId: uuid('entry_id').notNull(),
    threadId: uuid('thread_id'),
    runId: uuid('run_id')
      .notNull()
      .references(() => runs.id),
    readAt: timestamp('read_at', { withTimezone: true }).notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.snapshotId, table.entryId] }),
    // 与 migration 0023 的复合外键对齐：消费行必须指向本快照内的条目。
    foreignKey({
      columns: [table.snapshotId, table.entryId],
      foreignColumns: [runProjectContextEntries.snapshotId, runProjectContextEntries.entryId],
      name: 'run_context_consumption_snapshot_entry_fk',
    }),
  ],
)

export type RunProjectContextRow = typeof runProjectContexts.$inferSelect
export type RunProjectContextEntryRow = typeof runProjectContextEntries.$inferSelect
export type RunContextReceiptRow = typeof runContextReceipts.$inferSelect
export type RunContextConsumptionRow = typeof runContextConsumptions.$inferSelect
