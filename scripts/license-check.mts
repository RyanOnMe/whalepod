/**
 * 依赖许可 gate（#24 交付⑥，挂 Q7 家族第四半边）。
 *
 * 判据（本脚本即 SSoT，04 无既有 §——落地时定义于此并回链）：
 * 1. **禁用面**：强 copyleft（GPL/AGPL/SSPL 系）直接红——项目根 Apache-2.0，
 *    分发形态（Docker 镜像 + 源码安装）会把它变成传染问题；
 * 2. **弱 copyleft 默认禁、白名单放行**：LGPL 组件必须以**未修改的二进制 +
 *    动态链接**形态使用且写明来源链（libvips 经 sharp 即此形态）；MPL-2.0 是
 *    文件级（npm 分发不传染），直接列允许；
 * 3. **UNKNOWN 一律红**：许可不明 = 不可分发，人工核对后显式入名单才放行；
 * 4. 白名单必须带 `via`（依赖链）与 `rationale`（法据）——裸包名条目不放行。
 */
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO_ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..')

export interface LicenseInput {
  [licenseId: string]: Array<{ name: string }>
}

export interface AcceptedEntry {
  package: string
  license: string
  via: string
  rationale: string
}

const PERMISSIVE = new Set([
  'MIT',
  'MIT-0',
  'Apache-2.0',
  'BSD-2-Clause',
  'BSD-3-Clause',
  'ISC',
  'CC0-1.0',
  '0BSD',
  'Unlicense',
  'Python-2.0', // PSF 许可（argparse 移植），发布无义务
  'BlueOak-1.0.0', // npm 生态自有短许可（@isaacs 系工具包）
  'MPL-2.0', // 文件级弱 copyleft：不改其源文件即零传染（lightningcss/vite 链）
])

export function evaluateLicenses(
  input: LicenseInput,
  accepted: AcceptedEntry[],
): { violations: string[]; checked: number } {
  // package 允许尾部 `*` 前缀通配（同一组件的平台变体族共享判据，见 libvips 条目）。
  const acceptedMatchers = accepted.map((a) => ({
    license: a.license,
    prefix: a.package.endsWith('*') ? a.package.slice(0, -1) : null,
    exact: a.package.endsWith('*') ? null : a.package,
  }))
  const isAccepted = (name: string, license: string) =>
    acceptedMatchers.some(
      (m) =>
        m.license === license &&
        (m.exact !== null ? m.exact === name : name.startsWith(m.prefix ?? '')),
    )
  const bare = accepted.filter((a) => a.via.length === 0 || a.rationale.length === 0)
  const violations: string[] = bare.map((a) => `白名单条目缺 via/rationale（裸放行）: ${a.package}`)
  let checked = 0
  for (const [license, pkgs] of Object.entries(input)) {
    for (const p of pkgs) {
      checked += 1
      if (PERMISSIVE.has(license)) continue
      if (isAccepted(p.name, license)) continue
      violations.push(`${p.name} 持 ${license}：不在允许面也未显式白名单`)
    }
  }
  return { violations, checked }
}

function main(): void {
  const accepted = JSON.parse(
    readFileSync(join(REPO_ROOT, 'deploy/licenses.accepted.json'), 'utf8'),
  ) as AcceptedEntry[]
  const out = execFileSync('pnpm', ['licenses', 'list', '--json'], {
    cwd: REPO_ROOT,
    maxBuffer: 64 * 1024 * 1024,
  }).toString()
  const { violations, checked } = evaluateLicenses(JSON.parse(out) as LicenseInput, accepted)
  if (violations.length > 0) {
    process.stderr.write(
      `license-check: ${violations.length} violation(s) of ${checked} pkgs\n` +
        violations.map((v) => `  ✗ ${v}`).join('\n') +
        '\n',
    )
    process.exit(1)
  }
  process.stdout.write(`license-check: OK（${checked} 包全在允许面/有据白名单内）\n`)
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1]) {
  main()
}
