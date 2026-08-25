import { sql } from 'drizzle-orm'
import {
  bigserial,
  check,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core'
import { devices } from './device.js'

// 持久 Team Event（03 §5：cursor 补发、24 小时保留窗口）。
// id 即 Browser WS 的 cursor（wire 上序列化为字符串）。
export const teamEvents = pgTable(
  'team_event',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    type: varchar('type', { length: 80 }).notNull(),
    payload: jsonb('payload').notNull(),
    occurredAt: timestamp('occurred_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    // 持久事件单条 payload 上限 32 KiB（02 Global Constraints）。
    check('team_event_payload_size', sql`octet_length(${table.payload}::text) <= 32768`),
  ],
)

// Hub → Node 命令的持久队列（03 §2.6 dispatch_outbox）。
// 语义：至少一次投递；claim/ack/fail 见 src/outbox.ts。
export const dispatchOutbox = pgTable(
  'dispatch_outbox',
  {
    // 即协议里的 commandId（03 §2.6）。
    id: uuid('id').primaryKey(),
    deviceId: uuid('device_id')
      .notNull()
      .references(() => devices.id),
    type: varchar('type', { length: 80 }).notNull(),
    payload: jsonb('payload').notNull(),
    attemptCount: integer('attempt_count').notNull().default(0),
    nextAttemptAt: timestamp('next_attempt_at', { withTimezone: true }).notNull().defaultNow(),
    ackedAt: timestamp('acked_at', { withTimezone: true }),
    failedAt: timestamp('failed_at', { withTimezone: true }),
  },
  (table) => [
    index('dispatch_outbox_pending_idx')
      .on(table.nextAttemptAt)
      .where(sql`${table.ackedAt} is null and ${table.failedAt} is null`),
  ],
)

// transactCommand 幂等回执（02 Task 4 Step 4）：同 key 重放直接返回首次结果。
export const commandReceipts = pgTable('command_receipt', {
  key: text('key').primaryKey(),
  result: jsonb('result').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
})
