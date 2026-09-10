/**
 * #152 主题门：应用层 token（`tokens.css`）到 L1 白名单（`dsw-tokens.css`）的
 * **引用完整性** 与 **WCAG AA 对比度**。
 *
 * 为什么要有这道门：
 * 1. 主题统一后，应用层的每个颜色都是 `var(--dsw-*)`。若某个引用在白名单里不存在，
 *    浏览器不会报错——它静默落成「继承/无效值」，页面看着"还行"，实际颜色已经不是
 *    设计意图。这类漂移只能靠解析文本 + 断言解析得到来拦。
 * 2. 仓库把 WCAG 2.1 AA 写成了基线（`prototype/IMPLEMENTATION-PLAN.md`），但此前
 *    没有任何门能拦住"某次取色把对比度拉下去"（#151 的 AA 回归就是这么进来的）。
 *
 * 判据：清单里每一对「文字色 / 其背景」都必须 ≥4.5:1（正文尺寸）。
 * 若将来要放行某对（例如仅用于装饰），必须**在本文件里显式登记理由**，不许静默放宽。
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { WHITE, contrastRatio, parseCssColor, readTokenValue, round2 } from './contrast.js'

const here = dirname(fileURLToPath(import.meta.url))
const appTokens = readFileSync(join(here, '../src/styles/tokens.css'), 'utf8')
const l1Tokens = readFileSync(join(here, '../src/styles/dsw-tokens.css'), 'utf8')

/** 解析一层 var() 间接：先取应用层声明，若其值是 var(--dsw-x) 再取白名单的字面量。 */
function resolve(name: string): string {
  const raw = readTokenValue(appTokens, name)
  const indirect = /^var\((--[a-z0-9-]+)\)$/i.exec(raw.trim())
  if (indirect === null) return raw
  const target = indirect[1]
  if (target === undefined) throw new Error(`${name} 的 var() 形态无法解析：${raw}`)
  return readTokenValue(l1Tokens, target)
}

const AA_TEXT = 4.5

/** 清单：语义名 → [文字 token, 背景 token, 说明]。背景用绝对白时写 WHITE。 */
/** 背景写 null = 绝对白（无 token 对应）。 */
const PAIRS: ReadonlyArray<[string, string, string | null, string]> = [
  ['正文 / 卡片面', '--color-ink', '--color-surface', '卡片里的正文'],
  ['正文 / 页面底', '--color-ink', '--color-paper', '页面底上的正文'],
  ['次级文字 / 卡片面', '--color-ink-soft', '--color-surface', '说明性文字'],
  ['弱化文字 / 卡片面', '--color-muted', '--color-surface', '提示与时间戳'],
  ['顶栏文字 / 顶栏底', '--color-paper', '--color-ink', '顶栏（底用 ink）'],
  ['主按钮文字 / 主按钮底', '--color-surface', '--color-signal', '白字按钮'],
  ['链接文字 / 卡片面', '--color-signal', '--color-surface', '链接与可点文字'],
  ['链接文字 / 页面底', '--color-signal', '--color-paper', '页面底上的链接'],
  ['运行态文字 / 运行态底', '--color-run', '--color-run-soft', '运行/成功徽标'],
  ['警告态文字 / 警告态底', '--color-warn', '--color-warn-soft', '警告徽标'],
  ['危险态文字 / 危险态底', '--color-danger', '--color-danger-soft', '危险徽标'],
  ['危险态文字 / 卡片面', '--color-danger', '--color-surface', '错误横幅文字'],
]

describe('#152 主题门', () => {
  it('应用层每个颜色引用都能在白名单里解析（否则浏览器静默回落）', () => {
    const referenced = [...appTokens.matchAll(/var\((--dsw-[a-z0-9-]+)\)/gi)].map((m) => m[1] ?? '')
    expect(referenced.length).toBeGreaterThan(10)
    const unresolved = [...new Set(referenced)].filter(
      (name) => readTokenValue(l1Tokens, name).trim() === '',
    )
    expect(unresolved).toEqual([])
  })

  it('白名单取值与上游同源（抽样：不得出现本仓自创色值）', () => {
    // 抽样断言具体字面量：改上游颜色必须同时改这里，改不动就是有人手写了别的色
    expect(resolve('--color-signal').trim()).toBe('rgb(37, 99, 235)') // blue-600
    expect(resolve('--color-paper').trim()).toBe('rgb(245, 246, 247)') // bg-module-platform
    expect(resolve('--color-run').trim()).toBe('rgb(35, 60, 44)') // green-900
  })

  it(`清单里每对文字/背景都过 WCAG AA（≥${AA_TEXT}:1）`, () => {
    const failures: string[] = []
    const report: string[] = []
    for (const [label, fgName, bgRef, note] of PAIRS) {
      const fg = parseCssColor(resolve(fgName))
      const bg = bgRef === null ? WHITE : parseCssColor(resolve(bgRef))
      const ratio = round2(
        contrastRatio({ r: fg.r, g: fg.g, b: fg.b }, { r: bg.r, g: bg.g, b: bg.b }),
      )
      report.push(`${label}: ${ratio}:1（${note}）`)
      if (ratio < AA_TEXT) failures.push(`${label} 仅 ${ratio}:1`)
    }
    // 打印整张表：门绿时也留下数字，便于评审看趋势
    console.log(`[#152 主题 AA]\n${report.join('\n')}`)
    expect(failures).toEqual([])
  })

  it('反向用例：把上游亮色当文字色会不达标（说明门不是恒真）', () => {
    // 上游 500 阶：亮绿 on 白 —— 这就是 #151 的 AA 回归现场
    expect(round2(contrastRatio(parseCssColor('rgb(34, 197, 94)'), WHITE))).toBeLessThan(AA_TEXT)
    // 品牌亮蓝当按钮底 + 白字 —— 也是不达标的那一档
    expect(round2(contrastRatio(WHITE, parseCssColor('rgb(86, 134, 254)')))).toBeLessThan(AA_TEXT)
  })
})
