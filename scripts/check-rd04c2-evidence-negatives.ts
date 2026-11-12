#!/usr/bin/env tsx
/** Confirm the independent verifier rejects omissions, tampering and privacy regressions. */
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { sha256 } from './lib/acceptance-provenance.js'
import { checkRd04c2 } from './verify-rd04c2-acceptance.js'

const path = process.argv[2] ?? 'artifacts/evidence/rd04c2/result.json'
const [resultBytes, events] = await Promise.all([
  readFile(path, 'utf8'),
  readFile(join(dirname(path), 'events.jsonl'), 'utf8'),
])
const result = JSON.parse(resultBytes)
assert.equal(result.mode, 'loopback_model_replay')
checkRd04c2(result, events)

const withoutReads = events
  .split('\n')
  .filter((line) => {
    if (!line) return true
    return JSON.parse(line).component !== 'hub.work_input'
  })
  .join('\n')

const bad = [
  { name: 'substituted events', mutate: () => {}, events: events + '\n' },
  {
    name: 'removed reads even with valid event fingerprint',
    mutate: (value: typeof result) => {
      value.provenance.eventsDigest = sha256(withoutReads)
    },
    events: withoutReads,
  },
  {
    name: 'different source version',
    mutate: (value: typeof result) => {
      value.run.entries[0].sourceVersion += '-wrong'
    },
  },
  {
    name: 'duplicate run',
    mutate: (value: typeof result) => {
      value.run.count = 2
    },
  },
  {
    name: 'private marker disclosed',
    mutate: (value: typeof result) => {
      value.visibility[2].leaks = 1
    },
  },
  {
    name: 'private workspace cleanup missing',
    mutate: (value: typeof result) => {
      value.workspaceClean = false
    },
  },
  {
    name: 'owner can still read after revocation',
    mutate: (value: typeof result) => {
      value.revocation.ownerHttp = 200
    },
  },
]
for (const { name, mutate, events: changedEvents } of bad) {
  const value = structuredClone(result)
  mutate(value)
  assert.throws(() => checkRd04c2(value, changedEvents ?? events), 'accepted bad evidence: ' + name)
}
console.log('RD-04c2 evidence negatives PASS (' + bad.length + ')')
