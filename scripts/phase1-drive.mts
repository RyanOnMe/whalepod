#!/usr/bin/env tsx
/**
 * P1-18 标准链路驱动器（六原语·驱动/观测/取证采集）。
 *
 * 用法:
 *   pnpm phase1:drive [-- --scenario minimal|standard|secrets] [--fault none|hub|node|runtime|browser] [--out <dir>]
 *
 * - 驱动真链路（真 Hub + 真 Node + 真 Runtime/replay + 双 Browser WS），走真人
 *   同一条 HTTP/WS 处理路径；事件与分层证据落到 artifacts/evidence/（gitignore）。
 * - 本命令只「触发 + 采集」，不下结论；判定用 `pnpm phase1:verify`。
 * - 一次性 PostgreSQL 由本脚本自起自灭（--out 目录与容器都无残留）。
 */
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { drivePhase1, SCENARIOS, type Phase1Scenario } from './lib/phase1/drive.js'
import { FAULT_KINDS, type FaultKind } from './lib/phase1/events.js'
import { evidenceRoot } from './lib/phase1/evidence.js'

const log = (message: string): void => console.error(`[phase1-drive] ${message}`)

function usage(): never {
  console.error(
    '用法: tsx scripts/phase1-drive.mts [--scenario minimal|standard|secrets] [--fault none|hub|node|runtime|browser] [--out <dir>]',
  )
  process.exit(1)
}

async function main(): Promise<number> {
  const argv = process.argv.slice(2)
  let scenario: Phase1Scenario = 'standard'
  let fault: FaultKind = 'none'
  let out: string | undefined
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === '--scenario') {
      const value = argv[++i]
      if (value === undefined || !SCENARIOS.includes(value as Phase1Scenario)) usage()
      scenario = value as Phase1Scenario
    } else if (arg === '--fault') {
      const value = argv[++i]
      if (value === undefined || !FAULT_KINDS.includes(value as FaultKind)) usage()
      fault = value as FaultKind
    } else if (arg === '--out') {
      out = argv[++i]
      if (out === undefined) usage()
    } else if (arg === '--help' || arg === '-h') {
      usage()
    } else {
      usage()
    }
  }

  const attemptId = new Date().toISOString().replaceAll(/[-:]/g, '').replace(/\..+$/, 'Z')
  const attemptDir =
    out ?? join(evidenceRoot(), `phase1-${scenario}`, `${attemptId}-${randomUUID().slice(0, 8)}`)

  log(`scenario=${scenario} fault=${fault} evidence=${attemptDir}`)
  const result = await drivePhase1({ scenario, fault, attemptDir })
  if (!result.captured) {
    log(`FAIL drive 未完成采集：${result.error ?? 'unknown'}`)
    return 1
  }
  log(`captured: runs=${result.runIds.length} → ${result.attemptDir}`)
  log(`判定: pnpm phase1:verify -- --evidence ${result.attemptDir}`)
  // stdout 契约：唯一一行 = 证据目录（供脚本链式调用）。
  console.log(result.attemptDir)
  return 0
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
