#!/usr/bin/env tsx
/** Confirm the independent verifier rejects omissions, tampering and privacy regressions. */
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fingerprintProductionAssembly, sha256 } from './lib/acceptance-provenance.js'
import { bindToolErrorFollowup } from './lib/rd04c2-tool-error.js'
import { repoRoot } from './lib/production-acceptance.js'
import { checkRd04c2 } from './verify-rd04c2-acceptance.js'

const followup = process.argv.includes('--tool-error-followup')
const binding = followup ? await bindToolErrorFollowup(repoRoot) : undefined
const assemblyDigest = followup ? await fingerprintProductionAssembly(repoRoot) : undefined
const path =
  process.argv.slice(2).find((arg) => !arg.startsWith('--')) ??
  (binding
    ? `artifacts/evidence/rd04c2/tool-error-followup/${binding.commit}/result.json`
    : 'artifacts/evidence/rd04c2/result.json')
const [resultBytes, events] = await Promise.all([
  readFile(path, 'utf8'),
  readFile(join(dirname(path), 'events.jsonl'), 'utf8'),
])
const result = JSON.parse(resultBytes)
assert.equal(result.mode, followup ? 'loopback_tool_error_followup' : 'loopback_model_replay')
checkRd04c2(result, events, assemblyDigest, binding)

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
if (followup) {
  const withoutError = events
    .split('\n')
    .filter((line) => !line || JSON.parse(line).type !== 'tool_error.observed')
    .join('\n')
  bad.push(
    {
      name: 'missing actual tool error',
      mutate: (value: typeof result) => {
        value.replay.toolErrors = []
      },
    },
    {
      name: 'duplicate actual tool error',
      mutate: (value: typeof result) => {
        value.replay.toolErrors.push(value.replay.toolErrors[0])
      },
    },
    {
      name: 'wrong tool error call',
      mutate: (value: typeof result) => {
        value.replay.toolErrors[0].callId = 'wrong-call'
      },
    },
    {
      name: 'assistant instead of tool error',
      mutate: (value: typeof result) => {
        value.replay.toolErrors[0].role = 'assistant'
      },
    },
    {
      name: 'success instead of tool error',
      mutate: (value: typeof result) => {
        value.replay.toolErrors[0].resultDigest = sha256('success')
      },
    },
    {
      name: 'removed error event even with valid fingerprint',
      mutate: (value: typeof result) => {
        value.provenance.eventsDigest = sha256(withoutError)
      },
      events: withoutError,
    },
    {
      name: 'wrong follow-up commit',
      mutate: (value: typeof result) => {
        value.provenance.commit = '0'.repeat(40)
      },
    },
    {
      name: 'wrong follow-up harness',
      mutate: (value: typeof result) => {
        value.provenance.harnessDigest = '0'.repeat(64)
      },
    },
    {
      name: 'legacy evidence substituted',
      mutate: (value: typeof result) => {
        value.schemaVersion = 1
        value.mode = 'loopback_model_replay'
      },
    },
  )
  for (const index of [0, 1, 2])
    bad.push(
      {
        name: 'error leaked on surface ' + index,
        mutate: (value: typeof result) => {
          value.visibility[index].toolErrorLeaks = 1
        },
      },
      {
        name: 'surface unobserved ' + index,
        mutate: (value: typeof result) => {
          value.visibility[index].observed = 0
        },
      },
      {
        name: 'draft leaked on surface ' + index,
        mutate: (value: typeof result) => {
          value.visibility[index].leaks = 1
        },
      },
    )
}
for (const { name, mutate, events: changedEvents } of bad) {
  const value = structuredClone(result)
  mutate(value)
  assert.throws(
    () => checkRd04c2(value, changedEvents ?? events, assemblyDigest, binding),
    'accepted bad evidence: ' + name,
  )
}
console.log('RD-04c2 evidence negatives PASS (' + bad.length + ')')
