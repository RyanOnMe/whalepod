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
  readTokenValueDark,
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
  // 第六、七处：⑥c 的目标来源 chip（Q5 先抓到，纳入本门后不再依赖 e2e 偶然覆盖）。
  { cls: '.target-mode', label: '目标来源：自动选' },
  { cls: '.target-mode-explicit', label: '目标来源：显式指定' },
] as const

/**
 * **中性 chip**（不是状态色）：`.ref-chip`（⑥f 的运行引用）、`.chip-gray`（⑥d 的只读提示）。
 *
 * 它们与状态家族同形（同色浅底 + 小字），但**不属于** `--dsw-alias-state-*` 那一族——
 * 硬塞进上面那道门就得给它编一个状态色，那是造假。所以另立一条：仍然**从 CSS 读 tint**、
 * 仍然按白底算比值，只是不要求颜色是状态 token。
 * （这道口子本来就是门暴露出来的真实缺口：中性 chip 此前没有任何对比度判据。）
 */
const NEUTRAL_CHIPS = [
  { cls: '.ref-chip', label: '运行引用 chip' },
  { cls: '.chip-gray', label: '只读提示 chip' },
  // 第三处：#210 的「未知状态」兜底（服务端今天不发 null 所以不可达，
  // 但样式存在就必须达标——"画不出来的样式"不需要门，"画得出来的"都需要）。
  { cls: '.instruction-state-unknown', label: '未知状态 chip' },
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
      ['--dsw-alias-state-business-primary', '.target-mode'],
      // 评审 S1：反面钉只加了 .target-mode，漏了显式态那个（它不重映射只有 1.93:1，
      // 比 business 那档更差）——主判据覆盖了它，但"门不是恒真"这条对它没证明。
      ['--dsw-alias-state-warn-primary', '.target-mode-explicit'],
    ] as const) {
      const tint = tintOf(cls)
      const rgb = parseCssColor(readTokenValue(TOKENS, name))
      expect(
        round2(contrastOnTint(rgb, tint, WHITE)),
        `${name} 原本的 500 档应当不过 AA（这正是要重映射的原因）`,
      ).toBeLessThan(4.5)
    }
  })

  // #214 A 方案：深色面缺口（`it.fails` 形态——"已知会红"，不是"绿了"）。
  //
  // 同一批 chip 在深色面（bg-layer-3 深色值）上的真实比值：900 档重绑在深色下是
  // 1.01~1.23:1（高估约 10 倍，Issue 实测）。深色段今天不可达（index.html 不设
  // `data-ds-dark-theme`），所以这条**不是"现在坏了"**，而是"启用深色的那天要修"——
  // `it.fails` 修好之前保持"预期失败"形态，修好的那天它会自动提醒删掉自己
  // （`it.fails` 在断言通过时会红："居然过了，快把我删掉"）。
  //
  // 比值**从 CSS 真值算**（深色 token 生效值 + 同一 tint），不是硬编码 1.01——
  // 以后有人改了深色 token 或 900 档取值，这里的报告数字会跟着变。
  it.fails.each(STATES)('$label：深色面（已知缺口，启用深色前必须修）', ({ cls }) => {
    const tint = tintOf(cls)
    const colorText = declaration(cls, 'color')
    // 先断言颜色仍是状态 token：否则下面 exec 抛 TypeError 也会被 it.fails 吞掉，
    // "颜色写坏"和"比值不够"两种失败混在一起，报告不诚实（中性门同理已显式断言）。
    expect(colorText).toMatch(/^var\(--dsw-alias-state-/)
    const tokenName = /var\((--dsw-alias-state-[a-z-]+)\)/.exec(colorText)![1]!
    // 深色生效值：包裹重绑（900 档）浅深同值所以还是 900；state 原始值深色可能提亮
    // （error/business 深色是 400 档），但 chip 类自己重绑了 token，读的是重绑后的 900。
    const staticName = /var\((--dsw-static-[a-z]+-900)\)/.exec(declaration(cls, tokenName))![1]!
    const rgb = parseCssColor(readTokenValueDark(TOKENS, staticName))
    const surface = parseCssColor(readTokenValueDark(TOKENS, '--dsw-alias-bg-layer-3'))
    const ratio = round2(contrastOnTint(rgb, tint, surface))
    console.log(`[#214 深色缺口] ${cls} 深色面 ${ratio}:1（浅色门算的是白底，要求 4.5:1）`)
    expect(ratio).toBeGreaterThanOrEqual(4.5)
  })
})

/**
 * 平面底色上的字（#214 第 3 条：复核 O2 指出 surface 从未被读取）。
 *
 * chip 门只验"tint 浅底"——但 `.instruction-item`（`background: var(--dsw-alias-bg-layer-3)`，
 * 平面色、无 color-mix）上面还坐着两行字：`.instruction-body`（primary 正文）与
 * `.instruction-head`（secondary 小字，含 `.instruction-kind`）。字色 token 与容器底 token
 * 都是 CSS 真值，双底（浅 `:root` / 深 `body[data-ds-dark-theme]`）各算一次。
 * 前提同样钉住：primary/secondary 在两底上都必须 ≥ 4.5（否则"字 vs 面"无从谈起）。
 */
describe('平面底色上的字（容器底 + 字色都是 CSS 真值）', () => {
  it('前提：primary / secondary 在浅深两底上都 ≥ 4.5:1', () => {
    for (const dark of [false, true] as const) {
      const read = dark ? readTokenValueDark : readTokenValue
      const surface = parseCssColor(read(TOKENS, '--dsw-alias-bg-layer-3'))
      for (const token of ['--dsw-alias-label-primary', '--dsw-alias-label-secondary'] as const) {
        const ink = parseCssColor(read(TOKENS, token))
        const ratio = round2(contrastRatio(ink, surface))
        expect(ratio, `${token} 在${dark ? '深' : '浅'}色面上是 ${ratio}:1`).toBeGreaterThanOrEqual(
          4.5,
        )
      }
    }
  })

  it.each([
    { cls: '.instruction-body', token: '--dsw-alias-label-primary', label: '指令正文' },
    { cls: '.instruction-head', token: '--dsw-alias-label-secondary', label: '指令头小字' },
    { cls: '.target-note', token: '--dsw-alias-label-secondary', label: '目标条说明' },
  ])('$label：浅深两底上字色 vs 容器底都 ≥ 4.5:1', ({ cls, token }) => {
    // 字色声明必须是该 token（否则"字 vs 面"算的不是屏上真的那对）。
    expect(declaration(cls, 'color')).toBe(`var(${token})`)
    for (const dark of [false, true] as const) {
      const read = dark ? readTokenValueDark : readTokenValue
      const ink = parseCssColor(read(TOKENS, token))
      // 容器底：instruction 系坐 `.instruction-item` 上，target 系坐页面底上——
      // 页面底浅色是白、深色是 bg-layer-3 的深色值；instruction-item 的底浅深恰好也是
      // （浅 `rgb(255,255,255)` / 深 `rgb(53,54,56)`）——同一对值，同一条判据。
      const surface = parseCssColor(read(TOKENS, '--dsw-alias-bg-layer-3'))
      const ratio = round2(contrastRatio(ink, surface))
      expect(ratio, `${cls} 在${dark ? '深' : '浅'}色面上是 ${ratio}:1`).toBeGreaterThanOrEqual(4.5)
    }
  })
})

describe('中性 chip 的 AA 门（同形不同族）', () => {
  it.each(NEUTRAL_CHIPS)('$label：文字 vs 自身浅底 ≥ 4.5:1（取值来自 CSS 真值）', ({ cls }) => {
    const tint = tintOf(cls)
    const colorText = declaration(cls, 'color')
    // 中性 chip 的字色是 label 语义 token（不是 state），底必须是**同一个** token 的浅底。
    expect(colorText).toMatch(/^var\(--dsw-alias-label-/)
    expect(declaration(cls, 'background')).toContain(colorText.replace('var(', '').replace(')', ''))
    const tokenName = /var\((--dsw-alias-label-[a-z-]+)\)/.exec(colorText)![1]!
    const rgb = parseCssColor(readTokenValue(TOKENS, tokenName))
    const ratio = round2(contrastOnTint(rgb, tint, WHITE))
    expect(
      ratio,
      `${cls} 的 ${tokenName} 在白底 ${tint}% 浅底上是 ${ratio}:1`,
    ).toBeGreaterThanOrEqual(4.5)
  })

  // #214 A 方案：中性 chip 的深色面（普通 `it` 真门——深色下 secondary 6:1 照样过）。
  // 前提钉：深色下 secondary 必须过、且 chip 必须用 secondary（tertiary 深色只有 4.51:1，
  // 擦线过——和浅色 3.706:1 同一个教训：能当小字灰的只有 secondary）。
  it('深色面 secondary 同样达标（tertiary 深色擦线，不许用）', () => {
    const surface = parseCssColor(readTokenValueDark(TOKENS, '--dsw-alias-bg-layer-3'))
    const secondary = parseCssColor(readTokenValueDark(TOKENS, '--dsw-alias-label-secondary'))
    const tertiary = parseCssColor(readTokenValueDark(TOKENS, '--dsw-alias-label-tertiary'))
    // tint 同样从 CSS 读（复核 R2 的教训：硬编码 12% 的话，CSS 改成 44% 门也发现不了）。
    for (const { cls } of NEUTRAL_CHIPS) {
      const tint = tintOf(cls)
      expect(
        round2(contrastOnTint(secondary, tint, surface)),
        `${cls} 深色面 secondary 是 ${round2(contrastOnTint(secondary, tint, surface))}:1`,
      ).toBeGreaterThanOrEqual(4.5)
      expect(round2(contrastOnTint(tertiary, tint, surface))).toBeLessThan(5)
    }
  })

  it.each(NEUTRAL_CHIPS)('$label：深色面 ≥ 4.5:1（取值来自 CSS 真值）', ({ cls }) => {
    const tint = tintOf(cls)
    const colorText = declaration(cls, 'color')
    expect(colorText).toMatch(/^var\(--dsw-alias-label-secondary\)$/)
    const rgb = parseCssColor(readTokenValueDark(TOKENS, '--dsw-alias-label-secondary'))
    const surface = parseCssColor(readTokenValueDark(TOKENS, '--dsw-alias-bg-layer-3'))
    const ratio = round2(contrastOnTint(rgb, tint, surface))
    expect(ratio, `${cls} 深色面是 ${ratio}:1`).toBeGreaterThanOrEqual(4.5)
  })
})
