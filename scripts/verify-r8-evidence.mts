import { readFile } from 'node:fs/promises'
import { r8EvidenceFailures } from '../apps/web/tests/e2e/r8-window.js'
let input: unknown
try {
  input = JSON.parse(await readFile(process.argv[2] ?? '', 'utf8'))
} catch {
  input = undefined
}
const failures = r8EvidenceFailures(input)
process.stdout.write(
  `${JSON.stringify({ verdict: failures.length === 0 ? 'PASS' : 'FAIL', component: 'hub.outbox', failures })}\n`,
)
process.exitCode = failures.length === 0 ? 0 : 2
