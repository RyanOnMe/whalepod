/**
 * applyMigrations 并发串行化自证（#55 钉住用例）。
 *
 * 多实例并发启动/重跑迁移的判据：两个并发 applyMigrations 调用在同一空库上
 * 都必须成功，每个迁移文件恰好执行一次——台账 `_schema_migrations` 每个
 * 文件名恰一条，DDL 不重跑（重跑会冒出 dup key / relation 已存在错误）。
 * 串行化机制是 packages/db/src/migrate.ts 的逐文件事务 +
 * pg_advisory_xact_lock（MIGRATION_LOCK_KEY=20260825）；本用例把该保证变成
 * 机器证据，任何人去掉/改坏锁都会在这里变红。
 * 另钉等锁上限（#55 N2）：病态持锁者不会让启动无限排队——lock_timeout 到点
 * 以 55P03 fail-fast，报错可归因、重试可完成。
 */
import { randomBytes } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { applyMigrations, createDatabase, MIGRATION_LOCK_KEY, unwrapPgError } from '../src/index.js'
import type { Database } from '../src/index.js'

let admin: Database
let adminUrl: string

beforeAll(async () => {
  const url = process.env.DATABASE_URL
  if (url === undefined || url === '') {
    throw new Error('DATABASE_URL 未设置：integration 测试须经 scripts/with-test-postgres.mts 运行')
  }
  adminUrl = url
  admin = createDatabase({ connectionString: url, max: 2 })
})

afterAll(async () => {
  await admin.close()
})

/** 换掉连接串末尾的库名（一次性容器密码只在 stderr 环境里，绝不入日志）。 */
function urlWithDatabase(connectionString: string, databaseName: string): string {
  return `${connectionString.slice(0, connectionString.lastIndexOf('/'))}/${databaseName}`
}

describe('applyMigrations 并发（#55）', () => {
  it('空库上两个并发 applyMigrations：都成功，每个迁移文件恰好应用一次', async () => {
    const dbName = `mig_concurrent_${randomBytes(4).toString('hex')}`
    // 安全：dbName 是本用例生成的 hex 字面量，非外部输入。
    await admin.sql.unsafe(`create database ${dbName}`)
    const a = createDatabase({ connectionString: urlWithDatabase(adminUrl, dbName), max: 3 })
    const b = createDatabase({ connectionString: urlWithDatabase(adminUrl, dbName), max: 3 })
    try {
      const [ra, rb] = await Promise.allSettled([applyMigrations(a), applyMigrations(b)])
      // 都成功：败者不得以 dup key（台账/目录）或 relation 已存在等同族报错冒出来。
      for (const r of [ra, rb] as const) {
        if (r.status === 'rejected') {
          throw new Error(`并发 applyMigrations 失败：${String(r.reason)}`)
        }
      }
      // 台账恰好一次：每个 name 计数为 1。
      const ledger = await a.sql<{ name: string; n: number }[]>`
          select name, count(*)::int as n from _schema_migrations group by name order by name
        `
      expect(ledger.length).toBeGreaterThan(0)
      expect(ledger.map((row) => row.n)).toEqual(ledger.map(() => 1))
      // DDL 恰好执行一次（若重跑会直接报错，上面的 allSettled 已兜住）；
      // 抽查代表性表存在。
      const tables = await a.sql<{ tablename: string }[]>`
          select tablename from pg_tables where schemaname = 'public'
        `
      const names = tables.map((row) => row.tablename)
      expect(names).toContain('plugin_pack')
      expect(names).toContain('team')
    } finally {
      await a.close()
      await b.close()
      await admin.sql.unsafe(`drop database if exists ${dbName}`)
    }
  }, 60_000)

  it('病态持锁者：等锁以 lock_timeout 55P03 fail-fast 可归因，释放后重试恰好完成', async () => {
    const dbName = `mig_timeout_${randomBytes(4).toString('hex')}`
    // 安全：dbName 是本用例生成的 hex 字面量，非外部输入。
    await admin.sql.unsafe(`create database ${dbName}`)
    const url = urlWithDatabase(adminUrl, dbName)
    const a = createDatabase({ connectionString: url, max: 2 })
    const b = createDatabase({ connectionString: url, max: 2 })
    try {
      // advisory lock 按库作用域：持锁者必须落在目标库上（reserve 独占连接）。
      const holder = await a.sql.reserve()
      try {
        await holder`select pg_advisory_lock(${MIGRATION_LOCK_KEY})`
        const failure = await applyMigrations(b, { lockTimeoutMs: 250 }).then(
          () => undefined,
          (caught: unknown) => caught,
        )
        if (failure === undefined) throw new Error('等锁超时应 fail-fast，却意外成功')
        // 归因：SQLSTATE 55P03（lock_not_available），不是无声排队也不是莫名错误。
        expect(unwrapPgError(failure)?.code).toBe('55P03')
      } finally {
        await holder`select pg_advisory_unlock(${MIGRATION_LOCK_KEY})`
        holder.release()
      }
      // 持锁者离开后，正常上限的迁移可直接成功（fail-fast 无副作用残留）。
      await applyMigrations(b)
      const ledger = await b.sql<{ name: string; n: number }[]>`
          select name, count(*)::int as n from _schema_migrations group by name
        `
      expect(ledger.length).toBeGreaterThan(0)
      expect(ledger.map((row) => row.n)).toEqual(ledger.map(() => 1))
    } finally {
      await a.close()
      await b.close()
      await admin.sql.unsafe(`drop database if exists ${dbName}`)
    }
  }, 60_000)
})
