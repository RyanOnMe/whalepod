import { readFile } from 'node:fs/promises'
import { verifyAttentionEvidence } from './lib/attention-evidence.js'
let input: unknown
try {
  const path = process.argv[2]
  if (!path) throw new Error('missing evidence')
  input = JSON.parse(await readFile(path, 'utf8'))
} catch {
  // Never echo paths or raw payloads into the evidence log.
  input = undefined
}
const result = verifyAttentionEvidence(input)
process.stdout.write(`${JSON.stringify(result)}\n`)
process.exitCode = result.verdict === 'PASS' ? 0 : 2
