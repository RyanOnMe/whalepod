import { verifyOfficePreviewLoopEvidence } from './lib/office-preview-loop-evidence.js'
import { readFile } from 'node:fs/promises'
import { verifyDeliveryReviewEvidence } from './lib/delivery-review-evidence.js'
import { verifyHandoffLoopEvidence } from './lib/handoff-loop-evidence.js'

let input: unknown
try {
  const path = process.argv[2]
  if (!path) throw new Error('missing evidence')
  input = JSON.parse(await readFile(path, 'utf8'))
} catch {
  input = undefined
}
// 读不到/坏 JSON 一律按缺证据判 FAIL；不把原始证据或路径打出来。
const handoff = verifyHandoffLoopEvidence(input)
const review = verifyDeliveryReviewEvidence(
  (input as { reviewLoop?: unknown } | undefined)?.reviewLoop,
)
const officeRequired = process.argv.includes('--office')
const office = officeRequired
  ? verifyOfficePreviewLoopEvidence((input as { officeLoop?: unknown } | undefined)?.officeLoop)
  : { ok: true, failures: [], checks: 0 }
const result = {
  ok: handoff.ok && review.ok && office.ok,
  failures: [...handoff.failures, ...review.failures, ...office.failures],
  checks: handoff.checks + review.checks + office.checks,
}

process.stdout.write(
  `${JSON.stringify({ verdict: result.ok ? 'PASS' : 'FAIL', officeRequired, failures: result.failures, checks: result.checks })}\n`,
)
process.exitCode = result.ok ? 0 : 2
