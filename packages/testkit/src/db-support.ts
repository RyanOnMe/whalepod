/**
 * 跨应用共享的 DB 测试脚手架（#183 拆耦合第 1 步）。
 *
 * 背景：`apps/node` 的 integration spec 借用了 `apps/hub/tests/helpers.ts` 的
 * `createTestDatabase`/`idemKey`/`waitForValue`——跨包相对路径 import（`../../../hub/tests/...`）
 * 会把 hub 的源码文件拖进 node 的 typecheck program（#178/#183 实测的 62 个 TS6059 假象）。
 * 与 hub 无关的这部分挪到 testkit（两侧都能按包名 import），hub app 相关的部分留在
 * `apps/hub/src/testing`（`@whalepod/hub/testing` 子路径导出）。
 *
 * 只依赖 `@whalepod/db` 的公开导出（applyMigrations/createDatabase），不引用任何
 * 应用内部文件——testkit 的依赖方向不变。
 */
import { applyMigrations, createDatabase } from '@whalepod/db'
import type { Database } from '@whalepod/db'

const MIGRATION_TABLE = '_schema_migrations' as const

/** 清空 public schema 下所有业务表（保留迁移登记表）。 */
export async function resetDatabase(database: Database): Promise<void> {
  const rows = await database.sql<{ tablename: string }[]>`
    select tablename from pg_tables
    where schemaname = 'public' and tablename <> ${MIGRATION_TABLE}
  `
  if (rows.length === 0) return
  const list = rows.map(({ tablename }) => `"${tablename}"`).join(', ')
  await database.sql.unsafe(`truncate table ${list} restart identity cascade`)
}

/** 打开 DATABASE_URL 指向的测试库并应用迁移（须经 with-test-postgres.mts 运行）。 */
export async function createTestDatabase(): Promise<Database> {
  const url = process.env.DATABASE_URL
  if (url === undefined || url === '') {
    throw new Error('DATABASE_URL 未设置：integration 测试须经 scripts/with-test-postgres.mts 运行')
  }
  const database = createDatabase({ connectionString: url, max: 4 })
  await applyMigrations(database)
  return database
}

/**
 * 轮询到条件成立或超时（#256）：测试等待异步落库不得用固定 sleep——
 * 那是「猜系统要跑多久」，CI 负载升高即抖红，且可能掩盖真实时序缺陷。
 *
 * 判据是**可观察条件**（返回值非空/falsy 由调用方决定），超时给明确失败消息。
 * `describe` 是超时消息里的读法提示（如「workspace available 未在 3s 内恢复」）。
 */
export async function waitForValue<T>(
  probe: () => Promise<T | undefined>,
  describe: string,
  options: { timeoutMs?: number; intervalMs?: number } = {},
): Promise<T> {
  const timeoutMs = options.timeoutMs ?? 3_000
  const intervalMs = options.intervalMs ?? 25
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const value = await probe()
    if (value !== undefined) return value
    if (Date.now() > deadline) {
      throw new Error(`${describe}（等待上限 ${timeoutMs}ms，判据是条件成立而不是固定时长）`)
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs))
  }
}
