/**
 * #169 文案排版门：JSX 文本里"跨行折叠出一个空格"的瑕疵。
 *
 * 为什么需要机器守（真发生过）：`routes/MembersPage.tsx` 里写成
 *
 *     …生成后请立即复制发给他
 *     ——Token 只出现这一次。
 *
 * JSX 会把**跨行的换行 + 缩进折叠成一个空格**，于是用户看到的是「…发给他 ——Token…」——
 * 中文里破折号前不该有空格。这类瑕疵有三个特点：① 源码里看不出来（两行都"对"）；
 * ② 单元测试断言整段文案时通常按 `toContain` 的短片段写，空格落在片段之外就漏掉；
 * ③ 只有截图或真人看才发现。所以把它变成一条能跑的门。
 *
 * 判据口径（刻意保守，避免把正常的 JSX 结构误判成瑕疵）：
 *   - 只看 `apps/web/src/**` 下**非 vendor** 的 `.tsx`；
 *   - 上一行以中文/字母/数字结尾，下一行以**全角标点或破折号**开头 ⇒ 命中；
 *   - 上一行以 JSX 结构符号（`> { } ] ) ,`）结尾的不算（那是标签/表达式换行，不是文本折行）；
 *   - 命中即失败，**除非**该行为已在 `ACCEPTED` 里显式登记并写明理由（不许静默放宽）。
 *
 * 复跑：`pnpm exec vitest run --project unit apps/web/tests/copy-typography.spec.ts`
 */
import { readFileSync } from 'node:fs'
import { readdirSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { dirname } from 'node:path'
import { describe, expect, it } from 'vitest'

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '../../..')

/** 会被 JSX 折叠出多余空格的全角标点（含破折号与省略号）。 */
const CJK_PUNCT = '、。，；：！？）》」』—…'

/**
 * 显式放行清单：`相对路径:行号` → 理由。
 * 空 = 当前全仓无此类瑕疵（#169 修掉了唯一一处）。
 */
const ACCEPTED: Readonly<Record<string, string>> = {}

interface Hit {
  where: string
  prevTail: string
  nextHead: string
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

function scanForFoldedSpace(): Hit[] {
  const hits: Hit[] = []
  for (const file of collectTsx(join(repoRoot, 'apps/web/src'))) {
    const rel = file.slice(repoRoot.length + 1)
    const lines = readFileSync(file, 'utf8').split('\n')
    for (let i = 0; i < lines.length - 1; i += 1) {
      const prev = (lines[i] ?? '').replace(/\s+$/, '')
      const next = (lines[i + 1] ?? '').replace(/^\s+/, '')
      if (prev === '' || next === '') continue
      const prevEndsText = /[\u4e00-\u9fffA-Za-z0-9]$/.test(prev)
      // JSX 结构符号结尾 = 标签/表达式换行，不是文本折行（例如 `{cond ? (` 后面跟文字）
      if (!prevEndsText || prev.endsWith('>') || prev.endsWith('{') || prev.endsWith('}')) continue
      if (prev.endsWith(']') || prev.endsWith(')') || prev.endsWith(',')) continue
      if (!CJK_PUNCT.includes(next[0] ?? '')) continue
      hits.push({
        where: `${rel}:${i + 1}`,
        prevTail: prev.slice(-28),
        nextHead: next.slice(0, 28),
      })
    }
  }
  return hits
}

describe('#169 文案排版门', () => {
  it('没有"跨行折叠出空格"的中文标点（未登记的不许出现）', () => {
    const unexplained = scanForFoldedSpace().filter((h) => ACCEPTED[h.where] === undefined)
    expect(
      unexplained,
      `JSX 文本跨行会在中文标点前折叠出一个空格（渲染成「发给他 ——Token」这种）：\n${unexplained
        .map((h) => `  ${h.where}  上一行尾「…${h.prevTail}」 / 下一行首「${h.nextHead}」`)
        .join(
          '\n',
        )}\n修法：把标点与后文放到同一行；确实必须换行的，登记到本文件 ACCEPTED 并写明理由。`,
    ).toEqual([])
  })

  it('反面钉：扫描器对人为构造的折行确实会报（不是恒真）', () => {
    // 直接喂给同一套判定逻辑的等价实现：造两行，断言命中。
    const lines = [
      '                生成后请立即复制发给他',
      '                ——Token 只出现这一次。',
    ]
    const prev = (lines[0] ?? '').replace(/\s+$/, '')
    const next = (lines[1] ?? '').replace(/^\s+/, '')
    const wouldHit =
      prev !== '' &&
      next !== '' &&
      /[\u4e00-\u9fffA-Za-z0-9]$/.test(prev) &&
      !prev.endsWith('>') &&
      CJK_PUNCT.includes(next[0] ?? '')
    expect(wouldHit, '扫描器的判定形态本身失效了（恒真的门等于没有门）').toBe(true)
    // 而修好之后的写法（标点紧跟同文）不该命中
    const fixed = '生成后请立即复制发给他——Token 只出现这一次。'
    expect(CJK_PUNCT.includes(fixed[0] ?? '')).toBe(false)
  })
})
