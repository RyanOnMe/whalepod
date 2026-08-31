/**
 * 迁移应用器（packages/db/migrations/*.sql 按文件名序 + `_schema_migrations` 台账）。
 *
 * 此前本逻辑只在两份 test helper 里各抄一份（packages/db 与 apps/hub）——生产 Hub
 * 与 e2e 环境同样需要可靠的迁移入口，故收敛到包内导出；test helper 委托至此。
 * 幂等：advisory lock 串行化并发应用（含台账建表本身，#55），台账跳过已应用文件；
 * 缺迁移文件必须失败。拿不到锁的实例阻塞等待（非 fail-fast），xact 锁随事务结束
 * 或连接崩溃自动释放，不残留。
 */
import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Database } from './client.js'

const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'migrations')
const MIGRATION_TABLE = '_schema_migrations'
// advisory lock：串行化并发 spec 文件/进程的迁移应用，内容任意但全仓库唯一。
const MIGRATION_LOCK_KEY = 20260825

export async function applyMigrations(database: Database): Promise<void> {
  // 台账建表也必须在锁内：`create table if not exists` 的并发判定不互斥，
  // 两实例同时建表会撞 pg_type 目录索引 23505（#55 并发用例实测复现），
  // 「多实例并发启动/重跑迁移」直接失败。
  await database.sql.begin(async (sql) => {
    await sql`select pg_advisory_xact_lock(${MIGRATION_LOCK_KEY})`
    await sql`
      create table if not exists ${sql(MIGRATION_TABLE)} (
        name text primary key,
        applied_at timestamptz not null default now()
      )
    `
  })
  let files: string[]
  try {
    files = readdirSync(MIGRATIONS_DIR)
      .filter((file) => file.endsWith('.sql'))
      .sort()
  } catch {
    files = []
  }
  if (files.length === 0) {
    throw new Error('packages/db/migrations 缺少迁移文件（期望 0001_phase1.sql）')
  }
  for (const file of files) {
    const ddl = readFileSync(join(MIGRATIONS_DIR, file), 'utf8')
    await database.sql.begin(async (sql) => {
      await sql`select pg_advisory_xact_lock(${MIGRATION_LOCK_KEY})`
      const applied = await sql<{ name: string }[]>`
        select name from ${sql(MIGRATION_TABLE)} where name = ${file}
      `
      if (applied.length > 0) return
      await sql.unsafe(ddl)
      await sql`insert into ${sql(MIGRATION_TABLE)} ${sql({ name: file })}`
    })
  }
}
