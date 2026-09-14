import { sql } from 'drizzle-orm'
import {
  check,
  index,
  pgEnum,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core'
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

/**
 * 指令权授权（#198；ADR-0009 决策 4）：谁能在**执行区**驱动这个 Task 的 Agent。
 *
 * 与"谁能说话"无关——讨论区任何成员都能评论（ADR-0010）。授权只影响：发指令、起 Run、排队追问。
 * 审批决定权**不可授予**（只看 `run.owner_user_id`）；Run 归属永远是责任人。
 */
export const taskInstructionGrants = pgTable(
  'task_instruction_grant',
  {
    id: uuid('id').primaryKey(),
    taskId: uuid('task_id')
      .notNull()
      .references(() => tasks.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => userAccounts.id, { onDelete: 'cascade' }),
    /** 谁授的。只有责任人能授——这条由 migration 0006 的触发器钉在库上，不靠命令层自觉。 */
    grantedBy: uuid('granted_by')
      .notNull()
      .references(() => userAccounts.id, { onDelete: 'cascade' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    // 一人一 Task 一条授权：重复授予是幂等的，不该长出第二行。
    // 唯一索引同时服务守卫的点查（列序相同），不再另建普通索引（评审应改 3）。
    unique('task_instruction_grant_unique').on(table.taskId, table.userId),
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
    /** 受理状态收敛：pending → accepted / rejected。 */
    instructionState: text('instruction_state'),
    /**
     * 拒绝理由（#186）：`team_event` 只有 24 小时保留窗口，理由必须与状态同列存放，
     * 否则「我的指令为什么没被受理」在一天后就查不到了。仅 `rejected` 时可有值。
     */
    instructionErrorCode: text('instruction_error_code'),
    instructionErrorMessage: text('instruction_error_message'),
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
    // 「受理成功」必然落到某个 Run 上：accepted 而无 run_id 就是「已受理、零痕迹」
    //（ADR-0009 决策 3 禁止）。pending（还没建 Run）与 rejected（可能挂在既有 Run 上）不设限。
    check(
      'task_message_accepted_has_run',
      sql`${table.instructionState} <> 'accepted' or ${table.runId} is not null`,
    ),
    // 理由只在被拒时有意义：受理成功却带拒绝理由是自相矛盾的账。
    check(
      'task_message_error_only_when_rejected',
      sql`${table.instructionState} = 'rejected' or (${table.instructionErrorCode} is null and ${table.instructionErrorMessage} is null)`,
    ),
    index('task_message_task_created_idx').on(table.taskId, table.createdAt),
  ],
)
