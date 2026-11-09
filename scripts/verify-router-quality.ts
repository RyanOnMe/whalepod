#!/usr/bin/env tsx
import assert from 'node:assert/strict'
import { readFile, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import {
  digest,
  freezeRouterQuality,
  verifyRouterQuality,
  type QualityFreeze,
  type QualityResult,
} from './lib/router-quality.js'
import { verifyM1RA } from './verify-m1r-a-acceptance.js'

const base = fileURLToPath(new URL('../artifacts/evidence/router-quality', import.meta.url))
const phase = process.argv[2]
assert(
  phase === 'development' || phase === 'holdout' || phase === 'freeze',
  'provide development, freeze, or holdout',
)
try {
  const engineering = join(base, '../m1r-a/result.json')
  await verifyM1RA(engineering)
  const engineeringDigest = digest(await readFile(engineering, 'utf8'))
  const readReport = async (split: 'development' | 'holdout') => {
    const raw = await readFile(join(base, split, 'result.json'), 'utf8')
    const report = JSON.parse(raw) as QualityResult
    assert.equal(
      report.engineeringEvidenceDigest,
      engineeringDigest,
      'wrong preceding engineering evidence',
    )
    return { raw, report }
  }
  const development = async () => (await readReport('development')).raw
  if (phase === 'freeze') {
    const freeze = freezeRouterQuality(await development())
    await writeFile(join(base, 'freeze.json'), `${JSON.stringify(freeze, null, 2)}\n`, {
      mode: 0o600,
      flag: 'wx',
    })
    process.stdout.write(
      `Holdout frozen before execution: ${freeze.minimumMatching}/6 structural matches required; zero critical findings.\n`,
    )
  } else {
    const freeze =
      phase === 'holdout'
        ? (JSON.parse(await readFile(join(base, 'freeze.json'), 'utf8')) as QualityFreeze)
        : undefined
    if (freeze)
      assert.deepEqual(
        freeze,
        freezeRouterQuality(await development()),
        'freeze does not match development evidence',
      )
    const { report: result } = await readReport(phase)
    const score = verifyRouterQuality(result, freeze)
    assert.equal(score.split, phase, 'result directory does not match split')
    const encoded = `${JSON.stringify(score, null, 2)}\n`
    await writeFile(join(base, phase, 'score.json'), encoded, { mode: 0o600 })
    process.stdout.write(encoded)
    if (score.status === 'fail') process.exitCode = 2
  }
} catch (error) {
  process.stderr.write(
    `Router quality evidence rejected: ${error instanceof Error ? error.message : 'unknown failure'}\n`,
  )
  process.exitCode = 2
}
