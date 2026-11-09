import { sql } from 'drizzle-orm'
import {
  bigint,
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
import { projects, tasks, taskMessages } from './project.js'
import { devices } from './device.js'
import { userAccounts } from './identity.js'
import { works, workMandates } from './work.js'
import type {
  RouterProposal,
  CoordinationUsage,
  ConfigureProjectRouterRequest,
} from '@whalepod/protocol'

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
    purpose: varchar('purpose', { length: 16 })
      .$type<'inference' | 'router' | 'discovery'>()
      .notNull()
      .default('inference'),
    workId: uuid('work_id').references(() => works.id),
    workKey: varchar('work_key', { length: 64 }),
    taskId: uuid('task_id').references(() => tasks.id),
    principalUserId: uuid('principal_user_id').references(() => userAccounts.id),
    mandateId: uuid('mandate_id').references(() => workMandates.id),
    mandateVersion: integer('mandate_version'),
    evaluationDigest: char('evaluation_digest', { length: 64 }),
    deviceId: uuid('device_id').references(() => devices.id),
    configVersion: integer('config_version'),
    discoveryDownloadedIds: jsonb('discovery_downloaded_ids')
      .$type<string[]>()
      .notNull()
      .default([]),
    discoverySourceId: uuid('discovery_source_id').references(() => taskMessages.id),
    routerContext: jsonb('router_context').$type<{
      sourceType: 'task_message' | 'context_entry'
      sourceId: string
      triggerKey: string
    }>(),
    configSnapshot: jsonb('config_snapshot').$type<ConfigureProjectRouterRequest>(),
    readEntryIds: jsonb('read_entry_ids').$type<string[]>().notNull().default([]),
    modelStartedAt: timestamp('model_started_at', { withTimezone: true }),
    preModelFailureConfirmed: boolean('pre_model_failure_confirmed').notNull().default(false),
    leaseToken: varchar('lease_token', { length: 256 }),
    leaseExpiresAt: timestamp('lease_expires_at', { withTimezone: true }),
    deadlineAt: timestamp('deadline_at', { withTimezone: true }),
    inputTokensEstimate: integer('input_tokens_estimate'),
    reservedTokens: bigint('reserved_tokens', { mode: 'number' }),
    reservedCostMicros: bigint('reserved_cost_micros', { mode: 'number' }),
    routerProposal: jsonb('router_proposal').$type<RouterProposal>(),
    usage: jsonb('usage').$type<CoordinationUsage>(),
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
      sql`${table.status} <> 'completed' or (${table.resultDigest} is not null and ((${table.purpose} = 'inference' and ${table.inferenceEntryId} is not null and ${table.routerProposal} is null) or (${table.purpose} = 'router' and ${table.inferenceEntryId} is null and ${table.routerProposal} is not null) or (${table.purpose} = 'discovery' and ${table.inferenceEntryId} is null and ${table.routerProposal} is null)))`,
    ),
    check(
      'coordination_evaluation_purpose',
      sql`${table.purpose} in ('inference', 'router', 'discovery')`,
    ),
    check(
      'coordination_evaluation_router_binding',
      sql`${table.purpose} <> 'router' or (${table.workId} is not null and ${table.workKey} is not null and ${table.taskId} is not null and ${table.principalUserId} is not null and ${table.mandateId} is not null and ${table.mandateVersion} is not null and ${table.mandateVersion} > 0 and ${table.evaluationDigest} is not null and ${table.evaluationDigest} ~ '^[a-f0-9]{64}$' and ${table.routerContext} is not null and ${table.configSnapshot} is not null)`,
    ),
    check(
      'coordination_evaluation_discovery_binding',
      sql`(${table.purpose} <> 'discovery' and ${table.discoverySourceId} is null) or (${table.purpose} = 'discovery' and ${table.discoverySourceId} is not null and ${table.workId} is null and ${table.workKey} is null and ${table.taskId} is null and ${table.mandateId} is null and ${table.mandateVersion} is null and ${table.principalUserId} is not null and ${table.deviceId} is not null and ${table.evaluationDigest} is not null and ${table.configVersion} is not null and ${table.configVersion} > 0 and ${table.configSnapshot} is not null and ${table.routerContext} is null and ${table.routerProposal} is null and ${table.inferenceEntryId} is null)`,
    ),
    uniqueIndex('coordination_evaluation_input_attempt_unique').on(
      table.projectId,
      table.purpose,
      sql`coalesce(${table.evaluationDigest}, ${table.inputDigest})`,
      table.attempt,
    ),
    uniqueIndex('coordination_evaluation_one_queued')
      .on(table.projectId, table.purpose, sql`coalesce(${table.workKey}, '')`)
      .where(sql`${table.status} = 'queued'`),
    uniqueIndex('coordination_evaluation_one_completed_per_input')
      .on(
        table.projectId,
        table.purpose,
        sql`coalesce(${table.evaluationDigest}, ${table.inputDigest})`,
      )
      .where(sql`${table.status} = 'completed'`),
    uniqueIndex('coordination_evaluation_one_running')
      .on(table.projectId)
      .where(sql`${table.status} in ('dispatched', 'running')`),
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
