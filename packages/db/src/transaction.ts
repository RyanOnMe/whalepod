import { eq } from 'drizzle-orm'
import { unwrapPgError } from './client.js'
import type { Database, DbHandle, Tx } from './client.js'
import { commandReceipts } from './schema/outbox.js'

// 命令幂等（02-第一阶段实施计划.md Task 4 Step 4）：
// 命令 key 首次执行后把结果写进 command_receipt（与命令副作用同一事务），
// 同 key 重放不再执行副作用，直接返回首次结果。
export type CommandKey = string

export type CommandReceiptRow = typeof commandReceipts.$inferSelect

export async function findCommandReceipt(
  handle: DbHandle,
  key: CommandKey,
): Promise<CommandReceiptRow | undefined> {
  const [row] = await handle
    .select()
    .from(commandReceipts)
    .where(eq(commandReceipts.key, key))
    .limit(1)
  return row
}

/**
 * 在单个事务内执行命令：领域写、Team Event、Outbox 入队与回执原子提交。
 * execute 的返回值必须 JSON 可序列化（要写入回执）。
 */
export async function transactCommand<T>(
  database: Database,
  key: CommandKey,
  execute: (tx: Tx) => Promise<T>,
): Promise<T> {
  try {
    return await database.transaction(async (tx) => {
      const prior = await findCommandReceipt(tx, key)
      if (prior !== undefined) return prior.result as T
      const result = await execute(tx)
      await tx.insert(commandReceipts).values({ key, result })
      return result
    })
  } catch (error) {
    // 并发同 key：败者在回执 INSERT 上撞 23505 并整体回滚；
    // 此时胜者必然已提交（唯一约束会等待在途事务），回读其结果即可。
    if (isCommandReceiptConflict(error)) {
      const prior = await findCommandReceipt(database.db, key)
      if (prior !== undefined) return prior.result as T
    }
    throw error
  }
}

function isCommandReceiptConflict(error: unknown): boolean {
  const pg = unwrapPgError(error)
  return pg?.code === '23505' && (pg.constraintName ?? '').includes('command_receipt')
}
