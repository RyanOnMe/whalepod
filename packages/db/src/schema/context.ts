import { sql } from 'drizzle-orm'
import {
  bigserial,
  char,
  check,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
  type AnyPgColumn,
} from 'drizzle-orm/pg-core'
import { userAccounts } from './identity.js'
import { projects } from './project.js'

// ADR-0025（PC-03a）：项目事实账本。内部业务事件先行；来源修订、线程与
// WorkLink 由后续切片增加。所有读面统一按 status='active' AND correctedAt IS NULL
// 过滤；Decision 的当前有效行另有部分唯一索引。
export const contextEntryKind = pgEnum('context_entry_kind', [
  'observation',
  'inference',
  'decision',
  'correction',
])
export const contextEntryStatus = pgEnum('context_entry_status', [
  'active',
  'superseded',
  'conflict',
  'retracted',
])
export const contextActorKind = pgEnum('context_actor_kind', ['member', 'system', 'coordinator'])
export const contextCitationKind = pgEnum('context_citation_kind', ['source', 'business'])

export const contextEntries = pgTable(
  'context_entry',
  {
    id: uuid('id').primaryKey(),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id),
    kind: contextEntryKind('kind').notNull(),
    status: contextEntryStatus('status').notNull().default('active'),
    /** Correction 写入时同步标记目标行；不是第二套 status。 */
    correctedAt: timestamp('corrected_at', { withTimezone: true }),
    title: varchar('title', { length: 200 }).notNull(),
    /** 团队可读的正文；内部事件先行为纯文本，来源正文后续按 ADR-0024 保留。 */
    body: text('body').notNull().default(''),
    payload: jsonb('payload').$type<Record<string, unknown>>().notNull().default({}),
    sourceId: uuid('source_id'),
    revisionId: uuid('revision_id'),
    threadId: uuid('thread_id'),
    businessRef: varchar('business_ref', { length: 300 }),
    businessVersion: varchar('business_version', { length: 200 }),
    targetEntryId: uuid('target_entry_id').references((): AnyPgColumn => contextEntries.id),
    evaluationId: uuid('evaluation_id'),
    inputDigest: char('input_digest', { length: 64 }),
    createdBy: uuid('created_by').references(() => userAccounts.id),
    actorKind: contextActorKind('actor_kind').notNull(),
    processorVersion: varchar('processor_version', { length: 100 }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    check('context_entry_title_length', sql`length(btrim(${table.title})) between 1 and 200`),
    check('context_entry_body_size', sql`octet_length(${table.body}) <= 65536`),
    check('context_entry_payload_object', sql`jsonb_typeof(${table.payload}) = 'object'`),
    check('context_entry_payload_size', sql`octet_length(${table.payload}::text) <= 16384`),
    check(
      'context_entry_decision_fields',
      sql`${table.kind} <> 'decision' or (${table.actorKind} = 'member' and ${table.createdBy} is not null and ${table.businessRef} is not null and ${table.businessVersion} is not null and ${table.targetEntryId} is null and ${table.evaluationId} is null)`,
    ),
    check(
      'context_entry_observation_fields',
      sql`${table.kind} <> 'observation' or (${table.actorKind} = 'system' and (${table.businessRef} is not null or ${table.sourceId} is not null) and ${table.targetEntryId} is null and ${table.evaluationId} is null)`,
    ),
    check(
      'context_entry_inference_fields',
      sql`${table.kind} <> 'inference' or (${table.actorKind} = 'coordinator' and ${table.evaluationId} is not null and ${table.inputDigest} is not null and ${table.targetEntryId} is null)`,
    ),
    check(
      'context_entry_correction_fields',
      sql`${table.kind} <> 'correction' or (${table.actorKind} = 'member' and ${table.createdBy} is not null and ${table.targetEntryId} is not null and ${table.businessRef} is null and ${table.businessVersion} is null and ${table.evaluationId} is null and ${table.correctedAt} is null)`,
    ),
    check(
      'context_entry_business_pair',
      sql`(${table.businessRef} is null) = (${table.businessVersion} is null)`,
    ),
    check(
      'context_entry_corrected_at_kind',
      sql`${table.correctedAt} is null or ${table.kind} <> 'correction'`,
    ),
    uniqueIndex('context_entry_decision_version_unique')
      .on(table.businessRef, table.businessVersion)
      .where(sql`${table.kind} = 'decision'`),
    uniqueIndex('context_entry_decision_active_unique')
      .on(table.businessRef)
      .where(
        sql`${table.kind} = 'decision' and ${table.status} = 'active' and ${table.correctedAt} is null`,
      ),
    uniqueIndex('context_entry_observation_version_unique')
      .on(table.businessRef, table.businessVersion)
      .where(sql`${table.kind} = 'observation'`),
    uniqueIndex('context_entry_correction_target_unique')
      .on(table.targetEntryId)
      .where(sql`${table.kind} = 'correction'`),
    index('context_entry_project_created_idx').on(
      table.projectId,
      table.createdAt.desc(),
      table.id,
    ),
    index('context_entry_business_ref_idx')
      .on(table.businessRef)
      .where(sql`${table.businessRef} is not null`),
    // ADR-0026：一条协调评估只产生一条 Inference（评估 id 是输出幂等键）。
    uniqueIndex('context_entry_inference_evaluation_unique')
      .on(table.evaluationId)
      .where(sql`${table.kind} = 'inference'`),
  ],
)

export const contextCitations = pgTable(
  'context_citation',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    entryId: uuid('entry_id')
      .notNull()
      .references(() => contextEntries.id, { onDelete: 'cascade' }),
    kind: contextCitationKind('kind').notNull(),
    sourceId: uuid('source_id'),
    revisionId: uuid('revision_id'),
    resourceKey: text('resource_key'),
    threadKey: varchar('thread_key', { length: 300 }),
    locator: text('locator'),
    authorizationGeneration: integer('authorization_generation'),
    observedAt: timestamp('observed_at', { withTimezone: true }),
    digest: char('digest', { length: 64 }),
    businessRef: varchar('business_ref', { length: 300 }),
    businessVersion: varchar('business_version', { length: 200 }),
    occurredAt: timestamp('occurred_at', { withTimezone: true }),
  },
  (table) => [
    check(
      'context_citation_source_fields',
      sql`${table.kind} <> 'source' or (${table.sourceId} is not null and ${table.revisionId} is not null and ${table.resourceKey} is not null and ${table.locator} is not null and ${table.authorizationGeneration} is not null and ${table.observedAt} is not null and ${table.digest} is not null and ${table.businessRef} is null and ${table.businessVersion} is null and ${table.occurredAt} is null)`,
    ),
    check(
      'context_citation_business_fields',
      sql`${table.kind} <> 'business' or (${table.businessRef} is not null and ${table.businessVersion} is not null and ${table.occurredAt} is not null and ${table.sourceId} is null and ${table.revisionId} is null and ${table.resourceKey} is null and ${table.locator} is null and ${table.authorizationGeneration} is null and ${table.observedAt} is null and ${table.digest} is null)`,
    ),
    index('context_citation_entry_idx').on(table.entryId, table.id),
  ],
)

export type ContextEntryRow = typeof contextEntries.$inferSelect
export type NewContextEntryRow = typeof contextEntries.$inferInsert
export type ContextCitationRow = typeof contextCitations.$inferSelect
export type NewContextCitationRow = typeof contextCitations.$inferInsert
