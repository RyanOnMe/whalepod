/**
 * #168 自研表单控件（`.field input` / `.field textarea` / `.button` 族）对齐 DSH 族的**机器判据**。
 *
 * 这个文件存在的理由：本次改的是几个「看起来对就行」的视觉度量（描边 0.5px、圆角 8px、
 * 颜色改走 L1）。没有判据的话，任何人把 `0.5px` 改回 `1px`、或把 `--dsw-alias-*` 换成应用层
 * `--color-*`，页面依然"看着正常"，测试全绿。
 *
 * 判据分四组（对应 Issue #168 第 3 节）：
 *  A. 描边宽度与圆角**逐值等于 vendored `Input.module.css` 的度量**——度量从那边**现场读**
 *     （`parseVendorInputMetrics`），本文件里**没有 8px / 0.5px 字面量**。抄死数字的判据在上游
 *     改度量那天不会红，等于没判。
 *  B. 这几条控件（含 `:hover` / `:focus-visible` 变体）的颜色声明**只引用 L1 `--dsw-*`**，
 *     且**登记了期望 token 的属性必须用那一个 token**——"只吃 L1"挡不住"换成另一个 L1 里的
 *     同色/近色 token"（评审 S2/S3：主按钮底色换成 `brand-primary`、危险按钮底色换成 red-500
 *     都曾全绿）。没登记期望值、却声明了颜色属性的规则**直接报红**，不许静默放过。
 *  C. `min-height` 与 `var(--touch-min)` 同值，且 `--touch-min ≥ 40px`——**高度不跟着
 *     vendored `Input` 降到 32px** 这件事必须由判据承担，否则下一个人"顺手对齐 32px"没人拦。
 *  D. 反面钉（变异验证，22 条）：按 **CSS 规则 + 属性**定位后改坏一次（描边回 1px / 圆角回 6px /
 *     换另一个 L1 描边档 / 颜色回应用层 token（含**同值**的 `--color-surface`，纯文本判据才拦得住）/
 *     高度回 32px / 变体写裸色值 / 底色换成错误色 / hover 与 disabled 里塞应用层值与裸色值 /
 *     `@media` 里偷偷改松），`assertControlFamily` 必须**变红**，且失败信息指到那条规则；
 *     改坏后仍全绿就说明前三条恒真。这条与 #161 的 M3 变异验证同款（同值换 token 的漏网
 *     正是它要挡的），所以变异走**真实 CSS 文本**、与正向用例共用同一个断言函数。
 *
 * 与 Q5 的分工：这里在 CSS **源码文本**上判「写的是哪个 token、哪个度量」；真实浏览器里
 * 「computed style 等于 token 解析值」由 `tests/e2e/helpers.ts` 的 `assertControlTokens`
 * 采一次。**浏览器读不到声明原文**（自定义属性是继承属性、`var()` 在 computed-value 阶段
 * 就代换完了），所以"用了哪个 token"只能在源码文本这一层判；两边共用
 * `src/shared/control-style-tokens.ts` 的常量与判定函数（各写一份必漂移）。
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  CONTROL_BACKGROUND_TOKEN,
  CONTROL_BORDER_TOKEN,
  CONTROL_DANGER_FILL_TOKEN,
  CONTROL_DANGER_LABEL_TOKEN,
  CONTROL_HOVER_BACKGROUND_TOKEN,
  CONTROL_HOVER_BORDER_TOKEN,
  CONTROL_LABEL_TOKEN,
  CONTROL_PRIMARY_FILL_TOKEN,
  CONTROL_PRIMARY_HOVER_TOKEN,
  CONTROL_PRIMARY_LABEL_TOKEN,
  CONTROL_TOUCH_TOKEN,
  TOUCH_MIN_PX,
  checkControlTokens,
  parseVendorInputMetrics,
  resolveTokenValue,
  type ComputedStyleLike,
  type ControlProbe,
} from '../src/shared/control-style-tokens.js'

const repoRoot = join(import.meta.dirname, '../../..')
const globalCss = readFileSync(join(repoRoot, 'apps/web/src/styles/global.css'), 'utf8')
const l1Css = readFileSync(join(repoRoot, 'apps/web/src/styles/dsw-tokens.css'), 'utf8')
const appTokensCss = readFileSync(join(repoRoot, 'apps/web/src/styles/tokens.css'), 'utf8')
const vendorCss = readFileSync(
  join(repoRoot, 'apps/web/src/vendor/dsh-ui/Input.module.css'),
  'utf8',
)
const vendor = parseVendorInputMetrics(vendorCss)

// ---------- CSS 读取（本仓没有 postcss 运行时依赖，够用就好） ----------

/** 去注释。注释里有花括号与引号，不先去掉会把规则体切歪。 */
function stripComments(text: string): string {
  return text.replaceAll(/\/\*[\s\S]*?\*\//g, '')
}
const globalPlain = stripComments(globalCss)
const l1Plain = stripComments(l1Css)
const appTokensPlain = stripComments(appTokensCss)

/** 一条样式规则：选择器列表（逐段）+ 规则体 + 位置（位置用于变异回写）。 */
interface CssRule {
  selectors: string[]
  body: string
  bodyStart: number
  bodyEnd: number
}

/**
 * 扫描 CSS 文本，返回所有**样式规则**，并**把 at-rule 前导剥在选择器之外**。
 *
 * 为什么必须显式做这件事（评审 BLOCK-2 的复现）：早先的写法是"反向退到配平的 `}` 就当成
 * 选择器起点"，于是 `@media (max-width: 390px) { .field input { … } }` 里内层规则的选择器
 * 文本变成 `@media (max-width: 390px) { .field input`——`parts.includes('.field input')`
 * 永假，**那条规则根本没被看到**，往 `@media` 里塞回旧值是"全绿通过"。
 *
 * 现在按配对花括号把文本切成"前导 + 体"：前导以 `@` 开头的是 at-rule（自己不是样式规则、
 * 不进结果），而**每次进入块之后前导重新起算**——内层规则的选择器文本因此天然干净。
 */
function scanRules(cssText: string): CssRule[] {
  const rules: CssRule[] = []
  let preludeStart = 0
  const stack: Array<'at' | 'style'> = []
  for (let i = 0; i < cssText.length; i += 1) {
    const char = cssText[i]
    if (char === '{') {
      const prelude = cssText.slice(preludeStart, i).trim()
      if (prelude === '' || prelude.startsWith('@')) {
        // `@media … {` / `@supports … {`：不是样式规则，只压栈
        stack.push('at')
      } else {
        stack.push('style')
        const selectors = prelude
          .split(',')
          .map((part) => part.trim().replaceAll(/\s+/g, ' '))
          .filter((part) => part !== '')
        let depth = 0
        let end = i
        for (; end < cssText.length; end += 1) {
          if (cssText[end] === '{') depth += 1
          else if (cssText[end] === '}') {
            depth -= 1
            if (depth === 0) break
          }
        }
        if (end >= cssText.length) {
          throw new Error(`CSS 花括号不配平（规则 ${selectors.join(', ')} 未闭合）`)
        }
        rules.push({ selectors, body: cssText.slice(i + 1, end), bodyStart: i + 1, bodyEnd: end })
      }
      preludeStart = i + 1
    } else if (char === '}') {
      stack.pop()
      preludeStart = i + 1
    } else if (char === ';' && stack.length === 0) {
      // `@import './tokens.css';` 这类语句结束：前导从这里之后重新起算，
      // 否则文件头的 @import 会被并进下一条规则的选择器（本次实测踩到过）
      preludeStart = i + 1
    }
  }
  return rules
}

const globalRules = scanRules(globalPlain)

/** 按「选择器 + 必须声明的属性」定位唯一一条规则（找不到 / 命中多条都抛，不静默跳过）。 */
function findRule(rules: CssRule[], selector: string, mustDeclare?: string): CssRule {
  const hits = rules.filter(
    (rule) =>
      rule.selectors.includes(selector) &&
      (mustDeclare === undefined ||
        new RegExp(`(?:^|;)\\s*${mustDeclare}\\s*:`, 'i').test(rule.body)),
  )
  const first = hits[0]
  if (first === undefined) {
    throw new Error(
      `CSS 里找不到规则：${selector}${mustDeclare === undefined ? '' : `（需含 ${mustDeclare} 声明）`}`,
    )
  }
  if (hits.length > 1) {
    throw new Error(`${selector} 命中 ${hits.length} 条规则，判据定位不唯一（先收窄再判）`)
  }
  return first
}

/** 从规则体里取某声明的值（`border` 简写这种含空格的值也能取全）。 */
function declaration(body: string, property: string): string | undefined {
  return new RegExp(`(?:^|;)\\s*${property}\\s*:\\s*([^;]+)`, 'i').exec(body)?.[1]?.trim()
}

/** 颜色相关属性清单：登记了期望 token 的规则里，这些属性逐条判。 */
const COLOR_PROPERTIES = ['color', 'background', 'background-color', 'border', 'border-color']

/**
 * 裸色值形态（评审 B-2b）：`#rgb`/`#rrggbb`、`rgb()/rgba()/hsl()/hsla()`（`color-mix()` 里
 * 也含 `rgb` 字面量时会被一并抓住）、CSS 具名色。
 *
 * 为什么用"裸色值扫描"而不是"按属性名逐个判"：后者只覆盖点名的几个属性，
 * `outline: 2px solid #ff0000`、`box-shadow: 0 0 0 2px red` 这类**同族写法**会静默逃逸
 * （评审实测全绿）。所以现在是"整条规则体里不许出现裸色值"，属性名只用来决定
 * **要不要额外钉 token**。
 */
const RAW_COLOR_VALUE =
  /#[0-9a-f]{3,8}\b|\b(?:rgba?|hsla?)\(|(?<![\w-])(?:red|blue|green|black|white|gray|grey|orange|purple|yellow|pink|brown|cyan|magenta)(?![\w-])/i

/**
 * 只承载几何/布局的属性：它们不该出现颜色，但会在值里出现合法关键字
 * （例如 `solid`）。命中这些属性名时**跳过裸色值扫描**，改由 A 组判据钉住形状值本身。
 */
/**
 * 期望值哨兵：允许某个属性用**裸值**，但必须显式登记具体值（评审认可的那种）。
 *
 * 为什么需要它：整体规则是"颜色只走 `var(--dsw-*)`"，而顶栏 hover 那一条是全仓少见的
 * 裸 `rgba()`（L1 没有"深色容器上的 hover 叠加"这一档）。放行它的方式是**把这个值写进
 * 期望表**，而不是给一个属性名开洞——后者会让"换个裸值"也通过。
 */
const EXPECT_RAW_VALUE = 'raw:'

/**
 * 期望值哨兵：允许某个属性引用**应用层 token**（`--color-*`），必须显式写出变量名与理由。
 *
 * 为什么需要它：#159 的深色容器前景族就是应用层机制（顶栏给出 `--color-signal-soft`），
 * 把整个应用层颜色一律禁掉会逼着后人改成裸值或改 L1——两条都更糟。放行的方式同样是
 * **把变量名写进期望表**，所以"换成另一个 `--color-*`"仍会红。
 */
const EXPECT_APP_TOKEN = 'app:'

const SHAPE_ONLY_PROPERTIES = new Set([
  'display',
  'align-items',
  'justify-content',
  'min-height',
  'padding',
  'padding-inline',
  'padding-block',
  'width',
  'height',
  'border-radius',
  'border-width',
  'border-style',
  'cursor',
  'position',
  'flex',
  'gap',
])

/** 解析规则体里的所有声明（属性名小写）。 */
function declarationsOf(body: string): Array<{ property: string; value: string }> {
  return [...body.matchAll(/(?:^|;)\s*([a-z-]+)\s*:\s*([^;]+)/gi)].map((match) => ({
    property: (match[1] ?? '').toLowerCase(),
    value: (match[2] ?? '').trim(),
  }))
}

/**
 * 按「规则 + 属性」改一处声明值——变异验证专用（吃**去注释**后的文本）。
 *
 * 为什么不用 `css.replace('原文片段', '改后片段')`：那种写法一旦注释/空白漂一格就**静默
 * 不生效**，变异测试随后"绿着通过"，比没有这条用例更糟（它假装验过）。这里定位不到就抛，
 * 调用方还会断言文本真的变了。
 */
function setDeclaration(
  rule: { selector: string; mustDeclare?: string },
  property: string,
  value: string,
): string {
  if (globalPlain.includes('/*')) throw new Error('setDeclaration 只吃去注释后的 CSS 文本')
  const { body, bodyStart, bodyEnd } = findRule(globalRules, rule.selector, rule.mustDeclare)
  const next = body.replace(new RegExp(`((?:^|;)\\s*${property}\\s*:\\s*)[^;]+`, 'i'), `$1${value}`)
  if (next === body) throw new Error(`变异定位失败：${rule.selector} 没有 ${property} 声明`)
  const mutated = globalPlain.slice(0, bodyStart) + next + globalPlain.slice(bodyEnd)
  // 自检：改写只能替换值，不许动花括号个数——扫描器按记账定位，配平被破坏会让后续规则全部
  // 错位（报错会伪装成"某条规则找不到"，误导排查方向）。
  const braces = (text: string): number => (text.match(/[{}]/g) ?? []).length
  if (braces(mutated) !== braces(globalPlain)) {
    throw new Error(`变异破坏了花括号配平：${rule.selector} 的 ${property}`)
  }
  return mutated
}

/**
 * 变体沿哪条基类继承（用于把源码侧的探针凑成**浏览器里会算出来的那一组值**；
 * 链可以有多跳，见 `cascadedBody`）。
 *
 * 为什么需要它：`checkControlTokens` 是给**真实控件**用的判据，探针里三项颜色都必须有值
 * （浏览器里它们一定都被解析出来了）。变体规则自己只声明改动的那几项（例如 `.button:hover`
 * 只声明 `background` 与 `border-color`），所以这里按层叠把基类的声明补上——
 * 补的是"浏览器会怎么算"，不是"期望值"，装错照样会红。
 */
const BASE_OF: Record<string, string> = {
  '.button:hover:not(:disabled)': '.button',
  '.button:disabled': '.button',
  '.button:focus-visible': '.button',
  '.button-primary': '.button',
  '.button-primary:hover:not(:disabled)': '.button-primary',
  '.button-quiet': '.button',
  '.button-quiet:hover:not(:disabled)': '.button-quiet',
  '.app-header .button-quiet:hover:not(:disabled)': '.button-quiet:hover:not(:disabled)',
  '.app-header-user .button': '.button',
  '.button-danger': '.button',
}

/**
 * 把继承链上的声明并进规则体（近者优先），模拟**浏览器会算出来的那一组值**。
 *
 * 为什么要走**整条链**而不是一跳：`.button-primary` 自己不声明 `min-height`/`cursor`，
 * 它们来自 `.button`；而 `.button-primary:hover` 又只声明两个属性。一跳就把链截断了
 * （实测踩到：`.button-primary:hover` 的探针里取不到 `min-height`，报"规则体里没有声明"）。
 */
function cascadedBody(
  scanned: CssRule[],
  selector: string,
  mustDeclare?: string,
  seen = new Set<string>(),
): string {
  if (seen.has(selector)) throw new Error(`BASE_OF 出现环：${selector}`)
  seen.add(selector)
  // 子规则要按 mustDeclare 收窄（`.field textarea` 有两条）；基类规则本身唯一，不必收窄
  // （而且变体常常不声明那条属性，收窄会反而找不到）。
  const own = findRule(scanned, selector, mustDeclare).body
  const base = BASE_OF[selector]
  if (base === undefined) return own
  const inherited = cascadedBody(scanned, base, undefined, seen)
  const declaredHere = new Set(
    [...own.matchAll(/(?:^|;)\s*([a-z-]+)\s*:/gi)].map((match) => match[1] ?? ''),
  )
  const fromBase = inherited
    .split(';')
    .filter((piece) => {
      const property = /^\s*([a-z-]+)\s*:/i.exec(piece)?.[1]
      return property !== undefined && !declaredHere.has(property)
    })
    .join(';')
  return `${own};${fromBase}`
}

// ---------- 期望表 ----------

/**
 * 基类控件：描边必须**逐值等于 vendored `Input` 的 `border` 简写**（期望值由
 * `parseVendorInputMetrics` 拼出，本文件里没有 `0.5px`、`8px` 这类字面量）。
 */
const vendorBorder = `${vendor.borderWidth} ${vendor.borderStyle} var(${CONTROL_BORDER_TOKEN})`

interface ExpectedRule {
  selector: string
  /** 定位用：规则体里必须含这条声明（`.field textarea` 在别处还有一条 `resize` 规则） */
  mustDeclare: string
  /**
   * 期望的 `border` 简写。`undefined` = 这条规则**不该声明**描边（变体靠 `.button` 继承），
   * 那就断言它确实没声明——比"不判"严：谁在这里复制一份描边就会被抓出来。
   */
  border?: string
  /** 期望的 `border-radius`。语义同 `border`。 */
  radius?: string
  /**
   * 逐属性的期望 token。`null` = **这条规则不许声明这个属性**（比"没登记"更严：
   * 未登记只是"漏登记"，`null` 是"这条规则上就是禁止"）。
   */
  colors: Record<string, string | null>
  /**
   * 豁免"度量必须等于 vendored Input"与"颜色必须登记"的**具体属性**（都要在本文件里
   * 写明为什么）。用途只有一个：`:focus-visible` 这种**全局可访问性**规则——
   * 它对所有元素生效，不是"控件族的新写法"，不该被控件族的度量绑架。
   */
  exempt?: readonly string[]
}

const rules: ExpectedRule[] = [
  {
    selector: '.field input',
    mustDeclare: 'border',
    border: vendorBorder,
    radius: vendor.radius,
    colors: {
      background: CONTROL_BACKGROUND_TOKEN,
      border: CONTROL_BORDER_TOKEN,
      color: CONTROL_LABEL_TOKEN,
    },
  },
  {
    selector: '.field textarea',
    mustDeclare: 'border',
    border: vendorBorder,
    radius: vendor.radius,
    colors: {
      background: CONTROL_BACKGROUND_TOKEN,
      border: CONTROL_BORDER_TOKEN,
      color: CONTROL_LABEL_TOKEN,
    },
  },
  {
    selector: '.button',
    mustDeclare: 'border',
    border: vendorBorder,
    radius: vendor.radius,
    colors: {
      background: CONTROL_BACKGROUND_TOKEN,
      border: CONTROL_BORDER_TOKEN,
      color: CONTROL_LABEL_TOKEN,
    },
  },
  // ---- 交互变体（评审 S3：hover / disabled / focus-visible 早先完全在判据之外） ----
  {
    // 变体**不声明**描边宽度/圆角（靠 `.button` 继承）——所以这里不填 border/radius，
    // 断言就会要求它确实没声明：谁在变体里复制一份度量会被抓出来（下一个漂移点）。
    selector: '.button:hover:not(:disabled)',
    mustDeclare: 'background',
    colors: {
      background: CONTROL_HOVER_BACKGROUND_TOKEN,
      'border-color': CONTROL_HOVER_BORDER_TOKEN,
    },
  },
  {
    // :disabled 只改透明度与光标（不声明任何颜色属性）——仍纳入扫描，这样"往后往里加一条
    // `color: #123456`"会被"声明了未登记的属性"那条判据挡下。
    selector: '.button:disabled',
    mustDeclare: 'opacity',
    colors: {},
  },
  {
    // 通用焦点规则里也有 `.button`（`*:focus-visible`），不登记的话"往通用焦点里加颜色"
    // 会绕过全部判据——它是无条件生效的，比单条控件规则更危险。
    selector: ':focus-visible',
    mustDeclare: 'box-shadow',
    // 豁免圆角：这条是**全局可访问性规则**（对所有元素生效），它的 `border-radius`
    // 只是给"本来没有圆角的元素"一个协调的形状；控件自己声明了 8px，box-shadow 跟随
    // 元素自身圆角，所以对这三族**无实际影响**（#164 的 focus-ring 门另有覆盖）。
    exempt: ['border-radius'],
    colors: { 'box-shadow': `${EXPECT_RAW_VALUE}var(--focus-ring)` },
  },
  {
    selector: '.button:focus-visible',
    mustDeclare: 'border-color',
    colors: { 'border-color': '--dsw-alias-brand-primary' },
  },
  {
    selector: '.button-primary',
    mustDeclare: 'background',
    border: vendorBorder,
    radius: vendor.radius,
    colors: {
      background: CONTROL_PRIMARY_FILL_TOKEN,
      border: CONTROL_BORDER_TOKEN,
      color: CONTROL_PRIMARY_LABEL_TOKEN,
    },
  },
  {
    selector: '.button-primary:hover:not(:disabled)',
    mustDeclare: 'background',
    colors: {
      background: CONTROL_PRIMARY_HOVER_TOKEN,
      'border-color': CONTROL_BORDER_TOKEN,
    },
  },
  {
    selector: '.button-quiet',
    mustDeclare: 'border',
    // 无边形态：**宽度仍必须跟 vendored 同步**（`0.5px` 不写死——vendor 改 0.25px 时这里要红）
    border: `${vendor.borderWidth} ${vendor.borderStyle} transparent`,
    radius: vendor.radius,
    // 只有这条的 `color` **不钉 token 名**：`.app-header .button-quiet` 是 #159 加的
    // 深色容器前景覆盖（`--color-signal-soft`，blue-100 压 ink 实测 15.49:1），
    // 那是另一层机制、另一个判据（Q5 的对比度扫描器）的地盘。
    // 这里仍然钉住"不是应用层 token、不是裸色值"，只放开 token 名（详细理由见 rules 表后的注释）。
    colors: { background: 'transparent', border: 'transparent' },
  },
  {
    selector: '.button-quiet:hover:not(:disabled)',
    mustDeclare: 'background',
    colors: { background: CONTROL_HOVER_BACKGROUND_TOKEN, 'border-color': 'transparent' },
  },
  {
    // 产品决定（评审）：#159 那条 `border-color` 删掉后，顶栏「退出登录」在浅色主题下
    // 失去了可见的 hover 反馈（通用 hover 面 `rgba(38,49,72,0.06)` 压在顶栏上只差 1/255）。
    // 所以补一条**面**变，并在这里钉住——免得它下一轮又被顺手删掉。
    selector: '.app-header .button-quiet:hover:not(:disabled)',
    mustDeclare: 'background',
    colors: {
      // 这一条刻意写**裸 rgba**：L1 没有"深色容器上的 hover 叠加"这一档，理由与实测数字
      // 写在 global.css 该规则处（评审已认可这个量）。用哨兵把**具体值**登记进来——
      // 改小到看不见、或换成别的裸色，都会红。
      background: `${EXPECT_RAW_VALUE}rgba(255, 255, 255, 0.08)`,
    },
  },
  {
    // #159 的深色容器前景族（blue-100 压 ink 15.49:1）。登记它的目的是让守卫能覆盖
    // "往这个容器规则里加东西"：`border-color` 显式登记为 `null`——那是 #159 原先写在
    // `:hover` 上、被本 PR 删掉的那条（无边形态不该被容器点出描边）。谁再加回来就会红。
    selector: '.app-header .button-quiet',
    mustDeclare: 'color',
    colors: { color: `${EXPECT_APP_TOKEN}--color-signal-soft`, 'border-color': null },
  },
  {
    // 下面两条是**形状限定**规则（顶栏退出按钮的布局 / 页头用户的按钮不参与收缩）：
    // 登记进来是为了让选择器守卫能覆盖它们——`colors: {}` 的含义是"这里不许出现任何颜色，
    // 出现即红（未登记）"。不登记的话，"往 `.app-header-user .button` 里加一条 color"
    // 会绕过全部判据（评审 B-2a 的同类逃逸）。
    selector: '.app-header-user .button',
    mustDeclare: 'flex',
    colors: {},
  },
  {
    selector: '.button-danger',
    mustDeclare: 'border',
    border: vendorBorder,
    radius: vendor.radius,
    colors: {
      background: CONTROL_DANGER_FILL_TOKEN,
      border: CONTROL_BORDER_TOKEN,
      color: CONTROL_DANGER_LABEL_TOKEN,
    },
  },
]

/**
 * `.button-quiet` 的 `color` 为什么**没有**登记期望 token 名（其余属性都登记了）：
 *
 * - 本仓存在 `--dsw-alias-brand-primary`（近黑）与 #159 的深色容器覆盖
 *   `.app-header .button-quiet { color: var(--color-signal-soft) }`；
 * - 容器级覆盖是**另一层机制**（"深色容器给前景族"），它的判据是对比度门
 *   （`apps/web/tests/e2e/contrast-sweep.ts` 在真实浏览器里量），不是这一条；
 * - 所以这里只要求"非应用层 token、非裸色值"——**能挡住"往 quiet 里塞 `#123456` 或
 *   `--color-signal`"**，挡不住"在两个 L1 token 之间换"（那种换色由对比度门管）。
 *
 * 这条边界写在这里而不是省略：**放开一个检查必须写明放到哪去了**，否则下一个人
 * 会以为这里漏了。
 */

// ---------- 颜色判据 ----------

/**
 * 一条颜色声明的值必须是**单一 L1 token 引用**（裸色值 / color-mix / 应用层 token 都不算），
 * 且当调用方登记了期望 token 时必须就是那一个。
 *
 * `border` 是简写（`0.5px solid var(--x)`），先把宽度/样式剥掉再判颜色项；颜色位写
 * `transparent` 的自绘无边形态放行（那是"没有颜色"，且期望表里显式登记了 `transparent`）。
 */
function checkColor(
  failures: string[],
  selector: string,
  property: string,
  value: string,
  expected: string | undefined,
): void {
  const used = ((): string => {
    if (property !== 'border') {
      if (value.trim() === 'transparent') return 'transparent'
      const ref = /^var\(\s*(--[\w-]+)\s*\)$/.exec(value.trim())
      const token = ref?.[1]
      if (token === undefined) {
        failures.push(
          `${selector} 的 ${property} 不是单一 L1 token 引用：\`${value}\`（裸色值 / color-mix / 应用层 token 都不算）`,
        )
        return ''
      }
      return token
    }
    const shorthand = /^([\d.]+(?:px|rem|em))\s+(\w+)\s+(.+)$/.exec(value.trim())
    const color = shorthand?.[3]
    if (color === undefined) {
      failures.push(
        `${selector} 的 border 形态不是「宽度 样式 颜色」：\`${value}\`（颜色那一项必须是 var(--dsw-*)）`,
      )
      return ''
    }
    if (color === 'transparent') return 'transparent'
    const ref = /^var\(\s*(--[\w-]+)\s*\)$/.exec(color)
    const token = ref?.[1]
    if (token === undefined) {
      failures.push(`${selector} 的 border 颜色不是单一 L1 token 引用：\`${color}\``)
      return ''
    }
    return token
  })()
  if (used === '' || used === 'transparent') return
  if (!used.startsWith('--dsw-')) {
    failures.push(`${selector} 的 ${property} 引用了非 L1 变量 ${used}（约定只吃 --dsw-*）`)
    return
  }
  if (expected !== undefined && used !== expected) {
    failures.push(`${selector} 的 ${property} 引用了 ${used}，约定应是 ${expected}`)
    return
  }
  // 定义判定要**锚定前缀**：裸查 `(--dsw-x)\s*:` 会把 `--dsw-x-hover:` 也当成 `--dsw-x` 的
  // 定义（子串匹配的经典坑，#138 切片实测踩过）。
  if (!new RegExp(`(?:^|[;{\\s])${used}\\s*:`).test(l1Plain)) {
    failures.push(`${selector} 的 ${property} 引用的 ${used} 在 L1 白名单里没有定义`)
  }
}

/** 取某 token 的**源码声明值**（递归解 var() 链）。颜色在 L1，`--touch-min` 在 tokens.css。 */
function tokenValue(name: string): string {
  for (const css of [l1Plain, appTokensPlain]) {
    const root = scanRules(css).find((rule) => rule.selectors.includes(':root'))
    const value = root === undefined ? undefined : declaration(root.body, name)
    if (value !== undefined) {
      const ref = /^var\(\s*(--[\w-]+)\s*\)$/.exec(value)
      return ref?.[1] === undefined ? value : tokenValue(ref[1])
    }
  }
  throw new Error(`两处 :root 都找不到 token：${name}`)
}

// ---------- 判据主体 ----------

/**
 * 对一份 `global.css` 文本跑完 A/B/C 三组判据。
 *
 * 抽成函数是为了让反向用例能拿**改坏的 CSS 文本**跑同一条路径——否则反向用例只是在验
 * 判定函数，证明不了正向用例真的会红。
 */
function assertControlFamily(cssText: string): void {
  const scanned = scanRules(stripComments(cssText))
  const failures: string[] = []

  for (const expected of rules) {
    // 定位不到 / 命中多条都会抛：`@media` 里复制一份同名规则时必须红，而不是"取第一条"。
    const rule = findRule(scanned, expected.selector, expected.mustDeclare)
    // A. 描边与圆角逐值等于 vendored Input 的度量（期望值从那边现场读）；
    //    变体没登记期望值时，要求它**确实没声明**（继承基类），不许自己复制一份度量。
    const border = declaration(rule.body, 'border')
    if (expected.border === undefined) {
      if (border !== undefined) {
        failures.push(
          `${expected.selector} 不该声明描边（应继承 .button 的 \`${vendorBorder}\`），实测 \`${border}\``,
        )
      }
    } else if (border !== expected.border) {
      failures.push(
        `${expected.selector} 的描边是 \`${border ?? '（未声明）'}\`，应为 \`${expected.border}\``,
      )
    }
    const radius = declaration(rule.body, 'border-radius')
    if (expected.exempt?.includes('border-radius')) {
      // 显式豁免（理由写在期望表该条上）：不判圆角度量
    } else if (expected.radius === undefined) {
      if (radius !== undefined) {
        failures.push(
          `${expected.selector} 不该声明圆角（应继承 .button 的 ${vendor.radius}），实测 ${radius}`,
        )
      }
    } else if (radius !== expected.radius) {
      failures.push(
        `${expected.selector} 的圆角应与 vendored Input 同值（${expected.radius}），实测 ${radius ?? '（未声明）'}`,
      )
    }
    // B1（评审 B-2b）：**整条规则体**里不许出现裸色值 / 应用层变量——不再只看
    // COLOR_PROPERTIES 那几个属性名，否则 `outline: 2px solid #ff0000` 这类同族写法会逃逸。
    for (const { property, value } of declarationsOf(rule.body)) {
      if (SHAPE_ONLY_PROPERTIES.has(property)) continue
      // 显式登记过的裸值放行（期望表里写的是 `raw:<原值>`）；未登记的裸值一律红。
      if (expected.colors[property] === `${EXPECT_RAW_VALUE}${value}`) continue
      const raw = RAW_COLOR_VALUE.exec(value)?.[0]
      if (raw !== undefined) {
        failures.push(
          `${expected.selector} 的 ${property} 里有裸色值 \`${raw}\`：颜色必须走 var(--dsw-*)（整条规则体都在判据内，不是只查颜色属性名）`,
        )
      }
      const appVar = /--color-[\w-]+/.exec(value)?.[0]
      if (appVar !== undefined && expected.colors[property] !== `${EXPECT_APP_TOKEN}${appVar}`) {
        failures.push(`${expected.selector} 的 ${property} 引用了应用层变量 ${appVar}`)
      }
    }
    // B2：登记了期望 token 的颜色属性逐条判。
    for (const property of COLOR_PROPERTIES) {
      const value = declaration(rule.body, property)
      if (value === undefined) continue
      if (expected.exempt?.includes(property)) continue
      const expectedToken = expected.colors[property]
      if (expectedToken === null) {
        failures.push(
          `${expected.selector} 不该声明 ${property}（期望表里登记为 null），实测 \`${value}\``,
        )
        continue
      }
      if (expectedToken === undefined) {
        // 豁免：`.button-quiet` 的 color（理由见上方注释）。其余规则上未登记的颜色仍然报红。
        if (expected.selector === '.button-quiet' && property === 'color') {
          checkColor(failures, expected.selector, property, value, undefined)
          continue
        }
        failures.push(
          `${expected.selector} 声明了未登记的 ${property}: \`${value}\`——要么登记进期望表（连同期望 token），要么去掉`,
        )
        continue
      }
      if (expectedToken === 'transparent') {
        if (!/(^|\s)transparent$/.test(value.trim())) {
          failures.push(`${expected.selector} 的 ${property} 应为 transparent，实测 \`${value}\``)
        }
        continue
      }
      // 显式登记的应用层 token（`app:<变量名>`）：必须逐字相等
      if (expectedToken.startsWith(EXPECT_APP_TOKEN)) {
        const wanted = expectedToken.slice(EXPECT_APP_TOKEN.length)
        if (value.trim() !== `var(${wanted})`) {
          failures.push(
            `${expected.selector} 的 ${property} 是 \`${value}\`，登记的是应用层 token \`var(${wanted})\``,
          )
        }
        continue
      }
      // 显式登记的裸值（`raw:<原值>`）：必须逐字相等，且**不进**"只吃 L1"那条分支
      // （否则同一个值既被放行又被判为"非 L1"）。换任何别的裸值都会红。
      if (expectedToken.startsWith(EXPECT_RAW_VALUE)) {
        const wanted = expectedToken.slice(EXPECT_RAW_VALUE.length)
        if (value !== wanted) {
          failures.push(
            `${expected.selector} 的 ${property} 是 \`${value}\`，登记的是裸值 \`${wanted}\`（只许这一处裸值，且逐字相等）`,
          )
        }
        continue
      }
      checkColor(failures, expected.selector, property, value, expectedToken)
    }
    // 反向钉：不许残留应用层 `--color-*` 变量名（显式登记的应用层 token 除外）。
    const declaredAppTokens = Object.values(expected.colors).filter(
      (token): token is string => typeof token === 'string' && token.startsWith(EXPECT_APP_TOKEN),
    )
    const leftovers = [...rule.body.matchAll(/--color-[\w-]+/g)]
      .map((match) => match[0])
      .filter((token) => !declaredAppTokens.includes(`${EXPECT_APP_TOKEN}${token}`))
    if (leftovers.length > 0) {
      failures.push(`${expected.selector} 里残留应用层变量 ${[...new Set(leftovers)].join('、')}`)
    }
  }

  // D. 选择器守卫（评审 B-2a）：**任何命中同一批元素**的规则都必须登记进期望表，
  //    否则"新加一条 `.field input:focus-visible { border-color: … }`"会静默逃逸
  //    （实测全绿：`*:focus-visible` 不在选择器白名单里，判据根本不看它）。
  //
  //    判据是"选择器组里出现基类选择器"，所以 `.field > input` 这种与 `.field input`
  //    命中同一批元素的等价写法也算命中。**必须跑在期望表循环之后**：早期版本写在循环里，
  //    用的是"已遍历到的那几条"，新规则一看"不在已遍历集合里"就被当成已登记而放行。
  //
  //    登记形式统一为 `.selector + mustDeclare`（例如 `*:focus-visible|border-color`）。
  const guardedBases = ['.field input', '.field textarea', '.button']
  const registeredSelectors = new Set(rules.map((entry) => entry.selector))
  for (const rule of scanned) {
    for (const group of rule.selectors) {
      // 切词要切掉伪类/伪元素/属性选择器：`.field input:focus-visible` 必须还原出
      // `.field input` 这一对（否则"新加一条带伪类的规则"仍然逃逸——实测踩到过）。
      // 先把伪类/伪元素（`:…`）与属性选择器（`[…]`）整段换成空格，再按组合子/后代切开：
      // `.field input:focus-visible` → `.field input`、`.field > input` → `.field input`。
      // 用"在 `:` 前切"的写法实测会切出 `:focus-visible` 这个片段而漏掉整对（踩过）。
      const hit = guardedBases.find((base) =>
        group
          .replaceAll(/::?[\w-]+(?:\([^)]*\))?|\[[^\]]*\]/g, ' ')
          .split(/[\s>+~]+/)
          .filter((piece) => piece !== '')
          .join(' ')
          .includes(base),
      )
      if (hit === undefined || registeredSelectors.has(group)) continue
      failures.push(
        `${group} 命中了控件族元素（${hit}）却不在期望表里：新增/改名的控件规则必须登记（连同它的期望 token 与必须声明的属性），否则它会绕过全部判据`,
      )
    }
  }

  // C. 高度：与 --touch-min 同值且不低于触屏下限。
  for (const selector of ['.field input', '.field textarea', '.button']) {
    const minHeight = declaration(findRule(scanned, selector, 'border').body, 'min-height')
    if (minHeight !== `var(${CONTROL_TOUCH_TOKEN})`) {
      failures.push(
        `${selector} 的 min-height 是 \`${minHeight ?? '（未声明）'}\`，应交给 var(${CONTROL_TOUCH_TOKEN})——高度轴不放开到 vendored Input 的 32px`,
      )
    }
  }
  const touchMin = Number.parseFloat(tokenValue(CONTROL_TOUCH_TOKEN))
  if (!(touchMin >= TOUCH_MIN_PX)) {
    failures.push(
      `L1 ${CONTROL_TOUCH_TOKEN}=${tokenValue(CONTROL_TOUCH_TOKEN)} 低于触屏下限 ${TOUCH_MIN_PX}px`,
    )
  }

  if (failures.length > 0) {
    throw new Error(`#168 控件族判据未过（${failures.length} 条）：\n- ${failures.join('\n- ')}`)
  }
}

/**
 * 把静态 CSS 的声明装成**浏览器侧探针**（与 Q5 采回来的结构完全一致），用同一份
 * `checkControlTokens` 判一遍——两侧共用判定函数本身也是被验的对象。
 *
 * **每一个字段都必须来自与它对照的那一侧不同的来源**，否则这条对照就是自己跟自己比
 * （评审 B-1 实测：早先 `minHeight` 与 `resolved.touch` 都是 `tokenValue('--touch-min')`、
 * `referenceBorderWidth/Radius` 就是 `borderWidth/radius` 自身 → 那次调用**恒真**，
 * 只有"`--touch-min ≥ 40px`"这条地板是平凡的）。所以现在：
 *
 * | 探针字段 | 来源 | 对照对象 | 来源 |
 * |---|---|---|---|
 * | `background` / `borderColor` / `color` | **规则体的声明**（经 var() 指向的 token 解析） | `resolved.*` | 该 token 在 L1/应用层 `:root` 里的**声明值** |
 * | `borderWidth` / `radius` | **控件规则体**的声明 | `reference*` | **vendored `Input.module.css`** 解出的度量 |
 * | `minHeight` | **规则体的 `min-height` 声明** | `resolved.touch` | `tokens.css` 里 `--touch-min` 的声明值 |
 *
 * 源码侧与浏览器侧的差别只在一处（都写在注释里）：浏览器里 `0.5px` 会算成 `1px`，
 * 所以浏览器侧拿**参照元素的实测值**比（元素对元素）；源码侧比的是两处**声明值**。
 */
function probeFromSource(scanned: CssRule[], selector: string, mustDeclare?: string): ControlProbe {
  const body = cascadedBody(scanned, selector, mustDeclare)
  const borderValue = (declaration(body, 'border') ?? '').replaceAll(/\s+/g, ' ').trim()
  // 取值可能是 `var(--token)`（→ 先解出 token 名再解析），也可能是**显式登记的裸值**
  // （顶栏 hover 那条 `rgba(...)`，见 `EXPECT_RAW_VALUE`）。裸值原样传下去，
  // 与"对照侧"的 token 解析值不同就会红——不会因为它"不是 token"而在这里抛错。
  const colorToken = (property: string): string => {
    const value = declaration(body, property) ?? ''
    if (value.trim() === 'transparent') return 'transparent'
    const ref = /var\(\s*(--[\w-]+)\s*\)/.exec(value)
    return ref?.[1] ?? value.trim()
  }
  const resolve = (token: string): string => {
    if (token === 'transparent') return 'rgba(0, 0, 0, 0)'
    return token.startsWith('--') ? tokenValue(token) : token
  }
  // 颜色项可能是 `border-color/mix`（`.button-danger` 的 3.19:1）——这里只做"装进探针"，
  // 真正的形态判据在 checkColor 里。
  const borderToken = /var\(\s*(--[\w-]+)\s*\)/.exec(borderValue)?.[1]
  const background = colorToken('background')
  const borderColor = borderValue.endsWith('transparent')
    ? 'transparent'
    : (borderToken ?? colorToken('border-color'))
  const label = colorToken('color')
  const width = borderValue.split(/\s+/)[0] ?? ''
  const radius = declaration(body, 'border-radius') ?? ''
  // `min-height` 从**规则体的声明**解出来（不是把 token 值填进去），与 `resolved.touch`
  // 形成两条独立来源的对照。声明缺失时报错而不是静默取空串。
  // 声明原文是 `var(--touch-min)`、浏览器算出来是 `40px`——所以要在**这里**把声明里的
  // var() 解成解析值（与浏览器 computed style 的形态一致），而不是把 `resolved.touch`
  // 反向填进 `minHeight`（那就是原先那个自比）。
  const minHeightRaw = declaration(body, 'min-height')
  if (minHeightRaw === undefined) {
    throw new Error(`${selector} 的规则体里没有 min-height 声明（探针无法与 --touch-min 对照）`)
  }
  const minHeight = minHeightRaw.replaceAll(/var\(\s*(--[\w-]+)\s*\)/g, (_match, token: string) =>
    tokenValue(token),
  )
  return {
    background: resolve(background),
    borderColor: resolve(borderColor),
    borderWidth: width,
    radius,
    color: resolve(label),
    minHeight,
    // 参照值取 **vendored** 度量（另一份 CSS 的另一条规则），不是把控件自己的值抄一遍。
    referenceBorderWidth: vendor.borderWidth,
    referenceRadius: vendor.radius,
    resolved: {
      background: resolve(background),
      border: resolve(borderColor),
      label: resolve(label),
      touch: tokenValue(CONTROL_TOUCH_TOKEN),
    },
  }
}

const checkerExpect = {
  backgroundToken: CONTROL_BACKGROUND_TOKEN,
  borderToken: CONTROL_BORDER_TOKEN,
  labelToken: CONTROL_LABEL_TOKEN,
  minTouchPx: TOUCH_MIN_PX,
}

describe('#168 自研控件对齐 DSH 族（源码文本判据）', () => {
  it('度量来源：vendored Input 的描边/圆角被读到（上游形态变了不能静默失效）', () => {
    // 这条不是凑数：解析器抛错会立刻红，但"解析出来是空串"不会——空串会让后面所有
    // "逐值相等"退化成"两边都空"的假绿。
    expect(vendor.borderWidth).toMatch(/^[\d.]+px$/)
    expect(vendor.borderStyle).toBe('solid')
    expect(vendor.borderToken).toBe(CONTROL_BORDER_TOKEN)
    expect(vendor.radius).toMatch(/^\d+px$/)
    expect(tokenValue(CONTROL_BACKGROUND_TOKEN)).not.toBe('')
    expect(TOUCH_MIN_PX).toBe(40)
  })

  it('A+B+C：描边/圆角逐值等于 vendored Input，颜色只吃登记的 L1 token，高度 = --touch-min', () => {
    assertControlFamily(globalCss)
    // 顺带把两侧共用的判定函数跑一遍（Q5 的 assertControlTokens 用的就是它）。
    // 注意这里**不是**恒真（评审 B-1 实测过它曾恒真，所以每条对照的来源都写在
    // `probeFromSource` 的注释里）：控件侧的值来自规则体声明，对照侧分别来自 L1 的
    // token 声明与 vendored `Input.module.css`——三处不同来源，改坏任一处就会红。
    for (const expected of rules) {
      // 只对"控件族规则"跑浏览器侧探针：`:focus-visible` 是全局可访问性规则，
      // 它没有控件的高度/底/字那一组语义，硬跑只会得到"缺 min-height"的噪音失败。
      if (!BASE_OF[expected.selector] && !expected.selector.startsWith('.field ')) continue
      const probe = probeFromSource(globalRules, expected.selector, expected.mustDeclare)
      expect(
        checkControlTokens(probe, checkerExpect, expected.selector),
        `${expected.selector} 的探针与对照：${JSON.stringify({
          minHeight: probe.minHeight,
          touch: probe.resolved.touch,
          borderWidth: probe.borderWidth,
          referenceBorderWidth: probe.referenceBorderWidth,
          radius: probe.radius,
          referenceRadius: probe.referenceRadius,
        })}`,
      ).toEqual([])
    }
  })

  it('判定函数不是恒真：五类问题各自被造出来时都必须挑出问题', () => {
    const base = probeFromSource(globalRules, '.field input', 'border')
    expect(checkControlTokens(base, checkerExpect, '.field input')).toEqual([])
    // ① 背景值被改坏（token 名不变）——"只比最终值"能抓住的那类漂移
    expect(
      checkControlTokens(
        { ...base, background: 'rgb(1, 2, 3)' },
        checkerExpect,
        '.field input',
      ).join('\n'),
    ).toContain('背景取值')
    // ② 描边宽度与同浏览器参照不一致（0.5px→1px 的取整由参照吸收，这里造真实分歧）
    expect(
      checkControlTokens(
        { ...base, borderWidth: '2px', referenceBorderWidth: '1px' },
        checkerExpect,
        '.field input',
      ).join('\n'),
    ).toContain('描边宽度')
    // ③ 圆角与参照不一致
    expect(
      checkControlTokens(
        { ...base, radius: '6px', referenceRadius: '8px' },
        checkerExpect,
        '.field input',
      ).join('\n'),
    ).toContain('圆角')
    // ④ token 解析不出来（元素与祖先都取到空串）必须报"未解析"，不能静默通过
    expect(
      checkControlTokens(
        { ...base, resolved: { ...base.resolved, background: '' } },
        checkerExpect,
        '.field input',
      ).join('\n'),
    ).toContain('未解析')
    // ⑤ 高度降到 vendored Input 的 32px：与 token 不同值 + 低于触屏下限各报一条
    const lowered = { ...base, minHeight: '32px' }
    expect(checkControlTokens(lowered, checkerExpect, '.field input').join('\n')).toContain(
      '不同值',
    )
    expect(
      checkControlTokens(
        { ...lowered, resolved: { ...base.resolved, touch: '32px' } },
        checkerExpect,
        '.field input',
      ).join('\n'),
    ).toContain('小于触屏下限')
  })

  it('resolveTokenValue：沿继承链解 var() 链，且认最近的重绑', () => {
    const style = (values: Record<string, string>): ComputedStyleLike => ({
      getPropertyValue: (name) => values[name] ?? '',
      backgroundColor: '',
      borderTopColor: '',
      borderTopWidth: '',
      borderTopLeftRadius: '',
      color: '',
      minHeight: '',
    })
    const root = style({
      '--dsw-alias-button-primary-fill': 'var(--dsw-alias-brand-primary)',
      '--dsw-alias-brand-primary': 'rgb(15, 17, 21)',
    })
    const body = style({ '--dsw-alias-brand-primary': 'rgb(249, 250, 251)' })
    // 无重绑：跟两跳拿到 :root 的值
    expect(resolveTokenValue([root], '--dsw-alias-button-primary-fill')).toBe('rgb(15, 17, 21)')
    // 有重绑（深色主题那种形态）：解链按**每个元素自己的**值走，取最近的那个
    expect(resolveTokenValue([body, root], '--dsw-alias-button-primary-fill')).toBe(
      'rgb(249, 250, 251)',
    )
    // 元素没声明就往上找；到处都没有就是空串（判定函数会报"未解析"）
    expect(resolveTokenValue([body, root], '--nobody-declares-this')).toBe('')
    // 循环引用必须抛，不能死循环
    expect(() =>
      resolveTokenValue([style({ '--a': 'var(--b)', '--b': 'var(--a)' })], '--a'),
    ).toThrow(/var\(\) 链/)
  })

  it('BLOCK-2：@media 里偷偷改松这三条控件，判据必须红（不是静默失明）', () => {
    const injected = `${globalPlain}
@media (max-width: 390px) {
  .field input {
    border: 1px solid var(--dsw-alias-border-l4);
    border-radius: 6px;
  }
  .button {
    border: 1px solid var(--dsw-alias-border-l4);
  }
}
`
    // 前提：这条规则真的被扫描到了（早先的实现在这里静默失明：选择器文本里带着
    // `@media (max-width: 390px) { ` 前缀，`.field input` 永远匹配不上 → 全绿通过）
    const mediaSelectors = scanRules(stripComments(injected)).map((rule) =>
      rule.selectors.join(','),
    )
    expect(mediaSelectors).toContain('.field input')
    expect(mediaSelectors).toContain('.button')
    // 一条选择器命中两条规则（顶层 + @media 内）→ 判据必须拒绝"定位不唯一"，而不是取第一条
    expect(() => assertControlFamily(injected)).toThrow(/命中 2 条规则/)
  })

  it('D 变异验证：按规则+属性改坏一处，同一条判据必须红', () => {
    const mutations: Array<{ name: string; css: string; expect: RegExp }> = [
      {
        name: '描边宽度改回旧值 1px',
        css: setDeclaration(
          { selector: '.field input', mustDeclare: 'border' },
          'border',
          `1px ${vendor.borderStyle} var(${CONTROL_BORDER_TOKEN})`,
        ),
        expect: /\.field input 的描边是/,
      },
      {
        name: '圆角改回旧值 6px',
        css: setDeclaration({ selector: '.button', mustDeclare: 'border' }, 'border-radius', '6px'),
        expect: /\.button 的圆角应与 vendored Input 同值（8px），实测 6px/,
      },
      {
        // 换到另一个 L1 描边档。注意 `border-l3` 与 `-l4` **不是同值**（实测 l3=rgba(0,0,0,0.12)、
        // l4=rgba(0,0,0,0.16)，评审 S6 纠正了我原先写错的"同值"）；真正同值的是 `bg-layer-1/-2`
        // （都 rgb(255,255,255)），下面"背景换回应用层 --color-surface"那条才是同值现场。
        name: '描边换成另一个 L1 档 border-l3',
        css: setDeclaration(
          { selector: '.field input', mustDeclare: 'border' },
          'border',
          `${vendor.borderWidth} ${vendor.borderStyle} var(--dsw-alias-border-l3)`,
        ),
        expect: /引用了 --dsw-alias-border-l3，约定应是 --dsw-alias-border-l4/,
      },
      {
        // 同值换 token 的真实现场：`--color-surface` 就是 `--dsw-alias-bg-layer-2`，
        // 浅色下两者都是 rgb(255,255,255)——只比最终值的判据会静默通过。
        name: '输入框背景换回应用层 --color-surface（同值）',
        css: setDeclaration(
          { selector: '.field input', mustDeclare: 'background' },
          'background',
          'var(--color-surface)',
        ),
        expect: /非 L1 变量 --color-surface/,
      },
      {
        name: '高度降到 vendored Input 的 32px',
        css: setDeclaration(
          { selector: '.field input', mustDeclare: 'min-height' },
          'min-height',
          '32px',
        ),
        expect: /的 min-height 是 `32px`/,
      },
      {
        name: '主按钮文字写裸色值 #fff',
        css: setDeclaration({ selector: '.button-primary', mustDeclare: 'color' }, 'color', '#fff'),
        expect: /\.button-primary 的 color 不是单一 L1 token 引用：`#fff`/,
      },
      {
        // S2 复现：主按钮底色换成同色系的另一个 L1 token——"只吃 L1"放行，期望表拦下
        name: '主按钮底色换成 --dsw-alias-brand-primary',
        css: setDeclaration(
          { selector: '.button-primary', mustDeclare: 'background' },
          'background',
          'var(--dsw-alias-brand-primary)',
        ),
        expect: /引用了 --dsw-alias-brand-primary，约定应是 --dsw-alias-button-primary-fill/,
      },
      {
        // S2 复现（后果最重）：危险按钮底色换成错误色 → 红底 + red-900 字实测 3.19:1
        name: '危险按钮底色换成 --dsw-alias-state-error-primary',
        css: setDeclaration(
          { selector: '.button-danger', mustDeclare: 'background' },
          'background',
          'var(--dsw-alias-state-error-primary)',
        ),
        expect: /引用了 --dsw-alias-state-error-primary，约定应是 --dsw-alias-bg-layer-2/,
      },
      {
        name: '危险按钮文字回到别名亮阶 state-error-primary',
        css: setDeclaration(
          { selector: '.button-danger', mustDeclare: 'color' },
          'color',
          'var(--dsw-alias-state-error-primary)',
        ),
        expect: /引用了 --dsw-alias-state-error-primary，约定应是 --dsw-static-red-900/,
      },
      {
        name: '危险按钮描边宽度改回 1px',
        css: setDeclaration(
          { selector: '.button-danger', mustDeclare: 'border' },
          'border',
          `1px solid var(--dsw-alias-border-l4)`,
        ),
        expect: /\.button-danger 的描边是 `1px solid/,
      },
      {
        name: 'quiet 的无边形态被改松（描边换成有色 hairline）',
        css: setDeclaration(
          { selector: '.button-quiet', mustDeclare: 'border' },
          'border',
          `${vendor.borderWidth} solid var(--dsw-alias-border-l4)`,
        ),
        expect: /\.button-quiet 的描边是/,
      },
      {
        // S3 复现：hover 里写应用层变量，早先全绿（hover 根本不在判据里）
        name: 'hover 面换成应用层 --color-signal-soft',
        css: setDeclaration(
          { selector: '.button:hover:not(:disabled)', mustDeclare: 'background' },
          'background',
          'var(--color-signal-soft)',
        ),
        expect:
          /\.button:hover:not\(:disabled\) 的 background 引用了非 L1 变量 --color-signal-soft/,
      },
      {
        // quiet 的 color 不钉 token 名（见 rules 表后的豁免说明），但**裸色值仍要红**：
        // 豁免的是"在两个 L1 token 之间换"，不是"可以写死颜色"。
        name: 'quiet 文字写裸色值（豁免 token 名，不豁免裸值）',
        css: setDeclaration(
          { selector: '.button-quiet', mustDeclare: 'color' },
          'color',
          '#123456',
        ),
        expect: /\.button-quiet 的 color 不是单一 L1 token 引用：`#123456`/,
      },
      {
        // S3 复现：:disabled 里塞裸色值，早先全绿
        name: ':disabled 里塞一条裸色值',
        css: setDeclaration(
          { selector: '.button:disabled', mustDeclare: 'opacity' },
          'opacity',
          '0.55; color: #123456',
        ),
        expect: /\.button:disabled 声明了未登记的 color: `#123456`/,
      },
      {
        name: '焦点描边换成应用层 --color-signal',
        css: setDeclaration(
          { selector: '.button:focus-visible', mustDeclare: 'border-color' },
          'border-color',
          'var(--color-signal)',
        ),
        expect: /\.button:focus-visible 的 border-color 引用了非 L1 变量 --color-signal/,
      },
      {
        // B-2a 复现：新加一条**命中同一批元素**的规则，早先完全逃逸（不在选择器白名单里）
        name: 'B-2a：新选择器 .field input:focus-visible 覆盖描边',
        css: `${globalPlain}
.field input:focus-visible {
  border-color: var(--dsw-alias-state-error-primary);
}
`,
        expect: /命中了控件族元素（\.field input）却不在期望表里/,
      },
      {
        // B-2a 的另一种写法：`.field > input` 与 `.field input` 命中同一批元素
        name: 'B-2a：等价写法 .field > input 覆盖描边',
        css: `${globalPlain}
.field > input {
  border-color: var(--dsw-alias-state-error-primary);
}
`,
        expect: /命中了控件族元素（\.field input）却不在期望表里/,
      },
      {
        // B-2b 复现：被判规则里**非颜色属性**写裸色值，早先全绿（反向钉只抓 --color-*）
        name: 'B-2b：.button:focus-visible 里加 outline 裸色值',
        css: setDeclaration(
          { selector: '.button:focus-visible', mustDeclare: 'border-color' },
          'border-color',
          'var(--dsw-alias-brand-primary); outline: 2px solid #ff0000',
        ),
        expect: /的 outline 里有裸色值 `#ff0000`/,
      },
      {
        // 产品决定：顶栏「退出登录」的 hover 面（删掉 #159 那条 border-color 后补的反馈）
        name: '顶栏退出登录的 hover 面被改小到看不见',
        css: setDeclaration(
          { selector: '.app-header .button-quiet:hover:not(:disabled)', mustDeclare: 'background' },
          'background',
          'rgba(255, 255, 255, 0.01)',
        ),
        expect: /登记的是裸值 `rgba\(255, 255, 255, 0\.08\)`/,
      },
      {
        name: '危险按钮底色写成 color-mix（合法 CSS 但不是单一 token）',
        css: setDeclaration(
          { selector: '.button-danger', mustDeclare: 'background' },
          'background',
          'color-mix(in srgb, var(--dsw-alias-bg-layer-2) 90%, black)',
        ),
        expect: /不是单一 L1 token 引用/,
      },
    ]
    for (const mutation of mutations) {
      // 前提检查：替换真的发生了（否则"变异"是空操作，红不红都不说明问题）
      expect(mutation.css, `变异没生效：${mutation.name}`).not.toBe(globalPlain)
      expect(() => assertControlFamily(mutation.css), `变异未被判据拦下：${mutation.name}`).toThrow(
        mutation.expect,
      )
    }
    // 每条变异触发的那一句失败信息打出来：提交说明/PR 里的红→绿摘要直接取这段输出。
    for (const mutation of mutations) {
      const message = ((): string => {
        try {
          assertControlFamily(mutation.css)
          return '（未红——判据失效）'
        } catch (error) {
          return (error as Error).message.split('\n').slice(1).join(' | ')
        }
      })()
      console.log(`[变异] ${mutation.name} → ${message}`)
    }
    // 反向用例本身不是恒真：未变异的文本必须仍然全绿
    expect(() => assertControlFamily(globalCss)).not.toThrow()
  })
})
