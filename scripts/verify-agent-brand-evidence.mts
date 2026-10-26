import { strict as assert } from 'node:assert'
import { readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { verifyAgentBrandEvidence } from './lib/agent-brand-evidence.js'
const directory = process.argv[2]
assert(directory, 'Usage: tsx scripts/verify-agent-brand-evidence.mts <evidence-directory>')
const facts = JSON.parse(await readFile(join(directory, 'facts.json'), 'utf8'))
const verdict = verifyAgentBrandEvidence(facts)
const json = (name: string) => readFile(join(directory, name), 'utf8').then(JSON.parse)
assert.deepEqual(
  await json('visibility-probe.json'),
  facts.visibilityProbe,
  'native visibility sidecar does not match this driver',
)
const completion = await json('completion-loss.json')
assert.equal(completion.component, 'harness.agent-completion-loss')
assert.deepEqual(
  { runId: completion.runId, fault: completion.fault, terminal: completion.terminal },
  facts.completionLoss,
  'completion sidecar does not match this real Run',
)
const firstRun = facts.runs[0]
assert(
  Array.isArray(completion.sequence) && completion.sequence.length > 0,
  'completion sidecar missing actual sequence',
)
assert.deepEqual(
  firstRun.states.slice(0, completion.sequence.length),
  completion.sequence,
  'completion observation does not belong to the recorded Run sequence',
)
const permanent = await json('lost-before-completion.json')
assert.equal(permanent.component, 'harness.agent-lost-before-completion')
for (const field of ['runId', 'fault', 'observation', 'terminal'])
  assert.deepEqual(
    permanent[field],
    facts.lostBeforeCompletion[field],
    `permanent-loss sidecar mismatch: ${field}`,
  )
for (const width of [1440, 390, 320]) {
  for (const theme of ['light', 'dark'])
    for (const kind of ['brand', 'agent-thinking'])
      assert((await stat(join(directory, `${kind}-${theme}-${width}.png`))).size > 0)
  for (const theme of ['light', 'dark']) {
    const run = facts.runs.find((row: { width: number }) => row.width === width)
    const sample = run.samples.find((row: { theme: string }) => row.theme === theme)
    assert.deepEqual(
      await json(`visible-text-${theme}-${width}.json`),
      sample.visibleText,
      'visible-text sidecar mismatch',
    )
  }
  for (const kind of ['agent-approval', 'agent-completed'])
    assert((await stat(join(directory, `${kind}-${width}.png`))).size > 0)
}
assert((await stat(join(directory, 'agent-brand-preview.webm'))).size > 0)
assert((await stat(join(directory, 'visibility-probe.json'))).size > 0)
assert((await stat(join(directory, 'completion-loss.json'))).size > 0)
assert((await stat(join(directory, 'lost-before-completion.json'))).size > 0)
assert((await stat(join(directory, 'agent-fallback-visible.png'))).size > 0)
process.stdout.write(JSON.stringify(verdict) + '\n')
