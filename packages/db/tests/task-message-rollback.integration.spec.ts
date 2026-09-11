/**
 * 反向 SQL 的常驻验证（#185 评审应改 5 的收口）。
 *
 * 迁移 0003 的注释里给了「回滚路径」骨架（先备份 + 反向 SQL + 删台账行）。骨架本身**不可执行**
 * 就等于没写——评审手工跑过一遍，这里把它固定成机器判据：跑 0001→0003，再按骨架反向执行，
 * 断言 schema 与**迁移前逐名一致**（列 / 约束名 / 索引名），且台账行的处理被显式验证。
 *
 * 这份反向 SQL 是**验证夹具**，不是随仓库发布的 down-migration：本仓纪律是 forward-only，
 * 真回滚要现场按骨架写并以备份为准（见迁移尾部注释）。夹具的价值在于——任何人改动 0003
 * 却忘了同步回滚骨架，这条用例就会红。
 *
 * 判据里刻意包含「回滚后 `_schema_migrations` 仍记着 0003 会被静默跳过」这条：评审实测手工
 * 回滚后若忘了删台账行，下次部署迁移器会跳过 0003，而应用代码已按 task_message 写，直接变成
 * 「部署起来就报 relation 不存在」。所以回滚**必须**连带删台账行——这里把两半都验掉。
 */
import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createDatabase } from '../src/index.js'
import type { Database } from '../src/index.js'

const MIGRATIONS = fileURLToPath(new URL('../migrations/', import.meta.url))
const migration = (name: string): string => readFileSync(`${MIGRATIONS}${name}`, 'utf8')

/** 迁移 0003 的反向 SQL（与迁移尾部骨架逐条对应）。 */
const ROLLBACK_SQL = `
alter table task_message drop constraint task_message_accepted_has_run;
alter table task_message drop constraint task_message_followup_attached;
alter table task_message drop constraint task_message_instruction_addressed;
alter table task_message drop constraint task_message_discussion_inert;
alter table task_message drop constraint task_message_state_valid;
alter table task_message drop constraint task_message_origin_valid;
alter table task_message drop constraint task_message_kind_valid;
drop index task_message_task_created_idx;
alter table task_message drop column instruction_state;
alter table task_message drop column run_id;
alter table task_message drop column target_agent_id;
alter table task_message drop column origin;
alter table task_message drop column kind;
alter table task_message rename constraint task_message_created_at_not_null to task_comment_created_at_not_null;
alter table task_message rename constraint task_message_body_not_null to task_comment_body_not_null;
alter table task_message rename constraint task_message_author_user_id_not_null to task_comment_author_user_id_not_null;
alter table task_message rename constraint task_message_task_id_not_null to task_comment_task_id_not_null;
alter table task_message rename constraint task_message_id_not_null to task_comment_id_not_null;
alter table task_message rename constraint task_message_author_user_id_fkey to task_comment_author_user_id_fkey;
alter table task_message rename constraint task_message_task_id_fkey to task_comment_task_id_fkey;
alter table task_message rename constraint task_message_pkey to task_comment_pkey;
alter table task_message rename constraint task_message_body_length to task_comment_body_length;
alter table task_message rename to task_comment;
`

interface ShapeRow {
  kind: string
  name: string
}

describe('task_message migration: 反向 SQL 可执行且回到迁移前形态', () => {
  let database: Database
  const schema = `rollback_${randomUUID().replaceAll('-', '')}`

  beforeAll(async () => {
    const url = process.env.DATABASE_URL
    if (url === undefined || url === '') {
      throw new Error(
        'DATABASE_URL 未设置：integration 测试须经 scripts/with-test-postgres.mts 运行',
      )
    }
    database = createDatabase({ connectionString: url, max: 1 })
    await database.sql.unsafe(`create schema ${schema}`)
  })

  afterAll(async () => {
    await database.sql.unsafe(`drop schema if exists ${schema} cascade`)
    await database.close()
  })

  /** 当前 schema 里这张表的「列 + 约束 + 索引」名字快照（排序后比较，避免顺序噪声）。 */
  async function shape(table: string): Promise<ShapeRow[]> {
    const columns = (await database.sql.unsafe(
      `select column_name as name from information_schema.columns
        where table_schema = $1 and table_name = $2`,
      [schema, table],
    )) as unknown as Array<{ name: string }>
    const constraints = (await database.sql.unsafe(
      `select conname as name from pg_constraint where conrelid = $1::regclass`,
      [`${schema}.${table}`],
    )) as unknown as Array<{ name: string }>
    const indexes = (await database.sql.unsafe(
      `select indexname as name from pg_indexes where schemaname = $1 and tablename = $2`,
      [schema, table],
    )) as unknown as Array<{ name: string }>
    return [
      ...columns.map((row) => ({ kind: `column:${table}`, name: row.name })),
      ...constraints.map((row) => ({ kind: `constraint:${table}`, name: row.name })),
      ...indexes.map((row) => ({ kind: `index:${table}`, name: row.name })),
    ].sort((a, b) => `${a.kind}:${a.name}`.localeCompare(`${b.kind}:${b.name}`))
  }

  it('跑 0001→0003 再反向执行：列/约束/索引名逐名回到迁移前，台账行须显式删除', async () => {
    // ① 迁移前形态：只应用 0001/0002。
    let before: ShapeRow[] = []
    await database.sql.begin(async (tx) => {
      await tx.unsafe(`set local search_path to ${schema}`)
      await tx.unsafe(migration('0001_phase1.sql'))
      await tx.unsafe(migration('0002_device_runtime_facts.sql'))
    })
    before = await shape('task_comment')
    expect(before.length).toBeGreaterThan(0)

    // ② 应用 0003，并模拟台账已记账（真迁移器就是这么写的）。
    await database.sql.begin(async (tx) => {
      await tx.unsafe(`set local search_path to ${schema}`)
      await tx.unsafe(migration('0003_task_message.sql'))
      await tx.unsafe(`create table if not exists _schema_migrations (name text primary key)`)
      await tx.unsafe(`insert into _schema_migrations (name) values ('0003_task_message.sql')`)
    })
    const migrated = await shape('task_message')
    expect(migrated.length).toBeGreaterThan(before.length)

    // ③ 按骨架反向执行：必须零失败。
    await database.sql.begin(async (tx) => {
      await tx.unsafe(`set local search_path to ${schema}`)
      await tx.unsafe(ROLLBACK_SQL)
    })

    // ④ 形态逐名回到迁移前（列名、约束名、索引名全等——改名连带索引这件事就靠这条钉住）。
    expect(await shape('task_comment')).toEqual(before)

    // ⑤ 台账提醒不是空话：反向 SQL 不含删台账行，所以此刻 0003 仍被记为「已应用」。
    //    真回滚必须显式删掉它，否则下次部署会被迁移器静默跳过（而代码已按 task_message 写）。
    const ledger = (await database.sql.unsafe(
      `select name from ${schema}._schema_migrations where name = '0003_task_message.sql'`,
    )) as unknown as Array<{ name: string }>
    expect(ledger).toHaveLength(1)
    await database.sql.unsafe(
      `delete from ${schema}._schema_migrations where name = '0003_task_message.sql'`,
    )
    const afterDelete = (await database.sql.unsafe(
      `select name from ${schema}._schema_migrations where name = '0003_task_message.sql'`,
    )) as unknown as Array<{ name: string }>
    expect(afterDelete).toEqual([])
  })
})
