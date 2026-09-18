/**
 * 错误进日志前的脱敏（#206）。
 *
 * 红线（AGENTS.md）：密钥、Token、绝对路径不进日志。同一条红线处理原始 SQL：
 * Drizzle 把 PG 错误包在外层，最外层 message 是
 * `Failed query: insert into "…" (…) values ($1,$2,…) …`——**含完整列名，且 string 里
 * 能搜到参数值**（复核 #205 实测）。业务数据与库结构不能一起写进日志文件。
 *
 * 用法：日志只记 `sanitizeError(error)` 返回的结构化字段——`errorName` + PG
 * `code`/`constraint` + cause 链最内层那句人话（约束名/触发器文案）。原始 SQL 留在
 * 栈里、不进日志。从 `app.ts` 的 errorHandler 提取出来（本是那里的三个本地函数），
 * 三处调用点共用一份，不再各写一份"看起来像"的脱敏。
 */
import { unwrapPgError } from '@whalepod/db'

export interface SanitizedError {
  errorName: string
  /** cause 链上最内层那句 message（约束/触发器的人话，不是 Drizzle 的外层 SQL）。 */
  errorMessage: string
  /** PG code（如 23503），非 PG 错误时缺省。 */
  pgCode?: string
  /** PG 约束名，非 PG 错误时缺省。 */
  pgConstraint?: string
}

export function sanitizeError(error: unknown): SanitizedError {
  const out: SanitizedError = {
    errorName: error instanceof Error ? error.name : 'UnknownError',
    // 注意：必须调 `innermostErrorMessage(error)` 取 cause 链最内层——直接取外层 message
    // 就是 Drizzle 的 `Failed query: …`（含 SQL 与参数值），脱敏等于没做。
    errorMessage: innermostErrorMessage(error),
  }
  const code = pgErrorCode(error)
  if (code !== undefined) out.pgCode = code
  const constraint = pgConstraintName(error)
  if (constraint !== undefined) out.pgConstraint = constraint
  return out
}

/** PG 错误的 code / constraint（结构化字段，不含 SQL 与参数）。 */
function pgErrorCode(error: unknown): string | undefined {
  const pg = unwrapPgError(error)
  return typeof pg?.code === 'string' ? pg.code : undefined
}

function pgConstraintName(error: unknown): string | undefined {
  const pg = unwrapPgError(error)
  return typeof pg?.constraintName === 'string' ? pg.constraintName : undefined
}

function innermostErrorMessage(error: unknown): string {
  let message = error instanceof Error ? error.message : String(error)
  let cursor: unknown = error
  while (cursor instanceof Error) {
    const next: unknown = cursor.cause
    if (!(next instanceof Error)) break
    cursor = next
    message = next.message
  }
  return message
}
