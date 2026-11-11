import { sql } from 'drizzle-orm'
import {
  boolean,
  check,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  timestamp,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core'
import type { ConfigureDiscoveryRequest, DiscoveryProposal } from '@whalepod/protocol'
import { coordinationEvaluations } from './coordination.js'
import { userAccounts } from './identity.js'
import { projects, tasks, taskMessages } from './project.js'

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
  },
  (t) => [
    index('discovery_candidate_principal').on(t.projectId, t.principalUserId, t.createdAt),
    index('discovery_candidate_cleanup').on(t.checkedAt),
  ],
)
