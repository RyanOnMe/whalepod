/**
 * 迁移应用器（packages/db/migrations/*.sql 按文件名序 + `_schema_migrations` 台账）。
 *
 * 此前本逻辑只在两份 test helper 里各抄一份（packages/db 与 apps/hub）——生产 Hub
 * 与 e2e 环境同样需要可靠的迁移入口，故收敛到包内导出；test helper 委托至此。
 * 幂等：advisory lock 串行化并发应用（含台账建表本身，#55），台账跳过已应用文件；
 * 缺迁移文件必须失败。拿不到锁的实例在 lock_timeout 上限内阻塞等待，超时以
 * 55P03 fail-fast 报错（可重试，不做无限排队，#55 N2）；xact 锁随事务结束
 * 或连接崩溃自动释放，不残留。
 */
import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Database } from './client.js'

const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'migrations')
const MIGRATION_TABLE = '_schema_migrations'
// advisory lock：串行化并发 spec 文件/进程的迁移应用，内容任意但全仓库唯一。
// 导出仅供测试与取证钉同一把键（业务路径不需要）。
export const MIGRATION_LOCK_KEY = 20260825
// 等锁上限（#55 N2）：病态持锁者下让启动 fail-fast（55P03 报错可重试），
// 而不是无声无限排队。
const MIGRATION_LOCK_TIMEOUT_MS = 30_000

export async function applyMigrations(
  database: Database,
  options: { readonly lockTimeoutMs?: number } = {},
): Promise<void> {
  const lockTimeoutMs = options.lockTimeoutMs ?? MIGRATION_LOCK_TIMEOUT_MS
  // 台账建表也必须在锁内：`create table if not exists` 的并发判定不互斥，
  // 两实例同时建表会冒出同族目录冲突二者之一——42P07（relation 已存在）或
  // 23505（pg_type_typname_nsp_index 重复键；本轮红基线实录命中后者）——
  // 「多实例并发启动/重跑迁移」直接失败。
  await database.sql.begin(async (sql) => {
    // 取锁前先设本事务等锁上限（SET LOCAL 语义，随事务结束失效）。
    await sql`select set_config('lock_timeout', ${`${lockTimeoutMs}ms`}, true)`
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
      await sql`select set_config('lock_timeout', ${`${lockTimeoutMs}ms`}, true)`
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
