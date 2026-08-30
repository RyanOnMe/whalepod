#!/usr/bin/env tsx
/**
 * P1-18 标准链路判定器（六原语·判定/归因）。
 *
 * 用法:
 *   pnpm phase1:verify [-- --evidence <dir>]
 *
 * 读 drive 产出的证据目录，跑可证伪断言；链路任一层断掉即 FAIL 并按
 * component 归因到 Hub / Node / Runtime / Browser。exit code 即结论：
 * 0 = PASS，2 = FAIL（1 = 用法/证据缺失等 harness 错误）。
 * 判定结果写回 <dir>/assertions.json，供 `pnpm phase1:evidence` 打包。
 */
import { writeFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { verifyEvidence, formatVerdict } from './lib/phase1/verify.js'
import { latestAttemptDir } from './lib/phase1/evidence.js'

const log = (message: string): void => console.error(`[phase1-verify] ${message}`)

async function main(): Promise<number> {
  const argv = process.argv.slice(2)
  let dir: string | undefined
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--evidence') {
      dir = argv[++i]
    }
  }
  if (dir === undefined) {
    dir = latestAttemptDir()
    if (dir !== undefined) log(`未指定 --evidence，默认最近一次采集：${dir}`)
  }
  if (dir === undefined) {
    log('FAIL 未找到证据目录：先跑 pnpm phase1:drive，或用 --evidence 指定')
    return 1
  }
  if (!existsSync(join(dir, 'meta.json'))) {
    log(`FAIL ${dir} 不是 drive 证据目录（缺 meta.json）`)
    return 1
  }

  const verdict = verifyEvidence(dir)
  writeFileSync(join(dir, 'assertions.json'), `${JSON.stringify(verdict, null, 2)}\n`)
  console.log(formatVerdict(verdict))
  if (verdict.pass) return 0
  // 验收语义：FAULT 注入模式下 FAIL+归因正确是期望结果，但 verify 本身只报事实，
  // 期望比对由调用方（harness 自测/验收文档流程）完成——统一 2 = 判定 FAIL。
  return 2
}

main().then(
  (code) => {
    process.exitCode = code
  },
  (error) => {
    log(`FAIL ${error instanceof Error ? error.message : String(error)}`)
    process.exitCode = 1
  },
)
