/** Seal each combined-path campaign against the committed harness and production packages. */
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { fingerprintAssemblyFiles, fingerprintProductionAssembly } from './acceptance-provenance.js'

const exec = promisify(execFile)
const harnessFiles = [
  'scripts/run-rd05a-acceptance.ts',
  'scripts/verify-rd05a-acceptance.ts',
  'scripts/verify-rd05a-acceptance.spec.ts',
  'scripts/check-rd05a-evidence-negatives.ts',
  'scripts/lib/rd05a-replay.ts',
  'scripts/lib/rd05a-replay.spec.ts',
  'scripts/lib/rd05a-evidence.ts',
  'scripts/lib/rd05a-fixture.ts',
  'scripts/lib/rd05a-provenance.ts',
  'scripts/lib/rd04c2-replay.ts',
  'scripts/lib/production-acceptance.ts',
  'scripts/lib/acceptance-provenance.ts',
]

export interface Rd05aBinding {
  commit: string
  harnessDigest: string
  assemblyDigest: string
}

export async function bindRd05a(root: string): Promise<Rd05aBinding> {
  const [{ stdout: head }, { stdout: status }, harnessDigest, assemblyDigest] = await Promise.all([
    exec('git', ['rev-parse', 'HEAD'], { cwd: root }),
    exec('git', ['status', '--porcelain', '--', ...harnessFiles], { cwd: root }),
    fingerprintAssemblyFiles(root, harnessFiles, []),
    fingerprintProductionAssembly(root),
  ])
  const commit = head.trim()
  assert(/^[a-f0-9]{40}$/.test(commit), 'missing combined-path campaign commit')
  assert.equal(status.trim(), '', 'commit the combined-path harness before sealing evidence')
  return { commit, harnessDigest, assemblyDigest }
}
