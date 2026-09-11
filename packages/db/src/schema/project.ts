import { sql } from 'drizzle-orm'
import { check, index, pgEnum, pgTable, text, timestamp, uuid, varchar } from 'drizzle-orm/pg-core'
import { agents } from './agent.js'
import { userAccounts } from './identity.js'
import { runs } from './run.js'

// Project/Task 域表结构以 03-领域模型与运行协议.md §2.2 为准。
export const taskStatus = pgEnum('task_status', [
  'open',
  'in_progress',
  'in_review',
  'done',
  'cancelled',
])
export const assignmentStatus = pgEnum('assignment_status', ['pending', 'accepted', 'rejected'])

export const projects = pgTable(
  'project',
  {
    id: uuid('id').primaryKey(),
    // 单 Team 内唯一（03 §2.2；部署只有一个 Team，故全局唯一）。
    name: varchar('name', { length: 120 }).notNull().unique(),
    description: text('description').notNull().default(''),
    createdBy: uuid('created_by')
      .notNull()
      .references(() => userAccounts.id),
    archivedAt: timestamp('archived_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    check('project_name_length', sql`length(btrim(${table.name})) between 1 and 120`),
    check('project_description_length', sql`length(${table.description}) <= 4000`),
  ],
)

export const tasks = pgTable(
  'task',
  {
    id: uuid('id').primaryKey(),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id),
    title: varchar('title', { length: 200 }).notNull(),
    description: text('description').notNull().default(''),
    status: taskStatus('status').notNull().default('open'),
    // Task 始终有一名真人 assignee（03 §2.2 不变量）。
    assigneeUserId: uuid('assignee_user_id')
      .notNull()
      .references(() => userAccounts.id),
    assignmentStatus: assignmentStatus('assignment_status').notNull().default('pending'),
    createdBy: uuid('created_by')
      .notNull()
      .references(() => userAccounts.id),
    acceptedAt: timestamp('accepted_at', { withTimezone: true }),
    completedAt: timestamp('completed_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    check('task_title_length', sql`length(btrim(${table.title})) between 1 and 200`),
    check('task_description_length', sql`length(${table.description}) <= 20000`),
  ],
)

export const taskMessages = pgTable(
  'task_message',
  {
    id: uuid('id').primaryKey(),
    taskId: uuid('task_id')
      .notNull()
      .references(() => tasks.id),
    authorUserId: uuid('author_user_id')
      .notNull()
      .references(() => userAccounts.id),
    body: text('body').notNull(),
    /**
     * 线程消息的类型（#185 / ADR-0009 决策 2）：
     * discussion = 人际讨论（**不驱动 Agent**，不进它的上下文）；instruction = 驱动
     * Agent 的指令（可能开新 Run，也可能降级为 followup）；followup = 注入既有 Run 的追问。
     */
    kind: text('kind').notNull().default('discussion'),
    /** 触发来源：human = 真人发出；auto_assignment = 指派给 Agent 时自动生成。 */
    origin: text('origin').notNull().default('human'),
    /** 被驱动的 Agent（指令/追问必填；讨论恒空，由 check 约束钉住）。 */
    targetAgentId: uuid('target_agent_id').references(() => agents.id),
    /** 该指令/追问落到哪个 Run 上（followup 必填；instruction 建 Run 前可空）。 */
    runId: uuid('run_id').references(() => runs.id),
    /** 受理状态收敛：pending → accepted / rejected（rejected 的理由见 Run 失败码语义）。 */
    instructionState: text('instruction_state'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    editedAt: timestamp('edited_at', { withTimezone: true }),
  },
  (table) => [
    check('task_message_body_length', sql`length(btrim(${table.body})) between 1 and 10000`),
    check(
      'task_message_kind_valid',
      sql`${table.kind} in ('discussion', 'instruction', 'followup')`,
    ),
    check('task_message_origin_valid', sql`${table.origin} in ('human', 'auto_assignment')`),
    check(
      'task_message_state_valid',
      sql`${table.instructionState} is null or ${table.instructionState} in ('pending', 'accepted', 'rejected')`,
    ),
    check(
      'task_message_discussion_inert',
      sql`${table.kind} <> 'discussion' or (${table.targetAgentId} is null and ${table.runId} is null and ${table.instructionState} is null)`,
    ),
    check(
      'task_message_instruction_addressed',
      sql`${table.kind} = 'discussion' or (${table.targetAgentId} is not null and ${table.instructionState} is not null)`,
    ),
    check(
      'task_message_followup_attached',
      sql`${table.kind} <> 'followup' or ${table.runId} is not null`,
    ),
    index('task_message_task_created_idx').on(table.taskId, table.createdAt),
  ],
)
