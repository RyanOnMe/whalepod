import { sql } from 'drizzle-orm'
import { check, pgEnum, pgTable, text, timestamp, uuid, varchar } from 'drizzle-orm/pg-core'
import { userAccounts } from './identity.js'

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

export const taskComments = pgTable(
  'task_comment',
  {
    id: uuid('id').primaryKey(),
    taskId: uuid('task_id')
      .notNull()
      .references(() => tasks.id),
    authorUserId: uuid('author_user_id')
      .notNull()
      .references(() => userAccounts.id),
    body: text('body').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    editedAt: timestamp('edited_at', { withTimezone: true }),
  },
  (table) => [
    check('task_comment_body_length', sql`length(btrim(${table.body})) between 1 and 10000`),
  ],
)
