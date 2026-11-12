import { sql } from 'drizzle-orm'
import {
  bigint,
  boolean,
  char,
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
import { discoveryExecutions, discoveryPermits, discoverySlots } from './discovery.js'
import { teams } from './identity.js'
import { projects } from './project.js'
import { runs } from './run.js'
import { works } from './work.js'

export interface DiscoveryExecutorLimits {
  readonly calls: number
  readonly tokens: number
  readonly costMicros: number
}

export interface DiscoveryExecutorDispatchPolicy {
  readonly parent: DiscoveryExecutorLimits & { readonly dispatches: number }
  readonly team: DiscoveryExecutorLimits
  readonly project: DiscoveryExecutorLimits
  readonly work: DiscoveryExecutorLimits
  readonly maxInputTokens: number
  readonly maxOutputTokens: number
  readonly inputPriceMicrosPerMillionTokens: number
  readonly outputPriceMicrosPerMillionTokens: number
}

/** Slot identity survives permit renewal, changes of Agent, and new candidate applications. */
export const discoveryExecutorParentBudgets = pgTable(
  'discovery_executor_parent_budget',
  {
    slotId: uuid('slot_id')
      .primaryKey()
      .references(() => discoverySlots.id),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id),
    dispatches: bigint('dispatches', { mode: 'number' }).notNull().default(0),
    calls: bigint('calls', { mode: 'number' }).notNull().default(0),
    reservedTokens: bigint('reserved_tokens', { mode: 'number' }).notNull().default(0),
    reservedCostMicros: bigint('reserved_cost_micros', { mode: 'number' }).notNull().default(0),
    inputTokens: bigint('input_tokens', { mode: 'number' }).notNull().default(0),
    outputTokens: bigint('output_tokens', { mode: 'number' }).notNull().default(0),
    costMicros: bigint('cost_micros', { mode: 'number' }).notNull().default(0),
    egressBlockedAt: timestamp('egress_blocked_at', { withTimezone: true }),
  },
  (t) => [
    check(
      'discovery_executor_parent_nonnegative',
      sql`${t.dispatches} >= 0 and ${t.calls} >= 0 and ${t.reservedTokens} >= 0 and ${t.reservedCostMicros} >= 0 and ${t.inputTokens} >= 0 and ${t.outputTokens} >= 0 and ${t.costMicros} >= 0`,
    ),
  ],
)

/** A live egress Run is distinguishable from c2 replay by this immutable policy snapshot. */
export const discoveryExecutorDispatches = pgTable(
  'discovery_executor_dispatch',
  {
    runId: uuid('run_id')
      .primaryKey()
      .references(() => runs.id),
    executionId: uuid('execution_id')
      .notNull()
      .unique()
      .references(() => discoveryExecutions.id),
    slotId: uuid('slot_id')
      .notNull()
      .references(() => discoverySlots.id),
    permitId: uuid('permit_id')
      .notNull()
      .references(() => discoveryPermits.id),
    permitVersion: integer('permit_version').notNull(),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id),
    teamId: uuid('team_id')
      .notNull()
      .references(() => teams.id),
    workId: uuid('work_id')
      .notNull()
      .references(() => works.id),
    workKey: uuid('work_key').notNull(),
    sourceGrantsDigest: char('source_grants_digest', { length: 64 }).notNull(),
    routeDigest: char('route_digest', { length: 64 }).notNull(),
    policyGeneration: integer('policy_generation').notNull(),
    policy: jsonb('policy').$type<DiscoveryExecutorDispatchPolicy>().notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
  },
  (t) => [
    check(
      'discovery_executor_dispatch_versions',
      sql`${t.permitVersion} > 0 and ${t.policyGeneration} > 0`,
    ),
    check(
      'discovery_executor_dispatch_binding',
      sql`${t.routeDigest} ~ '^[0-9a-f]{64}$' and ${t.sourceGrantsDigest} ~ '^[0-9a-f]{64}$' and jsonb_typeof(${t.policy}) = 'object'`,
    ),
  ],
)

export type DiscoveryExecutorAttemptState = 'held' | 'unknown' | 'actual' | 'estimated' | 'unsent'

export const discoveryExecutorAttempts = pgTable(
  'discovery_executor_attempt',
  {
    runId: uuid('run_id')
      .notNull()
      .references(() => discoveryExecutorDispatches.runId),
    attemptId: uuid('attempt_id').notNull(),
    requestDigest: char('request_digest', { length: 64 }).notNull(),
    requestBytes: integer('request_bytes').notNull(),
    utcDate: varchar('utc_date', { length: 10 }).notNull(),
    maxInputTokens: bigint('max_input_tokens', { mode: 'number' }).notNull(),
    maxOutputTokens: bigint('max_output_tokens', { mode: 'number' }).notNull(),
    reservedCostMicros: bigint('reserved_cost_micros', { mode: 'number' }).notNull(),
    state: varchar('state', { length: 16 }).$type<DiscoveryExecutorAttemptState>().notNull(),
    inputTokens: bigint('input_tokens', { mode: 'number' }),
    outputTokens: bigint('output_tokens', { mode: 'number' }),
    costMicros: bigint('cost_micros', { mode: 'number' }),
    responseIdDigest: char('response_id_digest', { length: 64 }),
    overage: boolean('overage').notNull().default(false),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
    settledAt: timestamp('settled_at', { withTimezone: true }),
  },
  (t) => [
    primaryKey({ columns: [t.runId, t.attemptId] }),
    uniqueIndex('discovery_executor_attempt_request_identity').on(t.runId, t.requestDigest),
    uniqueIndex('discovery_executor_attempt_one_open')
      .on(t.runId)
      .where(sql`${t.state} in ('held','unknown')`),
    check(
      'discovery_executor_attempt_reservation',
      sql`${t.requestDigest} ~ '^[0-9a-f]{64}$' and ${t.requestBytes} > 0 and ${t.utcDate} ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' and ${t.maxInputTokens} > 0 and ${t.maxOutputTokens} > 0 and ${t.reservedCostMicros} >= 0`,
    ),
    check(
      'discovery_executor_attempt_settlement',
      sql`(${t.state} in ('held','unknown') and ${t.settledAt} is null and ${t.inputTokens} is null and ${t.outputTokens} is null and ${t.costMicros} is null and ${t.responseIdDigest} is null and not ${t.overage}) or
        (${t.state} in ('actual','estimated','unsent') and ${t.settledAt} is not null and ${t.inputTokens} is not null and ${t.inputTokens} >= 0 and ${t.outputTokens} is not null and ${t.outputTokens} >= 0 and ${t.costMicros} is not null and ${t.costMicros} >= 0
          and (${t.responseIdDigest} is null or (${t.state} = 'actual' and ${t.responseIdDigest} ~ '^[0-9a-f]{64}$')) and (not ${t.overage} or ${t.state} = 'actual'))`,
    ),
  ],
)

export type DiscoveryExecutorParentBudgetRow = typeof discoveryExecutorParentBudgets.$inferSelect
export type DiscoveryExecutorDispatchRow = typeof discoveryExecutorDispatches.$inferSelect
export type DiscoveryExecutorAttemptRow = typeof discoveryExecutorAttempts.$inferSelect
