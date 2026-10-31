import { sql } from 'drizzle-orm'
import {
  bigserial,
  boolean,
  check,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core'
import { devices } from './device.js'
import { userAccounts } from './identity.js'
import { projects } from './project.js'

// ADR-0024（PC-02a）：外部来源绑定、采集租约与审计。
// 正文/SourceRevision 由 PC-03 按 ADR-0025 增加；本文件不持有来源内容。
export const sourcePlatform = pgEnum('source_platform', ['feishu'])
export const sourceKind = pgEnum('source_kind', ['group', 'thread', 'doc', 'sheet_range'])
export const sourceStatus = pgEnum('source_status', ['active', 'paused', 'unavailable', 'revoked'])
export const sourcePermissionState = pgEnum('source_permission_state', [
  'verified',
  'unknown',
  'denied',
])

export const projectSources = pgTable(
  'project_source',
  {
    id: uuid('id').primaryKey(),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id),
    platform: sourcePlatform('platform').notNull(),
    kind: sourceKind('kind').notNull(),
    /** 平台侧不透明资源身份；不写日志、不进视图。 */
    resourceKey: text('resource_key').notNull(),
    /** 成员填写的团队可见标签；不存平台原名。 */
    displayLabel: varchar('display_label', { length: 120 }).notNull(),
    collectorNodeId: uuid('collector_node_id')
      .notNull()
      .references(() => devices.id),
    credentialSlot: varchar('credential_slot', { length: 80 }).notNull(),
    /** Node 只读检查返回的不透明应用身份哈希；用于采集租约分桶。 */
    appKey: varchar('app_key', { length: 200 }).notNull(),
    shareScope: varchar('share_scope', { length: 16 }).notNull().default('team'),
    autoExtraction: boolean('auto_extraction').notNull().default(false),
    status: sourceStatus('status').notNull().default('active'),
    permissionState: sourcePermissionState('permission_state').notNull().default('verified'),
    permissionCheckedAt: timestamp('permission_checked_at', { withTimezone: true }).notNull(),
    permissionExpiresAt: timestamp('permission_expires_at', { withTimezone: true }),
    /** verified 过期转 unknown 的时刻；连续 7 天 unknown 转 unavailable。 */
    permissionUnknownSince: timestamp('permission_unknown_since', { withTimezone: true }),
    /** 授权代次：恢复、重新验证、更换采集者各 +1；旧代次提交一律拒绝。 */
    authorizationGeneration: integer('authorization_generation').notNull().default(1),
    lastSuccessAt: timestamp('last_success_at', { withTimezone: true }),
    /** PC-03 的 source_revision 表建立后再补 FK。 */
    latestRevisionId: uuid('latest_revision_id'),
    boundBy: uuid('bound_by')
      .notNull()
      .references(() => userAccounts.id),
    boundAt: timestamp('bound_at', { withTimezone: true }).notNull().defaultNow(),
    pausedAt: timestamp('paused_at', { withTimezone: true }),
    unavailableAt: timestamp('unavailable_at', { withTimezone: true }),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    revokedBy: uuid('revoked_by').references(() => userAccounts.id),
    revokeReason: varchar('revoke_reason', { length: 500 }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    check('project_source_share_scope', sql`${table.shareScope} = 'team'`),
    check(
      'project_source_label_length',
      sql`length(btrim(${table.displayLabel})) between 1 and 120`,
    ),
    check(
      'project_source_resource_length',
      sql`length(btrim(${table.resourceKey})) between 1 and 500`,
    ),
    check(
      'project_source_credential_slot_length',
      sql`length(btrim(${table.credentialSlot})) between 1 and 80`,
    ),
    check('project_source_app_key_length', sql`length(btrim(${table.appKey})) between 1 and 200`),
    check('project_source_generation', sql`${table.authorizationGeneration} >= 1`),
    check(
      'project_source_revoked_fields',
      sql`(
        (${table.status} = 'revoked' and ${table.revokedAt} is not null
          and ${table.revokedBy} is not null and ${table.revokeReason} is not null)
        or (${table.status} <> 'revoked' and ${table.revokedAt} is null
          and ${table.revokedBy} is null and ${table.revokeReason} is null)
      )`,
    ),
    check(
      'project_source_permission_fields',
      sql`(
        (${table.permissionState} = 'verified' and ${table.permissionCheckedAt} is not null
          and ${table.permissionExpiresAt} is not null and ${table.permissionUnknownSince} is null)
        or (${table.permissionState} = 'unknown' and ${table.permissionCheckedAt} is not null
          and ${table.permissionUnknownSince} is not null)
        or (${table.permissionState} = 'denied' and ${table.permissionCheckedAt} is not null)
      )`,
    ),
    check(
      'project_source_status_fields',
      sql`((${table.status} = 'paused' and ${table.pausedAt} is not null)
        or (${table.status} <> 'paused' and ${table.pausedAt} is null))`,
    ),
    check(
      'project_source_unavailable_fields',
      sql`((${table.status} = 'unavailable' and ${table.unavailableAt} is not null)
        or (${table.status} <> 'unavailable' and ${table.unavailableAt} is null))`,
    ),
    // 同一外部资源同一时刻最多一个活动绑定；撤销后重新绑定是新行、新代次。
    uniqueIndex('project_source_active_resource')
      .on(table.platform, table.resourceKey)
      .where(sql`${table.status} <> 'revoked'`),
    index('project_source_by_project').on(table.projectId, table.createdAt),
    index('project_source_app_key').on(table.platform, table.appKey),
    index('project_source_permission_due')
      .on(table.permissionExpiresAt)
      .where(
        sql`${table.status} in ('active', 'paused') and ${table.permissionState} = 'verified'`,
      ),
    index('project_source_unknown_since')
      .on(table.permissionUnknownSince)
      .where(sql`${table.status} in ('active', 'paused') and ${table.permissionState} = 'unknown'`),
  ],
)

export type ProjectSourceRow = typeof projectSources.$inferSelect
export type NewProjectSourceRow = typeof projectSources.$inferInsert

export const sourceCollectionLeases = pgTable(
  'source_collection_lease',
  {
    platform: sourcePlatform('platform').notNull(),
    appKey: varchar('app_key', { length: 200 }).notNull(),
    deviceId: uuid('device_id')
      .notNull()
      .references(() => devices.id),
    generation: integer('generation').notNull(),
    leaseToken: uuid('lease_token').notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    acquiredAt: timestamp('acquired_at', { withTimezone: true }).notNull().defaultNow(),
    renewedAt: timestamp('renewed_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.platform, table.appKey] }),
    check('source_lease_generation', sql`${table.generation} >= 1`),
    check('source_lease_app_key_length', sql`length(btrim(${table.appKey})) between 1 and 200`),
  ],
)

export type SourceCollectionLeaseRow = typeof sourceCollectionLeases.$inferSelect

export const sourceAuditEvents = pgTable(
  'source_audit_event',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    sourceId: uuid('source_id')
      .notNull()
      .references(() => projectSources.id),
    action: varchar('action', { length: 40 }).notNull(),
    actorMemberId: uuid('actor_member_id').references(() => userAccounts.id),
    authorizationGeneration: integer('authorization_generation').notNull(),
    reason: varchar('reason', { length: 500 }),
    payload: jsonb('payload')
      .notNull()
      .default(sql`'{}'::jsonb`),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    check(
      'source_audit_action',
      sql`${table.action} in ('bound', 'paused', 'resumed', 'revoked', 'unavailable', 'permission_changed', 'lease_changed')`,
    ),
    check('source_audit_generation', sql`${table.authorizationGeneration} >= 1`),
    check(
      'source_audit_reason_length',
      sql`${table.reason} is null or length(btrim(${table.reason})) between 1 and 500`,
    ),
    check('source_audit_payload_size', sql`octet_length(${table.payload}::text) <= 4096`),
    index('source_audit_by_source').on(table.sourceId, table.id),
  ],
)

export type SourceAuditEventRow = typeof sourceAuditEvents.$inferSelect
