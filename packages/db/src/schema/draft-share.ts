import { sql } from 'drizzle-orm'
import {
  char,
  check,
  index,
  integer,
  pgTable,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core'
import { artifacts } from './artifact.js'
import { userAccounts } from './identity.js'
import { managedDraftCandidates, managedDraftSourcePolicies } from './managed-draft.js'
import { projects, tasks } from './project.js'
import { runs } from './run.js'
import { workMandates } from './work.js'

export type DraftShareState =
  | 'offered'
  | 'active'
  | 'declined'
  | 'revoked'
  | 'expired'
  | 'superseded'

export const draftShareGrants = pgTable(
  'draft_share_grant',
  {
    id: uuid('id').primaryKey(),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id),
    taskId: uuid('task_id')
      .notNull()
      .references(() => tasks.id),
    workKey: varchar('work_key', { length: 64 }).notNull(),
    runId: uuid('run_id')
      .notNull()
      .references(() => runs.id),
    artifactId: uuid('artifact_id')
      .notNull()
      .references(() => artifacts.id),
    sourcePolicyId: uuid('source_policy_id')
      .notNull()
      .references(() => managedDraftSourcePolicies.id),
    mandateId: uuid('mandate_id')
      .notNull()
      .references(() => workMandates.id),
    mandateVersion: integer('mandate_version').notNull(),
    sourceManifestDigest: char('source_manifest_digest', { length: 64 }).notNull(),
    sourcePolicyDigest: char('source_policy_digest', { length: 64 }).notNull(),
    modelBindingDigest: char('model_binding_digest', { length: 64 }).notNull(),
    verifiedUploadReceiptId: uuid('verified_upload_receipt_id')
      .notNull()
      .references(() => managedDraftCandidates.verifiedUploadReceiptId),
    grantorUserId: uuid('grantor_user_id')
      .notNull()
      .references(() => userAccounts.id),
    recipientUserId: uuid('recipient_user_id')
      .notNull()
      .references(() => userAccounts.id),
    sha256: char('sha256', { length: 64 }).notNull(),
    byteSize: integer('byte_size').notNull(),
    purpose: varchar('purpose', { length: 16 })
      .$type<'human_read'>()
      .notNull()
      .default('human_read'),
    state: varchar('state', { length: 16 }).$type<DraftShareState>().notNull().default('offered'),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    offeredAt: timestamp('offered_at', { withTimezone: true }).notNull(),
    acceptedAt: timestamp('accepted_at', { withTimezone: true }),
    closedAt: timestamp('closed_at', { withTimezone: true }),
    idempotencyKey: varchar('idempotency_key', { length: 128 }).notNull(),
    requestDigest: char('request_digest', { length: 64 }).notNull(),
  },
  (table) => {
    const open = sql`${table.state} in ('offered', 'active')`
    return [
      unique('draft_share_grant_idempotency').on(
        table.grantorUserId,
        table.artifactId,
        table.idempotencyKey,
      ),
      uniqueIndex('draft_share_grant_open_recipient_idx')
        .on(table.artifactId, table.recipientUserId)
        .where(open),
      index('draft_share_grant_recipient_idx')
        .on(table.recipientUserId, table.offeredAt.desc())
        .where(open),
      index('draft_share_grant_source_idx').on(table.sourcePolicyId).where(open),
      check(
        'draft_share_grant_fields',
        sql`${table.grantorUserId} <> ${table.recipientUserId} and ${table.expiresAt} > ${table.offeredAt}
          and (${table.acceptedAt} is null or (${table.acceptedAt} >= ${table.offeredAt} and ${table.acceptedAt} < ${table.expiresAt}))
          and (${table.closedAt} is null or ${table.closedAt} >= coalesce(${table.acceptedAt}, ${table.offeredAt}))
          and ((${table.state} = 'offered' and ${table.acceptedAt} is null and ${table.closedAt} is null)
            or (${table.state} = 'active' and ${table.acceptedAt} is not null and ${table.closedAt} is null)
            or (${table.state} = 'declined' and ${table.acceptedAt} is null and ${table.closedAt} is not null)
            or (${table.state} in ('revoked', 'expired', 'superseded') and ${table.closedAt} is not null))`,
      ),
    ]
  },
)

export const draftShareReadAdmissions = pgTable('draft_share_read_admission', {
  id: uuid('id').primaryKey(),
  grantId: uuid('grant_id').references(() => draftShareGrants.id),
  artifactId: uuid('artifact_id')
    .notNull()
    .references(() => artifacts.id),
  actorUserId: uuid('actor_user_id')
    .notNull()
    .references(() => userAccounts.id),
  verifiedUploadReceiptId: uuid('verified_upload_receipt_id')
    .notNull()
    .references(() => managedDraftCandidates.verifiedUploadReceiptId),
  sha256: char('sha256', { length: 64 }).notNull(),
  admittedAt: timestamp('admitted_at', { withTimezone: true }).notNull(),
})
