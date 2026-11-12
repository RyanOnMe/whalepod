#!/usr/bin/env tsx
/** Verify the sealed c3 evidence against the currently built production packages. */
import assert from 'node:assert/strict'
import { readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { repoRoot } from './lib/production-acceptance.js'
import {
  bindGuardedAcceptancePlan,
  checkRd04c3,
  type GuardedAcceptanceEvidence,
  type GuardedAcceptancePlan,
} from './lib/rd04c3-acceptance.js'

try {
  const root = join(repoRoot, 'artifacts/evidence/rd04c3')
  const live = join(root, 'live')
  const [planRaw, attemptRaw, eventsRaw, resultRaw] = await Promise.all([
    readFile(join(root, 'plan.json'), 'utf8'),
    readFile(join(live, 'attempt.json'), 'utf8'),
    readFile(join(live, 'events.jsonl'), 'utf8'),
    readFile(join(live, 'result.json'), 'utf8'),
  ])
  await assert.rejects(stat(join(live, 'failure.json')), { code: 'ENOENT' })
  const plan = JSON.parse(planRaw) as GuardedAcceptancePlan
  assert.deepEqual(await bindGuardedAcceptancePlan(plan.preparedAt), plan)
  const evidence = JSON.parse(resultRaw) as GuardedAcceptanceEvidence
  const totals = checkRd04c3(evidence, eventsRaw, planRaw, attemptRaw)
  console.log('RD-04c3 private draft and guarded provider usage PASS', JSON.stringify(totals))
  console.log('Provider invoice reconciliation: not_run')
} catch {
  console.error('RD-04c3 verification failed: absent, stale or inconsistent guarded live evidence')
  process.exitCode = 1
}
