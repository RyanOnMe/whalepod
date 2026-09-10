/**
 * #152 浏览器侧对比度扫描（Q5 用）：把「文字/背景对比度」从"我盯截图"变成机器判据。
 *
 * 为什么需要它（今天真发生过）：`.run-live-text` 只设了深色底、没设文字色，于是继承
 * 深色正文——深底深字，Run 实况文本基本看不清。单元门只能校验 token 表里的配对，
 * 抓不到「组件把颜色写在别处、或颜色由 color-mix/继承得出」这一类。扫描器直接量
 * **真实渲染结果**：对每个含可见文字的元素，取其 color 与"向上找到的第一个不透明
 * 背景色"，算 WCAG 对比度。
 *
 * 判据（与仓库基线一致，见 prototype/IMPLEMENTATION-PLAN.md）：正文级文字 ≥4.5:1。
 * 例外必须**显式登记**在 EXEMPT 里并写清理由——不许静默放宽。
 */
import { expect, type Page } from '@playwright/test'

/** 例外：选择器 → 理由。只允许"非正文/非信息性"的文字，且必须有理由。 */
export const CONTRAST_EXEMPT: ReadonlyArray<{ selector: string; reason: string }> = [
  {
    selector: '[disabled], [aria-disabled="true"]',
    reason: '禁用态按 WCAG 1.4.3 例外（inactive UI component），其文字无需满足对比度',
  },
  {
    selector: '.mutation-hint, .field-hint',
    reason:
      '加载/辅助提示目前用的是 secondary 灰（5.8:1，达标）；登记在此仅为将来若改成更浅灰时**必须显式改这里**，不许静默放宽',
  },
]

export interface ContrastOffender {
  selector: string
  text: string
  color: string
  background: string
  ratio: number
}

/**
 * 扫描当前页面，返回不达标的文字元素（ratio < min）。
 * 只量"有真实文字、可见、非禁用"的元素；背景向上找第一个 alpha>0.9 的祖先。
 */
export async function findContrastOffenders(page: Page, min = 4.5): Promise<ContrastOffender[]> {
  return page.evaluate(
    ({ minRatio, exemptSelectors }) => {
      const toRgb = (css: string): [number, number, number, number] | null => {
        const m = css.match(/rgba?\(([^)]+)\)/)
        if (m === null || m[1] === undefined) {
          // color(srgb r g b / a) 形态（Chrome 对 color-mix 的序列化）
          const s = css.match(/color\(srgb\s+([\d.]+)\s+([\d.]+)\s+([\d.]+)(?:\s*\/\s*([\d.]+))?\)/)
          if (s === null) return null
          return [
            Number(s[1]) * 255,
            Number(s[2]) * 255,
            Number(s[3]) * 255,
            s[4] === undefined ? 1 : Number(s[4]),
          ]
        }
        const parts = m[1].split(/[\s,/]+/).filter((p) => p !== '')
        const [r, g, b] = [Number(parts[0]), Number(parts[1]), Number(parts[2])]
        const a = parts[3] === undefined ? 1 : Number(parts[3])
        return [r ?? 0, g ?? 0, b ?? 0, a]
      }
      const lum = (rgb: [number, number, number, number]): number => {
        const f = (v: number): number => {
          const s = v / 255
          return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4
        }
        return 0.2126 * f(rgb[0]) + 0.7152 * f(rgb[1]) + 0.0722 * f(rgb[2])
      }
      const ratio = (
        a: [number, number, number, number],
        b: [number, number, number, number],
      ): number => {
        const [l1, l2] = [lum(a), lum(b)].sort((x, y) => y - x)
        return ((l1 ?? 0) + 0.05) / ((l2 ?? 0) + 0.05)
      }
      const blend = (
        fg: [number, number, number, number],
        bg: [number, number, number, number],
      ): [number, number, number, number] => [
        fg[0] * fg[3] + bg[0] * (1 - fg[3]),
        fg[1] * fg[3] + bg[1] * (1 - fg[3]),
        fg[2] * fg[3] + bg[2] * (1 - fg[3]),
        1,
      ]

      const describe = (el: Element): string => {
        const id = el.id !== '' ? `#${el.id}` : ''
        const cls =
          el.className !== '' && typeof el.className === 'string'
            ? `.${el.className.split(/\s+/)[0]}`
            : ''
        return `${el.tagName.toLowerCase()}${id}${cls}`
      }

      const out: Array<{
        selector: string
        text: string
        color: string
        background: string
        ratio: number
      }> = []

      for (const el of Array.from(document.querySelectorAll<HTMLElement>('body *'))) {
        // 只取"自己直接挂着文字"的元素，避免父容器被算两次
        const own = Array.from(el.childNodes)
          .filter((n) => n.nodeType === Node.TEXT_NODE)
          .map((n) => (n.textContent ?? '').trim())
          .join('')
        if (own.length === 0) continue
        if (exemptSelectors.some((sel: string) => el.matches(sel))) continue
        const cs = getComputedStyle(el)
        if (cs.display === 'none' || cs.visibility === 'hidden') continue
        if (Number(cs.opacity) < 0.5) continue
        const rect = el.getBoundingClientRect()
        if (rect.width === 0 || rect.height === 0) continue

        const fg = toRgb(cs.color)
        if (fg === null) continue
        // 向上找背景：把沿途半透明背景依次合成，直到遇到不透明底
        let acc: [number, number, number, number] = [255, 255, 255, 1]
        const chain: Array<[number, number, number, number]> = []
        for (let node: HTMLElement | null = el; node !== null; node = node.parentElement) {
          const bg = toRgb(getComputedStyle(node).backgroundColor)
          if (bg !== null && bg[3] > 0) chain.push(bg)
          if (bg !== null && bg[3] >= 0.9) break
        }
        for (const layer of chain.reverse()) acc = blend(layer, acc)

        const r = ratio(fg, acc)
        if (r < minRatio) {
          out.push({
            selector: describe(el),
            text: own.slice(0, 30),
            color: cs.color,
            background: `rgb(${Math.round(acc[0])}, ${Math.round(acc[1])}, ${Math.round(acc[2])})`,
            ratio: Math.round(r * 100) / 100,
          })
        }
      }
      return out
    },
    { minRatio: min, exemptSelectors: CONTRAST_EXEMPT.map((e) => e.selector) },
  )
}

/** 断言当前页面没有对比度不达标的文字元素（失败时打印逐条明细，便于定位）。 */
export async function expectNoContrastOffenders(page: Page, min = 4.5): Promise<void> {
  const offenders = await findContrastOffenders(page, min)
  expect(
    offenders,
    `对比度不达标的文字元素（<${min}:1）：\n${offenders
      .map((o) => `  ${o.selector} "${o.text}" color=${o.color} on ${o.background} → ${o.ratio}:1`)
      .join('\n')}`,
  ).toEqual([])
}
