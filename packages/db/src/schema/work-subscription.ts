import { sql } from 'drizzle-orm'
import {
  check,
  index,
  integer,
  pgEnum,
  pgTable,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core'
import { projects, tasks } from './project.js'
import { userAccounts } from './identity.js'
import { works, workMandates } from './work.js'

// ADR-0028（RD-02b）：显式工作订阅与入口准入观测。
// 订阅只表达「内部来源属于当前持续职责」，不授予执行权；入口准入记录快/慢路径
// 决定，但只保存不透明 id、摘要与计数。

export const workSubscriptionTargetType = pgEnum('work_subscription_target_type', [
  'task',
  'business_ref',
])
export const workSubscriptionStatus = pgEnum('work_subscription_status', [
  'active',
  'revoked',
  'stale',
])
export const workEntryAdmissionOutcome = pgEnum('work_entry_admission_outcome', [
  'deliver',
  'route_router',
  'drop',
  'wait',
])
export const workEntryAdmissionTrigger = pgEnum('work_entry_admission_trigger', [
  'source',
  'return',
])

export const workSubscriptions = pgTable(
  'work_subscription',
  {
    id: uuid('id').primaryKey(),
    workId: uuid('work_id')
      .notNull()
      .references(() => works.id),
    workKey: varchar('work_key', { length: 64 }).notNull(),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id),
    taskId: uuid('task_id')
      .notNull()
      .references(() => tasks.id),
    targetType: workSubscriptionTargetType('target_type').notNull(),
    targetRef: varchar('target_ref', { length: 200 }).notNull(),
    status: workSubscriptionStatus('status').notNull().default('active'),
    // 来源侧授权代次；外部来源接入 PC-03b 后由权限链填充，本切片内部来源为常量。
    authorizationGeneration: varchar('authorization_generation', { length: 128 }).notNull(),
    // 创建订阅时绑定 Mandate 版本：新版本/暂停/撤销使旧订阅 stale，须重新确认。
    mandateId: uuid('mandate_id')
      .notNull()
      .references(() => workMandates.id),
    mandateVersion: integer('mandate_version').notNull(),
    createdByUserId: uuid('created_by_user_id')
      .notNull()
      .references(() => userAccounts.id),
    endedByUserId: uuid('ended_by_user_id').references(() => userAccounts.id),
    statusReason: varchar('status_reason', { length: 500 }),
    endedAt: timestamp('ended_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    check(
      'work_subscription_work_key_format',
      sql`${table.workKey} ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'`,
    ),
    check(
      'work_subscription_target_ref_length',
      sql`length(btrim(${table.targetRef})) between 1 and 200`,
    ),
    check('work_subscription_mandate_version', sql`${table.mandateVersion} >= 1`),
    check(
      'work_subscription_status_fields',
      sql`(${table.status} = 'active' and ${table.endedAt} is null and ${table.endedByUserId} is null and ${table.statusReason} is null) or (${table.status} in ('revoked', 'stale') and ${table.endedAt} is not null and ${table.statusReason} is not null)`,
    ),
    uniqueIndex('work_subscription_active_unique')
      .on(table.workId, table.targetType, table.targetRef)
      .where(sql`${table.status} = 'active'`),
    index('work_subscription_work_status_created_idx').on(
      table.workId,
      table.status,
      table.createdAt.desc(),
      table.id,
    ),
    index('work_subscription_mandate_idx').on(table.mandateId),
    index('work_subscription_task_idx').on(table.taskId),
  ],
)

export type WorkSubscriptionRow = typeof workSubscriptions.$inferSelect
export type NewWorkSubscriptionRow = typeof workSubscriptions.$inferInsert
