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
  // 复核 R2：天真实现（indexOf 找第一块 + 取第一条声明）有假绿——
  // ①同一规则体里重复声明时**浏览器取最后一条**，门却读第一条（实测能让文字 1.00:1 不可见而门 PASS）；
  // ②文件后部再来一个同名规则块同样覆盖。
  // 所以：断言该选择器只有一个规则块、该属性只声明一次，再取值。
  const blocks = [...CSS.matchAll(new RegExp(`\\${selector} \\{([^}]*)\\}`, 'g'))].map((m) => m[1]!)
  expect(blocks.length, `${selector} 只应有一个规则块（多块会互相覆盖，门会看不见）`).toBe(1)
  const body = blocks[0]!
  const matches = [...body.matchAll(new RegExp(`(?:^|[;\\s])${property}:\\s*([^;]+);`, 'g'))]
  expect(matches.length, `${selector} 的 ${property} 只应声明一次（重复时浏览器取最后一条）`).toBe(
    1,
  )
  return matches[0]![1]!.trim()
}

/** 从 `.cls` 的 `background: color-mix(in srgb, ... N%, ...)` 读混合比例（0..1）。 */
function tintOf(selector: string): number {
  const background = declaration(selector, 'background')
  const percent = /(\d+(?:\.\d+)?)%/.exec(background)?.[1]
  expect(percent, `${selector} 的 background 里没有 color-mix 比例`).toBeDefined()
  return Number.parseFloat(percent!) / 100
}

// tint 是 0..1 的混合比例（`contrastOnTint` 的契约，不是百分数）。
// tint **从 CSS 读**（复核 R2 实测：硬编码时把 CSS 的 12% 改成 44% 门也发现不了）。
const STATES = [
  { cls: '.instruction-state-pending', label: '待受理' },
  { cls: '.instruction-state-accepted', label: '已受理' },
  { cls: '.instruction-state-queued', label: '已排队' },
  { cls: '.instruction-state-rejected', label: '已拒绝' },
  // 同一形态的第五处：「读取不完整」告警也是小字 + 同色浅底。
  { cls: '.stream-incomplete', label: '读取不完整告警' },
] as const

describe('指令四态的 AA 门', () => {
  it.each(STATES)('$label：文字 vs 自身浅底 ≥ 4.5:1，且取值来自 CSS 真值', ({ cls }) => {
    const tint = tintOf(cls)
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
    // **必须读规则真正画的文字色**（复核 #209 R2 残留的真活口）：原先这条只读了重绑指令与 tint，
    // 直接从红-900 算比值——于是把 `color` 换成浅色（red-100）时浏览器实测 1.00:1 文字不可见，
    // 而门依然全绿，因为**根本没人请求过 `color` 这个属性**。
    expect(declaration('.instruction-error', 'color')).toBe('var(--dsw-alias-state-error-primary)')
    const ratio = round2(contrastOnTint(rgb, tintOf('.instruction-error'), WHITE))
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
    for (const [name, cls] of [
      ['--dsw-alias-state-success-primary', '.instruction-state-accepted'],
      ['--dsw-alias-state-error-primary', '.instruction-state-rejected'],
      ['--dsw-alias-state-business-primary', '.instruction-state-queued'],
      ['--dsw-alias-state-warn-primary', '.instruction-state-pending'],
      ['--dsw-alias-state-warn-primary', '.stream-incomplete'],
    ] as const) {
      const tint = tintOf(cls)
      const rgb = parseCssColor(readTokenValue(TOKENS, name))
      expect(
        round2(contrastOnTint(rgb, tint, WHITE)),
        `${name} 原本的 500 档应当不过 AA（这正是要重映射的原因）`,
      ).toBeLessThan(4.5)
    }
  })
})
