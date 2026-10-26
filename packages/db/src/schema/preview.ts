import { sql } from 'drizzle-orm'
import {
  bigint,
  char,
  check,
  index,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core'
import { artifacts } from './artifact.js'

// Office 只读 PDF 预览绑定（#431；ADR-0021 §2）。预览是派生阅读副本，
// 一件原件至多一条；ready/failed 决定读面是给 PDF 还是下载回退。
export const artifactPreviewStatus = pgEnum('artifact_preview_status', ['ready', 'failed'])

export const artifactPreviews = pgTable(
  'artifact_preview',
  {
    artifactId: uuid('artifact_id')
      .primaryKey()
      .references(() => artifacts.id),
    status: artifactPreviewStatus('status').notNull(),
    sourceSha256: char('source_sha256', { length: 64 }).notNull(),
    converter: varchar('converter', { length: 100 }).notNull(),
    storageKey: text('storage_key'),
    sha256: char('sha256', { length: 64 }),
    byteSize: bigint('byte_size', { mode: 'number' }),
    mediaType: varchar('media_type', { length: 200 }),
    failureReason: varchar('failure_reason', { length: 2000 }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    check('artifact_preview_source_digest', sql`${table.sourceSha256} ~ '^[a-f0-9]{64}$'`),
    check(
      'artifact_preview_converter_length',
      sql`length(btrim(${table.converter})) between 1 and 100`,
    ),
    check(
      'artifact_preview_ready_fields',
      sql`(${table.status} = 'ready' and ${table.storageKey} is not null and ${table.sha256} is not null and ${table.byteSize} is not null and ${table.byteSize} between 1 and 52428800 and ${table.mediaType} = 'application/pdf' and ${table.failureReason} is null) or (${table.status} = 'failed' and ${table.storageKey} is null and ${table.sha256} is null and ${table.byteSize} is null and ${table.mediaType} is null and ${table.failureReason} is not null)`,
    ),
    check(
      'artifact_preview_failure_reason_length',
      sql`${table.failureReason} is null or length(btrim(${table.failureReason})) between 1 and 2000`,
    ),
    index('artifact_preview_by_status').on(table.status, table.updatedAt),
  ],
)
