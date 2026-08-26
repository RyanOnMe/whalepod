import { sql } from 'drizzle-orm'
import {
  boolean,
  check,
  jsonb,
  pgEnum,
  pgTable,
  timestamp,
  unique,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core'
import { bytea } from './common.js'
import { userAccounts } from './identity.js'

// Device/Workspace 域表结构以 03-领域模型与运行协议.md §2.4 为准。
// 注意：Node 本地 workspace_registry（含 canonical_path）不落 Hub 库。
export const devicePlatform = pgEnum('device_platform', ['darwin', 'linux', 'win32'])
export const workspaceKind = pgEnum('workspace_kind', ['directory', 'git_repository'])

export const devices = pgTable(
  'device',
  {
    id: uuid('id').primaryKey(),
    // 永不转移（03 §2.4）。
    ownerUserId: uuid('owner_user_id')
      .notNull()
      .references(() => userAccounts.id),
    name: varchar('name', { length: 80 }).notNull(),
    platform: devicePlatform('platform').notNull(),
    architecture: varchar('architecture', { length: 32 }).notNull(),
    nodeVersion: varchar('node_version', { length: 32 }).notNull(),
    nodeAppVersion: varchar('node_app_version', { length: 32 }).notNull(),
    // Device WS 凭 token hash 找到唯一 Device，故需唯一（03 §6 连接条件）。
    tokenHash: bytea('token_hash').notNull().unique(),
    capabilities: jsonb('capabilities').notNull(),
    // node.hello 运行时事实（03 §6.2；migration 0002，#37）：
    // 配对建行时未知 → version 可空待回填；digests 空数组 = 尚未上报。
    dshDistributionVersion: varchar('dsh_distribution_version', { length: 64 }),
    pluginPackDigests: jsonb('plugin_pack_digests')
      .notNull()
      .default(sql`'[]'::jsonb`),
    lastSeenAt: timestamp('last_seen_at', { withTimezone: true }),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
  },
  (table) => [
    unique('device_owner_name_unique').on(table.ownerUserId, table.name),
    check(
      'device_plugin_pack_digests_array',
      sql`jsonb_typeof(${table.pluginPackDigests}) = 'array'`,
    ),
  ],
)

export const devicePairingCodes = pgTable('device_pairing_code', {
  id: uuid('id').primaryKey(),
  ownerUserId: uuid('owner_user_id')
    .notNull()
    .references(() => userAccounts.id),
  codeHash: bytea('code_hash').notNull(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  consumedAt: timestamp('consumed_at', { withTimezone: true }),
})

export const workspaces = pgTable(
  'workspace',
  {
    // 由 Node 生成（03 §2.4），Hub 不自增。
    id: uuid('id').primaryKey(),
    deviceId: uuid('device_id')
      .notNull()
      .references(() => devices.id),
    ownerUserId: uuid('owner_user_id')
      .notNull()
      .references(() => userAccounts.id),
    name: varchar('name', { length: 80 }).notNull(),
    kind: workspaceKind('kind').notNull(),
    capabilities: jsonb('capabilities').notNull(),
    available: boolean('available').notNull().default(false),
    lastCheckedAt: timestamp('last_checked_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [unique('workspace_owner_name_unique').on(table.ownerUserId, table.name)],
)
