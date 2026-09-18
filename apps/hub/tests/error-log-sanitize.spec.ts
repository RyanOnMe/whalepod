/**
 * 日志脱敏的机器判据（#206 红线：原始 SQL 与参数值不进日志）。
 *
 * 两层：
 *  1. **单元层**（不碰 DB）：`sanitizeError` 对 Drizzle 风格错误的输出里，
 *     不得出现 `Failed query:` / `insert into` / 参数值字样；
 *  2. **源码层反面钉**：三处调用点（hub.http / inventory / node-ws）不得绕过
 *     `sanitizeError` 直接记 `error.message`（与 select-menu 的既有反面钉同形）。
 *     "修完又被顺手改回去"是这类缺陷的标准复发路径（本片两处漏点就是这么活到今天的）。
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { sanitizeError } from '../src/modules/shared/error-log.js'

const HUB_SRC = join(import.meta.dirname, '../src')

/** 造一个 Drizzle 风格的错误：外层 message 含 SQL，cause 链最内层是 PG 人话。 */
function drizzleLikeError(): Error {
  const pg = new Error('violates foreign key constraint "workspace_device_id_fkey"')
  ;(pg as { code?: string }).code = '23503'
  const outer = new Error(
    'Failed query: insert into "workspace" ("id","device_id") values ($1,$2)',
    { cause: pg },
  )
  return outer
}

describe('sanitizeError', () => {
  it('输出里没有原始 SQL 语句与参数值（#206 ① inventory 实测的形状）', () => {
    const out = sanitizeError(drizzleLikeError())
    const dumped = JSON.stringify(out)
    // 禁的是 SQL 语句形态（动词 + 占位符），不是表名本身——最内层 PG 人话里本来就带
    // 约束名（含表名），那是排障要的信息（第一版判据连表名一起禁，把约束名人话也杀了）。
    expect(dumped).not.toContain('Failed query:')
    expect(dumped).not.toContain('insert into')
    expect(dumped).not.toContain('values (')
    expect(dumped).not.toMatch(/\$\d/)
    expect(dumped).not.toContain('"device_id"')
  })

  it('保留排障要用的：name + 最内层人话 + PG code', () => {
    const out = sanitizeError(drizzleLikeError())
    expect(out.errorName).toBe('Error')
    expect(out.errorMessage).toContain('foreign key constraint')
    expect(out.pgCode).toBe('23503')
  })

  it('errorMessage 取 cause 链最内层（不是外层 message——本次事故的精确形状）', () => {
    // 事故记录：`sanitizeError` 曾直接取外层 message（`innermostErrorMessage` 函数在、
    // 调用不在），脱敏等于没做。这一条钉住"必须调用"，而不是"函数存在"。
    const source = readFileSync(join(HUB_SRC, 'modules/shared/error-log.ts'), 'utf-8')
    const body = source.slice(source.indexOf('export function sanitizeError'))
    expect(body).toContain('innermostErrorMessage(error)')
  })

  it('非 Error 输入不崩（node-ws 的 `String(error)` 分支同义）', () => {
    const out = sanitizeError('boom')
    expect(out.errorName).toBe('UnknownError')
    expect(out.errorMessage).toBe('boom')
  })
})

describe('日志调用点反面钉（#206：三处共用一份，不许绕过）', () => {
  it('inventory.ts 里没有 console.error 调用，warn 走 sanitizeError', () => {
    // 只看代码行：注释里写"原来有这一行"不算还在记（第一版连注释一起禁，修注释就红）。
    const codeLines = readFileSync(join(HUB_SRC, 'modules/device/inventory.ts'), 'utf-8')
      .split('\n')
      .filter((line) => !line.trim().startsWith('//') && !line.trim().startsWith('*'))
      .join('\n')
    expect(codeLines).not.toContain('console.error')
    expect(codeLines).toMatch(/sanitizeError\(error\)/)
  })

  it('node-websocket.ts 的 warn 走 sanitizeError（不直接记 error.message）', () => {
    const source = readFileSync(join(HUB_SRC, 'modules/device/node-websocket.ts'), 'utf-8')
    expect(source).toContain('sanitizeError(error)')
    // 同一对象字面量里不许再出现原始 message 记账（注释里提一句不算——只看代码行）。
    const codeLines = source
      .split('\n')
      .filter((line) => !line.trim().startsWith('//') && !line.trim().startsWith('*'))
      .join('\n')
    expect(codeLines).not.toMatch(/errorMessage:\s*error instanceof Error \? error\.message/)
  })

  it('app.ts 的 errorHandler 走 sanitizeError（本地三函数不许加回来）', () => {
    const source = readFileSync(join(HUB_SRC, 'app.ts'), 'utf-8')
    expect(source).toContain('...sanitizeError(error)')
    expect(source).not.toMatch(/function (pgErrorCode|pgConstraintName|innermostErrorMessage)/)
  })
})
