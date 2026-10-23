import { readFile } from 'node:fs/promises'
import { strict as assert } from 'node:assert'
import { verifyPagesEvidence } from './lib/pages-evidence.js'
assert(process.argv[2], 'Usage: tsx scripts/verify-pages-evidence.mts <facts.json>')
process.stdout.write(
  JSON.stringify(verifyPagesEvidence(JSON.parse(await readFile(process.argv[2], 'utf8')))) + '\n',
)
