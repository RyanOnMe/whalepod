import { char, jsonb, pgEnum, pgTable, text, timestamp, uuid, varchar } from 'drizzle-orm/pg-core'
import { userAccounts } from './identity.js'

// Plugin 域表结构以 03-领域模型与运行协议.md §2.5 为准。
export const pluginTrust = pgEnum('plugin_trust', ['builtin', 'curated', 'unreviewed'])
export const pluginCapabilityClass = pgEnum('plugin_capability_class', [
  'declared',
  'legacy_unrestricted',
])
export const pluginStatus = pgEnum('plugin_status', ['installed', 'disabled', 'failed'])

export const pluginInstallations = pgTable('plugin_installation', {
  id: uuid('id').primaryKey(),
  packageName: varchar('package_name', { length: 214 }).notNull(),
  // 精确版本，不允许 range/tag（03 §2.5）。
  packageVersion: varchar('package_version', { length: 64 }).notNull(),
  integrity: text('integrity').notNull(),
  dependencyLockDigest: char('dependency_lock_digest', { length: 64 }).notNull(),
  trust: pluginTrust('trust').notNull(),
  capabilityClass: pluginCapabilityClass('capability_class').notNull(),
  capabilities: jsonb('capabilities').notNull(),
  status: pluginStatus('status').notNull().default('installed'),
  installedBy: uuid('installed_by')
    .notNull()
    .references(() => userAccounts.id),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
})

export const pluginPacks = pgTable('plugin_pack', {
  id: uuid('id').primaryKey(),
  name: varchar('name', { length: 80 }).notNull().unique(),
  // 按 package name 排序的 installation id 数组（03 §2.5）。
  installations: jsonb('installations').notNull(),
  packDigest: char('pack_digest', { length: 64 }).notNull(),
  createdBy: uuid('created_by')
    .notNull()
    .references(() => userAccounts.id),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
})
