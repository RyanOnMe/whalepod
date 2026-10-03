/**
 * #271 动效底座：交互态过渡与按下反馈的**可证伪**契约。
 *
 * 为什么是 CSS 源码判据而不是浏览器判据：jsdom 不做层叠（`getComputedStyle` 读不到
 * 样式表里的 transition），本地又没有 Playwright 浏览器（Q5 面挂既有 e2e 债）。这与
 * #231 骨架屏门口径一致（`room-polish.spec.tsx`），并且把"门会不会恒真"用**同一次运行内
 * 的变异自证**回答掉（照 `density-gate.spec.tsx` 的 measure() 变异自证写法）——
 * 契约检查函数既跑真文件，也跑几份故意改坏的副本。
 *
 * 契约内容（对应 Issue #271 的判据 1–5）：
 *   1. 动效取值有单一来源（tokens.css），且曲线是**强曲线**不是内置弱曲线；
 *   2. 具名交互面的规则体里带 transition（同名规则被复制到别处即报"定位不唯一"）；
 *   3. 按下反馈存在且取值走 token（不散落魔数）；
 *   4. reduced-motion 把位移关掉（减少不是清零：颜色类过渡保留）；
 *   5. 反向：全站自有 CSS 没有 `transition: all`，没有 `ease-in`（`ease-in-out` 不算）。
 */
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const stylesDir = resolve(process.cwd(), 'apps/web/src/styles')
const globalCss = readFileSync(resolve(stylesDir, 'global.css'), 'utf8')
const tokensCss = readFileSync(resolve(stylesDir, 'tokens.css'), 'utf8')

/** 去注释。注释里会写「为什么不用 ease-in」，不去掉会把说明文字判成违规。 */
function stripComments(text: string): string {
  return text.replaceAll(/\/\*[\s\S]*?\*\//g, '')
}

function escapeRegExp(text: string): string {
  return text.replaceAll(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

interface CssRule {
  selector: string
  body: string
}

/**
 * 扫描出**顶层**样式规则（花括号配平，`@media` 内部的规则不算顶层，嵌套写法也不算）。
 *
 * 为什么不用正则直接抓 `选择器 {`：`tokens.css` 里有一个媒体查询内的 `:root` 覆盖
 * （reduced-motion 关位移），正则会把它和顶层 `:root` 当成两份而误报"定位不唯一"；
 * 反过来，正则也认不出"同名规则被复制到 @media 里"这种真违规。两种都要能分开。
 */
function topLevelRules(css: string): CssRule[] {
  const rules: CssRule[] = []
  let depth = 0
  let preludeStart = 0
  let blockSelector = ''
  let blockStart = -1
  for (let i = 0; i < css.length; i += 1) {
    const char = css[i]
    if (char === '{') {
      if (depth === 0) {
        blockSelector = css.slice(preludeStart, i).trim()
        blockStart = i + 1
      }
      depth += 1
    } else if (char === '}') {
      depth -= 1
      if (depth === 0) {
        rules.push({ selector: blockSelector, body: css.slice(blockStart, i) })
        preludeStart = i + 1
      }
    } else if (char === ';' && depth === 0) {
      preludeStart = i + 1
    }
  }
  return rules
}

/**
 * 取某选择器的**顶层**规则体。
 *
 * - 命中 0 条：抛（别让判据静默变成空断言）；
 * - 命中 >1 条：也抛（同名规则被复制到别处正是本条要抓的目标，取第一条会看不见）。
 *
 * 只认独立规则块：分组选择器（`A, B {`）不会命中原选择器，后代选择器扩展
 * （`.app-nav a[aria-current]`）不会被误当成同一个选择器。
 */
function ruleBody(css: string, selector: string): string {
  const hits = topLevelRules(css).filter((rule) => rule.selector === selector)
  if (hits.length === 0) throw new Error(`找不到独立规则块：${selector}`)
  if (hits.length > 1) throw new Error(`${selector} 命中 ${hits.length} 条规则，判据定位不唯一`)
  return hits[0]!.body
}

/** 取某个 at-rule 块的完整内容（花括号配平，不靠正则贪婪跨块）。 */
function atRuleBody(css: string, prelude: string): string {
  const start = css.indexOf(prelude)
  if (start === -1) throw new Error(`找不到 at-rule：${prelude}`)
  let depth = 0
  for (let i = css.indexOf('{', start); i < css.length; i += 1) {
    if (css[i] === '{') depth += 1
    else if (css[i] === '}') {
      depth -= 1
      if (depth === 0) return css.slice(start, i + 1)
    }
  }
  throw new Error(`at-rule 花括号不配平：${prelude}`)
}

/** 动效取值必须集中在这几个 token 上；组件里写裸时长/曲线即契约失败。 */
const MOTION_TOKENS = [
  '--ease-out',
  '--ease-in-out',
  '--duration-quick',
  '--duration-base',
  '--press-scale',
] as const

/**
 * 要有过渡的交互面（侧栏/顶栏/按钮族/控件/卡片/行/筛选 chip）。
 *
 * 不在列的两类，各有理由（写下来免得下一个人当成漏网）：
 *   · `.task-link`：hover 只加下划线——下划线的出现是文本可读性提示，不是"面"的变化，
 *     没有可过渡的属性（`text-decoration-color` 动不了下划线的有无）。
 *   · `.global-search-item`：⌘K 结果行 100+/天，键盘面按 Raycast 约定**不加动效**（AUDIT §1）。
 */
const TRANSITIONED = [
  '.app-nav a',
  '.sidebar-recent-link',
  '.app-nav-toggle',
  '.button',
  '.select-menu .select-menu-trigger',
  '.ref-chip',
  '.app-sidebar-search',
  '.agent-card',
  '.run-item-button',
  '.cf',
] as const

/**
 * 契约检查：返回失败清单（空 = 成立）。真文件与变异副本都走这一个函数。
 * 所有取块失败都**转成失败清单而不是抛出**——这样一轮就能看全所有违规，
 * 而不是被第一条异常打断。
 */
function checkMotionContract(cssText: string, tokensText: string): string[] {
  const failures: string[] = []
  const css = stripComments(cssText)
  const tokens = stripComments(tokensText)
  const bodyOrFail = (source: string, selector: string): string | null => {
    try {
      return ruleBody(source, selector)
    } catch (error) {
      failures.push((error as Error).message)
      return null
    }
  }

  const root = bodyOrFail(tokens, ':root')
  if (root !== null) {
    for (const token of MOTION_TOKENS) {
      if (!new RegExp(`${escapeRegExp(token)}\\s*:`).test(root)) {
        failures.push(`tokens.css 的 :root 里没有定义 ${token}`)
      }
    }
    // 强曲线是"刻意设计"的判据：内置 ease-out/ease-in-out 太弱，写成本仓的强曲线才算数。
    if (!/--ease-out:\s*cubic-bezier\(0\.23,\s*1,\s*0\.32,\s*1\)/.test(root)) {
      failures.push('--ease-out 必须是强曲线 cubic-bezier(0.23, 1, 0.32, 1)')
    }
    if (!/--ease-in-out:\s*cubic-bezier\(0\.77,\s*0,\s*0\.175,\s*1\)/.test(root)) {
      failures.push('--ease-in-out 必须是强曲线 cubic-bezier(0.77, 0, 0.175, 1)')
    }
  }

  for (const selector of TRANSITIONED) {
    const body = bodyOrFail(css, selector)
    if (body !== null && !/(^|[;\s])transition(-property)?\s*:/.test(body)) {
      failures.push(`${selector} 的规则体里没有 transition`)
    }
  }

  // 按下反馈：只判"存在且走 token"，不判具体曲线（曲线在上面的 :root 判据里）。
  const pressed = bodyOrFail(css, '.button:active:not(:disabled)')
  if (pressed !== null && !/transform:\s*scale\(var\(--press-scale\)\)/.test(pressed)) {
    failures.push(
      '.button:active:not(:disabled) 的按下反馈必须走 transform: scale(var(--press-scale))',
    )
  }

  try {
    const reduced = atRuleBody(tokens, '@media (prefers-reduced-motion: reduce)')
    if (!/--press-scale:\s*1/.test(reduced)) {
      failures.push('reduced-motion 下必须把 --press-scale 改写为 1（位移关掉）')
    }
  } catch (error) {
    failures.push((error as Error).message)
  }

  // 反向判据：全站自有 CSS 里不许有 transition: all / ease-in。
  for (const [name, text] of [
    ['global.css', css],
    ['tokens.css', tokens],
  ] as const) {
    if (/transition\s*:\s*all/.test(text)) failures.push(`${name} 里出现 transition: all`)
    if (/ease-in(?!-out)/.test(text)) failures.push(`${name} 里出现 ease-in（UI 上永远不要）`)
  }

  return failures
}

describe('#271 动效底座契约', () => {
  it('真文件通过契约（tokens / 具名交互面 / 按下反馈 / reduced-motion / 反向判据）', () => {
    expect(checkMotionContract(globalCss, tokensCss)).toEqual([])
  })

  it('变异自证：拆掉一条 transition 会红（门不是恒真）', () => {
    const mutated = globalCss.replace(
      /(\.app-nav a \{)([\s\S]*?)(\})/,
      (_all, head: string, body: string, tail: string) =>
        head + body.replace(/transition[^;]*;/, '') + tail,
    )
    expect(mutated).not.toEqual(globalCss)
    expect(checkMotionContract(mutated, tokensCss)).toContain(
      '.app-nav a 的规则体里没有 transition',
    )
  })

  it('变异自证：把 reduced-motion 的 token 改写删掉会红', () => {
    const mutated = tokensCss.replace(/--press-scale:\s*1/, '--press-scale: 0.97')
    expect(mutated).not.toEqual(tokensCss)
    expect(checkMotionContract(globalCss, mutated)).toContain(
      'reduced-motion 下必须把 --press-scale 改写为 1（位移关掉）',
    )
  })

  it('变异自证：混进 ease-in（但 ease-in-out 不算）会红', () => {
    const mutated = globalCss.replace(
      'transition: background-color',
      'transition: background-color var(--duration-quick) ease-in, background-color',
    )
    expect(mutated).not.toEqual(globalCss)
    expect(checkMotionContract(globalCss, mutated).some((f) => f.includes('ease-in'))).toBe(true)
  })

  it('变异自证：transition: all 会红', () => {
    const mutated = globalCss.replace('transition: background-color', 'transition: all')
    expect(mutated).not.toEqual(globalCss)
    expect(checkMotionContract(globalCss, mutated).some((f) => f.includes('transition: all'))).toBe(
      true,
    )
  })

  it('反向：同名规则被复制到别处时不静默取第一条（报"定位不唯一"）', () => {
    const mutated = `${globalCss}\n.app-nav a { transition: none; }\n`
    expect(checkMotionContract(mutated, tokensCss)).toContain(
      '.app-nav a 命中 2 条规则，判据定位不唯一',
    )
  })
})
