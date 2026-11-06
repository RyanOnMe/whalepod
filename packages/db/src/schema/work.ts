import { sql } from 'drizzle-orm'
import type { AnyPgColumn } from 'drizzle-orm/pg-core'
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
// ADR-0028 §8（RD-03d2a）：ask 的问题账本与可绑定回答。
export const workQuestionType = pgEnum('work_question_type', ['choose_option', 'authorize_scope'])
export const workQuestionStatus = pgEnum('work_question_status', [
  'open',
  'answered',
  'superseded',
  'expired',
  'cancelled',
])
export const workAnswerType = pgEnum('work_answer_type', [
  'choose_option',
  'deny',
  'defer',
  'authorize_scope',
])

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
      sql`jsonb_typeof(${table.triggerRefs}) = 'array' and jsonb_array_length(case when jsonb_typeof(${table.triggerRefs}) = 'array' then ${table.triggerRefs} else '[]'::jsonb end) between 1 and 32`,
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

/**
 * ADR-0028 §8（RD-03d2a）：`ask` 的权威问题记录。decisionId 只由确定性输入哈希得出；
 * 同一 decisionId 至多一个 open 行（部分唯一索引），重复问题合并。refs/options 只存
 * 不透明定位与候选文本，不存来源正文。
 */
export const workQuestions = pgTable(
  'work_question',
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
    decisionId: char('decision_id', { length: 64 }).notNull(),
    questionType: workQuestionType('question_type').notNull(),
    blockedDecision: varchar('blocked_decision', { length: 64 }).notNull(),
    summary: varchar('summary', { length: 500 }).notNull(),
    options: jsonb('options').$type<WorkQuestionOption[]>().notNull(),
    recommendedOptionId: varchar('recommended_option_id', { length: 64 }),
    refs: jsonb('refs').$type<Record<string, unknown>>().notNull().default({}),
    inputDigest: char('input_digest', { length: 64 }).notNull(),
    mandateId: uuid('mandate_id')
      .notNull()
      .references(() => workMandates.id),
    mandateVersion: integer('mandate_version').notNull(),
    principalUserId: uuid('principal_user_id')
      .notNull()
      .references(() => userAccounts.id),
    dispatchIntentId: uuid('dispatch_intent_id').references(() => dispatchIntents.id),
    status: workQuestionStatus('status').notNull().default('open'),
    answeredAt: timestamp('answered_at', { withTimezone: true }),
    closedAt: timestamp('closed_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    check('work_question_decision_format', sql`${table.decisionId} ~ '^[0-9a-f]{64}$'`),
    check('work_question_input_digest_format', sql`${table.inputDigest} ~ '^[0-9a-f]{64}$'`),
    check('work_question_mandate_version', sql`${table.mandateVersion} >= 1`),
    check(
      'work_question_blocked_decision_length',
      sql`length(btrim(${table.blockedDecision})) between 1 and 64`,
    ),
    check('work_question_summary_length', sql`length(btrim(${table.summary})) between 1 and 500`),
    check(
      'work_question_options_shape',
      sql`jsonb_typeof(${table.options}) = 'array' and jsonb_array_length(case when jsonb_typeof(${table.options}) = 'array' then ${table.options} else '[]'::jsonb end) between 1 and 8 and octet_length(${table.options}::text) <= 4096`,
    ),
    check('work_question_refs_object', sql`jsonb_typeof(${table.refs}) = 'object'`),
    check('work_question_refs_size', sql`octet_length(${table.refs}::text) <= 4096`),
    check(
      'work_question_status_fields',
      sql`(${table.status} = 'open' and ${table.answeredAt} is null and ${table.closedAt} is null) or (${table.status} = 'answered' and ${table.answeredAt} is not null and ${table.closedAt} is not null) or (${table.status} = 'superseded' and ${table.closedAt} is not null) or (${table.status} in ('expired', 'cancelled') and ${table.answeredAt} is null and ${table.closedAt} is not null)`,
    ),
    uniqueIndex('work_question_open_decision_unique')
      .on(table.decisionId)
      .where(sql`${table.status} = 'open'`),
    index('work_question_work_created_idx').on(table.workId, table.createdAt.desc(), table.id),
    index('work_question_work_status_idx').on(table.workId, table.status, table.createdAt.desc()),
    index('work_question_principal_created_idx').on(
      table.principalUserId,
      table.createdAt.desc(),
      table.id,
    ),
  ],
)

/**
 * ADR-0028 §8：回答记录。binding=false 只记录、不解除阻塞（Mandate 版本变化/失效时）；
 * 同一问题至多一条 binding=true 的回答。
 */
export const workQuestionAnswers = pgTable(
  'work_question_answer',
  {
    id: uuid('id').primaryKey(),
    questionId: uuid('question_id')
      .notNull()
      .references(() => workQuestions.id),
    decisionId: char('decision_id', { length: 64 }).notNull(),
    actorUserId: uuid('actor_user_id')
      .notNull()
      .references(() => userAccounts.id),
    answerType: workAnswerType('answer_type').notNull(),
    optionId: varchar('option_id', { length: 64 }),
    reason: varchar('reason', { length: 500 }),
    mandateId: uuid('mandate_id')
      .notNull()
      .references(() => workMandates.id),
    mandateVersion: integer('mandate_version').notNull(),
    binding: boolean('binding').notNull(),
    rejectionReason: varchar('rejection_reason', { length: 64 }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    check('work_question_answer_decision_format', sql`${table.decisionId} ~ '^[0-9a-f]{64}$'`),
    check('work_question_answer_mandate_version', sql`${table.mandateVersion} >= 1`),
    check(
      'work_question_answer_reason_length',
      sql`${table.reason} is null or length(btrim(${table.reason})) between 1 and 500`,
    ),
    check(
      'work_question_answer_option_shape',
      sql`(${table.answerType} = 'choose_option' and ${table.optionId} is not null) or (${table.answerType} <> 'choose_option' and ${table.optionId} is null)`,
    ),
    check(
      'work_question_answer_binding_fields',
      sql`(${table.binding} and ${table.rejectionReason} is null) or (not ${table.binding} and ${table.rejectionReason} is not null)`,
    ),
    uniqueIndex('work_question_answer_binding_unique')
      .on(table.questionId)
      .where(sql`${table.binding}`),
    index('work_question_answer_question_created_idx').on(
      table.questionId,
      table.createdAt.desc(),
      table.id,
    ),
  ],
)

export type WorkQuestionRow = typeof workQuestions.$inferSelect
export type NewWorkQuestionRow = typeof workQuestions.$inferInsert
export type WorkQuestionAnswerRow = typeof workQuestionAnswers.$inferSelect
export type NewWorkQuestionAnswerRow = typeof workQuestionAnswers.$inferInsert

export type WorkMandateProposalStatus =
  | 'pending'
  | 'confirmed'
  | 'superseded'
  | 'expired'
  | 'cancelled'

/**
 * ADR-0028 §8（RD-03d2b）：`authorize_scope` 回答生成的 Mandate 草案。
 * 草案只扩大“提案”，确认前不改变当前 Mandate/inputDigest/派工权限。
 */
export const workMandateProposals = pgTable(
  'work_mandate_proposal',
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
    workKey: varchar('work_key', { length: 64 }).notNull(),
    questionId: uuid('question_id')
      .notNull()
      .references(() => workQuestions.id),
    answerId: uuid('answer_id')
      .notNull()
      .references(() => workQuestionAnswers.id),
    decisionId: char('decision_id', { length: 64 }).notNull(),
    baseMandateId: uuid('base_mandate_id')
      .notNull()
      .references(() => workMandates.id),
    baseMandateVersion: integer('base_mandate_version').notNull(),
    principalUserId: uuid('principal_user_id')
      .notNull()
      .references(() => userAccounts.id),
    scope: jsonb('scope').$type<Record<string, unknown>>().notNull(),
    status: varchar('status', { length: 16 })
      .$type<WorkMandateProposalStatus>()
      .notNull()
      .default('pending'),
    resultMandateId: uuid('result_mandate_id').references(() => workMandates.id),
    confirmedAt: timestamp('confirmed_at', { withTimezone: true }),
    closedAt: timestamp('closed_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    check('work_mandate_proposal_decision_format', sql`${table.decisionId} ~ '^[0-9a-f]{64}$'`),
    check('work_mandate_proposal_base_version', sql`${table.baseMandateVersion} >= 1`),
    check(
      'work_mandate_proposal_work_key_format',
      sql`${table.workKey} ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'`,
    ),
    check(
      'work_mandate_proposal_status',
      sql`${table.status} in ('pending', 'confirmed', 'superseded', 'expired', 'cancelled')`,
    ),
    check(
      'work_mandate_proposal_status_fields',
      sql`(${table.status} = 'pending' and ${table.confirmedAt} is null and ${table.closedAt} is null and ${table.resultMandateId} is null) or (${table.status} = 'confirmed' and ${table.confirmedAt} is not null and ${table.closedAt} is not null and ${table.resultMandateId} is not null) or (${table.status} in ('superseded', 'expired', 'cancelled') and ${table.confirmedAt} is null and ${table.closedAt} is not null and ${table.resultMandateId} is null)`,
    ),
    check(
      'work_mandate_proposal_scope_object',
      sql`jsonb_typeof(${table.scope}) = 'object' and octet_length(${table.scope}::text) <= 8192`,
    ),
    uniqueIndex('work_mandate_proposal_question_unique').on(table.questionId),
    uniqueIndex('work_mandate_proposal_answer_unique').on(table.answerId),
    index('work_mandate_proposal_work_status_idx').on(
      table.workId,
      table.status,
      table.createdAt.desc(),
    ),
  ],
)

export type WorkMandateProposalRow = typeof workMandateProposals.$inferSelect
export type NewWorkMandateProposalRow = typeof workMandateProposals.$inferInsert

/**
 * ADR-0028 §17（RD-03r2）：已接受 Router 提案的幂等应用记录。evaluationId 唯一；
 * 应用状态与意图/问题/wait 副作用同事务写入，重复提交/重启回读同一行。
 * evaluation_id 的 FK 在 migration 里指向 coordination_evaluation；此处不声明
 * references 以避免 schema 模块环。
 */
export const routerApplications = pgTable(
  'router_application',
  {
    evaluationId: uuid('evaluation_id').primaryKey(),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id),
    workId: uuid('work_id')
      .notNull()
      .references(() => works.id),
    taskId: uuid('task_id')
      .notNull()
      .references(() => tasks.id),
    workKey: varchar('work_key', { length: 64 }).notNull(),
    decision: varchar('decision', { length: 16 })
      .$type<'dispatch' | 'wait' | 'ask' | 'ignore'>()
      .notNull(),
    status: varchar('status', { length: 16 }).$type<'applied' | 'rejected' | 'stale'>().notNull(),
    reason: varchar('reason', { length: 500 }),
    evaluationDigest: char('evaluation_digest', { length: 64 }).notNull(),
    mandateId: uuid('mandate_id')
      .notNull()
      .references(() => workMandates.id),
    mandateVersion: integer('mandate_version').notNull(),
    decisionRowId: uuid('decision_row_id').references(() => routerDecisions.id),
    intentId: uuid('intent_id').references(() => dispatchIntents.id),
    questionId: uuid('question_id').references(() => workQuestions.id),
    waitId: uuid('wait_id').references((): AnyPgColumn => workWaits.id),
    runId: uuid('run_id').references(() => runs.id),
    refs: jsonb('refs').$type<Record<string, unknown>>().notNull().default({}),
    appliedAt: timestamp('applied_at', { withTimezone: true }).notNull(),
  },
  (table) => [
    check(
      'router_application_decision',
      sql`${table.decision} in ('dispatch','wait','ask','ignore')`,
    ),
    check('router_application_status', sql`${table.status} in ('applied','rejected','stale')`),
    check('router_application_digest', sql`${table.evaluationDigest} ~ '^[a-f0-9]{64}$'`),
    check(
      'router_application_reason_length',
      sql`${table.reason} is null or length(btrim(${table.reason})) between 1 and 500`,
    ),
    check(
      'router_application_work_key_format',
      sql`${table.workKey} ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'`,
    ),
    check('router_application_mandate_version', sql`${table.mandateVersion} >= 1`),
    check(
      'router_application_refs_object',
      sql`jsonb_typeof(${table.refs}) = 'object' and octet_length(${table.refs}::text) <= 8192`,
    ),
    uniqueIndex('router_application_intent_unique')
      .on(table.intentId)
      .where(sql`${table.intentId} is not null`),
    uniqueIndex('router_application_question_unique')
      .on(table.questionId)
      .where(sql`${table.questionId} is not null`),
    uniqueIndex('router_application_wait_unique')
      .on(table.waitId)
      .where(sql`${table.waitId} is not null`),
    index('router_application_work_created_idx').on(table.workId, table.appliedAt.desc()),
  ],
)

/**
 * ADR-0028 §17.3（RD-03r2）：Router `wait` 的持久记录。稳定原因、恢复条件与
 * 受 Mandate 约束的 deadline；generation 进入下一次显式重评的 triggerKey，
 * 同一 wait 的重复扫描保持同一代次。#518 再接到期扫描。
 */
export const workWaits = pgTable(
  'work_wait',
  {
    id: uuid('id').primaryKey(),
    evaluationId: uuid('evaluation_id').notNull().unique(),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id),
    workId: uuid('work_id')
      .notNull()
      .references(() => works.id),
    taskId: uuid('task_id')
      .notNull()
      .references(() => tasks.id),
    workKey: varchar('work_key', { length: 64 }).notNull(),
    status: varchar('status', { length: 16 })
      .$type<'open' | 'resumed' | 'expired' | 'superseded' | 'cancelled'>()
      .notNull(),
    reason: varchar('reason', { length: 64 }).notNull(),
    summary: varchar('summary', { length: 500 }).notNull(),
    resumeCondition: varchar('resume_condition', { length: 500 }).notNull(),
    sourceType: workSourceType('source_type').notNull(),
    sourceId: uuid('source_id').notNull(),
    triggerKey: varchar('trigger_key', { length: 200 }).notNull(),
    generation: integer('generation').notNull().default(1),
    deadlineAt: timestamp('deadline_at', { withTimezone: true }).notNull(),
    mandateId: uuid('mandate_id')
      .notNull()
      .references(() => workMandates.id),
    mandateVersion: integer('mandate_version').notNull(),
    principalUserId: uuid('principal_user_id')
      .notNull()
      .references(() => userAccounts.id),
    refs: jsonb('refs').$type<Record<string, unknown>>().notNull().default({}),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    check(
      'work_wait_status',
      sql`${table.status} in ('open','resumed','expired','superseded','cancelled')`,
    ),
    check(
      'work_wait_reason',
      sql`${table.reason} ~ '^[a-z][a-z0-9_]*$' and length(${table.reason}) <= 64`,
    ),
    check('work_wait_summary_length', sql`length(btrim(${table.summary})) between 1 and 500`),
    check(
      'work_wait_resume_length',
      sql`length(btrim(${table.resumeCondition})) between 1 and 500`,
    ),
    check('work_wait_source_type', sql`${table.sourceType} in ('task_message','context_entry')`),
    check(
      'work_wait_trigger_key_length',
      sql`length(btrim(${table.triggerKey})) between 1 and 200`,
    ),
    check('work_wait_generation', sql`${table.generation} >= 1`),
    check('work_wait_mandate_version', sql`${table.mandateVersion} >= 1`),
    check(
      'work_wait_work_key_format',
      sql`${table.workKey} ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'`,
    ),
    check(
      'work_wait_refs_object',
      sql`jsonb_typeof(${table.refs}) = 'object' and octet_length(${table.refs}::text) <= 4096`,
    ),
    uniqueIndex('work_wait_one_open')
      .on(table.workId)
      .where(sql`${table.status} = 'open'`),
    index('work_wait_deadline_idx').on(table.status, table.deadlineAt),
  ],
)

/**
 * ADR-0028 §17.1/§17.3（RD-03d3）：机器 Run 终态的边界复核标记。
 *
 * 终态事务只落 `pending`，不调用模型；Router tick 在受控后续事务中复核当前
 * work/Task/Mandate/活跃 Run 后，用 `run-terminal:<runId>` 触发一次评估。
 * `run_id` 唯一让重复终态收敛与重启恢复天然幂等；`evaluation_id` 只记本次
 * 触发生成的评估，不保存任何来源正文。
 */
export const workRunBoundaries = pgTable(
  'work_run_boundary',
  {
    id: uuid('id').primaryKey(),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id),
    workId: uuid('work_id')
      .notNull()
      .references(() => works.id),
    taskId: uuid('task_id')
      .notNull()
      .references(() => tasks.id),
    workKey: varchar('work_key', { length: 64 }).notNull(),
    runId: uuid('run_id')
      .notNull()
      .references(() => runs.id),
    principalUserId: uuid('principal_user_id')
      .notNull()
      .references(() => userAccounts.id),
    status: varchar('status', { length: 16 })
      .$type<'pending' | 'enqueued' | 'skipped'>()
      .notNull()
      .default('pending'),
    triggerKey: varchar('trigger_key', { length: 200 }).notNull(),
    // coordination_evaluation 在本 schema 里没有 FK（coordination.ts 反向引用 work），
    // 与 router_application.evaluation_id 同型；DB 迁移仍保留外键。
    evaluationId: uuid('evaluation_id'),
    reason: varchar('reason', { length: 64 }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    check('work_run_boundary_status', sql`${table.status} in ('pending','enqueued','skipped')`),
    check(
      'work_run_boundary_work_key_format',
      sql`${table.workKey} ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'`,
    ),
    check(
      'work_run_boundary_trigger_length',
      sql`length(btrim(${table.triggerKey})) between 1 and 200`,
    ),
    check(
      'work_run_boundary_reason',
      sql`${table.reason} is null or (${table.reason} ~ '^[a-z][a-z0-9_]*$' and length(${table.reason}) <= 64)`,
    ),
    check(
      'work_run_boundary_status_fields',
      sql`(${table.status} = 'pending' and ${table.evaluationId} is null and ${table.reason} is null) or (${table.status} = 'enqueued' and ${table.evaluationId} is not null and ${table.reason} is null) or (${table.status} = 'skipped' and ${table.evaluationId} is null and ${table.reason} is not null)`,
    ),
    uniqueIndex('work_run_boundary_run_unique').on(table.runId),
    index('work_run_boundary_status_created_idx').on(table.status, table.createdAt, table.id),
  ],
)

export type RouterApplicationRow = typeof routerApplications.$inferSelect
export type NewRouterApplicationRow = typeof routerApplications.$inferInsert
export type WorkWaitRow = typeof workWaits.$inferSelect
export type NewWorkWaitRow = typeof workWaits.$inferInsert
export type WorkRunBoundaryRow = typeof workRunBoundaries.$inferSelect
export type NewWorkRunBoundaryRow = typeof workRunBoundaries.$inferInsert

export interface WorkQuestionOption {
  readonly id: string
  readonly label: string
}
