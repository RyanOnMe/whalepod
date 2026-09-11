/**
 * #164 焦点环门：`--focus-ring` 的**每一层**颜色与粗细，在浅色底、深底（ink 档）与
 * 深色一套（`body[data-ds-dark-theme]`）上都要够看。
 *
 * 为什么单开一道门：
 * 1. 旧值 `0 0 0 3px color-mix(in srgb, var(--color-signal) 40%, transparent)` 是**应用层
 *    （global.css）唯一的焦点样式**（`:focus-visible`），而它合成后压页面底 1.77:1、压卡片面
 *    1.81:1、压顶栏底 1.53:1——SC 1.4.11 非文字对比度（AA）要求焦点指示与相邻颜色 ≥3:1。
 *    结果是键盘用户能操作、但看不见焦点在哪。
 *
 *    措辞更正（一审 S3）：**不能**说"全站唯一"——vendored 原语自带独立的焦点指示，
 *    本门既不扫它们、也没把它们算进覆盖：`vendor/dsh-ui/Switch.module.css:38`
 *    （`outline: 2px solid var(--dsw-alias-brand-primary)`）、
 *    `ConnectionIndicator.module.css:40`（warn 色 outline）、
 *    `Input.module.css:18`（`.wrap:focus-within` 改描边色）。三者在 `apps/web/src`（除 vendor）
 *    当前**零使用点**，所以不是线上回归；但"键盘可达路径全被覆盖"这个说法不成立，已列入
 *    本文末尾的未验证清单。
 * 2. 现有两道颜色门都守不住它：`theme-contrast.spec.ts` 判的是**声明出来的文字/背景配对**
 *    （焦点环不是文字，也不在那张清单里）；#159 的浏览器扫描判的是**文字**对比度。
 *
 * 判据（逐层算，不是只看最外层）：
 *   · 每个底色上**至少有一层** ≥3:1，且这一层的**可见环带 ≥2px**（0.5px 的发丝线再高的
 *     对比度也看不见）。底色清单：页面底 paper、卡片面 surface、深底 ink（= `--color-ink`，
 *     双层环要解决的正是它），外加焦点元素**自身底色** signal（`.button-primary` 就是蓝底）；
 *   · 焦点指示整体厚度（最外层 spread）≥2px：SC 2.4.13 焦点外观（AAA）的面积/周长口径；
 *   · 每一层颜色必须是对**应用层语义 token** 的 `var()` 引用（本仓"不写裸色值"惯例；也因为
 *     焦点环必须随 L1 深色段一起翻转，写死色值就等于把深色一套写坏）；
 *   · 同心环按"内层在前"的升序声明：box-shadow **先声明的画在上面**，顺序一换外层会把内层
 *     整条盖住，而本文件的"可见环带"算法会算出两个环——这条断言把写法钉住。
 *
 * 标准编号更正：#164 正文把 3:1 记在「SC 2.4.11 Focus Appearance」名下。WCAG 2.2 里 2.4.11
 * 是 Focus Not Obscured (Minimum)（焦点不被遮挡，AA），Focus Appearance 是 2.4.13（AAA，
 * 含"至少 2 CSS px 周长厚度"的面积口径），而焦点指示的 3:1 相邻色对比度落在 SC 1.4.11
 * 非文字对比度（AA）。判据不变，这里按标准编号写清楚，免得后人照错编号引错条款。
 *
 * 数字全部从 CSS 文本解析出来算（不抄死在测试里）：改 token，判据跟着变；门绿时也打印
 * 整张表，便于评审看趋势。末尾两条**反向用例**把"门不是恒真"变成常驻断言——旧值与
 * "单色加深"两个负样本都在里面，红→绿实测由它们复现——注意负样本里的数字是**刻意抄死**的
 * （负样本不该随 token 变，它记录的是历史事实），改动时别把它们改成"从当前 token 现算"。
 */
import { readFileSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  compositeOver,
  contrastRatio,
  parseCssColor,
  readTokenValue,
  round2,
  type Rgb,
  type Rgba,
} from './contrast.js'

const here = dirname(fileURLToPath(import.meta.url))
const styleDir = join(here, '../src/styles')
const appTokens = readFileSync(join(styleDir, 'tokens.css'), 'utf8')
const l1Tokens = readFileSync(join(here, '../src/styles/dsw-tokens.css'), 'utf8')
const globalCss = readFileSync(join(here, '../src/styles/global.css'), 'utf8')

/** SC 1.4.11 非文字对比度（AA）：焦点指示 vs 相邻颜色 ≥3:1。 */
const MIN_LAYER_RATIO = 3
/** SC 2.4.13 焦点外观（AAA）的面积/周长口径；本仓取 2px 为"看得见的一圈"下限。 */
const MIN_THICKNESS_PX = 2

/**
 * 判据用到的底色。前三条是 #164 点名的三个相邻色；signal 是**焦点元素自身**的底色
 * （`.button-primary` 的填充就是 `--color-signal`）——加测它是为了把"单色加深不够用"
 * 变成数字，见末尾反向用例。
 */
const BACKGROUNDS: ReadonlyArray<[label: string, token: string]> = [
  ['页面底 paper', '--color-paper'],
  ['卡片面 surface', '--color-surface'],
  // #173：深色顶栏已退役，但 ink 作为「深底」代表档留在矩阵里——任何将来的深色容器
  // （或深色主题上线）都会落在这条上。
  ['深底 ink', '--color-ink'],
  ['主按钮底 signal（元素自身底色）', '--color-signal'],
]

/**
 * 深色段（上游 `body[data-ds-dark-theme]` 段）。L1 深色**只重写与浅色取值不同的变量**，
 * 所以取不到时按 CSS 语义回落浅色段——浏览器里就是这个行为，这里如实照做。
 */
const darkBlockText = ((): string => {
  const match = /body\[data-ds-dark-theme\]\s*\{([\s\S]*?)\n\}/.exec(l1Tokens)
  if (match?.[1] === undefined) {
    throw new Error('dsw-tokens.css 里找不到 body[data-ds-dark-theme] 段')
  }
  return match[1]
})()

/** 同 contrast.ts 的 readTokenValue，但"找不到"返回 null（深色段允许没有该变量）。 */
function readTokenValueOrNull(cssText: string, name: string): string | null {
  const match = new RegExp(`${name}\\s*:\\s*([^;]+);`).exec(cssText)
  return match?.[1]?.trim() ?? null
}

/**
 * 解析 var() 链：应用层（tokens.css）→ L1（dsw-tokens.css）。`dark=true` 时每一跳都优先
 * 在深色段里找。引用不到的 token 由 readTokenValue 抛错——那正是仓库"引用了但没定义"
 * 要抓的形态，不许静默当成"没这回事"。
 */
function resolveTokenValue(name: string, dark: boolean): string {
  let value = readTokenValue(appTokens, name)
  for (let hop = 0; hop < 4; hop += 1) {
    const target = /^var\((--[a-z0-9-]+)\)$/i.exec(value.trim())?.[1]
    if (target === undefined) break
    const fromDark = dark ? readTokenValueOrNull(darkBlockText, target) : null
    value = fromDark ?? readTokenValue(l1Tokens, target)
  }
  return value.trim()
}

/**
 * 按**顶层逗号**切 box-shadow 的层：`color-mix(in srgb, …)` 内部也有逗号，裸 `split(',')`
 * 会把一层切碎（旧值就是这个形态，反向用例要能算它，所以这里按括号深度切）。
 */
function splitShadowLayers(value: string): string[] {
  const layers: string[] = []
  let depth = 0
  let current = ''
  for (const char of value) {
    if (char === '(') depth += 1
    else if (char === ')') depth -= 1
    if (char === ',' && depth === 0) {
      layers.push(current)
      current = ''
      continue
    }
    current += char
  }
  layers.push(current)
  return layers.map((layer) => layer.trim()).filter((layer) => layer !== '')
}

/**
 * 把一层里的颜色解成 Rgba。认两种形态：
 *   · 纯 token：`var(--color-surface)` → 应用层 → L1（按主题取浅色/深色段）；
 *   · 带透明的 color-mix：`color-mix(in srgb, var(--color-signal) 40%, transparent)`——
 *     旧值就是它。比例换算成 alpha，"落到哪个底色上"由 ratioOver() 用 contrast.ts 的
 *     compositeOver 完成，本文件不另起一套合成算法。
 * 其它写法（hex/命名色/别的 mix 形态）一律抛错：宁可炸，也不要门悄悄算错。
 */
function resolveColor(text: string, dark: boolean): Rgba {
  const mix = /^color-mix\(in srgb,\s*(.+?)\s+([\d.]+)%,\s*transparent\)$/i.exec(text)
  if (mix?.[1] !== undefined && mix[2] !== undefined) {
    const base = resolveColor(mix[1], dark)
    return { ...base, a: base.a * (Number.parseFloat(mix[2]) / 100) }
  }
  const varRef = /^var\((--[a-z0-9-]+)\)$/i.exec(text)
  if (varRef?.[1] !== undefined) return parseCssColor(resolveTokenValue(varRef[1], dark))
  return parseCssColor(text)
}

/** 一层环落在某个底色上的实际对比度：先 alpha 合成，再算 WCAG 对比度。 */
function ratioOver(color: Rgba, background: Rgb): number {
  return round2(contrastRatio(compositeOver(color, background), background))
}

interface RingLayer {
  /** 原始颜色文本，写进报告便于人对着 CSS 看 */
  colorText: string
  spreadPx: number
  color: Rgba
}

/**
 * 解析一个 box-shadow 值的每一层。默认读 `--focus-ring`；`value` 参数是给反向用例喂
 * 负样本用的（旧值 / 单色环），免得把历史值写进 token 才能算。
 * 形状不是「`0 0 0 Npx 颜色`」就抛——inset 环、带偏移的环都不接受，因为它们会改变
 * "环贴不贴元素"的语义。
 */
function ringLayers(dark: boolean, value = readTokenValue(appTokens, '--focus-ring')): RingLayer[] {
  return splitShadowLayers(value).map((layer) => {
    const match = /^0\s+0\s+0\s+(\d+(?:\.\d+)?)px\s+(.+)$/i.exec(layer)
    if (match?.[1] === undefined || match[2] === undefined) {
      throw new Error(`焦点环不是「0 0 0 Npx 颜色」形态：${layer}`)
    }
    return {
      colorText: match[2].trim(),
      spreadPx: Number.parseFloat(match[1]),
      color: resolveColor(match[2].trim(), dark),
    }
  })
}

interface LayerAudit {
  colorText: string
  spreadPx: number
  /** 该层实际露出的环带宽度（px） */
  widthPx: number
  ratio: number
}

interface BackgroundAudit {
  label: string
  token: string
  layers: LayerAudit[]
}

/**
 * 每层实际露出的环带宽度：box-shadow 同心外扩，第 i 层露出的是 spread_i - spread_{i-1}
 * 那一圈（spread_{-1} = 0）。前提是"内层在前"的升序声明，由调用方断言。
 */
function ringBands(layers: RingLayer[]): Array<{ layer: RingLayer; widthPx: number }> {
  let inner = 0
  return layers.map((layer) => {
    const widthPx = layer.spreadPx - inner
    inner = layer.spreadPx
    return { layer, widthPx }
  })
}

/** 一个底色上的实测：层 × 比值。 */
function readBackground(
  label: string,
  token: string,
  layers: RingLayer[],
  dark: boolean,
): BackgroundAudit {
  const parsed = parseCssColor(resolveTokenValue(token, dark))
  const background: Rgb = { r: parsed.r, g: parsed.g, b: parsed.b }
  return {
    label,
    token,
    layers: ringBands(layers).map(({ layer, widthPx }) => ({
      colorText: layer.colorText,
      spreadPx: layer.spreadPx,
      widthPx,
      ratio: ratioOver(layer.color, background),
    })),
  }
}

/** 判定：这一底色上的"达标层"——既 ≥3:1、又真的有 ≥2px 宽（否则达标的是根看不见的发丝线）。 */
function carriersOn(background: BackgroundAudit): LayerAudit[] {
  return background.layers.filter(
    (layer) => layer.ratio >= MIN_LAYER_RATIO && layer.widthPx >= MIN_THICKNESS_PX,
  )
}

/** 整张表（门绿时也打印）：层 × 底色 × 实测比值。 */
function reportOf(theme: string, ringValue: string, backgrounds: BackgroundAudit[]): string {
  const lines = [`${theme}：--focus-ring = ${ringValue}`]
  for (const background of backgrounds) {
    const cells = background.layers.map(
      (layer) =>
        `${layer.colorText}@${layer.spreadPx}px(带 ${layer.widthPx}px) = ${layer.ratio}:1${
          layer.ratio >= MIN_LAYER_RATIO ? '✓' : '✗'
        }`,
    )
    lines.push(`  ${background.label}（${background.token}）：${cells.join('  ')}`)
  }
  return lines.join('\n')
}

function failuresOf(theme: string, backgrounds: BackgroundAudit[]): string[] {
  return backgrounds
    .filter((background) => carriersOn(background).length === 0)
    .map((background) => {
      const measured = background.layers.map((layer) => `${layer.ratio}:1`).join(' / ')
      return `${theme} / ${background.label}：没有一层同时满足 ≥${MIN_LAYER_RATIO}:1 与环带 ≥${MIN_THICKNESS_PX}px（实测 ${measured}）`
    })
}

describe('#164 焦点环门', () => {
  for (const dark of [false, true] as const) {
    const theme = dark ? '深色 body[data-ds-dark-theme]' : '浅色 :root'
    it(`${dark ? '深色一套' : '浅色'}：paper / surface / ink / signal 每个底色上至少一层 ≥3:1（且够粗）`, () => {
      const layers = ringLayers(dark)
      const backgrounds = BACKGROUNDS.map(([label, token]) =>
        readBackground(label, token, layers, dark),
      )
      console.log(
        `[#164 焦点环]\n${reportOf(theme, readTokenValue(appTokens, '--focus-ring'), backgrounds)}`,
      )
      expect(failuresOf(theme, backgrounds)).toEqual([])
    })
  }

  it('深色段确实重定义了 ink / surface（双层环"跟着翻"的取证；真去掉了这条会红）', () => {
    const reports = ['--color-ink', '--color-surface'].map((token) => {
      const light = resolveTokenValue(token, false)
      const dark = resolveTokenValue(token, true)
      console.log(`[#164 深色段] ${token}：浅色 ${light} → 深色 ${dark}`)
      return { token, flipped: light !== dark }
    })
    // 若将来上游深色段不再重写这两个变量，上面的判据会按"与浅色同值"算并如实打印；
    // 这条用例红了就是提醒：深色一套的底色已经没人管了，得重新看。
    expect(reports.filter((report) => !report.flipped).map((report) => report.token)).toEqual([])
  })

  it('环带粗细：整体 ≥2px，且同心环按"内层在前"升序声明', () => {
    const failures: string[] = []
    for (const dark of [false, true] as const) {
      const theme = dark ? '深色一套' : '浅色'
      const layers = ringLayers(dark)
      if (layers.length === 0) failures.push(`${theme}：--focus-ring 一层都没有`)
      const spreads = layers.map((layer) => layer.spreadPx)
      const ascending = spreads.every(
        (spread, index) => index === 0 || spread > (spreads[index - 1] ?? 0),
      )
      if (!ascending) {
        failures.push(
          `${theme}：同心环没有按"内层在前"升序声明（${spreads.join(' → ')}）——box-shadow 先声明的画在上面，顺序一换外层会盖住内层`,
        )
      }
      const thickness = Math.max(0, ...spreads)
      if (thickness < MIN_THICKNESS_PX) {
        failures.push(`${theme}：焦点指示整体厚度 ${thickness}px < ${MIN_THICKNESS_PX}px`)
      }
    }
    console.log(
      `[#164 粗细] ${ringLayers(false)
        .map((l) => `${l.spreadPx}px`)
        .join(' + ')}`,
    )
    expect(failures).toEqual([])
  })

  it('每一层颜色都是对应用层语义 token 的 var() 引用（不写裸色值，深色一套才能自动翻）', () => {
    const offenders = splitShadowLayers(readTokenValue(appTokens, '--focus-ring')).filter(
      (layer) => !/var\(--color-[a-z0-9-]+\)/i.test(layer),
    )
    expect(offenders).toEqual([])
  })

  it('--focus-ring 全仓只声明一次且落在 :root（局部覆盖会让门失明——一审 S1 实测过）', () => {
    // 一审的实测反例：在 global.css 末尾追加 `.app-header { --focus-ring: 0 0 0 3px
    // var(--color-paper); }`（彼时顶栏是深底），token 里仍是好值 → 门 8/8 **全绿**，
    // 而真实顶栏上的焦点环已经
    // 退化。根因是 `readTokenValue` 取的是正则**首个**匹配，只读 tokens.css。
    // 所以这里对 styles/ 下**全部** css 扫一遍声明点，把"局部覆盖"这条通道关掉。
    // **递归**扫（二审 N5：首版用 readdirSync 只扫 styles/*.css，往 styles/themes/x.css 里放
    // 覆盖再 @import 进来时门仍然全绿——断言口径大于实现）。
    const files: string[] = []
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name)
        if (entry.isDirectory()) walk(full)
        else if (entry.name.endsWith('.css')) files.push(full)
      }
    }
    walk(styleDir)
    const declared: Array<{ where: string; selector: string }> = []
    for (const full of files) {
      const file = full.slice(styleDir.length + 1)
      const text = readFileSync(full, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '')
      for (const [, selector, body] of text.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
        if ((body ?? '').includes('--focus-ring:')) {
          declared.push({ where: file, selector: (selector ?? '').trim().replace(/\s+/g, ' ') })
        }
      }
    }
    expect(
      declared.map((d) => `${d.where} ${d.selector}`),
      '--focus-ring 只允许在 styles/tokens.css 的 :root 里声明一次；任何局部覆盖都会让本门失明',
    ).toEqual(['tokens.css :root'])
  })

  it('环的每一层里不出现裸色值（`var(--x, #ff00ff)` 这种带误导性 fallback 也算）', () => {
    // 一审 S2：原判据只查"有没有 var()"，不查"有没有裸色值"，所以带 fallback 的形态会放行。
    // 仓库里 `var(--color-accent, #4f6ef7)` 这类写法有 3 处，属真实惯例，不是假想。
    const value = readTokenValue(appTokens, '--focus-ring')
    const bare = [/#[0-9a-fA-F]{3,8}\b/, /\brgba?\(/, /\bhsla?\(/, /\boklch\(/].filter((re) =>
      re.test(value),
    )
    expect(
      bare.map((re) => re.source),
      '--focus-ring 的取值里出现裸色值',
    ).toEqual([])
    for (const layer of ringLayers(false)) {
      expect(
        [/#[0-9a-fA-F]{3,8}\b/, /\brgba?\(/]
          .filter((re) => re.test(layer.colorText))
          .map((re) => re.source),
        `层「${layer.colorText}」里出现裸色值`,
      ).toEqual([])
    }
  })

  it('焦点环只挂在 :focus-visible 上（鼠标点击不出环）；复用同一 token 的非焦点规则须登记', () => {
    // 先剥注释再切规则：注释里出现 `{`/`}` 时按大括号切块会错位
    const stripped = globalCss.replace(/\/\*[\s\S]*?\*\//g, '')
    const carriers = [...stripped.matchAll(/([^{}]+)\{([^{}]*)\}/g)]
      .filter(([, , body]) => (body ?? '').includes('var(--focus-ring)'))
      .map(([, selector]) => (selector ?? '').trim().replace(/\s+/g, ' '))
    expect(carriers).toContain(':focus-visible')
    // 允许的第二处消费：Agent 卡的"选中"态复用同一 token（选中与焦点本来就是同一视觉语言，
    // 这是 #164 之前就有的写法）。除它之外，任何不带 :focus-visible 的规则都算"鼠标也能看见
    // 焦点环"的嫌疑，必须在下面这行显式登记并写清理由，不许静默加进来。
    const registered = [':focus-visible', '.agent-card-selected']
    expect(carriers.filter((selector) => !registered.includes(selector))).toEqual([])
    // 反向：裸 `:focus`（不带 -visible）不得承载焦点环语义
    expect(carriers.some((selector) => /(^|[^-]):focus(?!-visible)/.test(selector))).toBe(false)
  })

  it('反向用例：旧值（40% 单层环）会被本门判红——红→绿实测的红侧', () => {
    // 这一串是**历史值**，故意写死：它是负样本（证明门不是恒真），不该跟着 token 一起变。
    const previous = '0 0 0 3px color-mix(in srgb, var(--color-signal) 40%, transparent)'
    const layers = ringLayers(false, previous)
    const backgrounds = BACKGROUNDS.map(([label, token]) =>
      readBackground(label, token, layers, false),
    )
    console.log(
      `[#164 负样本·旧值 40% 单层环]\n${backgrounds
        .map((bg) => `  ${bg.label}: ${bg.layers.map((l) => `${l.ratio}:1`).join(' / ')}`)
        .join('\n')}`,
    )
    // 数字与 #164 正文一致：paper 1.77 / surface 1.81 / ink 1.53（signal 上 1.00）
    expect(backgrounds.map((bg) => bg.layers.map((layer) => layer.ratio))).toEqual([
      [1.77],
      [1.81],
      [1.53],
      [1],
    ])
    // 关键一条：把旧值喂给门，三个底色**全部**判红（不是"数字小一点"）
    expect(failuresOf('旧值', backgrounds)).toHaveLength(BACKGROUNDS.length)
  })

  it('反向用例：单色 signal 环在 signal 自身底上只有 1:1（所以"单色加深"不是修法）', () => {
    // 100% blue-600 单层环在**浅色**的 paper / surface / ink 三个底色上确实够（4.78 / 5.17 /
    // 3.66——比旧值好得多），**但两侧都有盲区**：
    //   · 焦点元素**自身**的底色就可能是 signal（.button-primary）→ 环与它 1:1，等于没有指示；
    //   · **深色侧** paper 2.34:1、surface 2.7:1 都不达标（一审 B1 纠正了首版把这句当通用结论
    //     写在随深色一起翻转的 token 注释里的错误）；
    //   · 浅色全调色板（30 色）里还有 16 个底色不达标（`.button-danger` 的 red-900 2.78、
    //     `--color-signal` 自身蓝底 1:1、ghost-active-border 1.89、button-primary-hover 1.86…）。
    // 双层环取 ink / surface 两极，正是为了"任何底色都必然与其中之一拉开"；这条数字就是
    // "为什么不用更显然的写法（单色加深）"的机器证据。
    const signal = parseCssColor(resolveTokenValue('--color-signal', false))
    const single: RingLayer[] = [{ colorText: 'var(--color-signal)', spreadPx: 3, color: signal }]
    const backgrounds = BACKGROUNDS.map(([label, token]) =>
      readBackground(label, token, single, false),
    )
    console.log(
      `[#164 负样本·单色 signal 环]\n${backgrounds
        .map((bg) => `  ${bg.label}: ${bg.layers.map((l) => `${l.ratio}:1`).join(' / ')}`)
        .join('\n')}`,
    )
    expect(backgrounds.map((bg) => bg.layers.map((layer) => layer.ratio))).toEqual([
      [4.78],
      [5.17],
      [3.66],
      [1],
    ])
    expect(failuresOf('单色 signal 环', backgrounds)).toHaveLength(1)
    expect(ratioOver(signal, { r: signal.r, g: signal.g, b: signal.b })).toBe(1)
  })
})
