import { readFile } from 'node:fs/promises'
import { verifyPreparationReturnEvidence } from './lib/preparation-return-evidence.js'
let input: unknown
try {
  const path = process.argv[2]
  if (!path) throw new Error('missing evidence')
  input = JSON.parse(await readFile(path, 'utf8'))
} catch {
  input = undefined
}
// Do not print raw evidence or paths on read/parse failure.
const result = verifyPreparationReturnEvidence(input)
process.stdout.write(`${JSON.stringify(result)}\n`)
process.exitCode = result.verdict === 'PASS' ? 0 : 2
