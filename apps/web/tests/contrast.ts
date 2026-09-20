/**
 * 对比度（WCAG 2.1 AA）计算，供 #138 的两处判据共用：
 * - 单测 apps/web/tests/vendor-dsh-ui.spec.tsx：从 CSS 文本取色值算「文字 vs 浅底」；
 * - Q5 apps/web/tests/e2e/pairing-ui.spec.ts：从真实页面读 token 解析值再算一次。
 *
 * 为什么单独一个文件：判据要在「源码文本」和「浏览器实测」两条路径上用同一套算法，
 * 各写一份迟早漂移。这里只做纯函数，不碰 DOM/文件系统。
 *
 * 公式按 WCAG 2.1 相对亮度：https://www.w3.org/TR/WCAG21/#dfn-relative-luminance
 *   c_srgb = c/255；c_lin = c_srgb/12.92 (c_srgb ≤ 0.03928)
 *                     ((c_srgb+0.055)/1.055)^2.4 (否则)
 *   L = 0.2126 R + 0.7152 G + 0.0722 B
 *   对比度 = (L_light + 0.05) / (L_dark + 0.05)
 */

export interface Rgba {
  r: number
  g: number
  b: number
  /** 0..1 */
  a: number
}

export interface Rgb {
  r: number
  g: number
  b: number
}

/** 解析 CSS 颜色：`rgb()`/`rgba()`/(含空格与 `/` 语法) 与 `color(srgb …)`。解析不了就抛。 */
export function parseCssColor(text: string): Rgba {
  const value = text.trim()
  const rgb = /^rgba?\(([^)]+)\)$/i.exec(value)
  if (rgb?.[1] !== undefined) {
    const [channels = '', alpha] = rgb[1].split('/')
    const parts = channels
      .trim()
      .split(/[\s,]+/)
      .filter((p) => p !== '')
    const [r, g, b] = parts.slice(0, 3)
    if (r === undefined || g === undefined || b === undefined) {
      throw new Error(`解析不了的颜色：${text}`)
    }
    return {
      r: channel(r),
      g: channel(g),
      b: channel(b),
      a:
        alpha === undefined
          ? parts[3] === undefined
            ? 1
            : alphaValue(parts[3])
          : alphaValue(alpha),
    }
  }
  const srgb = /^color\(srgb\s+([^)]+)\)$/i.exec(value)
  if (srgb?.[1] !== undefined) {
    const [channels = '', alpha] = srgb[1].split('/')
    const [r, g, b] = channels
      .trim()
      .split(/\s+/)
      .map((p) => Number.parseFloat(p))
    if (r === undefined || g === undefined || b === undefined || Number.isNaN(r + g + b)) {
      throw new Error(`解析不了的颜色：${text}`)
    }
    return { r: r * 255, g: g * 255, b: b * 255, a: alpha === undefined ? 1 : alphaValue(alpha) }
  }
  throw new Error(`解析不了的颜色：${text}`)
}

/** 通道值：`51` 或 `20%` 都接受（CSS Color 4 允许百分比）。 */
function channel(part: string): number {
  return part.endsWith('%') ? (Number.parseFloat(part) / 100) * 255 : Number.parseFloat(part)
}

/** alpha 值：`0.1` 或 `10%` 都接受。 */
function alphaValue(part: string): number {
  const trimmed = part.trim()
  return trimmed.endsWith('%') ? Number.parseFloat(trimmed) / 100 : Number.parseFloat(trimmed)
}

/** 半透明色叠到不透明底色上（普通 alpha 合成），返回不透明结果。 */
export function compositeOver(color: Rgba, background: Rgb): Rgb {
  return {
    r: color.r * color.a + background.r * (1 - color.a),
    g: color.g * color.a + background.g * (1 - color.a),
    b: color.b * color.a + background.b * (1 - color.a),
  }
}

export const WHITE: Rgb = { r: 255, g: 255, b: 255 }

/** WCAG 2.1 相对亮度（0..1）。 */
export function relativeLuminance(color: Rgb): number {
  const lin = (c: number): number => {
    const srgb = c / 255
    return srgb <= 0.03928 ? srgb / 12.92 : ((srgb + 0.055) / 1.055) ** 2.4
  }
  return 0.2126 * lin(color.r) + 0.7152 * lin(color.g) + 0.0722 * lin(color.b)
}

/** 两色对比度（1..21）。 */
export function contrastRatio(a: Rgb, b: Rgb): number {
  const la = relativeLuminance(a)
  const lb = relativeLuminance(b)
  const [light, dark] = la >= lb ? [la, lb] : [lb, la]
  return (light + 0.05) / (dark + 0.05)
}

/**
 * 「同色 10% 浅底叠白」上放该色文字时的对比度——Tag 的 success/danger 就是这条形态
 * （`color-mix(in srgb, <token> 10%, transparent)` 落在白卡片上）。
 * @param tint 混合比例（Tag 里 success 10%、warning 12%、danger 10%）
 * @param surface 卡片底色（本仓列表在白卡片上，取白）
 */
export function contrastOnTint(color: Rgb, tint: number, surface: Rgb = WHITE): number {
  const background = compositeOver({ ...color, a: tint }, surface)
  return contrastRatio(color, background)
}

/** 取整到两位小数，便于写进注释与断言消息。 */
export function round2(value: number): number {
  return Math.round(value * 100) / 100
}

/**
 * 从 CSS 文本里取变量定义值（`:root` 段在前，取第一处即可）。
 * @param cssText 例如 dsw-tokens.css 的全文
 * @param name 含 `--` 前缀的变量名
 */
export function readTokenValue(cssText: string, name: string): string {
  const match = new RegExp(`${name}\\s*:\\s*([^;]+);`).exec(cssText)
  if (match?.[1] === undefined) throw new Error(`CSS 里找不到 ${name}`)
  return match[1].trim()
}

/**
 * 取深色主题下变量的**生效值**（#214 A 方案：门不再只按白底算）。
 *
 * 与 focus-ring 的 `resolveTokenValue(token, dark)` 同一语义：先取该变量在
 * `body[data-ds-dark-theme]` 段里的重定义（无则回落浅色值——tokens 文件注释写明
 * "两套取值相同的变量不重复声明"），再沿 var() 链跟进、**每一跳都优先深色段**
 * （最多 4 跳，与 focus-ring 同上限）。单跳实现曾在这里错过 alias→alias 链
 * （`--dsw-specific-menu → --dsw-alias-bg-layer-3` 取成浅色白，评审 S1 抓到），
 * 所以不要退回单跳。
 *
 * `body[data-ds-dark-theme]` 段本身缺失时抛错（与 focus-ring 同形态）：静默回落
 * 浅色会让深色门按浅色算出全绿、悄悄变盲（评审 S3）。单 token 无重定义则回落浅色，
 * 那是 CSS 语义（浏览器里就是这个行为），不是 fail-open。
 */
export function readTokenValueDark(cssText: string, name: string): string {
  const darkBlock = /body\[data-ds-dark-theme\]\s*\{([\s\S]*?)\n\}/.exec(cssText)?.[1]
  if (darkBlock === undefined) {
    throw new Error('dsw-tokens.css 里找不到 body[data-ds-dark-theme] 段')
  }
  const readOrNull = (block: string, token: string): string | null =>
    new RegExp(`${token}\\s*:\\s*([^;]+);`).exec(block)?.[1]?.trim() ?? null
  let value = readOrNull(darkBlock, name) ?? readTokenValue(cssText, name)
  for (let hop = 0; hop < 4; hop += 1) {
    const target = /^var\((--[a-z0-9-]+)\)$/i.exec(value.trim())?.[1]
    if (target === undefined) break
    value = readOrNull(darkBlock, target) ?? readTokenValue(cssText, target)
  }
  return value.trim()
}

/**
 * 取 Tag 里某个 tone 的浅底混合比例（success 10% / warning 12% / danger 10%）。
 * 比例不抄死在测试里：Tag.module.css 改了比例，判据跟着变。
 * @param tagCssText Tag.module.css 全文
 * @param tone `data-tone` 的取值
 * @returns 0..1 的比例
 */
export function readToneTintPercent(tagCssText: string, tone: string): number {
  const body = new RegExp(`data-tone='${tone}'\\]\\s*\\{([^}]*)\\}`).exec(tagCssText)?.[1]
  if (body === undefined) throw new Error(`Tag.module.css 里找不到 tone=${tone} 的规则`)
  const percent = /(\d+(?:\.\d+)?)%/.exec(body)?.[1]
  if (percent === undefined) throw new Error(`tone=${tone} 的规则里没有 color-mix 比例`)
  return Number.parseFloat(percent) / 100
}
