/**
 * #169 文案排版门：JSX 文本里"跨行折叠出一个空格"的瑕疵。
 *
 * 为什么需要机器守（真发生过两处）：JSX 会把**跨行的换行 + 缩进折叠成一个空格**。
 *
 *   ① 破折号前多空格（`routes/MembersPage.tsx`）：源码写成
 *        …生成后请立即复制发给他
 *        ——Token 只出现这一次。
 *      渲染成「…发给他 ——Token…」——中文里破折号前不该有空格。
 *   ② 句号后多空格（`features/run/RunFailureNotice.tsx`，一审复审时抓到的同类第二处）：
 *      源码写成「…外部系统调用等）。」换行接「系统不会自动重放…」，渲染成
 *      「…调用等）。 系统不会…」——空格被插在**全角句号之后**。
 *
 * 这类瑕疵有三个特点：① 源码里看不出来（两行都"对"）；② 按短片段 `toContain` 断言的
 * 单测漏得掉（空格落在片段之外）；③ 只有截图或真人读才发现。所以把它变成一条能跑的门。
 *
 * ## 判据口径（两条规则，都要求"空格确实会被折叠进去"）
 *
 * - **规则 A（标点开头）**：上一行以中文/字母/数字结尾（且不是 JSX 结构符号），下一行以
 *   全角标点或全角左括号开头 ⇒ 命中；
 * - **规则 B（标点结尾）**：上一行以全角句末/句中标点结尾，下一行以中文字符开头 ⇒ 命中
 *   （渲染出「。 系统」这种句号后带空格）。
 *
 * 排除与放行：
 * - 上一行以 JSX 结构符号（`> { } ] ) ,` 或反引号/`(`）结尾的不算——那是标签/表达式换行；
 * - **先剥注释再扫**：块注释、JSX 注释里的折行与渲染无关（一审实测出误报）；
 * - 命中即失败，**除非**该行在 `ACCEPTED` 里登记了**非空**理由（空字符串不算理由，一审实测
 *   过"登记成 '' 就放行"这条漏洞）；登记项若**已不再命中**也会失败（防止过期登记静默放行）；
 * - 扫描面：`apps/web/src/**` 下非 vendor 的 `.tsx`（仓库全部 `.tsx` 都在这里；`.ts` 里的
 *   模板字符串也可以承载文案，属已知未覆盖面，见 docs/agent/ 的登记）。
 *
 * 复跑：`pnpm exec vitest run --project unit apps/web/tests/copy-typography.spec.ts`
 */
import { readFileSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '../../..')

/** 下一行以这些字符开头 = 标点被折到了行首（规则 A）。含全角左括号与开引号。 */
const LEADING_PUNCT = '、。，；：！？）》」』】》—…「（《【'

/** 上一行以这些字符结尾 = 标点后折行，空格会被插在标点之后（规则 B）。 */
const TRAILING_PUNCT = '。！？；：，、）'

/** JSX 结构符号：这些结尾表示换行发生在标签/表达式之间，不是文本折行。 */
const STRUCTURAL_TAIL = ['>', '{', '}', ']', ')', ',', '`', '(']

const CJK_OR_WORD = /[\u4e00-\u9fffA-Za-z0-9]$/
const CJK_START = /^[\u4e00-\u9fff]/

/**
 * 显式放行清单：`相对路径:行号` → 理由（**必须非空**）。
 * 空 = 当前全仓无此类瑕疵。
 */
const ACCEPTED: Readonly<Record<string, string>> = {}

export interface FoldHit {
  where: string
  rule: 'A 标点开头' | 'B 标点结尾'
  prevTail: string
  nextHead: string
}

/** 把块注释内容替换成等长空白（**保留换行**，好让行号仍然准确）。 */
export function stripBlockComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
}

/**
 * 纯函数：给一段**已按行拆好**的文本找折行瑕疵。
 * 抽成纯函数是为了让"反面钉"能调用**真实逻辑**（首版把判定条件在测试里手抄了一份子集，
 * 一审实测：把真实函数的守卫全删掉，钉子照样绿——那种钉子保护不了它声称保护的东西）。
 */
export function findFoldedSpaceInLines(lines: readonly string[]): FoldHit[] {
  const hits: FoldHit[] = []
  for (let i = 0; i < lines.length - 1; i += 1) {
    const rawPrev = (lines[i] ?? '').replace(/\s+$/, '')
    const rawNext = (lines[i + 1] ?? '').replace(/^\s+/, '')
    if (rawPrev === '' || rawNext === '') continue
    // 注释行（块注释内容已被剥成空白，这里再挡掉 `*`/`//` 开头的行）
    if (/^(\*|\/\/)/.test(rawPrev) || /^(\*|\/\/)/.test(rawNext)) continue
    const prev = rawPrev.trimStart()
    if (STRUCTURAL_TAIL.some((tail) => prev.endsWith(tail))) continue
    const head = rawNext[0] ?? ''
    const tail = prev[prev.length - 1] ?? ''
    if (CJK_OR_WORD.test(prev) && LEADING_PUNCT.includes(head)) {
      hits.push({
        where: `${i + 1}`,
        rule: 'A 标点开头',
        prevTail: prev.slice(-28),
        nextHead: rawNext.slice(0, 28),
      })
      continue
    }
    if (TRAILING_PUNCT.includes(tail) && CJK_START.test(rawNext)) {
      hits.push({
        where: `${i + 1}`,
        rule: 'B 标点结尾',
        prevTail: prev.slice(-28),
        nextHead: rawNext.slice(0, 28),
      })
    }
  }
  return hits
}

function collectTsx(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'vendor' || entry.name === 'node_modules') continue
    const full = join(dir, entry.name)
    if (entry.isDirectory()) collectTsx(full, out)
    else if (entry.name.endsWith('.tsx')) out.push(full)
  }
  return out
}

/** 扫真实仓库（剥注释后按行判定），返回 `相对路径:行号` 形态的命中。 */
export function scanRepoForFoldedSpace(): Array<FoldHit & { file: string; key: string }> {
  const out: Array<FoldHit & { file: string; key: string }> = []
  for (const file of collectTsx(join(repoRoot, 'apps/web/src'))) {
    const rel = file.slice(repoRoot.length + 1)
    const text = stripBlockComments(readFileSync(file, 'utf8'))
    for (const hit of findFoldedSpaceInLines(text.split('\n'))) {
      out.push({ ...hit, file: rel, key: `${rel}:${hit.where}` })
    }
  }
  return out
}

describe('#169 文案排版门', () => {
  const hits = scanRepoForFoldedSpace()

  it('没有"跨行折叠出空格"的中文标点（未登记的不许出现）', () => {
    const unexplained = hits.filter((h) => (ACCEPTED[h.key] ?? '').trim() === '')
    expect(
      unexplained,
      `JSX 文本跨行会在中文标点处折叠出一个空格（渲染成「发给他 ——Token」/「调用等）。 系统」这类）：\n${unexplained
        .map(
          (h) => `  ${h.key}  [${h.rule}]  上一行尾「…${h.prevTail}」 / 下一行首「${h.nextHead}」`,
        )
        .join(
          '\n',
        )}\n修法：把折行点挪到标点之前（标点与后文放同一行）；确实需要这个空格的，登记到本文件 ACCEPTED 并写明理由（空理由不算）。`,
    ).toEqual([])
  })

  it('登记项没有过期（已不再命中的登记会让门静默放宽）', () => {
    const live = new Set(hits.map((h) => h.key))
    const stale = Object.keys(ACCEPTED).filter((key) => !live.has(key))
    expect(
      stale,
      `ACCEPTED 里的登记已不再命中（代码改了、行号漂了？）：${stale.join(', ')}——请删掉或更新，别让它挡住新瑕疵`,
    ).toEqual([])
  })

  it('反面钉：把两种真实形态喂给**真实判定函数**，都必须命中（不是恒真）', () => {
    // 规则 A：破折号被折到行首（MembersPage 那处的原形态）
    const ruleA = findFoldedSpaceInLines([
      '                生成后请立即复制发给他',
      '                ——Token 只出现这一次。',
    ])
    expect(ruleA.map((h) => h.rule)).toEqual(['A 标点开头'])

    // 规则 B：句号后折行（RunFailureNotice 那处的原形态）
    const ruleB = findFoldedSpaceInLines([
      '        这个 Run 崩溃前可能已执行过有副作用的工具（写文件、网络请求等）。',
      '        系统不会自动重放这些操作。',
    ])
    expect(ruleB.map((h) => h.rule)).toEqual(['B 标点结尾'])

    // 对照：JSX 结构换行（标签/表达式之间）不得命中——否则门会把正常代码判红
    const structural = findFoldedSpaceInLines([
      '        {cond ? (',
      '          文本',
      '        ) : (',
      '          另一段文本,',
      '        )}',
      '      </div>',
      '      <div className="x">',
      '        中文文案——不折行',
    ])
    expect(structural, '结构符号结尾的换行被误判为文本折行').toEqual([])

    // 对照：修好之后的写法（标点与后文同文）不得命中。
    // 注意第二行**不能以全角句号结尾**——那会落进规则 B（渲染出「。 下一行」），是真实命中；
    // 这正是本门的"边界在哪"：折行点不许落在标点上，跟标点在同侧才安全。
    // 用**真实修好后的字节**（MembersPage 那段现在的折行点落在「72 / 小时后失效」之间，
    // 边界上没有标点），而不是我编的句子——编句子容易编出一个自己就违规的对照。
    const fixed = findFoldedSpaceInLines([
      '                  选一个角色生成邀请链接。链接只能使用一次，72',
      '                  小时后失效；生成后请立即复制发给他——Token 只出现这一次。',
    ])
    expect(fixed).toEqual([])

    // 规则 B 的边界演示：行尾落在句号上会被如实抓住（不是误报）
    const bBoundary = findFoldedSpaceInLines([
      '        上一句到这里结束。',
      '        下一句从新的一行开始',
    ])
    expect(bBoundary.map((h) => h.rule)).toEqual(['B 标点结尾'])
  })

  it('反面钉：注释里的折行不算（剥注释后再判定）', () => {
    const withComment = stripBlockComments(
      ['/* 说明：这一行以句号结尾。', '   下一行是注释，渲染无关 */', 'const a = 1'].join('\n'),
    )
    expect(findFoldedSpaceInLines(withComment.split('\n'))).toEqual([])
  })
})
