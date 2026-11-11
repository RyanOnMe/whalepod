#!/usr/bin/env tsx
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { mkdir, open, readFile, realpath, rename, rm, unlink, writeFile } from 'node:fs/promises'
import { isAbsolute, join, relative, sep } from 'node:path'
import { parseArgs } from 'node:util'
import {
  assertNoHoldoutEvidence,
  fingerprintProductionAssembly,
  pathExists,
  reserveHoldoutAttempt,
  sha256,
} from './lib/acceptance-provenance.js'
import {
  discoveryCampaignPaths,
  freezeDiscoveryDevelopment,
  scoreDiscoveryCampaign,
  validateDiscoveryFreeze,
  validateDiscoveryHoldout,
  type DiscoveryCampaignBinding,
  type DiscoveryCampaignReport,
} from './lib/discovery-quality-campaign.js'
import {
  DISCOVERY_PILOT_FENCES_CAMPAIGN,
  getDiscoveryQualityCases,
  type DiscoveryQualityCampaign,
} from './lib/discovery-quality-cases.js'
import {
  DISCOVERY_QUALITY_REAL_CONFIGURATION,
  runDiscoveryQualityDriver,
} from './lib/discovery-quality-driver.js'
import { getDiscoveryQualityDatasetDigest } from './lib/discovery-quality-score.js'
import { repoRoot } from './lib/production-acceptance.js'
import { verifyRd04a, type Rd04aEvidence } from './verify-rd04a-acceptance.js'

const campaignFiles = [
  'scripts/run-discovery-quality.ts',
  'scripts/lib/discovery-quality-campaign.ts',
  'scripts/lib/discovery-quality-cases.ts',
  'scripts/lib/discovery-quality-driver.ts',
  'scripts/lib/discovery-quality-score.ts',
  'scripts/lib/acceptance-provenance.ts',
  'scripts/lib/production-acceptance.ts',
  'scripts/lib/ephemeral-postgres.mts',
  'scripts/verify-rd04a-acceptance.ts',
] as const
const pilotCampaignFiles = [
  'scripts/lib/discovery-quality-pilot-cases.ts',
  'scripts/run-rd04a-acceptance.ts',
] as const

async function binding(
  real: boolean,
  campaign?: DiscoveryQualityCampaign,
): Promise<DiscoveryCampaignBinding> {
  const { engineeringFile } = discoveryCampaignPaths(repoRoot, campaign)
  const files = campaign === undefined ? campaignFiles : [...campaignFiles, ...pilotCampaignFiles]
  const [assemblyDigest, sourceFiles] = await Promise.all([
    fingerprintProductionAssembly(repoRoot),
    Promise.all(files.map(async (path) => [path, sha256(await readFile(join(repoRoot, path)))])),
  ])
  let engineeringDigest: string | null = null
  if (real) {
    const raw = await readFile(engineeringFile, 'utf8')
    const evidence = JSON.parse(raw) as Rd04aEvidence
    assert.equal(evidence.campaign, campaign, 'engineering evidence belongs to another campaign')
    verifyRd04a(evidence, assemblyDigest)
    engineeringDigest = sha256(raw)
  }
  return {
    ...(campaign === undefined ? {} : { campaign }),
    assemblyDigest,
    engineeringDigest,
    campaignDigest: sha256(
      JSON.stringify(
        campaign === undefined
          ? sourceFiles
          : { campaign, datasetDigest: getDiscoveryQualityDatasetDigest(campaign), sourceFiles },
      ),
    ),
    providerConfigurationDigest: sha256(JSON.stringify(DISCOVERY_QUALITY_REAL_CONFIGURATION)),
  }
}

async function readKey(path: string) {
  try {
    const within = relative(await realpath(repoRoot), await realpath(path))
    assert(within === '..' || within.startsWith(`..${sep}`) || isAbsolute(within))
    const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
    try {
      const info = await file.stat()
      assert(
        info.isFile() &&
          (info.mode & 0o777) === 0o600 &&
          info.uid === process.getuid?.() &&
          info.size <= 4096,
      )
      const key = (await file.readFile('utf8')).trim()
      assert(/^[\x21-\x7e]{8,4096}$/.test(key))
      return key
    } finally {
      await file.close()
    }
  } catch {
    throw new Error('use an authorized private 0600 key file outside the repository')
  }
}

async function saveJson(path: string, value: unknown, exclusive: boolean) {
  const encoded = `${JSON.stringify(value, null, 2)}\n`
  const options = { flag: 'wx', mode: 0o600, flush: true } as const
  if (exclusive) return writeFile(path, encoded, options)
  const temporary = `${path}.${randomUUID()}`
  try {
    await writeFile(temporary, encoded, options)
    await rename(temporary, path)
  } finally {
    await rm(temporary, { force: true })
  }
}

async function withDevelopmentLock(
  { evidenceRoot, developmentLock }: ReturnType<typeof discoveryCampaignPaths>,
  action: () => Promise<void>,
) {
  await mkdir(evidenceRoot, { recursive: true, mode: 0o700 })
  const lock = await open(developmentLock, 'wx', 0o600).catch(() => {
    throw new Error('another development run or freeze holds the lock; inspect it if interrupted')
  })
  try {
    await action()
  } finally {
    await lock.close()
    await unlink(developmentLock)
  }
}

async function main() {
  const { positionals, values } = parseArgs({
    allowPositionals: true,
    options: {
      campaign: { type: 'string' },
      split: { type: 'string' },
      replay: { type: 'boolean' },
      'key-file': { type: 'string' },
      'prepare-only': { type: 'boolean' },
    },
  })
  const [command] = positionals
  assert(
    positionals.length === 1 && ['run', 'verify', 'freeze'].includes(command ?? ''),
    'use run, verify or freeze',
  )
  const campaign = values.campaign
  assert(
    campaign === undefined || campaign === DISCOVERY_PILOT_FENCES_CAMPAIGN,
    'unknown discovery quality campaign',
  )
  const paths = discoveryCampaignPaths(repoRoot, campaign)
  const { evidenceRoot, holdoutRoot, freezeFile, developmentFile, developmentFailure } = paths
  const campaignOption: { campaign?: DiscoveryQualityCampaign } =
    campaign === undefined ? {} : { campaign }
  const split = values.split
  const real = !values.replay && !values['prepare-only']
  if (command === 'freeze') {
    assert(
      Object.keys(values).every((key) => key === 'campaign'),
      'freeze uses the canonical real-model development result',
    )
    await withDevelopmentLock(paths, async () => {
      await assertNoHoldoutEvidence(holdoutRoot)
      assert(!(await pathExists(developmentFailure)), 'latest real development run failed')
      const current = await binding(true, campaign)
      const freeze = freezeDiscoveryDevelopment(
        await readFile(developmentFile, 'utf8'),
        current,
        new Date().toISOString(),
      )
      await saveJson(freezeFile, freeze, true)
    })
    console.log('Discovery holdout frozen; human review has not run.')
    return
  }

  assert(split === 'development' || split === 'holdout', 'provide --split development or holdout')
  if (command === 'run') {
    assert(
      [values.replay, values['key-file'], values['prepare-only']].filter(Boolean).length === 1,
      'choose exactly one: --replay, --prepare-only, or --key-file',
    )
  } else
    assert(
      !values['key-file'] && !values['prepare-only'],
      'verify requires evidence, not a credential',
    )

  const output = real ? join(evidenceRoot, split) : join(evidenceRoot, 'replay', split)
  const resultFile = join(output, 'result.json')
  const current = await binding(real, campaign)
  const verifyFreeze = async () => {
    const raw = await readFile(freezeFile, 'utf8')
    return {
      raw,
      freeze: validateDiscoveryFreeze(raw, await readFile(developmentFile, 'utf8'), current),
    }
  }
  if (command === 'verify') {
    if (real) {
      const failures = await Promise.all(
        ['failure.json', 'partial.json'].map((name) => pathExists(join(output, name))),
      )
      assert(!failures.some(Boolean), 'attempt has an incomplete or failed marker')
    }
    const { evidence, score } = scoreDiscoveryCampaign(await readFile(resultFile, 'utf8'), current)
    assert.equal(evidence.report.split, split, 'report does not match the split')
    assert.equal(
      evidence.report.mode,
      real ? 'real_model' : 'replay',
      'report does not match the mode',
    )
    if (real && split === 'holdout') {
      const { raw } = await verifyFreeze()
      validateDiscoveryHoldout(evidence, raw, await readFile(join(output, 'attempt.json'), 'utf8'))
    } else assert(evidence.holdout === undefined, 'unexpected holdout attempt binding')
    console.log(JSON.stringify(score, null, 2))
    if (score.status !== 'pass') process.exitCode = 2
    return
  }

  if (values['prepare-only']) {
    await runDiscoveryQualityDriver({ ...campaignOption, split, mode: 'prepare_only' })
    console.log(
      `Discovery production fixture setup: ${getDiscoveryQualityCases(split, campaign).length}; zero real model calls.`,
    )
    return
  }

  const key = values['key-file'] ? await readKey(values['key-file']) : undefined
  delete process.env.CMD_API_KEY
  const development = real && split === 'development'
  const run = async () => {
    if (development) {
      assert(!(await pathExists(freezeFile)), 'preserve frozen development evidence')
      await assertNoHoldoutEvidence(holdoutRoot)
      assert.deepEqual(
        await binding(true, campaign),
        current,
        'engineering evidence changed before the development lock',
      )
    }
    const sealed = real && split === 'holdout' ? await verifyFreeze() : undefined
    const witness = sealed
      ? await reserveHoldoutAttempt(output, sha256(sealed.raw), sealed.freeze.frozenAt)
      : undefined
    const generatedAt = witness?.attempt.startedAt ?? new Date().toISOString()
    const mode = real ? 'real_model' : 'replay'
    await mkdir(output, { recursive: true, mode: 0o700 })
    try {
      const cases = await runDiscoveryQualityDriver({
        ...campaignOption,
        split,
        mode,
        ...(key ? { key } : {}),
      })
      assert.deepEqual(
        await binding(real, campaign),
        current,
        'assembly or campaign changed during run',
      )
      const evidence: DiscoveryCampaignReport = {
        schemaVersion: 1,
        generatedAt,
        humanReview: 'not_run',
        binding: current,
        report: { schemaVersion: 1, ...campaignOption, split, mode, cases },
        ...(witness
          ? {
              holdout: {
                freezeDigest: witness.attempt.freezeDigest,
                attemptDigest: witness.digest,
              },
            }
          : {}),
      }
      const raw = `${JSON.stringify(evidence, null, 2)}\n`
      const { score } = scoreDiscoveryCampaign(raw, current)
      await saveJson(resultFile, evidence, Boolean(witness))
      if (development) await rm(developmentFailure, { force: true })
      console.log(JSON.stringify(score, null, 2))
      if (score.status !== 'pass') process.exitCode = 2
    } catch (error) {
      if (witness || development)
        await saveJson(
          join(output, 'failure.json'),
          { outcome: 'failed_or_interrupted' },
          Boolean(witness),
        ).catch(() => {})
      // No provider response or user-supplied credential path is emitted by this runner.
      const message = error instanceof Error ? error.message : 'unknown failure'
      throw new Error(key ? message.replaceAll(key, '[REDACTED]') : message)
    }
  }
  if (development) await withDevelopmentLock(paths, run)
  else await run()
}

main().catch((error: unknown) => {
  console.error(
    `Discovery quality failed: ${error instanceof Error ? error.message : 'unknown failure'}`,
  )
  process.exitCode = 2
})
