import { sql } from 'drizzle-orm'
import {
  boolean,
  char,
  check,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core'
import type {
  ConfigureDiscoveryRequest,
  DiscoveryProposal,
  TaskSpecContent,
} from '@whalepod/protocol'
import { coordinationEvaluations } from './coordination.js'
import { userAccounts } from './identity.js'
import { projects, tasks, taskMessages, taskSpecRevisions } from './project.js'
import { works } from './work.js'

export const discoveryConfigurations = pgTable(
  'discovery_configuration',
  {
    projectId: uuid('project_id')
      .primaryKey()
      .references(() => projects.id),
    version: integer('version').notNull(),
    modelConfigVersion: integer('model_config_version').notNull(),
    settings: jsonb('settings').$type<ConfigureDiscoveryRequest>().notNull(),
    configuredBy: uuid('configured_by')
      .notNull()
      .references(() => userAccounts.id),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull(),
  },
  (t) => [
    check('discovery_configuration_version', sql`${t.version} > 0 and ${t.modelConfigVersion} > 0`),
  ],
)

export const discoveryConsents = pgTable(
  'discovery_consent',
  {
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id),
    userId: uuid('user_id')
      .notNull()
      .references(() => userAccounts.id),
    kind: varchar('kind', { length: 16 }).$type<'permit' | 'participation'>().notNull(),
    configVersion: integer('config_version').notNull(),
    version: integer('version').notNull(),
    active: boolean('active').notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.projectId, t.userId, t.kind] }),
    check(
      'discovery_consent_binding',
      sql`${t.kind} in ('permit','participation') and ${t.configVersion} > 0 and ${t.version} > 0`,
    ),
  ],
)

/** Immutable routing decision; later fields describe processing, never redirect the event. */
export const discoveryAdmissions = pgTable(
  'discovery_admission',
  {
    sourceId: uuid('source_id')
      .primaryKey()
      .references(() => taskMessages.id),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id),
    entryTaskId: uuid('entry_task_id')
      .notNull()
      .references(() => tasks.id),
    sourceVersion: varchar('source_version', { length: 64 }).notNull(),
    sourceDigest: varchar('source_digest', { length: 64 }).notNull(),
    route: varchar('route', { length: 16 })
      .$type<'existing_work' | 'closed' | 'rejected' | 'discovery'>()
      .notNull(),
    reason: varchar('reason', { length: 64 }).notNull(),
    entryGeneration: varchar('entry_generation', { length: 64 }),
    configVersion: integer('config_version'),
    permitVersion: integer('permit_version'),
    authorVersion: integer('author_version'),
    evaluationId: uuid('evaluation_id').references(() => coordinationEvaluations.id),
    processedAt: timestamp('processed_at', { withTimezone: true }),
    processingReason: varchar('processing_reason', { length: 64 }),
    withdrawnAt: timestamp('withdrawn_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
  },
  (t) => [
    check(
      'discovery_admission_route',
      sql`${t.route} in ('existing_work','closed','rejected','discovery')`,
    ),
    check(
      'discovery_admission_binding',
      sql`${t.route} <> 'discovery' or (${t.entryGeneration} is not null and ${t.configVersion} > 0 and ${t.permitVersion} > 0 and ${t.authorVersion} > 0)`,
    ),
    index('discovery_admission_pending')
      .on(t.projectId, t.createdAt, t.sourceId)
      .where(sql`${t.route} = 'discovery' and ${t.processedAt} is null`),
  ],
)

export const discoveryCandidates = pgTable(
  'discovery_candidate',
  {
    id: uuid('id').primaryKey(),
    evaluationId: uuid('evaluation_id')
      .notNull()
      .unique()
      .references(() => coordinationEvaluations.id),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id),
    sourceId: uuid('source_id')
      .notNull()
      .references(() => discoveryAdmissions.sourceId),
    sourceVersion: varchar('source_version', { length: 64 }).notNull(),
    principalUserId: uuid('principal_user_id')
      .notNull()
      .references(() => userAccounts.id),
    proposal: jsonb('proposal').$type<DiscoveryProposal>().notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    checkedAt: timestamp('checked_at', { withTimezone: true }).notNull(),
    /** RD-04b：立项尝试水位。终态原因不再每个 tick 重试，目录变化类允许重试。 */
    creationCheckedAt: timestamp('creation_checked_at', { withTimezone: true }),
    creationReason: varchar('creation_reason', { length: 64 }),
    creationTerminal: boolean('creation_terminal').notNull().default(false),
  },
  (t) => [
    index('discovery_candidate_principal').on(t.projectId, t.principalUserId, t.createdAt),
    index('discovery_candidate_cleanup').on(t.checkedAt),
  ],
)

/** 来源更正：原作者版本化改正文，原文不动。 */
export const discoverySourceCorrections = pgTable(
  'discovery_source_correction',
  {
    id: uuid('id').primaryKey(),
    sourceId: uuid('source_id')
      .notNull()
      .references(() => taskMessages.id),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id),
    authorUserId: uuid('author_user_id')
      .notNull()
      .references(() => userAccounts.id),
    version: integer('version').notNull(),
    body: text('body').notNull(),
    digest: char('digest', { length: 64 }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
  },
  (t) => [
    check('discovery_source_correction_version', sql`${t.version} >= 1`),
    check('discovery_source_correction_body', sql`length(btrim(${t.body})) between 1 and 20000`),
    check('discovery_source_correction_digest', sql`${t.digest} ~ '^[a-f0-9]{64}$'`),
    unique('discovery_source_correction_version_unique').on(t.sourceId, t.version),
  ],
)

/** 稳定的交付槽位身份：活动 + 槽位名在同一项目内唯一；generation 随目录写入推进。 */
export const discoverySlots = pgTable(
  'discovery_slot',
  {
    id: uuid('id').primaryKey(),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id),
    activity: varchar('activity', { length: 120 }).notNull(),
    slot: varchar('slot', { length: 240 }).notNull(),
    generation: integer('generation').notNull().default(0),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull(),
  },
  (t) => [
    check('discovery_slot_generation', sql`${t.generation} >= 0`),
    unique('discovery_slot_identity').on(t.projectId, t.activity, t.slot),
  ],
)

/**
 * 责任人本人的预授权快照。`tier` 三档：discover 仅发现；create 可自动立项；
 * execute 另需执行授权（RD-04c 才实现）。`template` 是确认时看到的确切模板。
 */
export const discoveryPermits = pgTable(
  'discovery_permit',
  {
    id: uuid('id').primaryKey(),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id),
    slotId: uuid('slot_id')
      .notNull()
      .references(() => discoverySlots.id),
    configVersion: integer('config_version').notNull(),
    version: integer('version').notNull(),
    principalUserId: uuid('principal_user_id')
      .notNull()
      .references(() => userAccounts.id),
    entryTaskId: uuid('entry_task_id')
      .notNull()
      .references(() => tasks.id),
    tier: varchar('tier', { length: 16 }).$type<'discover' | 'create' | 'execute'>().notNull(),
    templateVersion: varchar('template_version', { length: 128 }).notNull(),
    template: jsonb('template').$type<TaskSpecContent>().notNull(),
    templateDigest: char('template_digest', { length: 64 }).notNull(),
    maxCreations: integer('max_creations').notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    verifierUserIds: jsonb('verifier_user_ids').$type<string[]>().notNull(),
    confirmedAt: timestamp('confirmed_at', { withTimezone: true }).notNull(),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    revokedReason: varchar('revoked_reason', { length: 64 }),
  },
  (t) => [
    check('discovery_permit_tier', sql`${t.tier} in ('discover', 'create', 'execute')`),
    check('discovery_permit_versions', sql`${t.configVersion} > 0 and ${t.version} > 0`),
    check(
      'discovery_permit_template_object',
      sql`jsonb_typeof(${t.template}) = 'object' and octet_length(${t.template}::text) <= 65536`,
    ),
    check('discovery_permit_template_digest', sql`${t.templateDigest} ~ '^[a-f0-9]{64}$'`),
    check('discovery_permit_creations', sql`${t.maxCreations} >= 1`),
    check('discovery_permit_expiry', sql`${t.expiresAt} > ${t.confirmedAt}`),
    check(
      'discovery_permit_verifiers',
      sql`jsonb_typeof(${t.verifierUserIds}) = 'array' and jsonb_array_length(case when jsonb_typeof(${t.verifierUserIds}) = 'array' then ${t.verifierUserIds} else '[]'::jsonb end) between 0 and 16 and (${t.tier} = 'discover' or jsonb_array_length(${t.verifierUserIds}) >= 1)`,
    ),
    check(
      'discovery_permit_revocation',
      sql`(${t.revokedAt} is null and ${t.revokedReason} is null) or (${t.revokedAt} is not null and ${t.revokedReason} is not null)`,
    ),
    unique('discovery_permit_principal_version').on(t.projectId, t.principalUserId, t.version),
    index('discovery_permit_active')
      .on(t.projectId, t.principalUserId, t.configVersion)
      .where(sql`${t.revokedAt} is null`),
  ],
)

/** 责任人核对完整目录的结果；只有当前 generation 且全部 not_covered 才是 eligible_empty。 */
export const discoverySlotVerifications = pgTable(
  'discovery_slot_verification',
  {
    id: uuid('id').primaryKey(),
    slotId: uuid('slot_id')
      .notNull()
      .references(() => discoverySlots.id),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id),
    generation: integer('generation').notNull(),
    catalogDigest: char('catalog_digest', { length: 64 }).notNull(),
    entries: jsonb('entries').$type<DiscoverySlotVerificationEntry[]>().notNull(),
    verifiedBy: uuid('verified_by')
      .notNull()
      .references(() => userAccounts.id),
    permitId: uuid('permit_id')
      .notNull()
      .references(() => discoveryPermits.id),
    permitVersion: integer('permit_version').notNull(),
    verifiedAt: timestamp('verified_at', { withTimezone: true }).notNull(),
  },
  (t) => [
    check('discovery_slot_verification_generation', sql`${t.generation} >= 0`),
    check('discovery_slot_verification_digest', sql`${t.catalogDigest} ~ '^[a-f0-9]{64}$'`),
    check(
      'discovery_slot_verification_entries',
      sql`jsonb_typeof(${t.entries}) = 'array' and jsonb_array_length(case when jsonb_typeof(${t.entries}) = 'array' then ${t.entries} else '[]'::jsonb end) <= 64 and octet_length(${t.entries}::text) <= 65536`,
    ),
    check('discovery_slot_verification_permit_version', sql`${t.permitVersion} > 0`),
    unique('discovery_slot_verification_generation_unique').on(t.slotId, t.generation),
  ],
)

/** 核实人对确切来源版本的正式回执；不存评论正文。 */
export const discoveryVerifications = pgTable(
  'discovery_verification',
  {
    id: uuid('id').primaryKey(),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id),
    slotId: uuid('slot_id')
      .notNull()
      .references(() => discoverySlots.id),
    permitId: uuid('permit_id')
      .notNull()
      .references(() => discoveryPermits.id),
    permitVersion: integer('permit_version').notNull(),
    sourceId: uuid('source_id')
      .notNull()
      .references(() => taskMessages.id),
    sourceVersion: varchar('source_version', { length: 64 }).notNull(),
    sourceDigest: char('source_digest', { length: 64 }).notNull(),
    verifierUserId: uuid('verifier_user_id')
      .notNull()
      .references(() => userAccounts.id),
    kind: varchar('kind', { length: 16 }).$type<'receipt'>().notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    revokedReason: varchar('revoked_reason', { length: 64 }),
  },
  (t) => [
    check('discovery_verification_kind', sql`${t.kind} in ('receipt')`),
    check('discovery_verification_digest', sql`${t.sourceDigest} ~ '^[a-f0-9]{64}$'`),
    check('discovery_verification_permit_version', sql`${t.permitVersion} > 0`),
    check(
      'discovery_verification_revocation',
      sql`(${t.revokedAt} is null and ${t.revokedReason} is null) or (${t.revokedAt} is not null and ${t.revokedReason} is not null)`,
    ),
    uniqueIndex('discovery_verification_current')
      .on(t.sourceId, t.slotId, t.permitId, t.verifierUserId)
      .where(sql`${t.revokedAt} is null`),
  ],
)

/** 一次已完成的立项：候选、许可、槽位、Task/约定/Work 与固定来源绑定。 */
export const discoveryApplications = pgTable(
  'discovery_application',
  {
    id: uuid('id').primaryKey(),
    candidateId: uuid('candidate_id')
      .notNull()
      .unique()
      .references(() => discoveryCandidates.id),
    evaluationId: uuid('evaluation_id')
      .notNull()
      .unique()
      .references(() => coordinationEvaluations.id),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id),
    slotId: uuid('slot_id')
      .notNull()
      .references(() => discoverySlots.id),
    permitId: uuid('permit_id')
      .notNull()
      .references(() => discoveryPermits.id),
    permitVersion: integer('permit_version').notNull(),
    sourceId: uuid('source_id')
      .notNull()
      .references(() => taskMessages.id),
    sourceVersion: varchar('source_version', { length: 64 }).notNull(),
    sourceDigest: char('source_digest', { length: 64 }).notNull(),
    verification: jsonb('verification').$type<DiscoveryApplicationVerification>().notNull(),
    taskId: uuid('task_id')
      .notNull()
      .unique()
      .references(() => tasks.id),
    workId: uuid('work_id')
      .notNull()
      .unique()
      .references(() => works.id),
    specRevisionId: uuid('spec_revision_id')
      .notNull()
      .unique()
      .references(() => taskSpecRevisions.id),
    status: varchar('status', { length: 16 }).$type<'applied' | 'rejected'>().notNull(),
    reason: varchar('reason', { length: 64 }),
    appliedAt: timestamp('applied_at', { withTimezone: true }).notNull(),
  },
  (t) => [
    check('discovery_application_status', sql`${t.status} in ('applied', 'rejected')`),
    check(
      'discovery_application_status_fields',
      sql`(${t.status} = 'applied' and ${t.reason} is null) or (${t.status} = 'rejected' and ${t.reason} is not null)`,
    ),
    check('discovery_application_digest', sql`${t.sourceDigest} ~ '^[a-f0-9]{64}$'`),
    check('discovery_application_permit_version', sql`${t.permitVersion} > 0`),
    check(
      'discovery_application_verification_object',
      sql`jsonb_typeof(${t.verification}) = 'object' and octet_length(${t.verification}::text) <= 65536`,
    ),
  ],
)

/** 槽位唯一占用：人工认领与自动立项同一约束。 */
export const discoverySlotOccupations = pgTable(
  'discovery_slot_occupation',
  {
    id: uuid('id').primaryKey(),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id),
    slotId: uuid('slot_id')
      .notNull()
      .unique()
      .references(() => discoverySlots.id),
    taskId: uuid('task_id')
      .notNull()
      .unique()
      .references(() => tasks.id),
    workId: uuid('work_id')
      .unique()
      .references(() => works.id),
    applicationId: uuid('application_id')
      .unique()
      .references(() => discoveryApplications.id),
    source: varchar('source', { length: 16 }).$type<'auto' | 'manual'>().notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
  },
  (t) => [
    check('discovery_slot_occupation_source', sql`${t.source} in ('auto', 'manual')`),
    check(
      'discovery_slot_occupation_fields',
      sql`(${t.source} = 'auto' and ${t.workId} is not null and ${t.applicationId} is not null) or (${t.source} = 'manual')`,
    ),
  ],
)

/** 固定来源绑定：只由 Hub 物化；客户端不可提交或修改。 */
export const discoverySourceBindings = pgTable(
  'discovery_source_binding',
  {
    id: uuid('id').primaryKey(),
    applicationId: uuid('application_id')
      .notNull()
      .unique()
      .references(() => discoveryApplications.id),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id),
    workId: uuid('work_id')
      .notNull()
      .unique()
      .references(() => works.id),
    taskId: uuid('task_id')
      .notNull()
      .unique()
      .references(() => tasks.id),
    slotId: uuid('slot_id')
      .notNull()
      .references(() => discoverySlots.id),
    sourceId: uuid('source_id')
      .notNull()
      .references(() => taskMessages.id),
    sourceVersion: varchar('source_version', { length: 64 }).notNull(),
    sourceDigest: char('source_digest', { length: 64 }).notNull(),
    verification: jsonb('verification').$type<DiscoveryApplicationVerification>().notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
  },
  (t) => [
    check('discovery_source_binding_digest', sql`${t.sourceDigest} ~ '^[a-f0-9]{64}$'`),
    check(
      'discovery_source_binding_verification_object',
      sql`jsonb_typeof(${t.verification}) = 'object' and octet_length(${t.verification}::text) <= 65536`,
    ),
  ],
)

export interface DiscoverySlotCatalogEntry {
  readonly taskId: string
  readonly status: string
  readonly assignmentStatus: string
  readonly workState: string | null
  readonly publishedArtifacts: readonly {
    readonly id: string
    readonly sha256: string
    readonly publishedAt: string
  }[]
}
export interface DiscoverySlotVerificationEntry {
  readonly taskId: string
  readonly coverage: 'covered' | 'not_covered'
}
export interface DiscoveryApplicationVerification {
  readonly kind: 'published_evidence' | 'receipt' | 'mixed'
  readonly evidence: readonly {
    readonly artifactId: string
    readonly sha256: string
    readonly verifierUserId: string
  }[]
  readonly receiptIds: readonly string[]
  readonly verifierUserIds: readonly string[]
}
