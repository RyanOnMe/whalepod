/**
 * task_message 迁移的**老库升级**路径（#185 评审：CI 永远从空库跑 0001→0003，
 * 「已应用旧迁移 + 表里有真实数据」这条路径此前无人覆盖）。
 *
 * 做法：在**独立 schema** 里按文件名序手工应用 0001/0002（真文件、真顺序），灌入按旧表结构
 * 写的真实行（含 body 长度边界与首尾空白），再应用 0003，断言既有行全部落到「惰性讨论」态、
 * 且 body 完好；最后反向验证新约束确实生效（accepted 无 run_id 被拒）。
 *
 * 为什么手工应用而不是走 `applyMigrations`：该函数按 public schema 的台账判定「已应用」，
 * 与并行跑的其他 spec 共享同一个库；本用例要造一个**只到 0002** 的库状态，必须在自己的
 * schema 里隔离（跑完 drop schema cascade）。
 */
import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createDatabase } from '../src/index.js'
import type { Database } from '../src/index.js'

const MIGRATIONS = fileURLToPath(new URL('../migrations/', import.meta.url))

function migration(name: string): string {
  return readFileSync(`${MIGRATIONS}${name}`, 'utf8')
}

describe('task_message migration: 老库带真实数据升级', () => {
  let database: Database
  const schema = `legacy_${randomUUID().replaceAll('-', '')}`

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

  it('只应用 0001/0002 并灌入旧表数据 → 应用 0003 后既有行成为讨论消息且 body 完好', async () => {
    const teamId = randomUUID()
    const userId = randomUUID()
    const projectId = randomUUID()
    const taskId = randomUUID()
    const longBody = 'x'.repeat(10_000)
    const rows: Array<{ id: string; body: string }> = [
      { id: randomUUID(), body: '旧评论：一句普通的话' },
      { id: randomUUID(), body: '  首尾带空白的旧评论  ' },
      { id: randomUUID(), body: longBody },
    ]

    await database.sql.begin(async (tx) => {
      await tx.unsafe(`set local search_path to ${schema}`)
      await tx.unsafe(migration('0001_phase1.sql'))
      await tx.unsafe(migration('0002_device_runtime_facts.sql'))

      // 按**旧表结构**灌数：只有 task_comment 的六个字段。
      await tx.unsafe(`insert into team (id, name) values ($1, $2)`, [
        teamId,
        `legacy-team-${schema.slice(-6)}`,
      ])
      await tx.unsafe(
        `insert into user_account (id, username, display_name, password_hash) values ($1, $2, $3, $4)`,
        [userId, `legacy-${schema.slice(-6)}`, 'Legacy', '$argon2id$placeholder$placeholder'],
      )
      await tx.unsafe(`insert into project (id, name, created_by) values ($1, $2, $3)`, [
        projectId,
        'legacy-project',
        userId,
      ])
      await tx.unsafe(
        `insert into task (id, project_id, title, assignee_user_id, assignment_status, created_by)
         values ($1, $2, $3, $4, 'accepted', $5)`,
        [taskId, projectId, 'legacy task', userId, userId],
      )
      for (const row of rows) {
        await tx.unsafe(
          `insert into task_comment (id, task_id, author_user_id, body) values ($1, $2, $3, $4)`,
          [row.id, taskId, userId, row.body],
        )
      }
      // 旧表名此时还在：这条断言本身就是「0003 尚未应用」的证据。
      const before = await tx.unsafe(`select count(*)::int as n from task_comment`)
      expect((before[0] as { n: number }).n).toBe(rows.length)

      await tx.unsafe(migration('0003_task_message.sql'))
    })

    // 升级后：行数不变、全部成为惰性讨论消息、body 逐字完好。
    const migrated = (await database.sql.unsafe(
      `select id, body, kind, origin, target_agent_id, run_id, instruction_state
         from ${schema}.task_message order by id`,
    )) as unknown as Array<{
      id: string
      body: string
      kind: string
      origin: string
      target_agent_id: string | null
      run_id: string | null
      instruction_state: string | null
    }>
    expect(migrated).toHaveLength(rows.length)
    for (const row of migrated) {
      expect(row).toMatchObject({
        kind: 'discussion',
        origin: 'human',
        target_agent_id: null,
        run_id: null,
        instruction_state: null,
      })
    }
    const byId = new Map(migrated.map((row) => [row.id, row.body]))
    for (const row of rows) {
      expect(byId.get(row.id)).toBe(row.body) // 含 10 000 字边界与首尾空白，逐字未变
    }

    // 旧对象名已随表名一并改掉（评审实测原先残留 8 个约束 + 1 个索引）。
    // 约束与索引都要查：主键约束改名会连带改索引名，漏掉索引面就查不出这类残留。
    const staleConstraints = (await database.sql.unsafe(
      `select conname from pg_constraint
        where conrelid = $1::regclass and conname like 'task_comment%'`,
      [`${schema}.task_message`],
    )) as unknown as Array<{ conname: string }>
    expect(staleConstraints).toEqual([])

    const staleIndexes = (await database.sql.unsafe(
      `select indexname from pg_indexes
        where schemaname = $1 and tablename = 'task_message' and indexname like 'task_comment%'`,
      [schema],
    )) as unknown as Array<{ indexname: string }>
    expect(staleIndexes).toEqual([])

    // 新约束确实在升级后的库上生效：accepted 必须落到某个 Run 上。
    await expect(
      database.sql.unsafe(
        `insert into ${schema}.task_message (id, task_id, author_user_id, body, kind, target_agent_id, instruction_state)
         values ($1, $2, $3, 'accepted 但没有 run', 'instruction', null, 'accepted')`,
        [randomUUID(), taskId, userId],
      ),
    ).rejects.toThrow(/task_message_instruction_addressed|task_message_accepted_has_run/)
  })
})
