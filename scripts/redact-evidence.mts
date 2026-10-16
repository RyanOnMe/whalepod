/**
 * 证据目录绝对路径归约（#73 的规则，#312 起独立成命令）。
 *
 * runner 产出的原始日志（vitest/playwright/pnpm check）天然带本机绝对路径；
 * 证据入包/出机前必须归约成 `<repo>` / `<home>` / `<tmp>` 占位——规则与 harness
 * 内部同一条单一真源（`scripts/lib/phase1/events.ts` 的 `redactText`），
 * 否则 `scripts/secret-scan.sh` 判 HIT（绝对路径不进日志、不进证据）。
 *
 * 用法：
 *   tsx scripts/redact-evidence.mts artifacts/evidence/<包> [更多目录...]
 *   scripts/secret-scan.sh artifacts/evidence/<包>   # 归约后必须无 HIT
 *
 * 幂等：已归约的文本不含任何模式，二次运行零变化（只打印 changed 文件）。
 */
import { readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { join, resolve, sep } from 'node:path'
import { redactText } from './lib/phase1/events.js'

// 大文件（原始 trace/录像）不进证据包的既有约定：这里跳过而不是就地重写，
// 免得把二进制当天文本改写坏。
const MAX_BYTES = 8 * 1024 * 1024

function walk(dir: string): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) out.push(...walk(path))
    else if (entry.isFile()) out.push(path)
  }
  return out
}

const targets = process.argv.slice(2)
if (targets.length === 0) {
  console.error('用法：tsx scripts/redact-evidence.mts <目录...>（就地归约证据里的绝对路径）')
  process.exit(2)
}

let changed = 0
let skipped = 0
for (const target of targets) {
  const root = resolve(target)
  const stats = statSync(root, { throwIfNoEntry: false })
  if (stats === undefined) {
    console.error(`跳过（不存在）：${target}`)
    continue
  }
  const files = stats.isDirectory() ? walk(root) : [root]
  for (const file of files) {
    const size = statSync(file).size
    if (size > MAX_BYTES) {
      skipped += 1
      console.error(`跳过（超过 ${MAX_BYTES} 字节，按约定不入证据包）：${file.split(sep).join('/')}`)
      continue
    }
    const before = readFileSync(file, 'utf8')
    const after = redactText(before)
    if (after !== before) {
      writeFileSync(file, after)
      changed += 1
      console.log(`已归约：${file}`)
    }
  }
}

console.log(`完成：${changed} 个文件归约，${skipped} 个跳过。复核：scripts/secret-scan.sh <目录>`)
