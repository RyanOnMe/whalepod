import { readFile } from 'node:fs/promises'
import { strict as assert } from 'node:assert'
import { verifyWorkbenchEvidence } from './lib/workbench-evidence.js'
assert(process.argv[2], 'Usage: tsx scripts/verify-workbench-evidence.mts <facts.json>')
console.log(
  JSON.stringify({
    component: 'web.workbench.verify',
    ok: true,
    ...verifyWorkbenchEvidence(JSON.parse(await readFile(process.argv[2], 'utf8'))),
  }),
)
