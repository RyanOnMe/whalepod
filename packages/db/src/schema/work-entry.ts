import { sql } from 'drizzle-orm'
import {
  boolean,
  char,
  check,
  index,
  pgTable,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core'
import { projects } from './project.js'
import { coordinationEvaluations } from './coordination.js'
import { works, workSourceType } from './work.js'
import { workInboxItems } from './work-inbox.js'
import {
  workEntryAdmissionOutcome,
  workEntryAdmissionTrigger,
  workSubscriptions,
} from './work-subscription.js'

// ADR-0028（RD-02b）：入口准入的逐事件账本。快路径 deliver 不调用 Router；
// route_router 必须留下独立的 Router 调用记录，禁止只写布尔标记冒充「已路由」。
// RD-02b 的 Router 只是端口（尚无模型决定），因此调用记录与 RD-01 的影子
// router_decision 分表存放：自动入口不会占用「同一来源只裁决一次」的唯一键。

export const workEntryRouterCalls = pgTable(
  'work_entry_router_call',
  {
    id: uuid('id').primaryKey(),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id),
    // task_id 是 work.task_id 的不可变冗余，不建 FK：入口准入在 Work 锁内插入，
    // 若 FK 再对 task 取 KEY SHARE，会与既有 Task→Work 锁序形成反向边并 40P01。
    taskId: uuid('task_id').notNull(),
    workId: uuid('work_id')
      .notNull()
      .references(() => works.id),
    workKey: varchar('work_key', { length: 64 }).notNull(),
    evaluationId: uuid('evaluation_id').references(() => coordinationEvaluations.id),
    resolvedAt: timestamp('resolved_at', { withTimezone: true }),
    resolutionReason: varchar('resolution_reason', { length: 64 }),
    reason: varchar('reason', { length: 500 }).notNull(),
    rulesVersion: varchar('rules_version', { length: 64 }).notNull(),
    inputDigest: char('input_digest', { length: 64 }).notNull(),
    sourceType: workSourceType('source_type').notNull(),
    sourceId: uuid('source_id').notNull(),
    sourceVersion: varchar('source_version', { length: 200 }).notNull(),
    sourceDigest: char('source_digest', { length: 64 }).notNull(),
    authorizationGeneration: varchar('authorization_generation', { length: 128 }).notNull(),
    dedupeKey: varchar('dedupe_key', { length: 400 }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    check(
      'work_entry_router_call_work_key_format',
      sql`${table.workKey} ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'`,
    ),
    check(
      'work_entry_router_call_reason_length',
      sql`length(btrim(${table.reason})) between 1 and 500`,
    ),
    check(
      'work_entry_router_call_digests',
      sql`${table.inputDigest} ~ '^[0-9a-f]{64}$' and ${table.sourceDigest} ~ '^[0-9a-f]{64}$'`,
    ),
    uniqueIndex('work_entry_router_call_dedupe_unique').on(table.dedupeKey),
    index('work_entry_router_call_unresolved_idx')
      .on(table.createdAt, table.id)
      .where(sql`${table.resolvedAt} is null`),
    index('work_entry_router_call_work_created_idx').on(
      table.workId,
      table.createdAt.desc(),
      table.id,
    ),
  ],
)

export const workEntryAdmissions = pgTable(
  'work_entry_admission',
  {
    id: uuid('id').primaryKey(),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id),
    // task_id 是 work.task_id 的不可变冗余，不建 FK：入口准入在 Work 锁内插入，
    // 若 FK 再对 task 取 KEY SHARE，会与既有 Task→Work 锁序形成反向边并 40P01。
    taskId: uuid('task_id').notNull(),
    workId: uuid('work_id')
      .notNull()
      .references(() => works.id),
    workKey: varchar('work_key', { length: 64 }).notNull(),
    trigger: workEntryAdmissionTrigger('trigger').notNull(),
    outcome: workEntryAdmissionOutcome('outcome').notNull(),
    reason: varchar('reason', { length: 500 }).notNull(),
    sourceType: workSourceType('source_type').notNull(),
    sourceId: uuid('source_id').notNull(),
    sourceVersion: varchar('source_version', { length: 200 }).notNull(),
    sourceDigest: char('source_digest', { length: 64 }).notNull(),
    authorizationGeneration: varchar('authorization_generation', { length: 128 }).notNull(),
    subscriptionId: uuid('subscription_id').references(() => workSubscriptions.id),
    inboxItemId: uuid('inbox_item_id').references(() => workInboxItems.id),
    routerInvoked: boolean('router_invoked').notNull(),
    routerCallId: uuid('router_call_id').references(() => workEntryRouterCalls.id),
    deadlineAt: timestamp('deadline_at', { withTimezone: true }),
    dedupeKey: varchar('dedupe_key', { length: 400 }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    check(
      'work_entry_admission_work_key_format',
      sql`${table.workKey} ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'`,
    ),
    check(
      'work_entry_admission_source_version_length',
      sql`length(btrim(${table.sourceVersion})) between 1 and 200`,
    ),
    check('work_entry_admission_digest_format', sql`${table.sourceDigest} ~ '^[0-9a-f]{64}$'`),
    check(
      'work_entry_admission_reason_length',
      sql`length(btrim(${table.reason})) between 1 and 500`,
    ),
    check(
      'work_entry_admission_outcome_fields',
      sql`(${table.outcome} = 'deliver' and ${table.subscriptionId} is not null and ${table.inboxItemId} is not null and ${table.routerInvoked} = false and ${table.routerCallId} is null and ${table.deadlineAt} is null) or (${table.outcome} = 'route_router' and ${table.routerInvoked} = true and ${table.routerCallId} is not null and ${table.deadlineAt} is null) or (${table.outcome} = 'wait' and ${table.routerInvoked} = false and ${table.routerCallId} is null and ${table.deadlineAt} is not null) or (${table.outcome} = 'drop' and ${table.routerInvoked} = false and ${table.routerCallId} is null and ${table.deadlineAt} is null)`,
    ),
    uniqueIndex('work_entry_admission_dedupe_unique').on(table.dedupeKey),
    index('work_entry_admission_work_created_idx').on(
      table.workId,
      table.createdAt.desc(),
      table.id,
    ),
    index('work_entry_admission_task_created_idx').on(
      table.taskId,
      table.createdAt.desc(),
      table.id,
    ),
    index('work_entry_admission_source_idx').on(
      table.sourceType,
      table.sourceId,
      table.createdAt.desc(),
    ),
  ],
)

export type WorkEntryRouterCallRow = typeof workEntryRouterCalls.$inferSelect
export type NewWorkEntryRouterCallRow = typeof workEntryRouterCalls.$inferInsert
export type WorkEntryAdmissionRow = typeof workEntryAdmissions.$inferSelect
export type NewWorkEntryAdmissionRow = typeof workEntryAdmissions.$inferInsert
