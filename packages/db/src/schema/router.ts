import { sql } from 'drizzle-orm'
import {
  bigint,
  boolean,
  check,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core'
import type { CoordinationUsage } from '@whalepod/protocol'
import { projects } from './project.js'
import { devices } from './device.js'
import { userAccounts, teams } from './identity.js'
import { coordinationEvaluations } from './coordination.js'

/** Explicit configuration; no endpoint or secret crosses the Hub. */
export const routerConfigurations = pgTable(
  'router_configuration',
  {
    projectId: uuid('project_id')
      .primaryKey()
      .references(() => projects.id),
    enabled: boolean('enabled').notNull(),
    configVersion: integer('config_version').notNull(),
    deviceId: uuid('device_id')
      .notNull()
      .references(() => devices.id),
    operatorUserId: uuid('operator_user_id')
      .notNull()
      .references(() => userAccounts.id),
    billingUserId: uuid('billing_user_id')
      .notNull()
      .references(() => userAccounts.id),
    configuredByUserId: uuid('configured_by_user_id')
      .notNull()
      .references(() => userAccounts.id),
    credentialSlot: varchar('credential_slot', { length: 80 }).notNull(),
    credentialConfigRevision: varchar('credential_config_revision', { length: 128 }).notNull(),
    provider: varchar('provider', { length: 100 }).notNull(),
    model: varchar('model', { length: 200 }).notNull(),
    teamDailyCallLimit: bigint('team_daily_call_limit', { mode: 'number' }).notNull(),
    teamDailyTokenLimit: bigint('team_daily_token_limit', { mode: 'number' }).notNull(),
    teamDailyCostMicrosLimit: bigint('team_daily_cost_micros_limit', { mode: 'number' }).notNull(),
    projectDailyCallLimit: bigint('project_daily_call_limit', { mode: 'number' }).notNull(),
    projectDailyTokenLimit: bigint('project_daily_token_limit', { mode: 'number' }).notNull(),
    projectDailyCostMicrosLimit: bigint('project_daily_cost_micros_limit', {
      mode: 'number',
    }).notNull(),
    maxInputTokens: integer('max_input_tokens').notNull(),
    maxOutputTokens: integer('max_output_tokens').notNull(),
    maxCostMicros: bigint('max_cost_micros', { mode: 'number' }).notNull(),
    inputPriceMicrosPerMillionTokens: bigint('input_price_micros_per_million_tokens', {
      mode: 'number',
    }).notNull(),
    outputPriceMicrosPerMillionTokens: bigint('output_price_micros_per_million_tokens', {
      mode: 'number',
    }).notNull(),
    timeoutSeconds: integer('timeout_seconds').notNull(),
    maxRetries: integer('max_retries').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    check(
      'router_configuration_limits',
      sql`${table.configVersion} > 0 and ${table.maxInputTokens} > 0 and ${table.maxOutputTokens} > 0 and ${table.maxCostMicros} > 0 and ${table.timeoutSeconds} between 1 and 120 and ${table.maxRetries} between 0 and 10`,
    ),
  ],
)

/** Shared day budgets; work uses lifetime date to prevent midnight/mandate resets. */
export const coordinationBudgets = pgTable(
  'coordination_budget',
  {
    scope: varchar('scope', { length: 16 }).$type<'team' | 'project' | 'work'>().notNull(),
    scopeId: uuid('scope_id').notNull(),
    utcDate: varchar('utc_date', { length: 10 }).notNull(),
    calls: bigint('calls', { mode: 'number' }).notNull().default(0),
    retryAttempts: integer('retry_attempts').notNull().default(0),
    inputTokens: bigint('input_tokens', { mode: 'number' }).notNull().default(0),
    outputTokens: bigint('output_tokens', { mode: 'number' }).notNull().default(0),
    costMicros: bigint('cost_micros', { mode: 'number' }).notNull().default(0),
    reservedTokens: bigint('reserved_tokens', { mode: 'number' }).notNull().default(0),
    reservedCostMicros: bigint('reserved_cost_micros', { mode: 'number' }).notNull().default(0),
  },
  (table) => [
    primaryKey({ columns: [table.scope, table.scopeId, table.utcDate] }),
    check('coordination_budget_scope', sql`${table.scope} in ('team','project','work')`),
    check(
      'coordination_budget_nonnegative',
      sql`${table.calls} >= 0 and ${table.retryAttempts} >= 0 and ${table.inputTokens} >= 0 and ${table.outputTokens} >= 0 and ${table.costMicros} >= 0 and ${table.reservedTokens} >= 0 and ${table.reservedCostMicros} >= 0`,
    ),
  ],
)
export const coordinationUsageLedger = pgTable(
  'coordination_usage_ledger',
  {
    id: uuid('id').primaryKey(),
    evaluationId: uuid('evaluation_id')
      .notNull()
      .references(() => coordinationEvaluations.id),
    attempt: integer('attempt').notNull(),
    phase: varchar('phase', { length: 16 }).$type<'reserved' | 'settled'>().notNull(),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id),
    teamId: uuid('team_id').notNull(),
    workKey: uuid('work_key').notNull(),
    utcDate: varchar('utc_date', { length: 10 }).notNull(),
    reservedTokens: bigint('reserved_tokens', { mode: 'number' }).notNull(),
    reservedCostMicros: bigint('reserved_cost_micros', { mode: 'number' }).notNull(),
    chargeMode: varchar('charge_mode', { length: 16 }).$type<'zero' | 'reserved' | 'actual'>(),
    usage: jsonb('usage').$type<CoordinationUsage>(),
    retry: boolean('retry').notNull().default(false),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('coordination_usage_ledger_once').on(
      table.evaluationId,
      table.attempt,
      table.phase,
    ),
    check('coordination_usage_ledger_phase', sql`${table.phase} in ('reserved','settled')`),
    check(
      'coordination_usage_ledger_values',
      sql`${table.attempt}>0 and ${table.reservedTokens}>=0 and ${table.reservedCostMicros}>=0 and (${table.phase}<>'reserved' or ${table.usage} is null)`,
    ),
  ],
)
export type RouterConfigRow = typeof routerConfigurations.$inferSelect
export type CoordinationBudgetRow = typeof coordinationBudgets.$inferSelect
export type CoordinationLedgerRow = typeof coordinationUsageLedger.$inferSelect

export const coordinationTeamPolicies = pgTable(
  'coordination_team_policy',
  {
    teamId: uuid('team_id')
      .primaryKey()
      .references(() => teams.id),
    dailyCallLimit: bigint('daily_call_limit', { mode: 'number' }).notNull(),
    dailyTokenLimit: bigint('daily_token_limit', { mode: 'number' }).notNull(),
    dailyCostMicrosLimit: bigint('daily_cost_micros_limit', { mode: 'number' }).notNull(),
    version: integer('version').notNull().default(1),
    updatedByUserId: uuid('updated_by_user_id')
      .notNull()
      .references(() => userAccounts.id),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    check(
      'coordination_team_policy_limits',
      sql`${table.dailyCallLimit}>0 and ${table.dailyTokenLimit}>0 and ${table.dailyCostMicrosLimit}>0 and ${table.version}>0`,
    ),
  ],
)
export type CoordinationTeamPolicyRow = typeof coordinationTeamPolicies.$inferSelect
