import { sql } from 'drizzle-orm'
import {
  boolean,
  char,
  check,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core'
import { contextEntries } from './context.js'
import { projects } from './project.js'

// ADR-0026（PC-04a）：确定性内部协调。本切片只使用 queued/completed/skipped/failed；
// 其余枚举值留给模型/Node 路径，先固化类型避免后续迁移。
export const coordinationEvaluationStatus = pgEnum('coordination_evaluation_status', [
  'queued',
  'dispatched',
  'running',
  'completed',
  'failed',
  'cancelled',
  'skipped',
  'stale',
])

export const coordinationEvaluations = pgTable(
  'coordination_evaluation',
  {
    id: uuid('id').primaryKey(),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id),
    status: coordinationEvaluationStatus('status').notNull().default('queued'),
    attempt: integer('attempt').notNull().default(1),
    inputDigest: char('input_digest', { length: 64 }).notNull(),
    inputManifest: jsonb('input_manifest').$type<Record<string, unknown>>().notNull().default({}),
    manifestVersion: integer('manifest_version').notNull().default(1),
    rulesVersion: varchar('rules_version', { length: 64 }).notNull(),
    processorVersion: varchar('processor_version', { length: 64 }).notNull(),
    queuedAt: timestamp('queued_at', { withTimezone: true }).notNull().defaultNow(),
    queueExpiresAt: timestamp('queue_expires_at', { withTimezone: true }).notNull(),
    coalescedAt: timestamp('coalesced_at', { withTimezone: true }),
    startedAt: timestamp('started_at', { withTimezone: true }),
    finishedAt: timestamp('finished_at', { withTimezone: true }),
    failureCode: varchar('failure_code', { length: 64 }),
    failureSummary: varchar('failure_summary', { length: 1000 }),
    resultDigest: char('result_digest', { length: 64 }),
    inferenceEntryId: uuid('inference_entry_id').references(() => contextEntries.id),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    check('coordination_evaluation_attempt', sql`${table.attempt} >= 1`),
    check(
      'coordination_evaluation_manifest_object',
      sql`jsonb_typeof(${table.inputManifest}) = 'object'`,
    ),
    check(
      'coordination_evaluation_manifest_size',
      sql`octet_length(${table.inputManifest}::text) <= 65536`,
    ),
    check(
      'coordination_evaluation_queued_fields',
      sql`${table.status} <> 'queued' or (${table.queuedAt} is not null and ${table.queueExpiresAt} is not null)`,
    ),
    check(
      'coordination_evaluation_terminal_fields',
      sql`${table.status} not in ('completed', 'failed', 'cancelled', 'skipped', 'stale') or ${table.finishedAt} is not null`,
    ),
    check(
      'coordination_evaluation_completed_fields',
      sql`${table.status} <> 'completed' or (${table.resultDigest} is not null and ${table.inferenceEntryId} is not null)`,
    ),
    uniqueIndex('coordination_evaluation_input_attempt_unique').on(
      table.projectId,
      table.inputDigest,
      table.attempt,
    ),
    uniqueIndex('coordination_evaluation_one_queued')
      .on(table.projectId)
      .where(sql`${table.status} = 'queued'`),
    uniqueIndex('coordination_evaluation_one_completed_per_input')
      .on(table.projectId, table.inputDigest)
      .where(sql`${table.status} = 'completed'`),
    index('coordination_evaluation_project_created_idx').on(
      table.projectId,
      table.createdAt.desc(),
      table.id,
    ),
  ],
)

export const projectCoordinatorStates = pgTable(
  'project_coordinator_state',
  {
    projectId: uuid('project_id')
      .primaryKey()
      .references(() => projects.id),
    enabled: boolean('enabled').notNull().default(true),
    rulesVersion: varchar('rules_version', { length: 64 }).notNull(),
    processorVersion: varchar('processor_version', { length: 64 }).notNull(),
    lastSuccessfulEvaluationId: uuid('last_successful_evaluation_id').references(
      () => coordinationEvaluations.id,
    ),
    pausedAt: timestamp('paused_at', { withTimezone: true }),
    pauseReason: varchar('pause_reason', { length: 500 }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    check(
      'project_coordinator_state_paused',
      sql`(${table.pausedAt} is null) = (${table.pauseReason} is null)`,
    ),
  ],
)

export type CoordinationEvaluationRow = typeof coordinationEvaluations.$inferSelect
export type NewCoordinationEvaluationRow = typeof coordinationEvaluations.$inferInsert
export type ProjectCoordinatorStateRow = typeof projectCoordinatorStates.$inferSelect
