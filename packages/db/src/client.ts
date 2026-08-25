import { drizzle } from 'drizzle-orm/postgres-js'
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js'
import postgres from 'postgres'
import * as schema from './schema/index.js'

export type Schema = typeof schema
export type Db = PostgresJsDatabase<Schema>
/** 事务句柄类型从驱动签名推断，避免手写 drizzle 泛型与版本失配。 */
export type Tx = Parameters<Parameters<Db['transaction']>[0]>[0]

/** 仓储与命令共用的查询句柄：普通连接（Db）与事务连接（Tx）皆可。 */
export type DbHandle = Pick<Db, 'select' | 'insert' | 'update' | 'delete' | 'execute'>

export interface DatabaseOptions {
  connectionString: string
  /** postgres.js 连接池上限，默认 10。 */
  max?: number
}

/**
 * P1-04 交付的数据库门面（02-第一阶段实施计划.md Task 4 Interfaces）。
 * 只负责连接与事务边界；不产生 WebSocket 流量。
 */
export interface Database {
  readonly db: Db
  readonly sql: postgres.Sql
  transaction<T>(fn: (tx: Tx) => Promise<T>): Promise<T>
  close(): Promise<void>
}

export function createDatabase(options: DatabaseOptions): Database {
  const sql = postgres(options.connectionString, { max: options.max ?? 10 })
  const db: Db = drizzle(sql, { schema })
  return {
    db,
    sql,
    transaction: (fn) => db.transaction(fn),
    close: async () => {
      await sql.end()
    },
  }
}

export interface PgErrorInfo {
  /** PostgreSQL SQLSTATE，如 23505（unique_violation）、23514（check_violation）。 */
  code: string
  constraintName?: string
}

/**
 * drizzle 0.45 把驱动错误包进 DrizzleQueryError（原始 PostgresError 在 cause 链上）。
 * 沿 cause 链取出第一个带 SQLSTATE 的错误；调用方按 code/constraintName 判定，
 * 不解析 message。
 */
export function unwrapPgError(error: unknown): PgErrorInfo | undefined {
  let current: unknown = error
  while (typeof current === 'object' && current !== null) {
    const code = (current as { code?: unknown }).code
    if (typeof code === 'string' && /^[0-9A-Z]{5}$/.test(code)) {
      const constraint = (current as { constraint_name?: unknown }).constraint_name
      return { code, ...(typeof constraint === 'string' ? { constraintName: constraint } : {}) }
    }
    current = (current as { cause?: unknown }).cause
  }
  return undefined
}
