/**
 * #159 浏览器侧对比度扫描（Q5 用）：把「文字/背景对比度」从"我盯截图"变成机器判据。
 *
 * 为什么需要它（真发生过两次）：`.run-live-text` 只设了底色、没设文字色，于是继承了深色
 * 正文（后来改成浅底深字）；#151 又把 `rgb(34,197,94)`（2.28:1）当成功色钉在断言里。
 * 单元门（tests/theme-contrast.spec.ts）只能校验**声明出来的 token 配对**，抓不到颜色由
 * 继承 / `color-mix` / 组件内部得出的情形。扫描器直接量**真实渲染结果**。
 *
 * 判据（WCAG 2.1 AA，与仓库基线见 prototype/IMPLEMENTATION-PLAN.md:17）：
 *   - 正文级文字 ≥ 4.5:1；
 *   - 大字号文字（≥24px，或 ≥18.66px 且粗体）≥ 3:1（SC 1.4.3 原文如此，不是放宽）。
 * 例外必须**显式登记**在 CONTRAST_EXEMPT 里并写清理由——不许静默放宽。
 *
 * ## 评审暴露过的漏报路径（都已修，改这个文件前先读）
 *
 * 首版有五条"静默放过"的通道。#159 一审逐条给了数值反例，修法如下：
 *   1. **前景 alpha 从不合成**：`color: rgba(15,17,21,.35)` 压白真值 ≈2.4:1（不达标），
 *      首版按不透明 ink 报 ≈16.9:1（通过）→ 现在前景也走 `compositeOver`（见 `ratio` 前一步）。
 *   2. **解析不了的颜色静默跳过**：将来谁写 `oklch()`/`lab()`/`color(display-p3 …)`
 *      （Chrome 对这些**不做** legacy 序列化）就永久免检而门恒绿 → 现在把解析失败**计数并上报**，
 *      `expectNoContrastOffenders` 直接失败（门不能对看不懂的颜色下结论）。
 *   3. **表单控件从不被扫**：只认 TEXT_NODE 子节点，而 `<input>` 的值是属性不是文本节点——
 *      而 placeholder 一档灰正是登录/初始化页最经典的 AA 失分处 → 现在 input/textarea 另取
 *      value 与 `::placeholder` 的 computed color 判定。
 *   4. **背景链只认 `background-color`**：渐变 / `backdrop-filter`（vendored Modal 的遮罩就有）
 *      会被当成"没这回事"，用底下的浅色当真底色（方向是**高估**对比度 = 假绿）→ 现在遇到
 *      这类祖先就登记为"无法判定"并失败。
 *   5. **祖先 `opacity` 不计**（opacity 不继承，子元素 computed 值仍是 1）→ 现在沿祖先链
 *      累乘有效不透明度，并把文字按该不透明度合成后再算对比度。
 *
 * 仍然不判定（诚实列出，当前仓库均 0 命中，见 docs/agent/web-shell-acceptance.md）：
 * `::before/::after` 生成的文本、`-webkit-text-fill-color`、非祖先覆盖层（浮层压住文字）、
 * 动画中间态（单次取样）。这些是**已知盲区**，不是"通过"。
 */
import { expect, type Page } from '@playwright/test'

/**
 * 例外：选择器 → 理由。只允许"非正文/非信息性"的文字，且必须有理由。
 *
 * 注意 `matches()` 是**逐元素**判定、不下沉子树，所以 `[disabled]` 不会顺带放过禁用控件
 * 里的子节点文字（这点被一审确认过：不必担心"豁免过宽"）。
 * `[aria-disabled="true"]` 当前全仓 0 命中（实测 grep），保留是因为它是 WCAG 认可的
 * inactive 形态，将来只需在组件上写属性、不必回来改这张表。
 */
export const CONTRAST_EXEMPT: ReadonlyArray<{ selector: string; reason: string }> = [
  {
    selector: '[disabled], [aria-disabled="true"]',
    reason: '禁用态按 WCAG 1.4.3 例外（inactive UI component），其文字无需满足对比度',
  },
  // 一审删掉了原先的 `.mutation-hint, .field-hint` 一条：它们是 **color: var(--color-muted)**
  // 的信息性提示文字（实测 5.80:1，本来就达标），豁免"达标的正文级文字"换不到任何覆盖率，
  // 却制造了两件事：① 与"例外只允许非信息性文字"这条口径自相矛盾；② 让 390×844 那几个
  // 扫描点在**加载态**下唯一能扫到的正文元素被排除（列表还在 isPending 时页面上只有
  // .mutation-hint），于是扫描退化成只量顶栏——门看着绿，其实什么都没量。
]

export interface ContrastOffender {
  selector: string
  text: string
  color: string
  background: string
  ratio: number
}

/** 门无法下结论的样本（颜色解析不了 / 底色无法判定）。它们一律计为失败，不许静默放过。 */
export interface ContrastUndecidable {
  selector: string
  text: string
  reason: string
}

export interface ContrastSweepResult {
  offenders: ContrastOffender[]
  undecidable: ContrastUndecidable[]
  /** 实际判定过的文字元素数——用来证明"这次真的量了东西"，不是空扫。 */
  checked: number
}

/**
 * 扫描当前页面。返回不达标项、无法判定项与判定计数。
 * 只量"有真实文字、可见、非禁用"的元素；背景向上把半透明层依次合成到第一个不透明底。
 */
export async function sweepContrast(page: Page, min = 4.5): Promise<ContrastSweepResult> {
  return page.evaluate(
    ({ minRatio, exemptSelectors }) => {
      const toRgb = (css: string): [number, number, number, number] | null => {
        const m = css.match(/rgba?\(([^)]+)\)/)
        if (m !== null && m[1] !== undefined) {
          const parts = m[1].split(/[\s,/]+/).filter((p) => p !== '')
          const num = (i: number): number => Number(parts[i])
          if (parts.length < 3 || parts.slice(0, 3).some((p) => Number.isNaN(Number(p)))) {
            return null
          }
          const a = parts[3] === undefined ? 1 : Number(parts[3])
          return [num(0), num(1), num(2), Number.isNaN(a) ? 1 : a]
        }
        // color(srgb r g b / a) 形态（Chrome 对 color-mix 的序列化）：数字可带负号/科学计数法
        const s = css.match(
          /color\(srgb\s+(-?[\d.eE+]+)\s+(-?[\d.eE+]+)\s+(-?[\d.eE+]+)(?:\s*\/\s*(-?[\d.eE+]+))?\)/,
        )
        if (s === null) return null
        const ch = (i: number): number => Math.min(255, Math.max(0, Number(s[i]) * 255))
        return [ch(1), ch(2), ch(3), s[4] === undefined ? 1 : Number(s[4])]
      }
      const lum = (rgb: [number, number, number, number]): number => {
        const f = (v: number): number => {
          const s = v / 255
          return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4
        }
        return 0.2126 * f(rgb[0]) + 0.7152 * f(rgb[1]) + 0.0722 * f(rgb[2])
      }
      const ratioOf = (
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

      /** 沿祖先链累乘有效不透明度（opacity 不继承，只看元素自身会漏掉父级的淡出）。 */
      const effectiveOpacity = (el: Element): number => {
        let o = 1
        for (let n: Element | null = el; n !== null; n = n.parentElement) {
          const v = Number(getComputedStyle(n).opacity)
          if (!Number.isNaN(v)) o *= v
          if (o === 0) return 0
        }
        return o
      }

      interface BgResult {
        color: [number, number, number, number] | null
        undecidable: string
      }

      /**
       * 背景：把沿途半透明层依次合成，直到遇到不透明底。
       * 遇到渐变 / backdrop-filter 就返回"无法判定"——那种情况下真实底色取决于图层合成，
       * 不是取一个 background-color 能算出来的，硬算只会高估对比度（假绿）。
       */
      const resolveBackground = (el: Element, ownOpacity: number): BgResult => {
        let acc: [number, number, number, number] = [255, 255, 255, 1]
        const chain: Array<[number, number, number, number]> = []
        for (let node: Element | null = el; node !== null; node = node.parentElement) {
          const cs = getComputedStyle(node)
          if (node !== el && (cs.backgroundImage !== 'none' || cs.backdropFilter !== 'none')) {
            return {
              color: null,
              undecidable: `${describe(node)} 有渐变/backdrop-filter，底色需人工判定`,
            }
          }
          const bg = toRgb(cs.backgroundColor)
          if (bg !== null && bg[3] > 0) {
            // 祖先的淡出同样作用在这一层底色上；元素自身那层用自己累乘后的不透明度。
            const faded: [number, number, number, number] =
              node === el ? [bg[0], bg[1], bg[2], bg[3] * ownOpacity] : bg
            chain.push(faded)
          }
          if (bg !== null && bg[3] >= 0.9) break
        }
        for (const layer of chain.reverse()) acc = blend(layer, acc)
        return { color: acc, undecidable: '' }
      }

      const out: Array<{
        selector: string
        text: string
        color: string
        background: string
        ratio: number
      }> = []
      const undecidable: Array<{ selector: string; text: string; reason: string }> = []
      let checked = 0

      /** 一个"文字样本"：文本 + 颜色 + 字号/字重（决定 4.5 还是 3）。 */
      const samples: Array<{
        el: Element
        text: string
        color: string
        fontSize: number
        weight: number
      }> = []

      for (const el of Array.from(document.querySelectorAll<HTMLElement>('body *'))) {
        if (exemptSelectors.some((sel: string) => el.matches(sel))) continue
        const cs = getComputedStyle(el)
        if (cs.display === 'none' || cs.visibility === 'hidden') continue
        const rect = el.getBoundingClientRect()
        if (rect.width === 0 || rect.height === 0) continue
        const fontSize = Number.parseFloat(cs.fontSize)
        const weight = Number(cs.fontWeight) || 400

        const tag = el.tagName.toLowerCase()
        if (tag === 'input' || tag === 'textarea') {
          // 控件文字不在 TEXT_NODE 里（值是属性）——首版整片漏扫，而 placeholder 恰恰是
          // 登录/初始化页最容易掉到 AA 以下的一档灰。
          const field = el as HTMLInputElement | HTMLTextAreaElement
          const value = field.value ?? ''
          if (value.trim() !== '') {
            samples.push({ el, text: value.trim().slice(0, 30), color: cs.color, fontSize, weight })
          } else if (field.placeholder !== '') {
            const phColor = getComputedStyle(el, '::placeholder').color
            if (phColor !== '') {
              samples.push({
                el,
                text: `placeholder: ${field.placeholder.slice(0, 30)}`,
                color: phColor,
                fontSize,
                weight,
              })
            }
          }
          continue
        }

        // 只取"自己直接挂着文字"的元素，避免父容器被算两次
        const own = Array.from(el.childNodes)
          .filter((n) => n.nodeType === Node.TEXT_NODE)
          .map((n) => (n.textContent ?? '').trim())
          .join('')
        if (own.length === 0) continue
        samples.push({ el, text: own.slice(0, 30), color: cs.color, fontSize, weight })
      }

      for (const sample of samples) {
        const fgRaw = toRgb(sample.color)
        if (fgRaw === null) {
          undecidable.push({
            selector: describe(sample.el),
            text: sample.text,
            reason: `文字色无法解析：${sample.color}（门看不懂的颜色不许当通过）`,
          })
          continue
        }
        const opacity = effectiveOpacity(sample.el)
        if (opacity === 0) continue
        const bg = resolveBackground(sample.el, opacity)
        if (bg.color === null) {
          undecidable.push({
            selector: describe(sample.el),
            text: sample.text,
            reason: bg.undecidable,
          })
          continue
        }
        // 前景的 alpha（含祖先淡出）也要合成到底色上——首版只把 alpha 解析出来却不用它。
        const fg: [number, number, number, number] = [
          fgRaw[0],
          fgRaw[1],
          fgRaw[2],
          fgRaw[3] * opacity,
        ]
        const effective = fg[3] >= 1 ? fg : blend(fg, bg.color)
        const r = ratioOf(effective, bg.color)
        // 大字号按 SC 1.4.3 用 3:1（不是放宽，是原文判据）
        const large = sample.fontSize >= 24 || (sample.fontSize >= 18.66 && sample.weight >= 700)
        const threshold = large ? Math.min(minRatio, 3) : minRatio
        checked += 1
        if (r < threshold) {
          out.push({
            selector: describe(sample.el),
            text: sample.text,
            color: sample.color,
            background: `rgb(${Math.round(bg.color[0])}, ${Math.round(bg.color[1])}, ${Math.round(bg.color[2])})`,
            ratio: Math.round(r * 100) / 100,
          })
        }
      }
      return { offenders: out, undecidable, checked }
    },
    { minRatio: min, exemptSelectors: CONTRAST_EXEMPT.map((e) => e.selector) },
  )
}

/** 只取不达标项（需要细节时用 `sweepContrast`）。 */
export async function findContrastOffenders(page: Page, min = 4.5): Promise<ContrastOffender[]> {
  return (await sweepContrast(page, min)).offenders
}

/**
 * 断言当前页面没有对比度不达标的文字元素（失败时打印逐条明细，便于定位）。
 *
 * 三类失败分开报，因为修法完全不同：
 *   - 不达标：改颜色；
 *   - 无法判定：门看不懂（未解析颜色 / 渐变底）——要么改写法，要么显式登记例外；
 *   - 一条都没量到：说明扫描点在"页面还没渲染出内容"的时刻取样，是**假绿**，必须补等待。
 */
export async function expectNoContrastOffenders(page: Page, min = 4.5): Promise<void> {
  const { offenders, undecidable, checked } = await sweepContrast(page, min)
  expect(
    checked,
    `本次扫描一个文字元素都没量到（${page.url()}）——扫描点大概率取在页面渲染完成之前，` +
      `这种"全绿"是假绿。补一个内容可见的等待（例如等列表项/空态出现、等加载提示消失）。`,
  ).toBeGreaterThan(0)
  expect(
    undecidable,
    `对比度门无法判定的元素（看不懂的颜色 / 底色需人工判定）：\n${undecidable
      .map((u) => `  ${u.selector} "${u.text}" — ${u.reason}`)
      .join('\n')}`,
  ).toEqual([])
  expect(
    offenders,
    `对比度不达标的文字元素（正文 <${min}:1；大字号 <3:1）：\n${offenders
      .map((o) => `  ${o.selector} "${o.text}" color=${o.color} on ${o.background} → ${o.ratio}:1`)
      .join('\n')}`,
  ).toEqual([])
}
