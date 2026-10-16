import { readFile } from 'node:fs/promises'
import { verifyCreateRecoveryEvidence } from './lib/create-recovery-evidence.js'

let input: unknown
try {
  const path = process.argv[2]
  if (!path) throw new Error('missing evidence')
  input = JSON.parse(await readFile(path, 'utf8'))
} catch {
  input = undefined
}
// 读不到/坏 JSON 一律按缺证据判 FAIL；不把原始证据或路径打出来。
const result = verifyCreateRecoveryEvidence(input)
process.stdout.write(`${JSON.stringify(result)}\n`)
process.exitCode = result.verdict === 'PASS' ? 0 : 2
