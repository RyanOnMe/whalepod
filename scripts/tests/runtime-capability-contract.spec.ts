/**
 * Runtime Capability Contract 的**文档漂移哨兵**（A0-6 / #288 家族）。
 *
 * 外部审查抓到的治理病是「文档写 G0/必跑/有判据，机器侧却什么都没跑」
 * （见 `docs/agent/runtime-capability-contract.md` 第四节）。本 spec 让那份契约表
 * 自己带上机器判据——它引用的东西必须真实、且不许拿含糊话冒充覆盖：
 *
 *   1. 表里反引号里的**每个文件路径**必须真实存在（改名/删文件/打字错不改文档 = 红；
 *      第一版只匹配 `.spec.ts`，把 `agent-control.contract.spec-TYPO.ts` 这种写歪的
 *      路径漏成假绿，故改为「表内所有反引号路径」）；
 *   2. 引用的每个 `pnpm <script>` / `bash <path>` 必须真实存在；
 *   3. 六项能力与四条熔断规则必须齐全（表被删行 = 红）；
 *   4. 标「未覆盖/缺口/部分」的行必须挂 Issue 号（`#123`）——「不知道谁修」不许过；
 *   5. 非空（引用数下界）：防止把表清空来变绿。
 *
 * 变绿的唯一方式：要么补上真判据，要么老实写「未覆盖 + 已立账的 Issue 号」。
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const REPO_ROOT = fileURLToPath(new URL('../..', import.meta.url))
const CONTRACT_DOC = join(REPO_ROOT, 'docs/agent/runtime-capability-contract.md')

/** 六项能力（总纲 §工程治理原文用词）与四条熔断规则。 */
const REQUIRED_CAPABILITIES = [
  'sessionResume',
  '单 Run 隔离',
  '中断模式',
  '审批桥',
  '指令回执',
  '事件流范围',
] as const
const REQUIRED_FUSE_RULES = [
  '未知事件不给权',
  '建不起归属不确认成功',
  '敏感不兼容禁启动',
  '升级失败回滚固定版',
] as const

/** 反引号里的文件路径（表内引用面）：带目录或裸文件名都要能被看见。 */
const BACKTICKED_FILE_RE = /`([A-Za-z0-9_.\-/]+\.(?:ts|tsx|mts|md|json|ya?ml|sh))`/g
const SPEC_FILE_RE = /\.spec\.ts$/
const PNPM_CMD_RE = /`pnpm ([a-z0-9:_\-]+)`/g
const BASH_CMD_RE = /`bash ([A-Za-z0-9_.\-/]+)`/g
const ISSUE_RE = /#\d+/
/** 「这一行没被机器钉住」的说法：必须同时出现 Issue 号。 */
const UNCOVERED_RE = /未覆盖|缺口|部分[：:]?/

export interface ContractInputs {
  doc: string
  /**
   * 路径 → 是否存在（注入以便自证，不依赖真实磁盘）。
   * 语义：带 `/` 的按仓库根相对路径判；裸文件名按「仓库里有没有同名文件」判——
   * 正文里写 `approval.contract.spec.ts` 这类简写是常态，但**改名必须让哨兵红**。
   */
  exists: (relPath: string) => boolean
  /** package.json scripts 名集合。 */
  knownScripts: ReadonlySet<string>
  /** 引用数下界（spec 文件）。 */
  minSpecCitations?: number
}

/** 纯函数：返回全部违规（空数组 = 契约表可信）。 */
export function findContractViolations(input: ContractInputs): string[] {
  const violations: string[] = []
  const files = new Set([...input.doc.matchAll(BACKTICKED_FILE_RE)].map((match) => match[1]!))
  const specFiles = [...files].filter((relPath) => SPEC_FILE_RE.test(relPath))
  const minSpecs = input.minSpecCitations ?? 6
  if (specFiles.length < minSpecs) {
    violations.push(
      `契约表引用的判据文件太少（${specFiles.length} < ${minSpecs}）——表被清空或写坏了？`,
    )
  }
  for (const relPath of files) {
    if (!input.exists(relPath)) violations.push(`引用了不存在的文件：${relPath}`)
  }
  for (const [, name] of input.doc.matchAll(PNPM_CMD_RE)) {
    if (!input.knownScripts.has(name!))
      violations.push(`引用了 package.json 里没有的脚本：pnpm ${name}`)
  }
  for (const [, path] of input.doc.matchAll(BASH_CMD_RE)) {
    if (!input.exists(path!)) violations.push(`引用了不存在的脚本：bash ${path}`)
  }
  for (const capability of REQUIRED_CAPABILITIES) {
    if (!input.doc.includes(capability)) violations.push(`缺能力行：${capability}`)
  }
  for (const rule of REQUIRED_FUSE_RULES) {
    if (!input.doc.includes(rule)) violations.push(`缺熔断规则行：${rule}`)
  }
  const rows = input.doc
    .split('\n')
    .filter((line) => line.startsWith('|') && !/^\|[\s\-:|]+\|$/.test(line))
  for (const row of rows) {
    if (UNCOVERED_RE.test(row) && !ISSUE_RE.test(row)) {
      violations.push(`承认未覆盖却无 Issue 号：${row.trim().slice(0, 120)}`)
    }
  }
  return violations
}

describe('runtime capability contract 的真实性（A0-6 文档漂移哨兵）', () => {
  const doc = readFileSync(CONTRACT_DOC, 'utf8')
  const packageScripts = new Set(
    Object.keys(
      (
        JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf8')) as {
          scripts: Record<string, string>
        }
      ).scripts,
    ),
  )
  // 裸文件名要走「全仓同名查找」：一次遍历建成 basename 集合（跳过 node_modules/dist/.git）。
  const basenames = new Set<string>()
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === 'node_modules' || entry.name === 'dist' || entry.name === '.git') continue
      const full = join(dir, entry.name)
      if (entry.isDirectory()) walk(full)
      else basenames.add(entry.name)
    }
  }
  walk(REPO_ROOT)
  const exists = (relPath: string): boolean =>
    relPath.includes('/') ? existsSync(join(REPO_ROOT, relPath)) : basenames.has(relPath)

  it('当前契约表无违规', () => {
    const violations = findContractViolations({ doc, exists, knownScripts: packageScripts })
    expect(violations, `契约表违规：\n${violations.join('\n')}`).toEqual([])
  })

  it('自证：写歪的路径、缺 Issue 的「未覆盖」、名字错的脚本都必须被抓到', () => {
    const base = [
      '| 能力 | 判定命令 | 判据文件 | 覆盖状态 |',
      '| --- | --- | --- | --- |',
      '| sessionResume | `pnpm test:dsh-contract` | `a/b/c.spec.ts` | 有判据 |',
      '| 单 Run 隔离 | `pnpm test:dsh-contract` | `a/b/d.spec.ts` | 有判据 |',
      '| 中断模式（cancel） | `pnpm test:dsh-contract` | `a/b/e.spec.ts` | 有判据 |',
      '| 审批桥 | `pnpm test:dsh-contract` | `a/b/f.spec.ts` | 有判据 |',
      '| 指令回执 | `pnpm test:dsh-contract` | `a/b/g.spec.ts` | 有判据 |',
      '| 事件流范围 | `pnpm test:dsh-contract` | `a/b/h.spec.ts` | 有判据 |',
      '| 未知事件不给权 | `pnpm test:dsh-contract` | `a/b/i.spec.ts` | 有判据 |',
      '| 建不起归属不确认成功 | `pnpm test:dsh-contract` | `a/b/j.spec.ts` | 有判据 |',
      '| 敏感不兼容禁启动 | `pnpm test:dsh-contract` | `a/b/k.spec.ts` | 有判据 |',
      '| 升级失败回滚固定版 | `pnpm test:dsh-contract` | `a/b/l.spec.ts` | 有判据 |',
    ].join('\n')
    // 假 exists：样本里全部路径都存在，除了显式写歪的那两个（TYPO / nope）。
    const okInputs = {
      exists: (relPath: string) => !/TYPO|nope/.test(relPath),
      knownScripts: new Set(['test:dsh-contract']),
      minSpecCitations: 6,
    }
    // 干净样本：零违规（否则下面的「抓到」没有意义）。
    expect(findContractViolations({ doc: base, ...okInputs })).toEqual([])

    expect(
      findContractViolations({
        doc: base.replace('a/b/c.spec.ts', 'a/b/c.spec-TYPO.ts'),
        ...okInputs,
      }).some((entry) => entry.includes('c.spec-TYPO.ts')),
    ).toBe(true)

    expect(
      findContractViolations({
        doc: base.replace('| 有判据 |', '| 部分：竞态未覆盖 |'),
        ...okInputs,
      }).some((entry) => entry.includes('无 Issue 号')),
    ).toBe(true)

    expect(
      findContractViolations({
        doc: base
          .replace('pnpm test:dsh-contract', 'pnpm test:nope')
          .replace(/pnpm test:dsh-contract/g, 'pnpm test:nope'),
        ...okInputs,
      }).some((entry) => entry.includes('test:nope')),
    ).toBe(true)

    // 表被清空（引用数掉到下界以下）也要红。
    expect(
      findContractViolations({ doc: '什么都没有', ...okInputs }).some((entry) =>
        entry.includes('判据文件太少'),
      ),
    ).toBe(true)
  })
})
