/**
 * #168 自研表单控件（`.field input` / `.field textarea` / `.button` 族）对齐 DSH 族的**机器判据**。
 *
 * 这个文件存在的理由：本次改的是三个「看起来对就行」的视觉度量（描边 0.5px、圆角 8px、
 * 颜色改走 L1）。没有判据的话，任何人把 `0.5px` 改回 `1px`、或把 `--dsw-alias-*` 换成应用层
 * `--color-*`，页面依然"看着正常"，测试全绿。
 *
 * 四条判据（对应 Issue #168 第 3 节）：
 *  A. 描边宽度与圆角**逐值等于 vendored `Input.module.css` 的度量**——度量从那边**现场读**
 *     （`readVendorMetrics`），本文件里**没有 8px / 0.5px 字面量**。抄死数字的判据在上游
 *     改度量那天不会红，等于没判。
 *  B. 这几条控件的颜色声明**只引用 L1 `--dsw-*`**：不出现应用层 `--color-*`，也不出现
 *     裸色值（hex / rgb() / color-mix）。反面清单是逐属性白名单，不是"扫全文找颜色"。
 *  C. `min-height` 与 `var(--touch-min)` 同值，且 `--touch-min ≥ 40px`——**高度不跟着
 *     vendored `Input` 降到 32px** 这件事必须由判据承担，否则下一个人"顺手对齐 32px"没人拦。
 *  D. 反面钉（变异验证）：按 **CSS 规则 + 属性**定位后改坏一次（描边回 1px / 圆角回 6px /
 *     同值换 token / 颜色回应用层 token / 高度回 32px / 变体写裸色值 / 无边形态被改松 /
 *     危险色回亮阶），`assertControlFamily` 必须**变红**，且失败信息指到那条规则；
 *     改坏后仍全绿就说明前三条恒真。这条与 #161 的 M3 变异验证同款（同值换 token 的漏网
 *     正是它要挡的），所以变异走**真实 CSS 文本**、与正向用例共用同一个断言函数。
 *
 * 与 Q5 的分工：这里在 CSS **源码文本**上判「写的是哪个 token、哪个度量」；真实浏览器里
 * 「computed style 等于 token 解析值」由 `tests/e2e/helpers.ts` 的 `assertControlTokens`
 * 采一次，两边共用 `src/shared/control-style-tokens.ts` 的常量与判定函数（各写一份必漂移）。
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  CONTROL_BACKGROUND_TOKEN,
  CONTROL_BORDER_TOKEN,
  CONTROL_DANGER_LABEL_TOKEN,
  CONTROL_LABEL_TOKEN,
  CONTROL_PRIMARY_LABEL_TOKEN,
  CONTROL_TOUCH_TOKEN,
  checkControlTokens,
  type ControlProbe,
} from '../src/shared/control-style-tokens.js'

/** 危险按钮文字色的约定 token（静态档 red-900；理由见 `variants` 处的注释）。 */
const DANGER_LABEL_TOKEN = CONTROL_DANGER_LABEL_TOKEN

const repoRoot = join(import.meta.dirname, '../../..')
const globalCss = readFileSync(join(repoRoot, 'apps/web/src/styles/global.css'), 'utf8')
const l1Css = readFileSync(join(repoRoot, 'apps/web/src/styles/dsw-tokens.css'), 'utf8')
const appTokensCss = readFileSync(join(repoRoot, 'apps/web/src/styles/tokens.css'), 'utf8')
const vendorInputCss = readFileSync(
  join(repoRoot, 'apps/web/src/vendor/dsh-ui/Input.module.css'),
  'utf8',
)

// ---------- 极小的 CSS 读取工具（够用就好；本仓没有 postcss 运行时依赖） ----------

/** 去注释。注释里有花括号与引号，不先去掉会把规则体切歪。 */
function stripComments(text: string): string {
  return text.replaceAll(/\/\*[\s\S]*?\*\//g, '')
}
const globalPlain = stripComments(globalCss)
const l1Plain = stripComments(l1Css)
const vendorPlain = stripComments(vendorInputCss)

/**
 * 扫描一份 CSS 文本，返回满足条件的花括号块。
 *
 * 为什么不用一个正则搞定：`@media` 之类的**嵌套块**会让 `[^}]*` 提前收尾，把内层规则的
 * 声明切一半——判据随后读到半条规则并"绿着通过"。所以这里按花括号深度走。
 *
 * @param selector 必须是选择器列表里**恰好这一段**（不是子串：`.button` 不该匹配
 *   `.app-header-user .button`——两者在别处各有规则，混淆会让判据读到另一条）
 * @param mustDeclare 可选：块体里必须含这条声明（`.field input` 与 `.field input, .field textarea`
 *   同时存在时靠它区分）
 */
function findRules(
  cssText: string,
  selector: string,
  mustDeclare?: string,
): Array<{ body: string; bodyStart: number; bodyEnd: number }> {
  const found: Array<{ body: string; bodyStart: number; bodyEnd: number }> = []
  for (let i = 0; i < cssText.length; i += 1) {
    if (cssText[i] !== '{') continue
    // 选择器 = 上一条规则/块结束到这里的文本。这里显式维护**反向的未配平记账**：
    // 反向碰到 `}` 说明"往左必然有与之配对的 `{`"，碰到 `{` 消一个，记账回到 0 之后再遇到的
    // `}` 就是块结束。
    //
    // 为什么不用更显然的"退到最近一个 `{`/`}`/`;`"：两者都要能识别边界，但方向不对称——
    // 反向时 `;` 只在**记账为 0** 时才是边界（声明值里的 `;` 不是），`}` 在记账为 0 时才是
    // 上一条规则的收尾。本次两种错法都实测踩到过：漏了 `;` → 文件头 `@import` 被并进第一条
    // 规则的选择器；漏了记账 → `.button` 读到了 `.field` 的声明（判据悄悄读错规则）。
    let start = i - 1
    let unclosed = 0
    while (start >= 0) {
      const char = cssText[start]
      if (char === '}') {
        // 记账为 0 时遇到的 `}` = 上一条规则（或 `@media` 块）的收尾，选择器从它之后开始
        if (unclosed === 0) break
        unclosed -= 1
      } else if (char === '{') {
        unclosed += 1
      } else if (char === ';' && unclosed === 0) {
        // `@import './tokens.css';` 这类语句同样是边界。少了这一条，文件头的 @import 会被并进
        // 第一条规则的选择器，扫描起点整体错位（实测：`.field input` 因此读到了 `*` 的声明）。
        break
      }
      start -= 1
    }
    const selectorList = cssText.slice(start + 1, i)
    const parts = selectorList.split(',').map((part) => part.trim().replaceAll(/\s+/g, ' '))
    if (!parts.includes(selector)) continue
    let bodyDepth = 0
    let end = i
    for (; end < cssText.length; end += 1) {
      if (cssText[end] === '{') bodyDepth += 1
      else if (cssText[end] === '}') {
        bodyDepth -= 1
        if (bodyDepth === 0) break
      }
    }
    if (end >= cssText.length) throw new Error(`CSS 花括号不配平，扫描到文件尾：${selector}`)
    const body = cssText.slice(i + 1, end)
    if (
      mustDeclare !== undefined &&
      !new RegExp(`(?:^|;)\\s*${mustDeclare}\\s*:`, 'i').test(body)
    ) {
      continue
    }
    found.push({ body, bodyStart: i + 1, bodyEnd: end })
  }
  return found
}

/**
 * 取某个控件的规则体；命中多条时按 `mustDeclare` 收窄（本文件里的控件恰好只有一条带描边的
 * 规则，仍然多命中就是改坏了，直接抛）。
 */
function ruleBody(cssText: string, selector: string, mustDeclare?: string): string {
  const hits = findRules(cssText, selector, mustDeclare)
  const body = hits[0]?.body
  if (body === undefined) {
    throw new Error(
      `CSS 里找不到规则：${selector}${mustDeclare === undefined ? '' : `（需含 ${mustDeclare} 声明）`}`,
    )
  }
  if (hits.length > 1) {
    throw new Error(`${selector} 命中 ${hits.length} 条规则，判据定位不唯一（先收窄再判）`)
  }
  return body
}

/** 从规则体里取某声明的值（`border` 简写这种含空格的值也能取全）。 */
function declaration(body: string, property: string): string {
  const value = new RegExp(`(?:^|;)\\s*${property}\\s*:\\s*([^;]+)`, 'i').exec(body)?.[1]
  if (value === undefined) throw new Error(`规则里找不到声明：${property}`)
  return value.trim()
}

/**
 * 按「规则 + 属性」改一处声明值——变异验证专用。
 *
 * 为什么不用 `css.replace('原文片段', '改后片段')`：那种写法一旦注释/空白漂一格就**静默
 * 不生效**，变异测试随后"绿着通过"，比没有这条用例更糟（它假装验过）。这里定位不到就抛，
 * 并且调用方还会断言文本真的变了。
 */
function setDeclaration(
  cssText: string,
  rule: { selector: string; mustDeclare?: string },
  property: string,
  value: string,
): string {
  // 扫描器按花括号记账定位规则，**注释必须先剥掉**：注释里出现 `{`/`}` 会让记账错位
  // （实测：把带注释的 global.css 喂进来，`.field input` 直接定位不到）。这里当场断言，
  // 免得调用方传错文本后得到一个"找不到规则"的误导性失败。
  if (cssText.includes('/*')) throw new Error('setDeclaration 只吃去注释后的 CSS 文本')
  const hit = findRules(cssText, rule.selector, rule.mustDeclare)[0]
  if (hit === undefined)
    throw new Error(
      `变异定位失败：${rule.selector}（mustDeclare=${String(rule.mustDeclare)}）找不到那条规则`,
    )
  const next = hit.body.replace(
    new RegExp(`((?:^|;)\\s*${property}\\s*:\\s*)[^;]+`, 'i'),
    `$1${value}`,
  )
  if (next === hit.body) throw new Error(`变异定位失败：${rule.selector} 没有 ${property} 声明`)
  const mutated =
    cssText.slice(0, hit.bodyStart) + next + cssText.slice(hit.bodyStart + hit.body.length)
  // 自检：改写只能替换值，不许动花括号个数——扫描器按记账定位，配平被破坏会让后续规则
  // 全部错位（实测：把花括号数改坏后，报错会伪装成"某条规则找不到"，误导排查方向）。
  const braces = (text: string): number => (text.match(/[{}]/g) ?? []).length
  if (braces(mutated) !== braces(cssText)) {
    throw new Error(`变异破坏了花括号配平：${rule.selector} 的 ${property}`)
  }
  return mutated
}

/**
 * 从 vendored `Input.module.css` 的 `.wrap` 读 DSH 族的真实度量。
 *
 * 只读 `border` 简写与 `border-radius` 两条，token 名从 `var()` 里解出来——所以上游哪天
 * 把 0.5px 改成 0.25px、把 `border-l4` 换成别的层，这里的期望值跟着动，应用层不同步就红。
 */
function readVendorMetrics(): {
  borderWidth: string
  borderStyle: string
  borderToken: string
  radius: string
} {
  const wrap = ruleBody(vendorPlain, '.wrap', 'border')
  const border = declaration(wrap, 'border').replaceAll(/\s+/g, ' ').trim()
  const parsed = /^([\d.]+(?:px|rem|em))\s+(solid|dashed|dotted)\s+var\(\s*(--[\w-]+)\s*\)$/.exec(
    border,
  )
  if (parsed === null) {
    throw new Error(`vendored Input 的 border 解析不了（判据依赖它的形态）：${border}`)
  }
  return {
    borderWidth: parsed[1] ?? '',
    borderStyle: parsed[2] ?? '',
    borderToken: parsed[3] ?? '',
    radius: declaration(wrap, 'border-radius').trim(),
  }
}

const vendor = readVendorMetrics()

/**
 * 取某 token 的解析值。**两处 `:root` 都要查**：颜色在 L1（`dsw-tokens.css`），
 * 而高度轴的应用层命名（`--touch-min`）在 `tokens.css`——只查一边会直接抛错。
 * var() 链递归解（实测 L1 里 `--dsw-alias-bg-layer-1: var(--dsw-static-neutral-bluish-00)` 这种
 * 别名间接是刻意保留的，压平成字面量会让「改一个静态档、所有引用它的语义一起动」断链）。
 */
function tokenValue(name: string): string {
  for (const css of [l1Plain, stripComments(appTokensCss)]) {
    const match = new RegExp(`(?:^|[;{\\s])${name}\\s*:\\s*([^;]+)`, 'm').exec(
      ruleBody(css, ':root'),
    )
    if (match?.[1] !== undefined) {
      const value = match[1].trim()
      const ref = /^var\(\s*(--[\w-]+)\s*\)$/.exec(value)
      return ref?.[1] === undefined ? value : tokenValue(ref[1])
    }
  }
  throw new Error(`两处 :root 都找不到 token：${name}`)
}

const TOUCH_MIN_PX = 40
const touchMin = Number.parseFloat(tokenValue(CONTROL_TOUCH_TOKEN))

/**
 * 基类控件：描边必须**逐值等于 vendored `Input` 的 `border` 简写**——期望值由
 * `vendor.borderWidth` / `vendor.borderStyle` / `CONTROL_BORDER_TOKEN` 拼出，
 * 本文件里没有 `0.5px`、`8px` 这类字面量。
 */
const vendorBorder = `${vendor.borderWidth} ${vendor.borderStyle} var(${CONTROL_BORDER_TOKEN})`
const bordered = [
  {
    selector: '.field input',
    mustDeclare: 'border',
    border: vendorBorder,
    background: CONTROL_BACKGROUND_TOKEN,
    color: CONTROL_LABEL_TOKEN,
  },
  {
    selector: '.field textarea',
    mustDeclare: 'border',
    border: vendorBorder,
    background: CONTROL_BACKGROUND_TOKEN,
    color: CONTROL_LABEL_TOKEN,
  },
  {
    selector: '.button',
    mustDeclare: 'border',
    border: vendorBorder,
    background: CONTROL_BACKGROUND_TOKEN,
    color: CONTROL_LABEL_TOKEN,
  },
] as const

/**
 * 变体：描边分两种——`vendorBorder`（与 vendored `Input` 同值）与 `transparent`
 * （自绘的无边形态，`.button-quiet`）。两者都**显式列出**，所以"变体的描边被改松"
 * （把 `border-l4` 换成 `transparent`、或把宽度改回 1px）会被判据抓住，
 * 而不是靠"没声明就不判"漏过去。
 *
 * `mustDeclare` 不是装饰：`.field textarea` 在 global.css 里有**两条**规则（本次收口的描边
 * 那条 + 既有的 `resize: vertical`），不带这条收窄会抛"定位不唯一"。
 */
const variants = [
  {
    selector: '.button-primary',
    mustDeclare: 'background',
    border: vendorBorder,
    label: CONTROL_PRIMARY_LABEL_TOKEN,
  },
  { selector: '.button-quiet', mustDeclare: 'border', border: `0.5px solid transparent` },
  // 危险按钮的文字色**必须是静态档 red-900**：别名 `--dsw-alias-state-error-primary`
  // 指向 red-500，白底实测 4.50:1 正好压在 AA 线上（与 tokens.css 头块记的"文字色取 900 阶"
  // 同一条纪律）。"只吃 L1"挡不住这次替换——两个都是 L1——所以这条要单独钉 token 名。
  {
    selector: '.button-danger',
    mustDeclare: 'border',
    border: vendorBorder,
    label: DANGER_LABEL_TOKEN,
  },
] as const

/** 本次收口涉及的全部规则（含变体）。 */
const allRules = [...bordered, ...variants]

/**
 * 每个控件上「必须走 L1」的颜色属性白名单。
 *
 * 为什么是逐属性白名单而不是"全文扫一遍找颜色字面量"：本次收口之外的地方（`:root` 的
 * token 定义、`.badge-*` 的浅底、`.app-header` 的深底）本来就有颜色字面量——扫全文只会
 * 得到一条永远红的判据。
 */
const colorProperties = ['color', 'background', 'background-color', 'border', 'border-color']

/**
 * 一条颜色声明的值必须是单一 L1 token 引用（裸色值 / color-mix / 应用层 token 都不算）。
 *
 * `border` 是简写（`0.5px solid var(--x)`），所以要先把宽度/样式剥掉再判颜色那一项；
 * 唯一的例外是**颜色位写 `transparent`** 的自绘无边形态（`.button-quiet`）——那是"没有颜色"
 * 而不是"用了别的颜色"，放行但不算通过 L1（调用方在 `variants` 里显式登记了它）。
 */
function assertL1Color(
  failures: string[],
  selector: string,
  property: string,
  value: string,
  expected?: string,
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
  // 定义判定要**锚定前缀**：裸查 `(--dsw-x)\s*:` 会把 `--dsw-x-hover:` 也当成 `--dsw-x`
  // 的定义（子串匹配的经典坑，#138 切片实测踩过）。
  if (!new RegExp(`(?:^|[;{\\s])${used}\\s*:`).test(l1Plain)) {
    failures.push(
      `${selector} 的 ${property} 引用的 ${used} 在 L1 白名单（dsw-tokens.css）里没有定义`,
    )
  }
}

/**
 * 判据主体：对一份 global.css 文本跑完 A/B/C 三条。
 *
 * 抽成函数是为了让反向用例能拿**改坏的 CSS 文本**跑同一条路径——否则反向用例只是
 * 在验判定函数，证明不了正向用例真的会红。
 */
function assertControlFamily(cssText: string): void {
  const plain = stripComments(cssText)
  // **收集**违反项而不是抛第一个：一个变异常常同时踩到多条（例如把描边改回 1px 也会让
  // "只吃 L1"那一轮看到 `1px`——不，那条看到的是颜色项，所以单条款就不成立；但把颜色换成
  // 应用层 token 会同时踩到"非 L1"与"圆角/描边"之外的多处）。只报第一条会让"某条变异到底
  // 触发了哪一条判据"变得不可读，也无法断言到具体那条失败信息。
  const failures: string[] = []

  // A. 描边宽度、描边颜色与圆角逐值等于 vendored Input 的度量
  //    （期望值从那边现场读，不在这里写死任何数字）。
  for (const rule of allRules) {
    const body = ruleBody(plain, rule.selector, rule.mustDeclare)
    const border = declaration(body, 'border')
    if (border !== rule.border) {
      failures.push(`${rule.selector} 的描边是 \`${border}\`，应为 \`${rule.border}\``)
    }
    const radius = declaration(body, 'border-radius')
    if (radius !== vendor.radius) {
      failures.push(
        `${rule.selector} 的圆角应与 vendored Input 同值（${vendor.radius}），实测 ${radius}`,
      )
    }
  }

  // B. 颜色只引用 L1。
  for (const control of bordered) {
    const body = ruleBody(plain, control.selector, control.mustDeclare)
    for (const property of colorProperties) {
      const match = new RegExp(`(?:^|;)\\s*${property}\\s*:\\s*([^;]+)`, 'i').exec(body)
      if (match?.[1] === undefined) continue
      const expected =
        property === 'border'
          ? CONTROL_BORDER_TOKEN
          : property === 'background' || property === 'background-color'
            ? control.background
            : control.color
      assertL1Color(failures, control.selector, property, match[1], expected)
    }
  }

  // 变体里重复声明的部分同样只吃 L1（原实现的 `--color-signal` / `#fff` /
  // `--color-danger-strong` 就落在这些位置）。登记了 `label` 的变体还额外钉**具体 token 名**
  // ——"只吃 L1"挡不住"换成另一个 L1 里的同色或近色 token"。
  for (const variant of variants) {
    const { selector, mustDeclare } = variant
    const body = ruleBody(plain, selector, mustDeclare)
    const labeled = 'label' in variant ? variant.label : undefined
    for (const property of colorProperties) {
      const match = new RegExp(`(?:^|;)\\s*${property}\\s*:\\s*([^;]+)`, 'i').exec(body)
      if (match?.[1] === undefined) continue
      assertL1Color(
        failures,
        selector,
        property,
        match[1],
        property === 'color' ? labeled : undefined,
      )
    }
  }

  // 反向钉：整个控件族里不许残留应用层 `--color-*` 变量名。
  for (const { selector, mustDeclare } of allRules) {
    const appToken = /--color-[\w-]+/.exec(ruleBody(plain, selector, mustDeclare))?.[0]
    if (appToken !== undefined) failures.push(`${selector} 里残留应用层变量 ${appToken}`)
  }

  // C. 高度：与 --touch-min 同值且不低于触屏下限。
  for (const control of bordered) {
    const minHeight = declaration(
      ruleBody(plain, control.selector, control.mustDeclare),
      'min-height',
    )
    if (minHeight !== `var(${CONTROL_TOUCH_TOKEN})`) {
      failures.push(
        `${control.selector} 的 min-height 是 \`${minHeight}\`，应交给 var(${CONTROL_TOUCH_TOKEN})——高度轴不放开到 vendored Input 的 32px`,
      )
    }
  }
  if (!(touchMin >= TOUCH_MIN_PX)) {
    failures.push(`L1 ${CONTROL_TOUCH_TOKEN}=${touchMin}px 低于触屏下限 ${TOUCH_MIN_PX}px`)
  }

  if (failures.length > 0) {
    throw new Error(`#168 控件族判据未过（${failures.length} 条）：\n- ${failures.join('\n- ')}`)
  }
}

/**
 * 把一份 CSS 文本里的某条控件转成**浏览器侧探针**形状，喂给共用判定函数。
 *
 * 解析值在这里取 L1 声明值（与浏览器里浅色 `:root` 解析结果同值）；真实浏览器的
 * computed style 由 Q5 的 `assertControlTokens` 采集。这一条验的是"两侧共用同一份判定"。
 */
function probeFromCss(cssText: string, selector: string, mustDeclare = 'border'): ControlProbe {
  const body = ruleBody(stripComments(cssText), selector, mustDeclare)
  const borderValue = declaration(body, 'border').replaceAll(/\s+/g, ' ').trim()
  return {
    background: tokenValue(/var\(\s*(--[\w-]+)\s*\)/.exec(declaration(body, 'background'))![1]!),
    borderColor: tokenValue(/var\(\s*(--[\w-]+)\s*\)$/.exec(borderValue)![1]!),
    borderWidth: borderValue.split(/\s+/)[0] ?? '',
    radius: declaration(body, 'border-radius'),
    color: tokenValue(/var\(\s*(--[\w-]+)\s*\)/.exec(declaration(body, 'color'))![1]!),
    minHeight: tokenValue(CONTROL_TOUCH_TOKEN),
    rawBackground: declaration(body, 'background'),
    rawBorder: borderValue.replace(/^[\d.]+px\s+\w+\s+/, ''),
    rawColor: declaration(body, 'color'),
    resolvedBackgroundToken: tokenValue(CONTROL_BACKGROUND_TOKEN),
    resolvedBorderToken: tokenValue(CONTROL_BORDER_TOKEN),
    resolvedLabelToken: tokenValue(CONTROL_LABEL_TOKEN),
    resolvedTouchToken: tokenValue(CONTROL_TOUCH_TOKEN),
  }
}

const checkerExpect = {
  backgroundToken: CONTROL_BACKGROUND_TOKEN,
  borderToken: CONTROL_BORDER_TOKEN,
  labelToken: CONTROL_LABEL_TOKEN,
  vendorBorderWidth: vendor.borderWidth,
  vendorRadius: vendor.radius,
  minTouchPx: TOUCH_MIN_PX,
}

describe('#168 自研控件对齐 DSH 族（源码文本判据）', () => {
  it('度量来源：vendored Input 的描边/圆角被读到（上游形态变了不能静默失效）', () => {
    // 这条不是凑数：`readVendorMetrics` 解析不了会抛错，但"解析出来是空串"不会——
    // 空串会让后面所有"逐值相等"退化成"两边都空"的假绿。
    expect(vendor.borderWidth).toMatch(/^[\d.]+px$/)
    expect(vendor.borderStyle).toBe('solid')
    expect(vendor.borderToken).toBe(CONTROL_BORDER_TOKEN)
    expect(vendor.radius).toMatch(/^\d+px$/)
    expect(tokenValue(CONTROL_BACKGROUND_TOKEN)).not.toBe('')
  })

  it('A+B+C：描边/圆角逐值等于 vendored Input，颜色只吃 L1，高度 = --touch-min', () => {
    assertControlFamily(globalCss)
    // 顺带把两侧共用的判定函数跑一遍（Q5 的 assertControlTokens 用的就是它）
    for (const control of bordered) {
      expect(
        checkControlTokens(
          probeFromCss(globalCss, control.selector),
          checkerExpect,
          control.selector,
        ),
      ).toEqual([])
    }
  })

  it('C 反面：高度降到 32px（vendored Input 的桌面密度）时判定函数必须红', () => {
    const probe = {
      ...probeFromCss(globalCss, '.field input'),
      minHeight: '32px',
      resolvedTouchToken: '32px',
    }
    expect(checkControlTokens(probe, checkerExpect, '.field input').join('\n')).toContain(
      '小于触屏下限',
    )
    // 与 --touch-min 不同值也要单独挑出来（只报下限不够定位）
    const mismatched = { ...probeFromCss(globalCss, '.field input'), minHeight: '32px' }
    expect(checkControlTokens(mismatched, checkerExpect, '.field input').join('\n')).toContain(
      '不同值',
    )
  })

  it('D 变异验证：按规则+属性改坏一处，同一条判据必须红', () => {
    const mutations: Array<{ name: string; css: string; expect: RegExp }> = [
      {
        name: '描边宽度改回旧值 1px',
        css: setDeclaration(
          globalPlain,
          bordered[0],
          'border',
          `1px ${vendor.borderStyle} var(${CONTROL_BORDER_TOKEN})`,
        ),
        expect: /\.field input 的描边是/,
      },
      {
        name: '圆角改回旧值 6px',
        css: setDeclaration(globalPlain, bordered[2], 'border-radius', '6px'),
        expect: /\.button 的圆角应与 vendored Input 同值（8px），实测 6px/,
      },
      {
        // 同值换 token：#161 的 M3 同款。浅色下 border-l3 与 border-l4 都是 rgba(0,0,0,.16)
        // （实测），只比 computed 值的判据会静默通过——必须在源码文本上钉 token 名。
        name: '同值换 token：描边换成 border-l3',
        css: setDeclaration(
          globalPlain,
          bordered[0],
          'border',
          `0.5px solid var(--dsw-alias-border-l3)`,
        ),
        expect: /引用了 --dsw-alias-border-l3，约定应是 --dsw-alias-border-l4/,
      },
      {
        name: '输入框背景换回应用层 --color-surface',
        css: setDeclaration(globalPlain, bordered[0], 'background', 'var(--color-surface)'),
        expect: /非 L1 变量 --color-surface/,
      },
      {
        name: '高度降到 vendored Input 的 32px',
        css: setDeclaration(globalPlain, bordered[0], 'min-height', '32px'),
        expect: /的 min-height 是 `32px`，应交给 var\(--touch-min\)/,
      },
      {
        name: '主按钮文字写裸色值 #fff',
        css: setDeclaration(globalPlain, variants[0], 'color', '#fff'),
        expect: /\.button-primary 的 color 不是单一 L1 token 引用：`#fff`/,
      },
      {
        name: '安静按钮的描边被换成有色的 border-l4（无边形态被改松）',
        css: setDeclaration(
          globalPlain,
          variants[1],
          'border',
          `0.5px solid var(--dsw-alias-border-l4)`,
        ),
        expect:
          /\.button-quiet 的描边是 `0\.5px solid var\(--dsw-alias-border-l4\)`，应为 `0\.5px solid transparent`/,
      },
      {
        name: '危险按钮描边宽度改回 1px',
        css: setDeclaration(
          globalPlain,
          variants[2],
          'border',
          `1px solid var(--dsw-alias-border-l4)`,
        ),
        expect: /\.button-danger 的描边是 `1px solid var\(--dsw-alias-border-l4\)`/,
      },
      {
        // 同值换 token 的第二种形态：危险色从静态档 red-900 换成别名 red-500。两者都是"红"，
        // 但 red-500 on 白底实测 4.50:1，正压在 AA 线上；判据钉的是"这个位置只许用约定的 token"。
        name: '危险按钮文字回到别名亮阶 state-error-primary',
        css: setDeclaration(
          globalPlain,
          variants[2],
          'color',
          'var(--dsw-alias-state-error-primary)',
        ),
        expect: /引用了 --dsw-alias-state-error-primary/,
      },
    ]
    for (const mutation of mutations) {
      // 前提检查：替换真的发生了（否则"变异"是空操作，红不红都不说明问题）
      expect(mutation.css, `变异没生效：${mutation.name}`).not.toBe(globalPlain)
      expect(() => assertControlFamily(mutation.css), `变异未被判据拦下：${mutation.name}`).toThrow(
        mutation.expect,
      )
    }
    // 每条变异触发的那一句失败信息打出来：提交说明里的红→绿摘要直接取这段输出，
    // 免得"判据红了"这种不可核的措辞（同时也让后人能一眼看出哪条变异对应哪条判据）。
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
    // 上面每条都断言到了**具体那条**失败信息（toThrow 的正则是带坐标的），所以"被判据拦下"
    // 不是"随便哪条红了就算"——一个变异只能触发它对应的那一条。
    // 反向用例本身不是恒真：未变异的文本必须仍然全绿（否则上面全在验一条永远红的判据）
    expect(() => assertControlFamily(globalCss)).not.toThrow()
  })
})
