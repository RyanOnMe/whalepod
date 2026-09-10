/**
 * #167 文案判据（Q5 用）：把「人话不人话」从"我盯截图"变成机器判据。
 *
 * 为什么需要它：Agents 页与插件页是 2026-09-11 截图审查里唯一两页还像内部工具的地方
 * ——标题中英混杂、`curated` 这种上游目录标识直接当正文、64 位摘要整串铺在卡片里。
 * 这些**每个都躲过了既有门**：#138 的对比度判据只管颜色，p1-07 的零泄漏判据只扫
 * Task Room 与项目页，两页此前没有任何文案判据（#159 才刚给它们加对比度扫描点）。
 *
 * ## 三条判据与其口径（都是**位置敏感**的，不是"页面里不许有英文"）
 *
 * 1. **正文不得出现裸的 64 位十六进制**（SHA-256 摘要形态）。载体只取
 *    `document.body.innerText` —— 也就是浏览器认为**看得见**的文字。这条口径本身就是
 *    位置判据：`title` 属性、`display:none` / `visibility:hidden` / 零尺寸元素里的值
 *    都不进 innerText。所以「摘要截断显示 + 全值走 title + 一键复制」是**可判定**的：
 *    正文只剩 `4d1be1bbe093…`（带省略号，不是 64 位），全值在 title 里。
 * 2. **正文不得出现"裸的"内部词**。词表显式列在 INTERNAL_TERMS 里并逐条写理由——
 *    不是"不许出现英文"：`Agent` / `Run` / `Artifact` / `Plugin Pack` 是 CONTEXT.md 的
 *    正式领域词，保留英文不算泄漏；泄漏的是**内部实现标识被当人话**（上游目录名
 *    `curated`、审核枚举 `unreviewed`）。带上中文的对照标签（`local-development（本地开发）`）
 *    按 CONTEXT.md 的口径是合法写法，判据只抓没有中文兜着的裸词（口径见 findInternalTerms）。
 * 3. **同一屏不得有两个同义标题**：`h1` 与紧随其后的 `h2/h3` 文案相同、或一方包含
 *    另一方（如「Agent 管理」与「Agents」是两套语言说同一件事）。
 *
 * 判据失败信息必须能定位：每条都报**哪个元素、什么文本、期望什么**（六原语·归因）。
 *
 * ## 为什么本文件放在 tests/ 而不是 tests/e2e/
 *
 * 三条判据的核心是**纯函数**（喂文本与标题列表进去），纯函数才配得上"每次 Q0 都跑"。
 * vitest 的 unit project 显式排除了 e2e 目录（根 vitest.config.ts 的 exclude 里有
 * `tests/e2e`），放那儿等于这份判据只在真人手动跑 Q5 时才被检验一次。所以：纯函数 + 采集入口都放 `tests/`（unit project 收 `*.spec.ts`
 * 统一跑），e2e spec 从这里 import；本文导出的 `expectCopyCriteria` 才是 playwright 侧
 * 入口（它 import 了 playwright 的类型，只有 e2e 会用到）。
 *
 * ## 与 #159 对比度扫描的关系（不是重复造轮子）
 *
 * #159 的 `contrast-sweep.ts` 管颜色，本文件管文案；两者挂在**同一个位置**
 * （p1-142 的 390×844 循环里、逐页等内容渲染之后），扫描点相同、断言不同。本文不依赖
 * 那个模块（它落地在另一条分支上）：这里只需要 innerText 采集 + 三条断言，独立实现
 * 比跨分支耦合更稳。
 *
 * ## 已知盲区（诚实列出，别当成"通过"）
 *
 * - 只看 `innerText`：`aria-label`、`title`、`placeholder`、表单控件的 `value` 都不算正文
 *   （它们不是"人读到的正文"，但 `aria-label` 会进读屏——本判据不覆盖读屏文案）；
 * - 不做语言判定：只查显式词表（INTERNAL_TERMS）与两种形态（64 位十六进制、同义标题），
 *   不试图判断"这句话是不是人话"——那需要语义判断，机器判据给不出可信结论；
 * - 词表是**枚举**，新出现的内部词不会被自动抓到：加词要人改 INTERNAL_TERMS，
 *   所以新页面上线时该顺手补词表（本文件顶部就是唯一登记处）。
 */
import type { Page } from '@playwright/test'

/** 内部词表：命中即失败。每条写清「为什么它在表里」。 */
export interface InternalTerm {
  /** 要匹配的文本形态（大小写不敏感、整词匹配）。 */
  readonly pattern: RegExp
  /** 词本身，失败信息里指名道姓用。 */
  readonly term: string
  /** 为什么它在表里（不是"不许有英文"，而是"它是内部标识"）。 */
  readonly why: string
}

export const INTERNAL_TERMS: readonly InternalTerm[] = [
  {
    pattern: /\bcurated\b/i,
    term: 'curated',
    why:
      '上游插件目录/信任级别的内部标识（03 §2.5、packages/protocol 的 trust 枚举）。' +
      '用户看到「curated 目录暂无插件」不知道那是什么目录；页面必须给中文名' +
      '（「精选」／「精选目录（curated）」）。',
  },
  {
    pattern: /\bunreviewed\b/i,
    term: 'unreviewed',
    why:
      '审核状态枚举值（PluginReviewStatus）。同 curated：页面用「未审核（unreviewed）」' +
      '这类带中文的标签表达，不把裸枚举当正文。',
  },
  {
    pattern: /\blocal-development\b/i,
    term: 'local-development',
    why: '同一枚举的第三档（本地开发包）。裸枚举让人以为是个命令或路径。',
  },
  // 判据 1 已覆盖摘要形态，不再进词表（避免同一条问题报两次）。
]

/**
 * 64 位十六进制摘要（SHA-256 形态）。**必须整词**：`(?<![0-9a-f])` / `(?![0-9a-f])`
 * 两侧排除，否则 64 位以上的串（如 git sha 拼长、或 64 × 2 的拼接）会被截成假阳性，
 * 而 63 位以下的串本来就不该命中。
 */
export const LONG_HEX_64 = /(?<![0-9a-fA-F])[0-9a-fA-F]{64}(?![0-9a-fA-F])/

/** 判据失败项：能直接定位到元素与文本。 */
export interface CopyViolation {
  /** 判据名（对应上面三条之一），失败信息开头用它分组。 */
  readonly rule: '裸 64 位摘要进正文' | '内部词表命中' | '同义标题重复'
  /** 定位（元素描述：标签 + 类名/文本片段）。 */
  readonly where: string
  /** 命中的文本（截断展示）。 */
  readonly text: string
  /** 期望什么（人话，不含代码）。 */
  readonly expected: string
}

/** 纯函数：正文里的裸 64 位摘要。`text` 按行扫描，报出命中所在行。 */
export function findBareLongDigests(text: string): CopyViolation[] {
  const violations: CopyViolation[] = []
  for (const line of text.split('\n')) {
    const match = LONG_HEX_64.exec(line)
    if (match === null) continue
    violations.push({
      rule: '裸 64 位摘要进正文',
      where: '页面可见文本',
      text: trimForMessage(line),
      expected:
        '摘要只以短码出现在正文（如 4d1be1bbe093…），全值放 title 并提供一键复制；' +
        '被命中的这段是 64 位十六进制整串',
    })
  }
  return violations
}

/**
 * 纯函数：正文里的内部词。
 *
 * **「中文（English）」标签形态不算泄漏**：`local-development（本地开发）` 与
 * `本地开发包（local-development）` 这类写法是本仓库既定口径（CONTEXT.md：领域词保留
 * 英文时写成「中文（English）」），它给的是**对照**而不是黑话——那个英文词旁边就写着
 * 中文。所以判据是「裸词才算」，不是一个词出现在屏上就算。
 *
 * 判据口径（两条都要求英文词紧贴括号、括号里只有它）：
 *   - 左标签：`（local-development）` 直接跟在中文后面 → 放过；`（curated 目录）`
 *     这种括号里还有别的词 → 仍算裸词（旧文案就是这么写的）；
 *   - 右标签：`local-development（本地开发）` → 放过。
 * 这条口径是被实测逼出来的：第一版实现把 `curated` 写成「精选目录（curated）」，
 * 判据当场变红；反过来，插件页本来就有的 `local-development（本地开发）` 徽标
 * （#167 之前就有）不该被判成泄漏。两种形态都得有一套说得清的口径。
 */
export function findInternalTerms(text: string): CopyViolation[] {
  const violations: CopyViolation[] = []
  for (const line of text.split('\n')) {
    for (const entry of INTERNAL_TERMS) {
      if (!entry.pattern.test(line)) continue
      if (isGlossedTerm(line, entry.term)) continue
      violations.push({
        rule: '内部词表命中',
        where: '页面可见文本',
        text: trimForMessage(line),
        expected: `「${entry.term}」是内部标识，页面必须用中文（需要对照时可写成「中文（${entry.term}）」标签）`,
      })
    }
  }
  return violations
}

/**
 * 这一行里的 `term` 是不是「中文（English）」标签形态（它被中文标注，或它标注了中文）。
 *
 * 两种合法形态（都要求**括号里只有这个词**）：
 * - 左标签：`精选（curated）`、`本地开发包（local-development）`——term 前一小段里有中文
 *   （中文没有词间空格，所以"中文出现在附近"就意味着这个词被中文解释着）；
 * - 右标签：`local-development（本地开发）`——term 后紧跟以中文开头的全角括号。
 *
 * 括号里只有 term 这条不能省：`这里只列上游精选过的插件（curated catalog）` 的括号
 * 属于前半句，只是恰好包住了 term——不设这条会把裸词判成标签。
 *
 * **为什么需要这条规则**（两个方向的实测各撞过一次）：
 * ① 第一版实现把空态写成「精选目录（curated）暂无插件」，判据当场变红；
 * ② 但插件页本来就有的审核徽标是 `local-development（本地开发）`（#167 之前就有），
 *    它显然不是黑话——英文词旁边就写着中文。所以判据只能是「裸词才算」，
 *    而"裸"的判据就是这个词在屏上有没有中文兜着。
 */
function isGlossedTerm(line: string, term: string): boolean {
  const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  // 左标签：term 前 8 个字符内出现中文，且括号里只有 term（防 `（curated catalog）`）
  const leftLabel = new RegExp(
    `[\\u3400-\\u9fff][^（(]{0,8}[（(]\\s*${escaped}\\s*[）)]`,
    'i',
  ).test(line)
  if (leftLabel) return true
  // 右标签：term 后紧跟（以中文开头的短括号）
  return new RegExp(`${escaped}\\s*[（(]\\s*[\\u3400-\\u9fff][^）)]{0,20}[）)]`, 'i').test(line)
}

/** 标题摘要（判据 3 的输入）。 */
export interface HeadingInfo {
  readonly level: number
  readonly text: string
}

/** 标题归一化：去空白、统一小写——`Agents` 与 ` Agents ` 是同一个标题。 */
export function normalizeHeading(text: string): string {
  return text.replace(/\s+/g, '').toLowerCase()
}

/**
 * 纯函数：同屏两个同义标题。
 *
 * 口径（位置敏感）：只比 `h1` 与**紧随其后的下一个标题**（2–3 级）——同一屏开头连着
 * 两个说同一件事的标题才是"重复标题"；页面深处的 h2/h3（如「已安装插件」「Revision
 * 是什么」）与 h1 本来就不是同层，拿它们互相比较会造出假阳性。
 *
 * 「相同/包含关系」判定用双向 `includes`（长度 ≥4 才认包含，`Run` ⊂ `运行中的 Run`
 * 属于正常修饰而非重复）：#167 的修法把页面标题写成主导航同一套的 `Agents`，而原来那个
 * 重复的区块标题也叫 `Agents`——这条判据正是为它立的。
 *
 * **它抓不到什么**（诚实标注）：中英两套说法且互不包含的标题对（例如 `Agent 管理` 与
 * `Agents`——字符串上毫无关系，甚至也不算包含）。那类只能靠人看，机器给不出可信结论；
 * 本次是**先删掉重复标题**消除现象，判据负责"别再长回来"。
 */
export function findDuplicateHeadings(headings: readonly HeadingInfo[]): CopyViolation[] {
  const h1 = headings.find((heading) => heading.level === 1)
  if (h1 === undefined) return []
  const h1Text = normalizeHeading(h1.text)
  if (h1Text === '') return []
  const next = headings.find((heading) => heading.level > 1 && heading.level <= 3)
  if (next === undefined) return []
  const nextText = normalizeHeading(next.text)
  if (nextText === '') return []
  // 短文案（<4 字符）只认完全相等：「Run」⊂「运行中的 Run」这类是正常修饰，不是重复标题。
  const related =
    h1Text === nextText ||
    (Math.min(h1Text.length, nextText.length) >= 4 &&
      (h1Text.includes(nextText) || nextText.includes(h1Text)))
  if (!related) return []
  return [
    {
      rule: '同义标题重复',
      where: `h1「${h1.text}」与其后的 h${next.level}「${next.text}」`,
      text: `${h1.text} / ${next.text}`,
      expected:
        '同一屏只留一个标题：页面标题放 h1，紧随其后的区块标题要么删掉、要么换成不重复的内容',
    },
  ]
}

/** 失败信息里的文本片段：长文本截断，换行折成空格。 */
function trimForMessage(text: string, max = 120): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length <= max ? flat : `${flat.slice(0, max)}…`
}

/** 判据失败：带上全部违规项（定位 + 文本 + 期望）。 */
export class CopyCriteriaError extends Error {
  constructor(readonly violations: readonly CopyViolation[]) {
    super(
      [
        `#167 文案判据未通过（${violations.length} 项）：`,
        ...violations.map(
          (violation, index) =>
            `  ${index + 1}. [${violation.rule}] ${violation.where}\n` +
            `     实测文本：${violation.text}\n` +
            `     期望：${violation.expected}`,
        ),
      ].join('\n'),
    )
    this.name = 'CopyCriteriaError'
  }
}

/** 把三类违规合成一条错误信息（失败时一眼看到全部，不用跑第二遍）。 */
export function assertCopyCriteria(input: {
  text: string
  headings: readonly HeadingInfo[]
  /** 页面名（失败信息里定位是哪个页面）。 */
  label: string
}): void {
  const violations = [
    ...findBareLongDigests(input.text),
    ...findInternalTerms(input.text),
    ...findDuplicateHeadings(input.headings),
  ]
  if (violations.length > 0) {
    throw new CopyCriteriaError(
      violations.map((violation) => ({ ...violation, where: `${input.label} ${violation.where}` })),
    )
  }
}

/**
 * 浏览器侧采集 + 判定（Q5 调用入口）。
 *
 * 采集口径全部写在这里，调用方不自己拼 innerText：
 * - 正文 = `document.body.innerText`（用户看得见的文字，隐藏元素与 title 都不在内）；
 * - 标题 = DOM 顺序的 h1–h3，文案取 `innerText`（隐藏标题不进判据——它不在屏上）。
 *
 * 为什么不用 Playwright 的 locator 循环取标题：`innerText` 的"可见"口径是浏览器给的，
 * 自己按 locator 取会退化成"元素在不在 DOM 里"，与判据 1 的口径不一致。
 */
export async function expectCopyCriteria(page: Page, label: string): Promise<void> {
  const sample = await page.evaluate(() => {
    const headings: { level: number; text: string }[] = []
    for (const el of document.querySelectorAll('h1, h2, h3')) {
      // 只看**渲染出来**的标题：`display:none` 或零尺寸的标题不在屏上，与正文那条
      // 判据（innerText）口径一致；用 getClientRects 而不是 offsetParent，后者对
      // `position:fixed` 元素恒为 null，会把固定定位的标题误判成隐藏。
      if (el.getClientRects().length === 0) continue
      const text = el.textContent ?? ''
      if (text.trim() === '') continue
      headings.push({ level: Number(el.tagName.slice(1)), text })
    }
    // 正文取 <main>（页面主体），拿不到再退回 body：顶栏导航的文案不属于"这一页"，
    // 混进来会让同义标题判据比错对象。
    const scope = document.querySelector('main') ?? document.body
    return { text: scope.innerText, headings }
  })
  assertCopyCriteria({ ...sample, label })
}
