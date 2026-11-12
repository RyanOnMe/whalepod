/** Bind the loopback tool-error follow-up without relabeling the sealed live batch. */
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { fingerprintAssemblyFiles } from './acceptance-provenance.js'

const exec = promisify(execFile)
const harnessFiles = [
  'scripts/run-rd04c2-acceptance.ts',
  'scripts/verify-rd04c2-acceptance.ts',
  'scripts/verify-rd04c2-acceptance.spec.ts',
  'scripts/check-rd04c2-evidence-negatives.ts',
  'scripts/lib/rd04c2-replay.ts',
  'scripts/lib/rd04c2-replay.spec.ts',
  'scripts/lib/rd04c2-tool-error.ts',
  'scripts/lib/discovery-draft-fixture.ts',
  'scripts/lib/production-acceptance.ts',
  'scripts/lib/acceptance-provenance.ts',
]

export interface ToolErrorBinding {
  commit: string
  harnessDigest: string
}

export async function bindToolErrorFollowup(root: string): Promise<ToolErrorBinding> {
  const [{ stdout: head }, { stdout: status }, harnessDigest] = await Promise.all([
    exec('git', ['rev-parse', 'HEAD'], { cwd: root }),
    exec('git', ['status', '--porcelain', '--', ...harnessFiles], { cwd: root }),
    fingerprintAssemblyFiles(root, harnessFiles, []),
  ])
  const commit = head.trim()
  assert(/^[a-f0-9]{40}$/.test(commit), 'missing follow-up commit')
  assert.equal(status.trim(), '', 'commit the follow-up harness before sealing evidence')
  return { commit, harnessDigest }
}
