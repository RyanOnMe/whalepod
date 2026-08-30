#!/usr/bin/env tsx
/**
 * P1-18 按 Run/场景取证打包（六原语·取证）。
 *
 * 用法:
 *   pnpm phase1:evidence [-- --evidence <dir>] [--run <runId>]
 *
 * 把一次 drive 采集整理成 04 §9 Evidence 包（manifest + README + 逐文件
 * 摘要；--run 收缩为单 run 包）；出包前必过 scripts/secret-scan.sh，
 * 命中即拒收（删包 + 非零退出）。包落在 artifacts/evidence/（gitignore）。
 */
import { packageEvidence, latestAttemptDir } from './lib/phase1/evidence.js'

const log = (message: string): void => console.error(`[phase1-evidence] ${message}`)

async function main(): Promise<number> {
  const argv = process.argv.slice(2)
  let dir: string | undefined
  let runId: string | undefined
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--evidence') dir = argv[++i]
    else if (argv[i] === '--run') runId = argv[++i]
  }
  if (dir === undefined) dir = latestAttemptDir()
  if (dir === undefined) {
    log('FAIL 未找到证据目录：先跑 pnpm phase1:drive')
    return 1
  }
  log(`打包 ${dir}${runId === undefined ? '' : `（run=${runId.slice(0, 8)}）`}`)
  const result = await packageEvidence({
    attemptDir: dir,
    ...(runId === undefined ? {} : { runId }),
  })
  log(`package: ${result.packageDir}`)
  console.log(
    JSON.stringify(
      {
        packageDir: result.packageDir,
        verdict: result.manifest.verdict,
        files: result.manifest.files.length,
        secretScan: 'PASS',
      },
      null,
      2,
    ),
  )
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
