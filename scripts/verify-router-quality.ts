#!/usr/bin/env tsx
import assert from 'node:assert/strict'
import { readFile, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { join, resolve } from 'node:path'
import { parseArgs } from 'node:util'
import {
  freezeRouterQuality,
  verifyRouterQuality,
  type QualityFreeze,
  type QualityHoldoutWitness,
  type QualityResult,
} from './lib/router-quality.js'
import { verifyM1RA } from './verify-m1r-a-acceptance.js'

const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: { 'evidence-root': { type: 'string' }, 'engineering-evidence': { type: 'string' } },
})
const base = values['evidence-root']
  ? resolve(values['evidence-root'])
  : fileURLToPath(new URL('../artifacts/evidence/router-quality', import.meta.url))
const alternateEvidence = Boolean(values['evidence-root'] || values['engineering-evidence'])
const [phase] = positionals
assert(
  positionals.length === 1 &&
    (phase === 'development' || phase === 'holdout' || phase === 'freeze'),
  'provide development, freeze, or holdout',
)
try {
  const engineering = values['engineering-evidence']
    ? resolve(values['engineering-evidence'])
    : join(base, '../m1r-a/result.json')
  const { resultDigest: engineeringDigest, assemblyDigest } = await verifyM1RA(engineering)
  const readReport = async (split: 'development' | 'holdout') => {
    const raw = await readFile(join(base, split, 'result.json'), 'utf8')
    const report = JSON.parse(raw) as QualityResult
    assert.equal(
      report.engineeringEvidenceDigest,
      engineeringDigest,
      'wrong preceding engineering evidence',
    )
    if (report.schemaVersion === 2)
      assert(
        assemblyDigest && report.assemblyDigest === assemblyDigest,
        'wrong preceding engineering assembly',
      )
    return { raw, report }
  }
  const development = async () => (await readReport('development')).raw
  if (phase === 'freeze') {
    assert(!alternateEvidence, 'alternate evidence locations are read-only')
    const dev = await readReport('development')
    assert.equal(
      dev.report.schemaVersion,
      2,
      'legacy development evidence can be rescored but not newly frozen',
    )
    const freeze = freezeRouterQuality(dev.raw, new Date().toISOString())
    await writeFile(join(base, 'freeze.json'), `${JSON.stringify(freeze, null, 2)}\n`, {
      mode: 0o600,
      flag: 'wx',
    })
    process.stdout.write(
      `Holdout frozen before execution: ${freeze.minimumMatching}/6 structural matches required; zero critical findings.\n`,
    )
  } else {
    const rawFreeze =
      phase === 'holdout' ? await readFile(join(base, 'freeze.json'), 'utf8') : undefined
    const freeze = rawFreeze === undefined ? undefined : (JSON.parse(rawFreeze) as QualityFreeze)
    if (freeze)
      assert.deepEqual(
        freeze,
        freezeRouterQuality(await development(), freeze.frozenAt),
        'freeze does not match development evidence',
      )
    const { report: result } = await readReport(phase)
    const witness: QualityHoldoutWitness | undefined =
      rawFreeze !== undefined && result.schemaVersion === 2
        ? { rawFreeze, rawAttempt: await readFile(join(base, 'holdout/attempt.json'), 'utf8') }
        : undefined
    const score = verifyRouterQuality(result, freeze, witness)
    assert.equal(score.split, phase, 'result directory does not match split')
    const encoded = `${JSON.stringify(score, null, 2)}\n`
    if (!alternateEvidence) {
      try {
        await writeFile(join(base, phase, 'score.json'), encoded, { flag: 'wx', mode: 0o600 })
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
      }
    }
    process.stdout.write(encoded)
    if (score.status === 'fail') process.exitCode = 2
  }
} catch (error) {
  process.stderr.write(
    `Router quality evidence rejected: ${error instanceof Error ? error.message : 'unknown failure'}\n`,
  )
  process.exitCode = 2
}
