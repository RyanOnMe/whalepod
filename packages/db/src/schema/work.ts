import { sql } from 'drizzle-orm'
import type { AnyPgColumn } from 'drizzle-orm/pg-core'
import {
  bigint,
  char,
  check,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core'
import { agentProfileRevisions, agents } from './agent.js'
import { devices, workspaces } from './device.js'
import { userAccounts } from './identity.js'
import { projects, tasks } from './project.js'
import { runs } from './run.js'

// ADR-0028（RD-01）：持续工作身份、Mandate、影子 Router 决定与只落 proposed 的派工意图。
// 全部表只保存协调元数据与引用；业务事实仍在 Task/Run/ADR-0025 账本。

export const workState = pgEnum('work_state', ['active', 'waiting', 'retired'])
export const workResumeMode = pgEnum('work_resume_mode', ['auto', 'owner_confirmation'])
export const workMandateStatus = pgEnum('work_mandate_status', [
  'draft',
  'active',
  'paused',
  'revoked',
  'expired',
  'superseded',
])
export const workAutoDispatch = pgEnum('work_auto_dispatch', ['off', 'existing_task'])
export const workSourceType = pgEnum('work_source_type', ['task_message', 'context_entry'])
export const routerDecisionKind = pgEnum('router_decision_kind', [
  'ignore',
  'wait',
  'ask',
  'propose',
])
export const dispatchIntentStatus = pgEnum('dispatch_intent_status', [
  'proposed',
  'approved',
  'dispatched',
  'rejected',
  'expired',
  'cancelled',
  'superseded',
])
export const dispatchApprovalBasis = pgEnum('dispatch_approval_basis', ['human', 'mandate'])

export const works = pgTable(
  'work',
  {
    id: uuid('id').primaryKey(),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id),
    taskId: uuid('task_id')
      .notNull()
      .references(() => tasks.id),
    workKey: varchar('work_key', { length: 64 }).notNull(),
    humanOwnerUserId: uuid('human_owner_user_id')
      .notNull()
      .references(() => userAccounts.id),
    goal: varchar('goal', { length: 1000 }).notNull(),
    state: workState('state').notNull().default('active'),
    resumeMode: workResumeMode('resume_mode'),
    resumeCondition: varchar('resume_condition', { length: 500 }),
    mandateId: uuid('mandate_id').references((): AnyPgColumn => workMandates.id),
    retiredAt: timestamp('retired_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    check('work_goal_length', sql`length(btrim(${table.goal})) between 1 and 1000`),
    check(
      'work_key_format',
      sql`${table.workKey} ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'`,
    ),
    check(
      'work_state_fields',
      sql`(${table.state} = 'active' and ${table.resumeMode} is null and ${table.resumeCondition} is null and ${table.retiredAt} is null) or (${table.state} = 'waiting' and ${table.resumeMode} is not null and ${table.resumeCondition} is not null and ${table.retiredAt} is null) or (${table.state} = 'retired' and ${table.retiredAt} is not null)`,
    ),
    uniqueIndex('work_task_current_unique')
      .on(table.taskId)
      .where(sql`${table.state} <> 'retired'`),
    uniqueIndex('work_work_key_unique').on(table.workKey),
    index('work_project_created_idx').on(table.projectId, table.createdAt.desc(), table.id),
    index('work_owner_created_idx').on(table.humanOwnerUserId, table.createdAt.desc(), table.id),
  ],
)

export const workMandates = pgTable(
  'work_mandate',
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
    version: integer('version').notNull(),
    status: workMandateStatus('status').notNull(),
    principalUserId: uuid('principal_user_id')
      .notNull()
      .references(() => userAccounts.id),
    onBehalfOfUserId: uuid('on_behalf_of_user_id')
      .notNull()
      .references(() => userAccounts.id),
    humanOwnerUserId: uuid('human_owner_user_id')
      .notNull()
      .references(() => userAccounts.id),
    draftRecipientUserId: uuid('draft_recipient_user_id')
      .notNull()
      .references(() => userAccounts.id),
    autoDispatch: workAutoDispatch('auto_dispatch').notNull().default('off'),
    allowedActionClasses: jsonb('allowed_action_classes').$type<string[]>().notNull(),
    allowedSourceTypes: jsonb('allowed_source_types').$type<string[]>().notNull(),
    allowedAgentIds: jsonb('allowed_agent_ids').$type<string[]>().notNull().default([]),
    allowedToolNames: jsonb('allowed_tool_names').$type<string[]>().notNull().default([]),
    maxRunsPerWork: integer('max_runs_per_work').notNull(),
    maxCostMicros: bigint('max_cost_micros', { mode: 'number' }).notNull(),
    maxTokens: bigint('max_tokens', { mode: 'number' }).notNull(),
    maxAttempts: integer('max_attempts').notNull(),
    waitDeadlineSeconds: integer('wait_deadline_seconds').notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    statusReason: varchar('status_reason', { length: 500 }),
    pausedAt: timestamp('paused_at', { withTimezone: true }),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    check('work_mandate_version', sql`${table.version} >= 1`),
    check(
      'work_mandate_work_key_format',
      sql`${table.workKey} ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'`,
    ),
    check(
      'work_mandate_identity',
      sql`${table.principalUserId} = ${table.onBehalfOfUserId} and ${table.principalUserId} = ${table.humanOwnerUserId} and ${table.principalUserId} = ${table.draftRecipientUserId}`,
    ),
    check(
      'work_mandate_limits',
      sql`${table.maxRunsPerWork} >= 0 and ${table.maxCostMicros} >= 0 and ${table.maxTokens} >= 0 and ${table.maxAttempts} >= 0 and ${table.waitDeadlineSeconds} between 1 and 86400`,
    ),
    check(
      'work_mandate_action_classes',
      sql`jsonb_typeof(${table.allowedActionClasses}) = 'array' and jsonb_array_length(case when jsonb_typeof(${table.allowedActionClasses}) = 'array' then ${table.allowedActionClasses} else '[]'::jsonb end) between 1 and 4 and ${table.allowedActionClasses} <@ '["research","analysis","draft","revise"]'::jsonb`,
    ),
    check(
      'work_mandate_source_types',
      sql`jsonb_typeof(${table.allowedSourceTypes}) = 'array' and jsonb_array_length(case when jsonb_typeof(${table.allowedSourceTypes}) = 'array' then ${table.allowedSourceTypes} else '[]'::jsonb end) between 1 and 2 and ${table.allowedSourceTypes} <@ '["task_message","context_entry"]'::jsonb`,
    ),
    check(
      'work_mandate_agent_ids',
      sql`jsonb_typeof(${table.allowedAgentIds}) = 'array' and jsonb_array_length(case when jsonb_typeof(${table.allowedAgentIds}) = 'array' then ${table.allowedAgentIds} else '[]'::jsonb end) <= 32`,
    ),
    check(
      'work_mandate_tool_names',
      sql`jsonb_typeof(${table.allowedToolNames}) = 'array' and jsonb_array_length(case when jsonb_typeof(${table.allowedToolNames}) = 'array' then ${table.allowedToolNames} else '[]'::jsonb end) <= 16`,
    ),
    check(
      'work_mandate_status_fields',
      sql`(${table.status} = 'paused' and ${table.pausedAt} is not null and ${table.revokedAt} is null) or (${table.status} = 'revoked' and ${table.revokedAt} is not null and ${table.pausedAt} is null) or (${table.status} in ('draft', 'active', 'expired', 'superseded') and ${table.pausedAt} is null and ${table.revokedAt} is null)`,
    ),
    check('work_mandate_expires_at', sql`${table.expiresAt} > ${table.createdAt}`),
    unique('work_mandate_work_version_unique').on(table.workId, table.version),
    index('work_mandate_work_version_idx').on(table.workId, table.version.desc()),
    index('work_mandate_work_status_idx').on(table.workId, table.status, table.version.desc()),
    index('work_mandate_expiry_idx').on(table.status, table.expiresAt),
  ],
)

export const routerDecisions = pgTable(
  'router_decision',
  {
    id: uuid('id').primaryKey(),
    workId: uuid('work_id')
      .notNull()
      .references(() => works.id),
    taskId: uuid('task_id')
      .notNull()
      .references(() => tasks.id),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id),
    decision: routerDecisionKind('decision').notNull(),
    reason: varchar('reason', { length: 64 }).notNull(),
    summary: varchar('summary', { length: 500 }).notNull(),
    sourceType: workSourceType('source_type').notNull(),
    sourceId: uuid('source_id').notNull(),
    sourceVersion: varchar('source_version', { length: 200 }).notNull(),
    sourceDigest: char('source_digest', { length: 64 }).notNull(),
    inputDigest: char('input_digest', { length: 64 }).notNull(),
    mandateId: uuid('mandate_id').references(() => workMandates.id),
    mandateVersion: integer('mandate_version'),
    rulesVersion: varchar('rules_version', { length: 64 }).notNull(),
    refs: jsonb('refs').$type<Record<string, unknown>>().notNull().default({}),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    check('router_decision_reason_length', sql`length(btrim(${table.reason})) between 1 and 64`),
    check('router_decision_summary_length', sql`length(btrim(${table.summary})) between 1 and 500`),
    check(
      'router_decision_source_version_length',
      sql`length(btrim(${table.sourceVersion})) between 1 and 200`,
    ),
    check(
      'router_decision_digest_format',
      sql`${table.sourceDigest} ~ '^[0-9a-f]{64}$' and ${table.inputDigest} ~ '^[0-9a-f]{64}$'`,
    ),
    check('router_decision_refs_object', sql`jsonb_typeof(${table.refs}) = 'object'`),
    check('router_decision_refs_size', sql`octet_length(${table.refs}::text) <= 4096`),
    check(
      'router_decision_mandate_pair',
      sql`(${table.mandateId} is null) = (${table.mandateVersion} is null)`,
    ),
    check(
      'router_decision_mandate_version',
      sql`${table.mandateVersion} is null or ${table.mandateVersion} >= 1`,
    ),
    uniqueIndex('router_decision_source_unique').on(
      table.workId,
      table.sourceType,
      table.sourceId,
      table.sourceVersion,
      table.sourceDigest,
    ),
    index('router_decision_work_created_idx').on(table.workId, table.createdAt.desc(), table.id),
    index('router_decision_work_decision_idx').on(
      table.workId,
      table.decision,
      table.createdAt.desc(),
    ),
  ],
)

export const dispatchIntents = pgTable(
  'dispatch_intent',
  {
    id: uuid('id').primaryKey(),
    workId: uuid('work_id')
      .notNull()
      .references(() => works.id),
    taskId: uuid('task_id')
      .notNull()
      .references(() => tasks.id),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id),
    /** ADR-0028 §6：派工意图携带的稳定工作身份（与 work.workKey 一致）。 */
    workKey: varchar('work_key', { length: 64 }).notNull(),
    decisionId: uuid('decision_id').references(() => routerDecisions.id),
    mandateId: uuid('mandate_id')
      .notNull()
      .references(() => workMandates.id),
    mandateVersion: integer('mandate_version').notNull(),
    status: dispatchIntentStatus('status').notNull(),
    approvalBasis: dispatchApprovalBasis('approval_basis'),
    authorizedByUserId: uuid('authorized_by_user_id')
      .notNull()
      .references(() => userAccounts.id),
    onBehalfOfUserId: uuid('on_behalf_of_user_id')
      .notNull()
      .references(() => userAccounts.id),
    inputDigest: char('input_digest', { length: 64 }).notNull(),
    triggerRefs: jsonb('trigger_refs').$type<unknown[]>().notNull(),
    candidates: jsonb('candidates').$type<unknown[]>().notNull().default([]),
    exclusionReasons: jsonb('exclusion_reasons').$type<unknown[]>().notNull().default([]),
    reason: varchar('reason', { length: 500 }).notNull(),
    // ADR-0028 §6（RD-03a）：派工端口在 dispatch 时固定候选与现场；proposed 阶段可空。
    agentId: uuid('agent_id').references(() => agents.id),
    profileRevisionId: uuid('profile_revision_id').references(() => agentProfileRevisions.id),
    deviceId: uuid('device_id').references(() => devices.id),
    workspaceId: uuid('workspace_id').references(() => workspaces.id),
    actionClass: varchar('action_class', { length: 32 }),
    /** 拒绝/取消的稳定原因；reason 保留 Router 原始摘要。 */
    resolutionReason: varchar('resolution_reason', { length: 500 }),
    runId: uuid('run_id').references(() => runs.id),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    approvedAt: timestamp('approved_at', { withTimezone: true }),
    dispatchedAt: timestamp('dispatched_at', { withTimezone: true }),
    cancelledAt: timestamp('cancelled_at', { withTimezone: true }),
    rejectedAt: timestamp('rejected_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    check('dispatch_intent_mandate_version', sql`${table.mandateVersion} >= 1`),
    check('dispatch_intent_input_digest_format', sql`${table.inputDigest} ~ '^[0-9a-f]{64}$'`),
    check(
      'dispatch_intent_trigger_refs_array',
      sql`jsonb_typeof(${table.triggerRefs}) = 'array' and jsonb_array_length(case when jsonb_typeof(${table.triggerRefs}) = 'array' then ${table.triggerRefs} else '[]'::jsonb end) between 1 and 16`,
    ),
    check('dispatch_intent_candidates_array', sql`jsonb_typeof(${table.candidates}) = 'array'`),
    check(
      'dispatch_intent_exclusions_array',
      sql`jsonb_typeof(${table.exclusionReasons}) = 'array'`,
    ),
    check('dispatch_intent_reason_length', sql`length(btrim(${table.reason})) between 1 and 500`),
    check(
      'dispatch_intent_work_key_format',
      sql`${table.workKey} ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'`,
    ),
    check(
      'dispatch_intent_resolution_reason_length',
      sql`${table.resolutionReason} is null or length(btrim(${table.resolutionReason})) between 1 and 500`,
    ),
    check(
      'dispatch_intent_target_fields',
      sql`${table.status} <> 'dispatched' or (${table.agentId} is not null and ${table.profileRevisionId} is not null and ${table.deviceId} is not null and ${table.workspaceId} is not null and ${table.actionClass} in ('research', 'analysis', 'draft', 'revise'))`,
    ),
    check(
      'dispatch_intent_status_fields',
      sql`(${table.status} = 'proposed' and ${table.approvalBasis} is null and ${table.approvedAt} is null and ${table.dispatchedAt} is null and ${table.runId} is null) or (${table.status} = 'approved' and ${table.approvalBasis} is not null and ${table.approvedAt} is not null and ${table.dispatchedAt} is null and ${table.runId} is null) or (${table.status} = 'dispatched' and ${table.approvalBasis} is not null and ${table.approvedAt} is not null and ${table.dispatchedAt} is not null and ${table.runId} is not null) or (${table.status} in ('rejected', 'expired', 'cancelled', 'superseded') and ${table.dispatchedAt} is null and ${table.runId} is null)`,
    ),
    uniqueIndex('dispatch_intent_decision_unique')
      .on(table.decisionId)
      .where(sql`${table.decisionId} is not null`),
    uniqueIndex('dispatch_intent_run_unique')
      .on(table.runId)
      .where(sql`${table.runId} is not null`),
    index('dispatch_intent_work_created_idx').on(table.workId, table.createdAt.desc(), table.id),
    index('dispatch_intent_work_status_idx').on(table.workId, table.status, table.createdAt.desc()),
    index('dispatch_intent_status_expiry_idx').on(table.status, table.expiresAt),
  ],
)

export type WorkRow = typeof works.$inferSelect
export type NewWorkRow = typeof works.$inferInsert
export type WorkMandateRow = typeof workMandates.$inferSelect
export type NewWorkMandateRow = typeof workMandates.$inferInsert
export type RouterDecisionRow = typeof routerDecisions.$inferSelect
export type NewRouterDecisionRow = typeof routerDecisions.$inferInsert
export type DispatchIntentRow = typeof dispatchIntents.$inferSelect
export type NewDispatchIntentRow = typeof dispatchIntents.$inferInsert
