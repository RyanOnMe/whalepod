import { readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { strict as assert } from 'node:assert'
import { verifyMotionEvidence } from './lib/motion-evidence.js'
assert(process.argv[2], 'Usage: tsx scripts/verify-motion-evidence.mts <evidence-directory>')
const directory = process.argv[2]
const driver = JSON.parse(await readFile(join(directory, 'facts.json'), 'utf8'))
assert.equal(driver.ok, true)
assert.deepEqual(driver.browserErrors, [])
const verdict = verifyMotionEvidence(
  JSON.parse(await readFile(join(directory, 'motion.json'), 'utf8')),
)
for (const width of [1440, 390, 320])
  for (const kind of ['timeline', 'artifact'])
    assert((await stat(join(directory, `motion-${kind}-${width}.png`))).size > 0)
for (const file of ['motion-project-depth.png', 'motion-tool-output.png', 'motion-preview.webm'])
  assert((await stat(join(directory, file))).size > 0)
process.stdout.write(JSON.stringify(verdict) + '\n')
