#!/usr/bin/env tsx
/**
 * Q8 性能门（P1-20 交付⑥）：`pnpm test:load`。
 *
 * 退出码语义（照 phase1-verify 的码位约定，绝不 SKIP 报绿）：
 *   0 = PASS  2 = FAIL  1 = harness/装配错误  3 = 环境不合格（**不是**通过，
 *   也不许被当成跳过；04 §8 判据环境是 4 CPU / 8 GiB / Linux Docker / PG 同机）。
 *
 * `--dev-report`：在非判据环境上完整跑一遍并打印数字，用于开发调试；
 * 无论结果如何**固定退出 3**，输出首行标 DEV-REPORT——开发机数字不得充当发布判据。
 */
import { parseArgs } from 'node:util'
import { assessEnvironment, readEnvFacts, runLoadProfile } from './lib/phase1/load.js'

const { values } = parseArgs({
  options: {
    'dev-report': { type: 'boolean', default: false },
    duration: { type: 'string', default: '60000' },
    connections: { type: 'string', default: '10' },
  },
})

const env = readEnvFacts()
const gate = assessEnvironment(env)
if (!gate.eligible) {
  if (values['dev-report'] !== true) {
    process.stdout.write(`Q8 环境不合格（非判据环境）：${gate.reasons.join('；')}\n`)
    process.stdout.write(
      '开发机调试用 `pnpm test:load -- --dev-report`（无论数字如何都退 3，不充当发布判据）\n',
    )
    process.exit(3)
  }
  process.stdout.write(
    `DEV-REPORT 非判据环境（${gate.reasons.join('；')}）——以下数字仅供调试，退出码固定 3\n`,
  )
}

const result = await runLoadProfile({
  durationMs: Number(values.duration),
  streams: 2,
  ratePerStreamPerSec: 20,
  browserConnections: Number(values.connections),
})
process.stdout.write(
  JSON.stringify(
    {
      verdict: result.verdict,
      failures: result.failures,
      metrics: result.metrics,
      report: result.report,
    },
    null,
    2,
  ) + '\n',
)
if (values['dev-report'] === true) {
  process.stdout.write('DEV-REPORT：不判 PASS/FAIL（见文件头环境口径）\n')
  process.exit(3)
}
process.exit(result.verdict === 'PASS' ? 0 : 2)
