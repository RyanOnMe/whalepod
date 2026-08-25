import { sql } from 'drizzle-orm'
import {
  bigint,
  char,
  check,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core'
import { userAccounts } from './identity.js'
import { tasks } from './project.js'
import { runs } from './run.js'

// Artifact 域表结构以 03-领域模型与运行协议.md §2.6 为准。
export const artifactStatus = pgEnum('artifact_status', ['candidate', 'published', 'rejected'])

export const artifacts = pgTable(
  'artifact',
  {
    id: uuid('id').primaryKey(),
    taskId: uuid('task_id')
      .notNull()
      .references(() => tasks.id),
    runId: uuid('run_id')
      .notNull()
      .references(() => runs.id),
    ownerUserId: uuid('owner_user_id')
      .notNull()
      .references(() => userAccounts.id),
    title: varchar('title', { length: 200 }).notNull(),
    mediaType: varchar('media_type', { length: 200 }).notNull(),
    // 单文件上限 50 MiB = 52,428,800 字节（02 Global Constraints）。
    byteSize: bigint('byte_size', { mode: 'number' }).notNull(),
    sha256: char('sha256', { length: 64 }).notNull(),
    // sha256/ab/cd/<digest>；不暴露本地源路径（03 §2.6）。
    storageKey: text('storage_key').notNull(),
    sourceRelativePath: text('source_relative_path'),
    status: artifactStatus('status').notNull().default('candidate'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    publishedAt: timestamp('published_at', { withTimezone: true }),
  },
  (table) => [
    check('artifact_title_length', sql`length(btrim(${table.title})) between 1 and 200`),
    check('artifact_byte_size_range', sql`${table.byteSize} between 0 and 52428800`),
  ],
)
