#!/usr/bin/env tsx
/** Independent judge. Missing observations, different bindings, or extra side effects fail. */
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { sha256, verifyM1RAProvenance, type M1RAProvenance } from './lib/acceptance-provenance.js'

type Run = {
  id: string
  status: string
  origin: string
  workKey: string
  dshSessionId: string
  dispatchIntentId: string
  manifestDigest: string
  itemIds: string[]
  startedAt: string
  finishedAt: string
}
interface Evidence {
  schemaVersion: number
  provenance?: M1RAProvenance
  generatedAt: string
  assembly: Record<string, string>
  modelQuality: string
  taskId: string
  workKey: string
  mandateId: string
  ownerUserId: string
  colleagueUserId: string
  subscriptionId: string
  bootstrapIntentId: string
  statusBeforeBoundary: string
  firstSnapshot: string
  firstEvidence: {
    id: string
    runId: string
    sha256: string
    status: string
    colleagueStatus: number
    publishedAt: string
  }
  fast: {
    sourceId: string
    itemId: string
    subscriptionId: string
    outcome: string
    reason: string
    admissionItemId: string
    admissionSubscriptionId: string
    status: string
    routerInvoked: boolean
    routerCalls: number
    routerRows: number
    runCount: number
    replayedMessageId: string
    admissionCount: number
  }
  finishedRuns: Run[]
  boundaries: { runId: string; evaluationId: string; triggerKey: string; status: string }[]
  receipts: {
    id: string
    runId: string
    manifestDigest: string
    entriesRead: string[]
    digestVerified: boolean
    readEvents: { inboxItemId: string; at: string; digestVerified: boolean }[]
  }[]
  consumptions: {
    receiptId: string
    runId: string
    inboxItemId: string
    kind: string
    manifestDigest: string
    readAt: string
  }[]
  inbox: { id: string; sourceId: string; status: string; bodyDigest: string }[]
  intents: { id: string; runId: string; status: string; approvalBasis: string; mandateId: string }[]
  applications: {
    evaluationId: string
    decision: string
    status: string
    runId: string | null
    intentId: string | null
    waitId: string | null
  }[]
  evaluations: {
    id: string
    status: string
    decision: string
    coverage: { inputId: string; status: string; evidenceIds: string[] }[]
    readEntryIds: string[]
    entries: { id: string; kind: string; sourceId: string; digest: string }[]
  }[]
  executorUsage: { runId: string; phase: string; chargeMode: string | null }[]
  draft: {
    id: string
    runId: string
    ownerUserId: string
    status: string
    sha256: string
    downloadedSha256: string
    ownerStatus: number
    colleagueStatus: number
  }
  wait: { id: string; evaluationId: string; status: string }
  replay: {
    routerCalls: { decision: string; sources: number; evidence: number }[]
    executorCalls: { phase: number; name: string; inboxItemId?: string; bodyDigest?: string }[]
  }
  totalTasks: number
}
interface Event {
  component: string
  runId?: string
  evaluationId?: string
  action?: string
  msg?: string
  type?: string
  audience?: string
  toolName?: string
  callId?: string
  outcome?: string
  readCount?: number
  seq?: number
}
const uuid = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/
const digest = /^[0-9a-f]{64}$/

function one<T>(values: readonly T[], label: string): T {
  assert.equal(values.length, 1, label)
  return values[0]!
}

export async function verifyM1RA(path: string, expectedAssemblyDigest?: string) {
  const resultBytes = await readFile(path)
  const result = JSON.parse(resultBytes.toString('utf8')) as Evidence
  const eventBytes = await readFile(join(dirname(path), 'events.jsonl'))
  verifyM1RAProvenance(result, eventBytes, expectedAssemblyDigest)
  const events = eventBytes
    .toString('utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line) as Event)
  assert(Number.isFinite(Date.parse(result.generatedAt)))
  assert.deepEqual(result.assembly, {
    hub: 'production-package-bin',
    node: 'production-package-replay-assembly',
    runtime: 'production-dsh-package-bin',
    database: 'postgresql',
    model: 'loopback-http-replay',
  })
  assert.equal(result.modelQuality, 'not_run')
  assert.equal(result.totalTasks, 1)
  for (const id of [
    result.taskId,
    result.workKey,
    result.mandateId,
    result.subscriptionId,
    result.ownerUserId,
    result.colleagueUserId,
  ])
    assert.match(id, uuid)
  assert.notEqual(result.ownerUserId, result.colleagueUserId)
  const { fast } = result
  assert.match(fast.sourceId, uuid)
  assert.match(fast.itemId, uuid)
  assert.equal(fast.subscriptionId, result.subscriptionId)
  assert.equal(fast.outcome, 'deliver')
  assert.equal(fast.reason, 'subscription_match')
  assert.equal(fast.admissionItemId, fast.itemId)
  assert.equal(fast.admissionSubscriptionId, result.subscriptionId)
  assert.equal(fast.status, 'pending')
  assert.equal(fast.routerInvoked, false)
  assert.equal(fast.routerCalls, 0)
  assert.equal(fast.routerRows, 0)
  assert.equal(fast.runCount, 0)
  assert.equal(fast.replayedMessageId, fast.sourceId)
  assert.equal(fast.admissionCount, 1)
  assert.equal(result.statusBeforeBoundary, 'pending')

  assert.equal(result.finishedRuns.length, 2, 'exactly two business Runs')
  const [first, next] = result.finishedRuns as [Run, Run]
  assert.notEqual(next.id, first.id)
  assert.notEqual(next.dshSessionId, first.dshSessionId)
  assert.equal(first.dispatchIntentId, result.bootstrapIntentId)
  assert.equal(first.itemIds.length, 1)
  assert.notEqual(first.itemIds[0], fast.itemId)
  assert.deepEqual(next.itemIds, [fast.itemId])
  assert.equal(first.manifestDigest, result.firstSnapshot, 'first Run snapshot remains unchanged')
  assert.notEqual(first.manifestDigest, next.manifestDigest)
  assert(
    Date.parse(next.startedAt) >= Date.parse(first.finishedAt),
    'next Runtime starts after the first terminates',
  )

  assert.equal(result.boundaries.length, 2)
  assert.equal(result.applications.length, 2)
  assert.equal(result.evaluations.length, 2)
  assert.equal(result.intents.length, 2)
  assert.equal(result.inbox.length, 2)
  assert.equal(result.consumptions.length, 2)
  assert.deepEqual(result.replay.routerCalls, [
    { decision: 'dispatch', sources: 2, evidence: 1 },
    { decision: 'wait', sources: 1, evidence: 1 },
  ])
  const source = one(
    result.inbox.filter((item) => item.id === fast.itemId),
    'subscribed inbox item',
  )
  assert.equal(source.sourceId, fast.sourceId)
  for (const [index, run] of result.finishedRuns.entries()) {
    const phase = index + 1
    assert.match(run.id, uuid)
    assert.equal(run.dshSessionId, `whalepod-run-${run.id}`)
    assert.equal(run.status, 'completed')
    assert.equal(run.origin, 'mandate')
    assert.equal(run.workKey, result.workKey)
    assert.match(run.manifestDigest, digest)
    assert(Date.parse(run.finishedAt) >= Date.parse(run.startedAt))
    const intent = one(
      result.intents.filter((row) => row.runId === run.id),
      'mandate-backed dispatch',
    )
    assert.equal(intent.id, run.dispatchIntentId)
    assert.equal(intent.status, 'dispatched')
    assert.equal(intent.approvalBasis, 'mandate')
    assert.equal(intent.mandateId, result.mandateId)
    const inbox = one(
      result.inbox.filter((item) => item.id === run.itemIds[0]),
      'frozen inbox item',
    )
    assert.equal(inbox.status, 'consumed')
    assert.match(inbox.bodyDigest, digest)
    const consumption = one(
      result.consumptions.filter((row) => row.runId === run.id),
      'persisted consumption',
    )
    assert.equal(consumption.kind, 'consumed')
    assert.equal(consumption.manifestDigest, run.manifestDigest)
    assert.equal(consumption.inboxItemId, inbox.id)
    const receipt = one(
      result.receipts.filter((row) => row.id === consumption.receiptId),
      'authoritative receipt',
    )
    assert.equal(receipt.runId, run.id)
    assert.equal(receipt.manifestDigest, run.manifestDigest)
    assert.equal(receipt.digestVerified, true)
    assert.deepEqual(receipt.entriesRead, [inbox.id])
    assert.deepEqual(receipt.readEvents, [
      { inboxItemId: inbox.id, at: consumption.readAt, digestVerified: true },
    ])

    const calls = result.replay.executorCalls.filter((call) => call.phase === phase)
    assert.deepEqual(
      calls.map((call) => call.name),
      ['read_work_input', 'write', 'publish_artifact', 'stop'],
    )
    assert.equal(calls[0]!.inboxItemId, inbox.id)
    assert.equal(
      calls[1]!.bodyDigest,
      inbox.bodyDigest,
      'actual tool-returned body reached the next model request',
    )
    const runEvents = events.filter(
      (event) =>
        event.component === 'hub.run' && event.runId === run.id && event.audience === 'owner',
    )
    assert(
      runEvents.some((event) => event.type === 'runtime.ready'),
      'persisted Runtime ready frame',
    )
    assert(
      runEvents.some((event) => event.type === 'run.completed'),
      'persisted Run terminal frame',
    )
    for (const [toolName, callId] of [
      ['read_work_input', `read-${phase}`],
      ['write', `write-${phase}`],
      ['publish_artifact', `candidate-${phase}`],
    ]) {
      const start = one(
        runEvents.filter(
          (event) =>
            event.type === 'tool.started' && event.callId === callId && event.toolName === toolName,
        ),
        `real DSH ${toolName} start`,
      )
      const finish = one(
        runEvents.filter((event) => event.type === 'tool.finished' && event.callId === callId),
        `real DSH ${toolName} finish`,
      )
      assert.equal(finish.outcome, 'succeeded')
      assert(
        Number.isInteger(start.seq) && Number.isInteger(finish.seq) && finish.seq! > start.seq!,
      )
    }
    const boundary = one(
      result.boundaries.filter((row) => row.runId === run.id),
      'unique terminal boundary',
    )
    assert.equal(boundary.triggerKey, `run-terminal:${run.id}`)
    assert.equal(boundary.status, 'enqueued')
    assert.match(boundary.evaluationId, uuid)
    assert(
      events.some(
        (event) =>
          event.component === 'hub.dispatch' &&
          event.action === 'work.run_boundary.enqueued' &&
          event.runId === run.id &&
          event.evaluationId === boundary.evaluationId,
      ),
      'production scheduler trace',
    )
    assert(
      events.some(
        (event) =>
          event.component === 'runtime.bridge.coordination' &&
          event.evaluationId === boundary.evaluationId &&
          Number.isInteger(event.readCount) &&
          event.readCount! > 0,
      ),
      'actual coordination Runtime read manifest',
    )
    const application = one(
      result.applications.filter((row) => row.evaluationId === boundary.evaluationId),
      'Hub applied boundary proposal',
    )
    assert.equal(application.status, 'applied')
    const evaluation = one(
      result.evaluations.filter((row) => row.id === boundary.evaluationId),
      'stored accepted evaluation',
    )
    assert.equal(evaluation.status, 'completed')
    assert.equal(evaluation.decision, application.decision)
    assert.deepEqual(
      [...evaluation.readEntryIds].sort(),
      evaluation.entries.map((entry) => entry.id).sort(),
    )
    const evidence = one(
      evaluation.entries.filter((entry) => entry.kind === 'evidence'),
      'only published evidence',
    )
    assert.equal(evidence.sourceId, result.firstEvidence.id)
    assert.equal(evidence.digest, result.firstEvidence.sha256)
    const supplement = one(
      evaluation.entries.filter(
        (entry) => entry.kind === 'source' && entry.sourceId === `task_message:${fast.sourceId}`,
      ),
      'same subscription source in Router manifest',
    )
    const supplementCoverage = one(
      evaluation.coverage.filter((entry) => entry.inputId === supplement.id),
      'supplement coverage',
    )
    assert.equal(supplement.digest, source.bodyDigest)
    assert.deepEqual(supplementCoverage.evidenceIds, [])
    if (index === 0) {
      assert.equal(evaluation.coverage.length, 2)
      assert.equal(supplementCoverage.status, 'uncovered')
      const bootstrapCoverage = one(
        evaluation.coverage.filter((entry) => entry.inputId !== supplement.id),
        'bootstrap coverage',
      )
      assert.equal(bootstrapCoverage.status, 'covered')
      assert.deepEqual(bootstrapCoverage.evidenceIds, [evidence.id])
    } else {
      assert.equal(evaluation.coverage.length, 1)
      assert.equal(supplementCoverage.status, 'unknown')
    }
    if (index === 0) {
      assert.equal(application.decision, 'dispatch')
      assert.equal(application.runId, next.id)
      assert.equal(application.intentId, next.dispatchIntentId)
      assert.equal(application.waitId, null)
    } else {
      assert.equal(application.decision, 'wait')
      assert.equal(application.runId, null)
      assert.equal(application.intentId, null)
      assert.equal(application.waitId, result.wait.id)
      assert.equal(application.evaluationId, result.wait.evaluationId)
    }
    const ledger = result.executorUsage.filter((row) => row.runId === run.id)
    assert.deepEqual(ledger.map((row) => row.phase).sort(), ['reserved', 'settled'])
    assert.equal(ledger.find((row) => row.phase === 'settled')?.chargeMode, 'actual')
  }
  assert.match(result.wait.id, uuid)
  assert.equal(result.wait.status, 'open')
  assert.match(result.firstEvidence.id, uuid)
  assert.equal(result.firstEvidence.runId, first.id)
  assert.match(result.firstEvidence.sha256, digest)
  assert.equal(result.firstEvidence.status, 'published')
  assert.equal(result.firstEvidence.colleagueStatus, 200)
  assert(Date.parse(result.firstEvidence.publishedAt) <= Date.parse(first.finishedAt))
  assert.match(result.draft.id, uuid)
  assert.notEqual(result.draft.id, result.firstEvidence.id)
  assert.equal(result.draft.status, 'candidate')
  assert.equal(result.draft.runId, next.id)
  assert.equal(result.draft.ownerUserId, result.ownerUserId)
  assert.match(result.draft.sha256, digest)
  assert.equal(result.draft.sha256, result.draft.downloadedSha256)
  assert.equal(result.draft.ownerStatus, 200)
  assert.equal(result.draft.colleagueStatus, 404)
  return { resultDigest: sha256(resultBytes), assemblyDigest: result.provenance?.assemblyDigest }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const path = process.argv[2]
  assert(path, 'usage: verify-m1r-a-acceptance.ts <evidence/result.json>')
  await verifyM1RA(path)
  console.log('M1R-A evidence PASS')
}
