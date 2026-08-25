import { sql } from 'drizzle-orm'
import {
  check,
  pgEnum,
  pgTable,
  primaryKey,
  smallint,
  text,
  timestamp,
  unique,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core'
import { bytea } from './common.js'

// 身份域表结构以 03-领域模型与运行协议.md §2.1 为准。
export const memberRole = pgEnum('member_role', ['owner', 'admin', 'member'])
export const inviteRole = pgEnum('invite_role', ['admin', 'member'])

export const teams = pgTable(
  'team',
  {
    id: uuid('id').primaryKey(),
    name: varchar('name', { length: 80 }).notNull(),
    // 单 Team 部署：singleton_key 恒为 1，唯一约束挡住第二个 Team（02 Task 4 Step 3）。
    singletonKey: smallint('singleton_key').notNull().default(1),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    unique('team_singleton').on(table.singletonKey),
    check('team_singleton_key_value', sql`${table.singletonKey} = 1`),
    check('team_name_length', sql`length(btrim(${table.name})) between 1 and 80`),
  ],
)

export const userAccounts = pgTable(
  'user_account',
  {
    id: uuid('id').primaryKey(),
    username: varchar('username', { length: 32 }).notNull().unique(),
    displayName: varchar('display_name', { length: 80 }).notNull(),
    passwordHash: text('password_hash').notNull(),
    disabledAt: timestamp('disabled_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    check('user_account_username_format', sql`${table.username} ~ '^[a-z0-9][a-z0-9._-]{2,31}$'`),
    check(
      'user_account_display_name_length',
      sql`length(btrim(${table.displayName})) between 1 and 80`,
    ),
  ],
)

export const teamMembers = pgTable(
  'team_member',
  {
    teamId: uuid('team_id')
      .notNull()
      .references(() => teams.id),
    userId: uuid('user_id')
      .notNull()
      .references(() => userAccounts.id),
    role: memberRole('role').notNull(),
    joinedAt: timestamp('joined_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.teamId, table.userId] }),
    // 每个用户一条成员记录（03 §2.1）。
    unique('team_member_user_unique').on(table.userId),
  ],
)

export const authSessions = pgTable('auth_session', {
  id: uuid('id').primaryKey(),
  userId: uuid('user_id')
    .notNull()
    .references(() => userAccounts.id),
  tokenHash: bytea('token_hash').notNull().unique(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  lastSeenAt: timestamp('last_seen_at', { withTimezone: true }).notNull().defaultNow(),
  revokedAt: timestamp('revoked_at', { withTimezone: true }),
})

export const invites = pgTable('invite', {
  id: uuid('id').primaryKey(),
  tokenHash: bytea('token_hash').notNull().unique(),
  // 不能邀请 Owner（03 §2.1）。
  role: inviteRole('role').notNull(),
  createdBy: uuid('created_by')
    .notNull()
    .references(() => userAccounts.id),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  consumedBy: uuid('consumed_by').references(() => userAccounts.id),
  consumedAt: timestamp('consumed_at', { withTimezone: true }),
})
