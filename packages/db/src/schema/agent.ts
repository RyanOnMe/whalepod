import { sql } from 'drizzle-orm'
import {
  bigint,
  char,
  check,
  integer,
  pgEnum,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core'
import type { AnyPgColumn } from 'drizzle-orm/pg-core'
import { userAccounts } from './identity.js'
import { pluginPacks } from './plugin.js'

// Agent/Profile 域表结构以 03-领域模型与运行协议.md §2.3 为准。
/** 审批档位（#241；ADR-0009 决策 7）：Run 内工具调用的授权姿态。 */
export const approvalPolicy = pgEnum('approval_policy', ['approval_required', 'full_access'])

export const agents = pgTable('agent', {
  id: uuid('id').primaryKey(),
  name: varchar('name', { length: 80 }).notNull().unique(),
  description: varchar('description', { length: 500 }).notNull().default(''),
  // 指向不可变 Revision；建 Agent 时同事务先插 Revision 再回填，故列可空。
  currentRevisionId: uuid('current_revision_id').references(
    (): AnyPgColumn => agentProfileRevisions.id,
  ),
  createdBy: uuid('created_by')
    .notNull()
    .references(() => userAccounts.id),
  archivedAt: timestamp('archived_at', { withTimezone: true }),
})

export const agentProfileRevisions = pgTable(
  'agent_profile_revision',
  {
    id: uuid('id').primaryKey(),
    agentId: uuid('agent_id')
      .notNull()
      .references(() => agents.id),
    revision: integer('revision').notNull(),
    persona: text('persona').notNull(),
    provider: varchar('provider', { length: 100 }).notNull(),
    model: varchar('model', { length: 200 }).notNull(),
    credentialSlot: varchar('credential_slot', { length: 80 }).notNull(),
    maxTokens: integer('max_tokens'),
    // ADR-0028 §17 / ADR-0026 §13（RD-03r2）：业务 Executor 的费用单价。两者必须
    // 同时配置；缺省表示该 Revision 没有可核定的费用上限，机器派工 fail-closed。
    inputPriceMicrosPerMillionTokens: bigint('input_price_micros_per_million_tokens', {
      mode: 'number',
    }),
    outputPriceMicrosPerMillionTokens: bigint('output_price_micros_per_million_tokens', {
      mode: 'number',
    }),
    // 默认审批档（#241）：非空，默认 approval_required。进 profileDigest 的
    // canonical JSON（档位是 Revision 行为的一部分）；Task 可覆盖（见 task 表）。
    approvalPolicy: approvalPolicy('approval_policy').notNull().default('approval_required'),
    pluginPackId: uuid('plugin_pack_id')
      .notNull()
      .references(() => pluginPacks.id),
    profileDigest: char('profile_digest', { length: 64 }).notNull(),
    createdBy: uuid('created_by')
      .notNull()
      .references(() => userAccounts.id),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    // 每个 Agent 的 revision 从 1 单调递增（03 §2.3）。
    unique('agent_profile_revision_unique').on(table.agentId, table.revision),
    check('agent_profile_revision_positive', sql`${table.revision} >= 1`),
    check(
      'agent_profile_revision_persona_length',
      sql`length(${table.persona}) between 1 and 20000`,
    ),
    check(
      'agent_profile_revision_max_tokens_positive',
      sql`${table.maxTokens} is null or ${table.maxTokens} > 0`,
    ),
    check(
      'agent_profile_revision_prices_pair',
      sql`(${table.inputPriceMicrosPerMillionTokens} is null) = (${table.outputPriceMicrosPerMillionTokens} is null)`,
    ),
    check(
      'agent_profile_revision_prices_positive',
      sql`(${table.inputPriceMicrosPerMillionTokens} is null or ${table.inputPriceMicrosPerMillionTokens} > 0) and (${table.outputPriceMicrosPerMillionTokens} is null or ${table.outputPriceMicrosPerMillionTokens} > 0)`,
    ),
  ],
)
