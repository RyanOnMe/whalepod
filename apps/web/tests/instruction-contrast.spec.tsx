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
  compositeOver,
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
const APP_TOKENS = readFileSync(join(STYLES, 'tokens.css'), 'utf8')

/** 从 `.cls { ... }` 里取出某个声明值（CSS 文本级，够用且稳定）。 */
function optionalDeclaration(selector: string, property: string, css = CSS): string | undefined {
  const plain = css.replace(/\/\*[\s\S]*?\*\//g, '')
  const blocks = [...plain.matchAll(/([^{}]+)\{([^{}]*)\}/g)]
    .filter((match) =>
      match[1]!
        .trim()
        .split(/\s*,\s*/)
        .includes(selector),
    )
    .map((match) => match[2]!)
  expect(blocks.length, `${selector} 不得有重复规则块`).toBeLessThanOrEqual(1)
  if (blocks.length === 0) return undefined
  const matches = [...blocks[0]!.matchAll(new RegExp(`(?:^|[;\\s])${property}:\\s*([^;]+);`, 'g'))]
  expect(matches.length, `${selector} 的 ${property} 不得重复声明`).toBeLessThanOrEqual(1)
  return matches[0]?.[1]?.trim()
}
function declaration(selector: string, property: string, css = CSS): string {
  const value = optionalDeclaration(selector, property, css)
  expect(value, `${selector} 必须声明 ${property}`).toBeDefined()
  return value!
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

const DARK_CASES = [
  {
    cls: '.instruction-state-pending',
    label: '待受理',
    state: '--dsw-alias-state-warn-primary',
    tone: '--color-warn',
  },
  {
    cls: '.instruction-state-accepted',
    label: '已受理',
    state: '--dsw-alias-state-success-primary',
    tone: '--color-run',
  },
  {
    cls: '.instruction-state-queued',
    label: '已排队',
    state: '--dsw-alias-state-business-primary',
    tone: '--color-signal',
  },
  {
    cls: '.instruction-state-rejected',
    label: '已拒绝',
    state: '--dsw-alias-state-error-primary',
    tone: '--color-danger',
  },
  {
    cls: '.stream-incomplete',
    label: '读取不完整',
    state: '--dsw-alias-state-warn-primary',
    tone: '--color-warn',
  },
  {
    cls: '.target-mode',
    label: '自动目标',
    state: '--dsw-alias-state-business-primary',
    tone: '--color-signal',
  },
  {
    cls: '.target-mode-explicit',
    label: '显式目标',
    state: '--dsw-alias-state-warn-primary',
    tone: '--color-warn',
  },
  {
    cls: '.instruction-error',
    label: '拒绝理由',
    state: '--dsw-alias-state-error-primary',
    tone: '--color-danger',
  },
  {
    cls: '.run-events-alert',
    label: '运行事件读取告警',
    state: '--dsw-alias-state-warn-primary',
    tone: '--color-warn',
  },
] as const

function declarationsFor(css: string, selector: string): Record<string, string> {
  const plain = css.replace(/\/\*[\s\S]*?\*\//g, '')
  return Object.fromEntries(
    [...plain.matchAll(/([^{}]+)\{([^{}]*)\}/g)]
      .filter((match) => match[1]!.trim() === selector)
      .flatMap((match) =>
        [...match[2]!.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)].map((value) => [
          value[1]!,
          value[2]!.trim(),
        ]),
      ),
  )
}
function darkTokens(app = APP_TOKENS) {
  return {
    ...declarationsFor(TOKENS, ':root'),
    ...declarationsFor(app, ':root'),
    ...declarationsFor(TOKENS, 'body[data-ds-dark-theme]'),
    ...declarationsFor(app, 'body[data-ds-dark-theme]'),
  }
}
function resolvedColor(tokens: Record<string, string>, token: string) {
  const seen = new Set<string>()
  while (true) {
    if (seen.has(token)) throw new Error(`循环 token: ${token}`)
    seen.add(token)
    const value = tokens[token]
    if (!value) throw new Error(`未解析 token: ${token}`)
    const ref = /^var\(\s*(--[\w-]+)\s*\)$/.exec(value)?.[1]
    if (!ref) return parseCssColor(value)
    token = ref
  }
}
function assertDarkChip(entry: (typeof DARK_CASES)[number], css = CSS, app = APP_TOKENS) {
  const selector = `body[data-ds-dark-theme] ${entry.cls}`
  const textSelector = entry.cls === '.run-events-alert' ? '.run-events-alert p' : entry.cls
  const darkTextSelector = `body[data-ds-dark-theme] ${textSelector}`
  const color =
    optionalDeclaration(darkTextSelector, 'color', css) ?? declaration(textSelector, 'color', css)
  const background =
    optionalDeclaration(selector, 'background', css) ?? declaration(entry.cls, 'background', css)
  expect(color, `${selector} 的真实字色`).toBe(
    entry.cls === '.run-events-alert' ? 'var(--color-ink)' : `var(${entry.state})`,
  )
  const mix = /^color-mix\(in srgb,\s*var\((--[\w-]+)\)\s*([\d.]+)%,\s*transparent\)$/.exec(
    background,
  )
  expect(mix?.[1], `${selector} 背景必须使用本地状态家族`).toBe(entry.state)
  const tint = Number(mix![2]) / 100
  const remap = declaration(selector, entry.state, css)
  expect(remap, `${selector} 的dark局部语义`).toBe(`var(${entry.tone})`)
  const tokens = { ...darkTokens(app), [entry.state]: remap }
  const tintInk = resolvedColor(tokens, entry.state)
  const ink = entry.cls === '.run-events-alert' ? resolvedColor(tokens, '--color-ink') : tintInk
  return ['--dsw-alias-bg-layer-3', '--color-surface', '--color-paper'].map((surfaceToken) => {
    const surface = resolvedColor(tokens, surfaceToken)
    const ratio = round2(
      contrastRatio(ink, compositeOver({ ...tintInk, a: tintInk.a * tint }, surface)),
    )
    expect(ratio, `${entry.cls} 在 ${surfaceToken} 的真实dark tint上`).toBeGreaterThanOrEqual(4.5)
    return { cls: entry.cls, surfaceToken, tint, ratio }
  })
}
function overrideDarkAccepted(declarations: string) {
  return CSS.replace(
    /(body\[data-ds-dark-theme\] \.instruction-state-accepted\s*\{)([^}]*)(\})/,
    `$1$2${declarations};$3`,
  )
}

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

  // P1-437 retires the seven expected failures: real dark remaps now have a mandatory AA gate.
  it.each(DARK_CASES)('$label：dark局部重绑与三种真实容器底均 ≥4.5:1', (entry) => {
    assertDarkChip(entry)
  })

  it('dark负控：旧900重绑、错误字色/浅底、错误语义、重复覆盖均须拒绝', () => {
    const accepted = DARK_CASES.find((entry) => entry.cls === '.instruction-state-accepted')!
    const old900 = CSS.replace(
      /(body\[data-ds-dark-theme\] \.instruction-state-accepted\s*\{[^}]*--dsw-alias-state-success-primary:\s*)var\(--color-run\)/,
      '$1var(--dsw-static-green-900)',
    )
    const wrongFamily = CSS.replace(
      /(body\[data-ds-dark-theme\] \.instruction-state-accepted\s*\{[^}]*--dsw-alias-state-success-primary:\s*)var\(--color-run\)/,
      '$1var(--color-danger)',
    )
    for (const bad of [
      old900,
      wrongFamily,
      overrideDarkAccepted('color: var(--dsw-static-green-900)'),
      overrideDarkAccepted(
        'background: color-mix(in srgb, var(--dsw-alias-state-success-primary) 90%, transparent)',
      ),
      `${CSS}\nbody[data-ds-dark-theme] .instruction-state-accepted { --dsw-alias-state-success-primary: var(--color-run); }`,
    ]) {
      expect(bad).not.toBe(CSS)
      expect(() => assertDarkChip(accepted, bad)).toThrow()
    }
    // Correct local semantic names cannot hide a broken dark semantic value.
    const wrongDarkTone = APP_TOKENS.replace(
      /(body\[data-ds-dark-theme\]\s*\{[^}]*--color-run:\s*)var\(--dsw-static-green-100\)/,
      '$1var(--dsw-static-green-900)',
    )
    expect(wrongDarkTone).not.toBe(APP_TOKENS)
    expect(() => assertDarkChip(accepted, CSS, wrongDarkTone)).toThrow(/真实dark tint/)
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
    // `.target-note` 坐页面底（`--dsw-alias-bg-module-platform`：浅 `rgb(245,246,247)`、
    // 深 `rgb(53,54,56)`）上，不是卡片面——第一版注释写"页面底浅色是白"是错的（评审 S2），
    // 错在注释不在判据（真底上 secondary 是 5.36:1，同样 ≥4.5）。
    {
      cls: '.target-note',
      token: '--dsw-alias-label-secondary',
      label: '目标条说明',
      surface: '--dsw-alias-bg-module-platform',
    },
  ])('$label：浅深两底上字色 vs 容器底都 ≥ 4.5:1', ({ cls, token, surface }) => {
    // 字色声明必须是该 token（否则"字 vs 面"算的不是屏上真的那对）。
    expect(declaration(cls, 'color')).toBe(`var(${token})`)
    for (const dark of [false, true] as const) {
      const read = dark ? readTokenValueDark : readTokenValue
      const ink = parseCssColor(read(TOKENS, token))
      // 容器底：instruction 系坐 `.instruction-item`（`bg-layer-3`）上；深色下两底恰好
      // 相等（都是 `rgb(53,54,56)`），浅色下才分叉（卡片面白 / 页面底 245,246,247）。
      const face = parseCssColor(read(TOKENS, surface ?? '--dsw-alias-bg-layer-3'))
      const ratio = round2(contrastRatio(ink, face))
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

/**
 * placeholder 的 AA 门（A0-8 补，2026-10-09）。
 *
 * 为什么补：`.instruction-composer textarea` 原先只声明 `color`，placeholder 走**浏览器默认色**
 * （Chrome 黑 54% 合成后 4.06:1）——这条只在**发布级** Q5 的对比度扫描里可见，PR 期的 Q0 全绿
 * 却是空的。2026-10-09 的发布取证里 Q5 正是被它拦下（`placeholder: 让 Agent 干这个…`）。
 * 所以这里补一条**快判据**：全局 placeholder 声明必须存在、且取色满足 AA——
 * 缺了声明 = 退回浏览器默认 = 立即红，不必等到发布前才看得见。
 */
describe('placeholder 的 AA 门（A0-8 补：此前只有 Q5 扫得见）', () => {
  /** 取 `…::placeholder { … }` 规则体（选择器可多行/多选择器，故用宽松匹配后取第一个含 textarea 的块）。 */
  function placeholderBlock(): string {
    const blocks = [...CSS.matchAll(/([^{}]*::placeholder[^{}]*)\{([^}]*)\}/g)]
    const block = blocks.find((match) => (match[1] ?? '').includes('textarea'))?.[2]
    expect(
      block,
      'global.css 缺 input/textarea 的 ::placeholder 规则——placeholder 会退回浏览器默认色（实测 4.06:1）',
    ).toBeDefined()
    return block as string
  }

  it('声明存在且取色在输入底（bg-layer-2）与白底上都 ≥ 4.5:1', () => {
    const block = placeholderBlock()
    const colorDecl = /(?:^|[;\s])color:\s*var\((--[\w-]+)\)/.exec(block)
    expect(colorDecl?.[1], 'placeholder 的颜色必须走 token（硬编码色值会在换肤时静默漂移）').toBe(
      '--dsw-alias-label-secondary',
    )
    const fg = parseCssColor(readTokenValue(TOKENS, colorDecl![1]!))
    // 两处底：composer 的输入底（bg-layer-2，浅色=白）与页面白底（登录/初始化页的表单）。
    for (const surface of [
      parseCssColor(readTokenValue(TOKENS, '--dsw-alias-bg-layer-2')),
      WHITE,
    ]) {
      const ratio = round2(contrastRatio(fg, surface))
      expect(ratio, `placeholder 对比度 ${ratio}:1 < 4.5:1`).toBeGreaterThanOrEqual(4.5)
    }
  })

  it('反证：把取色换成过浅的 dimmed token（#757575 一档）必须不达标——门不是恒真', () => {
    // 反证要能用**本仓同一套公式**复算：light 主题下 dimmed 别名解析到 neutral-bluish-200，
    // 它在白底上远低于 4.5:1。若有人把 placeholder 改成 dimmed（一个很自然的"淡一点"的念头），
    // 这条会红——这正是本轮要防的方向。
    // （不提"浏览器默认色是 4.06:1"：那个数字来自 Q5 扫描器的合成口径，本文件复算不出，
    //   不把未复算的算术写进判据。）
    const dimmed = parseCssColor(readTokenValue(TOKENS, '--dsw-static-neutral-bluish-200'))
    expect(round2(contrastRatio(dimmed, WHITE)), 'dimmed 档在白底上不该达标').toBeLessThan(4.5)
  })
})
