import { sql } from 'drizzle-orm'
import {
  bigint,
  char,
  check,
  jsonb,
  pgEnum,
  pgTable,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core'
import type { AnyPgColumn } from 'drizzle-orm/pg-core'
import { agents, agentProfileRevisions } from './agent.js'
import { devices, workspaces } from './device.js'
import { userAccounts } from './identity.js'
import { tasks } from './project.js'

// Run/Approval 域表结构以 03-领域模型与运行协议.md §2.6 为准。
// 状态枚举与 03 §3.2/§3.3 状态机一一对应。
export const runStatus = pgEnum('run_status', [
  'queued',
  'dispatching',
  'running',
  'waiting_approval',
  'cancel_requested',
  'completed',
  'failed',
  'cancelled',
  'lost',
])
export const runEventAudience = pgEnum('run_event_audience', ['owner', 'project', 'admin'])
export const approvalStatus = pgEnum('approval_status', [
  'pending',
  'allowed_once',
  'rejected',
  'expired',
  'cancelled',
])

export const runs = pgTable(
  'run',
  {
    id: uuid('id').primaryKey(),
    taskId: uuid('task_id')
      .notNull()
      .references(() => tasks.id),
    // 创建时等于 Task assignee，固化（03 §2.6）。
    ownerUserId: uuid('owner_user_id')
      .notNull()
      .references(() => userAccounts.id),
    agentId: uuid('agent_id')
      .notNull()
      .references(() => agents.id),
    profileRevisionId: uuid('profile_revision_id')
      .notNull()
      .references(() => agentProfileRevisions.id),
    deviceId: uuid('device_id')
      .notNull()
      .references(() => devices.id),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id),
    dshSessionId: varchar('dsh_session_id', { length: 128 }),
    status: runStatus('status').notNull().default('queued'),
    failureCode: varchar('failure_code', { length: 64 }),
    failureSummary: varchar('failure_summary', { length: 1000 }),
    rerunOfRunId: uuid('rerun_of_run_id').references((): AnyPgColumn => runs.id),
    profileDigest: char('profile_digest', { length: 64 }).notNull(),
    pluginPackDigest: char('plugin_pack_digest', { length: 64 }).notNull(),
    dshDistributionVersion: varchar('dsh_distribution_version', { length: 64 }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    startedAt: timestamp('started_at', { withTimezone: true }),
    finishedAt: timestamp('finished_at', { withTimezone: true }),
  },
  (table) => [
    // 每 Task 单活跃 Run（02 Task 4 Step 3）；终态不占位，允许重跑。
    uniqueIndex('run_one_active_per_task')
      .on(table.taskId)
      .where(
        sql`${table.status} in ('queued','dispatching','running','waiting_approval','cancel_requested')`,
      ),
  ],
)

export const runEvents = pgTable(
  'run_event',
  {
    id: uuid('id').primaryKey(),
    runId: uuid('run_id')
      .notNull()
      .references(() => runs.id),
    seq: bigint('seq', { mode: 'number' }).notNull(),
    type: varchar('type', { length: 80 }).notNull(),
    audience: runEventAudience('audience').notNull(),
    payload: jsonb('payload').notNull(),
    occurredAt: timestamp('occurred_at', { withTimezone: true }).notNull(),
    receivedAt: timestamp('received_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    // (run_id, seq) 唯一：Node 重发不产生重复持久事件（03 §2.6）。
    unique('run_event_run_seq_unique').on(table.runId, table.seq),
    // 持久事件单条 payload 上限 32 KiB（02 Global Constraints）。
    check('run_event_payload_size', sql`octet_length(${table.payload}::text) <= 32768`),
  ],
)

export const approvals = pgTable(
  'approval',
  {
    id: uuid('id').primaryKey(),
    runId: uuid('run_id')
      .notNull()
      .references(() => runs.id),
    callId: varchar('call_id', { length: 128 }).notNull(),
    toolName: varchar('tool_name', { length: 200 }).notNull(),
    reason: varchar('reason', { length: 1000 }).notNull(),
    preview: jsonb('preview').notNull(),
    status: approvalStatus('status').notNull().default('pending'),
    requestedAt: timestamp('requested_at', { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    decidedBy: uuid('decided_by').references(() => userAccounts.id),
    decidedAt: timestamp('decided_at', { withTimezone: true }),
  },
  (table) => [unique('approval_run_call_unique').on(table.runId, table.callId)],
)
