#!/usr/bin/env tsx
/** Independent #519 evidence judge. Missing cases, zero executions and stale partial output fail. */
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

const path = process.argv[2]
assert.ok(path, 'evidence path is required')
const result = JSON.parse(await readFile(path, 'utf8')) as {
  schemaVersion: number
  issue: number
  generatedAt: string
  assembly: Record<string, string>
  scenarios: Array<{
    scenario: string
    evaluationId?: string
    status?: string
    decision?: string
    modelCalls: number
    readCount?: number
    delivered?: boolean
  }>
  sideEffects: { runs: number; intents: number; questions: number; extraTasks: number }
  ledger: Array<{ evaluationId: string; phase: string; chargeMode: string }>
  reservationsRemaining: number
  privateInputsCleaned: boolean
  modelQuality: string
}
const events = (await readFile(join(dirname(path), 'events.jsonl'), 'utf8'))
  .trim()
  .split('\n')
  .map((line) => JSON.parse(line)) as Array<{
  component: string
  action: string
  evaluationId: string
  readCount?: number
  status?: string
}>
assert.equal(result.schemaVersion, 1)
assert.equal(result.issue, 519)
assert.ok(Number.isFinite(Date.parse(result.generatedAt)))
assert.deepEqual(result.assembly, {
  hub: 'package-production-server',
  node: 'package-cli-bin',
  runtime: 'package-bin-isolated-worker',
  database: 'postgresql',
  model: 'loopback-http-replay',
})
const expected = [
  'dispatch',
  'wait',
  'ask',
  'ignore',
  'missing_citation',
  'missing_usage',
  'fast',
  'revoked',
  'restart',
]
assert.deepEqual(result.scenarios.map((s) => s.scenario).sort(), expected.sort())
for (const name of ['dispatch', 'wait', 'ask', 'ignore']) {
  const scenario = result.scenarios.find((s) => s.scenario === name)!
  assert.equal(scenario.status, 'completed')
  assert.equal(scenario.decision, name)
  assert.equal(scenario.modelCalls, 1)
  assert.ok((scenario.readCount ?? 0) > 0)
  const facts = events.filter((event) => event.evaluationId === scenario.evaluationId)
  assert.ok(
    facts.some(
      (event) => event.component === 'node.coordination' && event.action === 'runtime_started',
    ),
  )
  assert.ok(
    facts.some(
      (event) =>
        event.component === 'runtime.bridge.coordination' &&
        event.action === 'inputs_read' &&
        (event.readCount ?? 0) > 0,
    ),
  )
  assert.ok(
    facts.some(
      (event) =>
        event.component === 'runtime.bridge.coordination' && event.action === 'model_started',
    ),
  )
  assert.ok(
    facts.some(
      (event) =>
        event.component === 'hub.router' &&
        event.action === 'router.result' &&
        event.status === 'completed',
    ),
  )
  assert.ok(
    facts.some(
      (event) => event.component === 'hub.router' && event.action === 'router.usage_settled',
    ),
  )
  assert.ok(
    facts.some(
      (event) => event.component === 'node.coordination' && event.action === 'cleanup_done',
    ),
  )
}
for (const name of ['missing_citation', 'missing_usage', 'revoked', 'restart']) {
  const scenario = result.scenarios.find((s) => s.scenario === name)!
  assert.ok(['failed', 'cancelled', 'stale'].includes(scenario.status ?? ''))
  assert.equal(scenario.modelCalls, 1)
}
const fast = result.scenarios.find((s) => s.scenario === 'fast')!
assert.equal(fast.modelCalls, 0)
assert.equal(fast.delivered, true)
assert.deepEqual(result.sideEffects, { runs: 0, intents: 0, questions: 0, extraTasks: 0 })
for (const scenario of result.scenarios.filter((s) => s.evaluationId)) {
  const pair = result.ledger.filter((l) => l.evaluationId === scenario.evaluationId)
  assert.deepEqual(pair.map((l) => l.phase).sort(), ['reserved', 'settled'])
}
assert.equal(result.reservationsRemaining, 0)
assert.equal(result.privateInputsCleaned, true)
assert.equal(result.modelQuality, 'not_run')
console.log('Router evaluation evidence PASS')
