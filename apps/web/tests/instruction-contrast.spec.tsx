/**
 * 指令流四态的 WCAG 2.1 AA 门（复核 #209 应改 ②）。
 *
 * 为什么要有这条：Q5 的对比度扫描**从不覆盖这四态**——e2e 从不为 `instructions` 播种指令，
 * `InstructionList` 一直走空态，四态 chip 一次都没被渲染过。所以「含对比度门全绿」是真的、
 * 但是**空的**：复核实测四态原本是 2.06~3.80:1（要求 4.5:1），没有一道门看得见。
 *
 * 做法与设备状态同一范式：算出 `<style>` 里实际声明的那对（文字色 + color-mix 底色），
 * 用仓库同一套算法（tests/contrast.ts）复算比值——**不是读我的期望值，是读 CSS 里的真值**，
 * 所以改了 900 档取值或混合比例，这里会先红。
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  contrastOnTint,
  contrastRatio,
  parseCssColor,
  readTokenValue,
  round2,
  WHITE,
} from './contrast.js'

// 用 `import.meta.dirname`（纯路径）而不是 `import.meta.url`：vitest 下后者的 scheme 不是 file，
// `new URL(..., import.meta.url)` 会抛 "The URL must be of scheme file"（踩过一次）。
const STYLES = join(import.meta.dirname, '../src/styles')
const CSS = readFileSync(join(STYLES, 'global.css'), 'utf8')
const TOKENS = readFileSync(join(STYLES, 'dsw-tokens.css'), 'utf8')

/** 从 `.cls { ... }` 里取出某个声明值（CSS 文本级，够用且稳定）。 */
function declaration(selector: string, property: string): string {
  const start = CSS.indexOf(`${selector} {`)
  expect(start, `CSS 里找不到 ${selector}`).toBeGreaterThan(-1)
  const end = CSS.indexOf('}', start)
  const body = CSS.slice(start, end)
  const match = new RegExp(`${property}:\\s*([^;]+);`).exec(body)
  expect(match, `${selector} 里找不到 ${property}`).not.toBeNull()
  return (match as RegExpExecArray)[1]!.trim()
}

// tint 是 0..1 的混合比例（`contrastOnTint` 的契约，不是百分数）。
const STATES = [
  { cls: '.instruction-state-pending', tint: 0.14, label: '待受理' },
  { cls: '.instruction-state-accepted', tint: 0.12, label: '已受理' },
  { cls: '.instruction-state-queued', tint: 0.1, label: '已排队' },
  { cls: '.instruction-state-rejected', tint: 0.1, label: '已拒绝' },
] as const

describe('指令四态的 AA 门', () => {
  it.each(STATES)('$label：文字 vs 自身浅底 ≥ 4.5:1，且取值来自 CSS 真值', ({ cls, tint }) => {
    const colorText = declaration(cls, 'color')
    const backgroundText = declaration(cls, 'background')
    // 两条声明都必须指向同一个语义 token（底与字是一家人，重绑时一起变深）。
    expect(colorText).toMatch(/^var\(--dsw-alias-state-/)
    expect(backgroundText).toContain(colorText.replace('var(', '').replace(')', ''))

    const tokenName = /var\((--dsw-alias-state-[a-z-]+)\)/.exec(colorText)![1]!
    // 重绑在包裹元素上：该类必须自己把该 token 指到 900 档（否则就是没重映射）。
    const remap = declaration(cls, tokenName)
    expect(remap).toMatch(/^var\(--dsw-static-[a-z]+-900\)$/)
    const staticName = /var\((--dsw-static-[a-z]+-900)\)/.exec(remap)![1]!
    const rgb = parseCssColor(readTokenValue(TOKENS, staticName))

    const ratio = round2(contrastOnTint(rgb, tint, WHITE))
    expect(
      ratio,
      `${cls} 的 ${staticName} 在白底 ${tint}% 浅底上是 ${ratio}:1`,
    ).toBeGreaterThanOrEqual(4.5)
  })

  it('被拒理由块同样走 900 档（它也是小字 + 同色浅底）', () => {
    const remap = declaration('.instruction-error', '--dsw-alias-state-error-primary')
    expect(remap).toBe('var(--dsw-static-red-900)')
    const rgb = parseCssColor(readTokenValue(TOKENS, '--dsw-static-red-900'))
    const ratio = round2(contrastOnTint(rgb, 0.1, WHITE))
    expect(ratio).toBeGreaterThanOrEqual(4.5)
  })

  it('区段说明与指令类型小字用 secondary（tertiary 白底只有 3.706:1）', () => {
    const tertiary = parseCssColor(readTokenValue(TOKENS, '--dsw-alias-label-tertiary'))
    const secondary = parseCssColor(readTokenValue(TOKENS, '--dsw-alias-label-secondary'))
    // 先把"tertiary 不够、secondary 够"这个前提钉住：前提变了这条门才有意义。
    expect(round2(contrastRatio(tertiary, WHITE))).toBeLessThan(4.5)
    expect(round2(contrastRatio(secondary, WHITE))).toBeGreaterThanOrEqual(4.5)
    for (const cls of ['.room-column-note', '.instruction-kind']) {
      expect(declaration(cls, 'color')).toBe('var(--dsw-alias-label-secondary)')
    }
  })

  it('对照：改为不重映射（原始 500 档）时该门会红——判据不是恒真', () => {
    // 直接算 500 档的比值，确认它确实过不了 4.5（否则上面那条门就无从判别）。
    for (const [name, tint] of [
      ['--dsw-alias-state-success-primary', 0.12],
      ['--dsw-alias-state-error-primary', 0.1],
      ['--dsw-alias-state-business-primary', 0.1],
      ['--dsw-alias-state-warn-primary', 0.14],
    ] as const) {
      const rgb = parseCssColor(readTokenValue(TOKENS, name))
      expect(
        round2(contrastOnTint(rgb, tint, WHITE)),
        `${name} 原本的 500 档应当不过 AA（这正是要重映射的原因）`,
      ).toBeLessThan(4.5)
    }
  })
})
