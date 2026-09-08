#!/usr/bin/env tsx
/**
 * Q8 性能门（P1-20 交付⑥）：`pnpm test:load`。
 *
 * 退出码语义（#109 修订后的两级判定，FAIL 永不绿洗、SKIP 形态不存在）：
 *   0 = PASS（合格环境=权威判；欠规环境=PASS-CONSERVATIVE 保守口径，标签写明）
 *   2 = FAIL（合格环境的产品红）
 *   3 = INCONCLUSIVE（欠规环境 FAIL——可能环境贫血，须合格环境复判）
 *       或 DEV-REPORT（--dev-report 恒退 3，任何结果不充当判据）
 *   1 = harness/装配错误
 *
 * 判据环境（04 §8）：4 CPU / 8 GiB / Linux Docker / PG 同机。欠规环境**不再**
 * 空跑退 3——修订原因见 load.ts finalVerdict 注释（裁决前提"ubuntu-latest
 * 4vCPU"被闸亲手证伪：实测 2vCPU/7.8GiB）。
 */
import { parseArgs } from 'node:util'
import { assessEnvironment, finalVerdict, readEnvFacts, runLoadProfile } from './lib/phase1/load.js'

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
  process.stdout.write(`Q8 环境欠规（非 04 §8 判据环境）：${gate.reasons.join('；')}\n`)
  process.stdout.write(
    values['dev-report'] === true
      ? 'DEV-REPORT 模式：以下数字仅供调试，恒退 3\n'
      : '两级判定：跑完照判——PASS 只算保守口径（PASS-CONSERVATIVE），FAIL 判 INCONCLUSIVE（exit 3）\n',
  )
}

const result = await runLoadProfile({
  durationMs: Number(values.duration),
  streams: 2,
  ratePerStreamPerSec: 20,
  browserConnections: Number(values.connections),
})
const final = finalVerdict(gate.eligible, result, values['dev-report'] === true)
process.stdout.write(
  JSON.stringify(
    {
      verdict: result.verdict,
      label: final.label,
      envFacts: env,
      envEligible: gate.eligible,
      failures: result.failures,
      metrics: result.metrics,
      report: result.report,
    },
    null,
    2,
  ) + '\n',
)
process.stdout.write(`Q8 判定：${final.label}\n`)
process.exit(final.code)
