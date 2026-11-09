#!/usr/bin/env tsx
/** Drop or corrupt one observed fact at a time; never edit the captured production evidence. */
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { verifyM1RA } from './verify-m1r-a-acceptance.js'

interface MutableEvidence {
  fast: { routerInvoked: boolean }
  finishedRuns: { id: string }[]
  consumptions: { runId: string }[]
  replay: { executorCalls: { phase: number; name: string; bodyDigest?: string }[] }
  draft: { status: string; colleagueStatus: number }
}

const path = resolve(process.argv[2] ?? 'artifacts/evidence/m1r-a/result.json')
const directory = dirname(path)
const source = await readFile(path, 'utf8')
const sourceEvents = await readFile(join(directory, 'events.jsonl'), 'utf8')
await verifyM1RA(path)

const mutations: Record<string, (evidence: MutableEvidence, events: string) => string> = {
  'fast-path-invoked-model': (evidence, events) => {
    evidence.fast.routerInvoked = true
    return events
  },
  'terminal-boundary-trace-missing': (_evidence, events) =>
    events
      .trimEnd()
      .split('\n')
      .filter((line) => JSON.parse(line).action !== 'work.run_boundary.enqueued')
      .join('\n') + '\n',
  'third-run-created': (evidence, events) => {
    evidence.finishedRuns.push({ ...evidence.finishedRuns[1]! })
    return events
  },
  'body-did-not-reach-next-model-request': (evidence, events) => {
    const write = evidence.replay.executorCalls.find(
      (call) => call.phase === 2 && call.name === 'write',
    )
    assert(write)
    write.bodyDigest = '0'.repeat(64)
    return events
  },
  'next-run-consumption-missing': (evidence, events) => {
    const secondRunId = evidence.finishedRuns[1]!.id
    evidence.consumptions = evidence.consumptions.filter((row) => row.runId !== secondRunId)
    return events
  },
  'draft-was-published': (evidence, events) => {
    evidence.draft.status = 'published'
    return events
  },
  'colleague-could-read-draft': (evidence, events) => {
    evidence.draft.colleagueStatus = 200
    return events
  },
}

const scratch = await mkdtemp(join(directory, '.negative-'))
const evidencePath = join(scratch, 'result.json')
const eventsPath = join(scratch, 'events.jsonl')
const killed: string[] = []
try {
  for (const [name, mutate] of Object.entries(mutations)) {
    const evidence = JSON.parse(source) as MutableEvidence
    const events = mutate(evidence, sourceEvents)
    await writeFile(evidencePath, JSON.stringify(evidence))
    await writeFile(eventsPath, events)
    await assert.rejects(verifyM1RA(evidencePath), { code: 'ERR_ASSERTION' }, name)
    killed.push(name)
  }
} finally {
  await rm(scratch, { recursive: true, force: true })
}
await verifyM1RA(path)
await writeFile(
  join(directory, 'negative-controls.json'),
  `${JSON.stringify({ status: 'pass', tested: killed.length, killed }, null, 2)}\n`,
)
console.log(
  `M1R-A evidence negative controls: ${killed.length}/${Object.keys(mutations).length} rejected`,
)
