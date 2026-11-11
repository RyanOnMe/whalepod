import { sql } from 'drizzle-orm'
import {
  bigint,
  boolean,
  char,
  check,
  index,
  integer,
  foreignKey,
  pgTable,
  timestamp,
  unique,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core'
import { artifacts } from './artifact.js'
import { runs } from './run.js'
import { dispatchOutbox } from './outbox.js'
import { userAccounts } from './identity.js'
import { projects, tasks, taskSpecRevisions } from './project.js'

export const managedDraftModelPolicyFloor = pgTable(
  'managed_draft_model_policy_floor',
  {
    singleton: boolean('singleton').primaryKey(),
    generation: bigint('generation', { mode: 'number' }).notNull(),
    bindingDigest: char('binding_digest', { length: 64 }).notNull(),
  },
  (t) => [
    check('managed_draft_model_policy_floor_singleton_check', sql`${t.singleton}`),
    check(
      'managed_draft_model_policy_floor_generation_check',
      sql`${t.generation} between 1 and 9007199254740991`,
    ),
    check(
      'managed_draft_model_policy_floor_binding_digest_check',
      sql`${t.bindingDigest} ~ '^[a-f0-9]{64}$'`,
    ),
  ],
)

export const managedDraftSourcePolicies = pgTable(
  'managed_draft_source_policy',
  {
    id: uuid('id').primaryKey(),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id),
    taskId: uuid('task_id')
      .notNull()
      .references(() => tasks.id),
    revisionId: uuid('revision_id')
      .notNull()
      .references(() => taskSpecRevisions.id),
    ownerUserId: uuid('owner_user_id')
      .notNull()
      .references(() => userAccounts.id),
    recipientUserId: uuid('recipient_user_id')
      .notNull()
      .references(() => userAccounts.id),
    sha256: char('sha256', { length: 64 }).notNull(),
    byteSize: integer('byte_size').notNull(),
    modelBindingDigest: char('model_binding_digest', { length: 64 }).notNull(),
    permitsPublishedAudience: boolean('permits_published_audience').notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    idempotencyKey: varchar('idempotency_key', { length: 128 }).notNull(),
    requestDigest: char('request_digest', { length: 64 }).notNull(),
  },
  (t) => [
    index('managed_draft_source_policy_active_task_idx')
      .on(t.taskId)
      .where(sql`${t.revokedAt} is null`),
    index('managed_draft_source_policy_active_owner_idx')
      .on(t.ownerUserId)
      .where(sql`${t.revokedAt} is null`),
    index('managed_draft_source_policy_active_recipient_idx')
      .on(t.recipientUserId)
      .where(sql`${t.revokedAt} is null`),
    unique('managed_draft_source_policy_idempotency').on(t.ownerUserId, t.idempotencyKey),
    check(
      'managed_draft_source_policy_fields',
      sql`${t.ownerUserId} <> ${t.recipientUserId}
        and ${t.byteSize} between 1 and 65536
        and ${t.sha256} ~ '^[a-f0-9]{64}$'
        and ${t.modelBindingDigest} ~ '^[a-f0-9]{64}$'
        and ${t.requestDigest} ~ '^[a-f0-9]{64}$'
        and ${t.expiresAt} > ${t.createdAt}
        and (${t.revokedAt} is null or ${t.revokedAt} >= ${t.createdAt})`,
    ),
  ],
)

export type ManagedDraftSourcePolicyRow = typeof managedDraftSourcePolicies.$inferSelect

/** One isolated execution check, one source delivery and one model send decision. */
export const managedDraftExecutions = pgTable(
  'managed_draft_execution',
  {
    runId: uuid('run_id')
      .primaryKey()
      .references(() => runs.id),
    commandId: uuid('command_id')
      .notNull()
      .unique()
      .references(() => dispatchOutbox.id),
    connectionId: uuid('connection_id'),
    offeredAt: timestamp('offered_at', { withTimezone: true }),
    sourceRequestId: uuid('source_request_id'),
    sourceReadAt: timestamp('source_read_at', { withTimezone: true }),
    modelAttemptId: uuid('model_attempt_id').unique(),
    modelRequestDigest: char('model_request_digest', { length: 64 }),
    modelRequestByteSize: integer('model_request_byte_size'),
    modelDecidedAt: timestamp('model_decided_at', { withTimezone: true }),
    modelRespondedAt: timestamp('model_responded_at', { withTimezone: true }),
    modelResponseSha256: char('model_response_sha256', { length: 64 }),
    modelResponseByteSize: integer('model_response_byte_size'),
  },
  (t) => [
    unique('managed_draft_execution_run_model_attempt').on(t.runId, t.modelAttemptId),
    check(
      'managed_draft_execution_response_binding',
      sql`(${t.modelResponseSha256} is null and ${t.modelResponseByteSize} is null)
        or (${t.modelRespondedAt} is not null and ${t.modelResponseSha256} is not null
          and ${t.modelResponseByteSize} is not null
          and ${t.modelResponseSha256} ~ '^[a-f0-9]{64}$'
          and ${t.modelResponseByteSize} between 1 and 65536)`,
    ),
    check(
      'managed_draft_execution_offer_fields',
      sql`
      (${t.connectionId} is null) = (${t.offeredAt} is null)
      and (${t.sourceRequestId} is null) = (${t.sourceReadAt} is null)
      and (${t.sourceReadAt} is null or (${t.offeredAt} is not null and ${t.sourceReadAt} >= ${t.offeredAt}))`,
    ),
    check(
      'managed_draft_execution_model_fields',
      sql`
      (${t.modelAttemptId} is null and ${t.modelRequestDigest} is null and ${t.modelRequestByteSize} is null
        and ${t.modelDecidedAt} is null and ${t.modelRespondedAt} is null)
      or (${t.modelAttemptId} is not null and ${t.modelRequestDigest} is not null and ${t.modelRequestByteSize} is not null
        and ${t.modelRequestDigest} ~ '^[a-f0-9]{64}$' and ${t.modelRequestByteSize} between 1 and 131072
        and ${t.sourceReadAt} is not null and ${t.modelDecidedAt} is not null and ${t.modelDecidedAt} >= ${t.sourceReadAt}
        and (${t.modelRespondedAt} is null or ${t.modelRespondedAt} >= ${t.modelDecidedAt}))`,
    ),
  ],
)

/** A Run's only verified private candidate. Source bytes and model text never live in this table. */
export const managedDraftCandidates = pgTable(
  'managed_draft_candidate',
  {
    runId: uuid('run_id')
      .primaryKey()
      .references(() => runs.id),
    artifactId: uuid('artifact_id')
      .notNull()
      .unique()
      .references(() => artifacts.id),
    sourcePolicyId: uuid('source_policy_id')
      .notNull()
      .references(() => managedDraftSourcePolicies.id),
    manifestDigest: char('manifest_digest', { length: 64 }).notNull(),
    modelAttemptId: uuid('model_attempt_id').notNull(),
    fileWriteReceiptId: uuid('file_write_receipt_id').notNull().unique(),
    verifiedUploadReceiptId: uuid('verified_upload_receipt_id').notNull().unique(),
    sha256: char('sha256', { length: 64 }).notNull(),
    byteSize: integer('byte_size').notNull(),
    verifiedAt: timestamp('verified_at', { withTimezone: true }).notNull(),
  },
  (t) => [
    foreignKey({
      columns: [t.runId, t.modelAttemptId],
      foreignColumns: [managedDraftExecutions.runId, managedDraftExecutions.modelAttemptId],
      name: 'managed_draft_candidate_run_model_attempt_fkey',
    }),
    check(
      'managed_draft_candidate_fields',
      sql`${t.fileWriteReceiptId} <> ${t.verifiedUploadReceiptId}
        and ${t.manifestDigest} ~ '^[a-f0-9]{64}$'
        and ${t.sha256} ~ '^[a-f0-9]{64}$'
        and ${t.byteSize} between 1 and 65536`,
    ),
  ],
)
