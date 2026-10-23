import { readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { strict as assert } from 'node:assert'
import { verifyManagementEvidence } from './lib/management-evidence.js'
assert(process.argv[2], 'Usage: tsx scripts/verify-management-evidence.mts <evidence-directory>')
const directory = process.argv[2]
const result = verifyManagementEvidence(
  JSON.parse(await readFile(join(directory, 'facts.json'), 'utf8')),
)
for (const width of [1440, 390, 320])
  for (const kind of ['members', 'invite', 'plugins', 'packs', 'agents', 'revision', 'devices'])
    assert((await stat(join(directory, `management-${kind}-${width}.png`))).size > 0)
assert((await stat(join(directory, 'management-pairing-320.png'))).size > 0)
process.stdout.write(JSON.stringify(result) + '\n')
