/**
 * #167 文案判据自身的机器判据（unit project：纯函数，不需要浏览器）。
 *
 * 门最容易坏的方式不是"判据变红"，而是"判据恒绿"——所以这份文件两件事都钉：
 * 1. **旧文案必须变红**：把 #167 改动前 Agent 页/插件页的**逐字原文**喂进来，
 *    三条判据各自都要抓到（这是 e2e 红→绿实测的离线复现，跑 unit 就能重放）；
 * 2. **不该红的不能红**：CONTEXT.md 的正式领域词（Agent / Run / Plugin Pack…）、
 *    短摘要形态（`4d1be1bbe093…`）、正常的 h1 + 无关 h2 都不得命中——
 *    否则这条门会逼着后来的人把领域词也译成中文，与 #152 的口径相反。
 */
import { describe, expect, it } from 'vitest'
import {
  INTERNAL_TERMS,
  LONG_HEX_64,
  assertCopyCriteria,
  findBareLongDigests,
  findDuplicateHeadings,
  findInternalTerms,
  normalizeHeading,
  type HeadingInfo,
} from './copy-criteria.js'

/** 真实形态的 64 位摘要（与 dsh/registry 里的 SHA-256 hex 同形）。 */
const DIGEST_64 = '4d1be1bbe0933b9c2bd0e7f6b0e3aa1a4a0f8a1c8e6b7f5d3c2b1a09f8e7d6c5'
const DIGEST_PACK = 'd'.repeat(64)

describe('#167 文案判据（自身）', () => {
  it('64 位摘要形态：整串命中，短摘要与更长的串都不命中', () => {
    expect(LONG_HEX_64.test(DIGEST_64)).toBe(true)
    // 页面上的截断形态（当前实现）：不是裸摘要，必须放过
    expect(LONG_HEX_64.test(`${DIGEST_64.slice(0, 12)}…`)).toBe(false)
    // 整词边界：64 位以上/以下都不算"64 位摘要"
    expect(LONG_HEX_64.test('a'.repeat(65))).toBe(false)
    expect(LONG_HEX_64.test('a'.repeat(63))).toBe(false)
    // 含非十六进制字符（UUID、base32 配对码）不是摘要
    expect(LONG_HEX_64.test('f0000000-0000-4000-8000-000000000001')).toBe(false)
  })

  it('旧文案（#167 改动前）必须变红：插件页裸摘要两行 + curated + 同义标题', () => {
    // 逐字取自改动前的 PluginPackEditor.tsx / PluginSettings.tsx / AgentsPage+AgentList
    const before = [
      'Plugin Packs',
      'review-pack 1 个插件',
      'Pack ID',
      'dddddddd',
      'Pack Digest',
      `${DIGEST_PACK.slice(0, 12)}…`,
      '完整 Digest',
      `${DIGEST_PACK}`,
      'curated 目录暂无插件。',
    ].join('\n')
    const digestHits = findBareLongDigests(before)
    // 「完整 Digest」那一行是旧的正文形态：整串 64 位十六进制
    expect(digestHits).toHaveLength(1)
    expect(digestHits[0]?.rule).toBe('裸 64 位摘要进正文')
    expect(digestHits[0]?.text).toContain(DIGEST_PACK)

    const termHits = findInternalTerms(before)
    expect(termHits.map((hit) => hit.text)).toEqual(['curated 目录暂无插件。'])

    // 同义标题：h1 与紧随的 h2 写同一个词（#167 修法把页面标题写成 h1「Agents」，
    // 若谁再补一个区块标题「Agents」，这条判据当场变红）
    const headings: HeadingInfo[] = [
      { level: 1, text: 'Agents' },
      { level: 2, text: 'Agents' },
    ]
    expect(findDuplicateHeadings(headings)).toHaveLength(1)

    // 合成入口把三类一起报出来（e2e 失败信息就是这条）
    expect(() => assertCopyCriteria({ text: before, headings, label: '/plugins' })).toThrow(
      /#167 文案判据未通过（3 项）/,
    )
  })

  it('改动后的现文案必须全绿：截断摘要 + title（不在正文）+ 中文标题', () => {
    // 逐字取自改动后的 PluginPackEditor.tsx：正文只有短码，全值是 title 属性（不进 innerText）
    const after = [
      '插件组合（Plugin Pack）',
      'review-pack 1 个插件',
      'Pack ID',
      'dddddddd',
      '插件组合摘要（Pack Digest）',
      `${DIGEST_PACK.slice(0, 12)}…`,
      '创建时间',
      '昨天 09:30',
    ].join('\n')
    const headings: HeadingInfo[] = [
      { level: 1, text: '插件管理' },
      { level: 2, text: '插件目录' },
      { level: 2, text: '已安装插件' },
      { level: 2, text: '插件组合（Plugin Pack）' },
    ]
    expect(() => assertCopyCriteria({ text: after, headings, label: '/plugins' })).not.toThrow()
  })

  it('领域词不算泄漏：Agent / Run / Artifact / Plugin Pack / Profile Revision 都放过', () => {
    const domainText =
      '一个 Agent 是团队共用的长期 AI 角色。它每次运行（Run）用到的配置会被固化成一份不可变的 Profile Revision；' +
      '插件组合（Plugin Pack）由不可变的 Plugin Installation 组成；交付物（Artifact）保留来源 Run。'
    expect(findInternalTerms(domainText)).toEqual([])
    // 但真内部词仍要抓（词表不是摆设）
    expect(findInternalTerms('请先安装 curated 包。')).toHaveLength(1)
    expect(findInternalTerms('unreviewed 包不能进入普通 Pack')).toHaveLength(1)
  })

  it('「中文（English）」标签形态放过，裸词仍抓（实测逼出来的第二条口径）', () => {
    // 本仓库既定写法（CONTEXT.md：领域词保留英文时写成「中文（English）」）：
    // 英文词旁边就写着中文，是**对照**不是黑话。插件页的审核徽标本来就是这种形态。
    expect(findInternalTerms('local-development（本地开发）')).toEqual([])
    expect(findInternalTerms('本地开发包（local-development）：未经完整审核')).toEqual([])
    expect(findInternalTerms('精选（curated）包')).toEqual([])
    expect(findInternalTerms('curated（上游精选）')).toEqual([])

    // 裸词：没有中文兜着 → 抓。这三条就是 #167 截图里真实存在的旧文案。
    expect(findInternalTerms('curated 目录暂无插件。')).toHaveLength(1)
    expect(findInternalTerms('尚无已安装插件；请先在上方插件目录安装 curated 包。')).toHaveLength(1)
    expect(findInternalTerms('unreviewed 包不能进入普通 Pack')).toHaveLength(1)
    expect(findInternalTerms('这里只列上游精选过的插件（curated catalog）')).toHaveLength(1)

    // 已知放过的一类（诚实标注）：括号里只有 term、但括号属于前半句的散文写法
    // （`精选目录（curated）暂无插件`）。它与左标签形态字符串上无法区分——本次的
    // 处置是**不写这种散文**（空态写成「精选目录暂无插件」），判据只保证别退回裸词。
    expect(findInternalTerms('精选目录（curated）暂无插件。')).toEqual([])
  })

  it('零宽字符不能当绕过路径（\u200b 插在词里照样命中）', () => {
    // #167 一审 B2：`cur\u200bated` 在屏幕上与 `curated` 一模一样，但不做剥离时
    // 正则匹配不到 → 判据静默放过。剥离发生在判定之前（normalizeForCriteria）。
    expect(findInternalTerms('cur\u200bated 目录暂无插件。')).toHaveLength(1)
    expect(findInternalTerms('unre\u200dviewed 包不能进入普通 Pack')).toHaveLength(1)
    expect(findInternalTerms('local-\ufeffdevelopment（本地开发）')).toEqual([])
    // 摘要那条同样要穿过零宽字符
    const spaced = `${DIGEST_64.slice(0, 32)}\u200b${DIGEST_64.slice(32)}`
    expect(spaced).not.toBe(DIGEST_64)
    expect(findBareLongDigests(spaced)).toHaveLength(1)
  })

  it('内部词表每条都写清了理由（词表本身不许裸奔）', () => {
    expect(INTERNAL_TERMS.length).toBeGreaterThanOrEqual(1)
    for (const entry of INTERNAL_TERMS) {
      expect(entry.term, '词表项要有词').not.toBe('')
      expect(entry.why.length, `${entry.term} 的理由太短`).toBeGreaterThan(20)
      // 理由必须说明"它是什么标识"，而不是只写"不许出现"
      expect(entry.why).toMatch(/枚举|标识|目录|状态/)
    }
  })

  it('同义标题：只比 h1 与其后第一个 h2/h3，且要求相同或包含', () => {
    // 相同 → 命中
    expect(
      findDuplicateHeadings([
        { level: 1, text: 'Agents' },
        { level: 2, text: 'Agents' },
      ]),
    ).toHaveLength(1)
    // 包含 + 空白差异 → 命中（#167 的真实形态：h1 `Agents` 与紧随的 h2 `Agents`）
    expect(
      findDuplicateHeadings([
        { level: 1, text: 'Agents' },
        { level: 2, text: ' Agents ' },
      ]),
    ).toHaveLength(1)
    // 包含关系（英文领域词）：`Pack` ⊂ `Plugin Pack`
    expect(
      findDuplicateHeadings([
        { level: 1, text: 'Plugin Pack' },
        { level: 2, text: 'Pack' },
      ]),
    ).toHaveLength(1)
    // 已知抓不到的一类（诚实标注在判据注释里）：中英两套说法且互不包含。
    // 这里钉住"确实不报"，避免以后误以为它被覆盖了。
    expect(
      findDuplicateHeadings([
        { level: 1, text: 'Agent 管理' },
        { level: 2, text: 'Agents' },
      ]),
    ).toEqual([])
    // 同前缀但不同事的两个标题不是重复（插件页真实形态：h1「插件管理」+ h2「插件目录」）
    expect(
      findDuplicateHeadings([
        { level: 1, text: '插件管理' },
        { level: 2, text: '插件目录' },
      ]),
    ).toEqual([])
    // 无关标题 → 放过（页面深处的区块标题不该与页面标题互相比较）
    expect(
      findDuplicateHeadings([
        { level: 1, text: 'Agents' },
        { level: 2, text: 'Revision 是什么' },
        { level: 2, text: '已安装插件' },
      ]),
    ).toEqual([])
    // 太短的包含关系不算重复（「Run」⊥「运行中的 Run」这种正常修饰）
    expect(
      findDuplicateHeadings([
        { level: 1, text: 'Run' },
        { level: 2, text: '运行中的 Run' },
      ]),
    ).toEqual([])
    // 没有 h1 / 没有后续标题 → 无从判重，不报
    expect(findDuplicateHeadings([{ level: 2, text: 'Agents' }])).toEqual([])
    expect(findDuplicateHeadings([{ level: 1, text: 'Agents' }])).toEqual([])
  })

  it('标题归一化：空白与大小写不影响判定', () => {
    expect(normalizeHeading('  Agent   管理\n')).toBe('agent管理')
    expect(normalizeHeading('AGENTS')).toBe('agents')
  })

  it('失败信息能定位：元素/文本/期望三件都在', () => {
    let message = ''
    try {
      assertCopyCriteria({
        text: `完整 Digest ${DIGEST_64}`,
        headings: [
          { level: 1, text: 'Agents' },
          { level: 2, text: 'Agents' },
        ],
        label: '/agents',
      })
    } catch (error) {
      message = error instanceof Error ? error.message : ''
    }
    expect(message).toContain('[裸 64 位摘要进正文] /agents 页面可见文本')
    expect(message).toContain('实测文本：完整 Digest')
    expect(message).toContain('期望：摘要只以短码出现在正文')
    expect(message).toContain('[同义标题重复] /agents h1「Agents」与其后的 h2「Agents」')
    expect(message).toContain('期望：同一屏只留一个标题')
  })
})
