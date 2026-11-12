#!/usr/bin/env tsx
/** Independent fail-closed verdict for the redacted RD-04c2 replay evidence. */
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { fingerprintProductionAssembly, isSha256, sha256 } from './lib/acceptance-provenance.js'
import { sourceBody } from './lib/rd04c2-replay.js'

type Source = {
  kind: string
  sourceId: string
  sourceVersion: string
  sourceDigest: string
  authorizationGeneration: string
}

type Entry = Omit<Source, 'kind'> & { inboxItemId: string; sourceType: string; bodyDigest: string }
type Event = {
  component: string
  runId: string
  type: string
  audience?: string
  manifestDigest?: string
  digestVerified?: boolean
  receiptSeq?: number
  delivered?: string[]
  read?: string[]
  readEvents?: { inboxItemId: string; digestVerified: boolean }[]
  missing?: string[]
}
interface Result {
  schemaVersion: number
  mode: string
  projectId: string
  discussionTaskId: string
  comparisonTaskId: string
  taskId: string
  specRevisionId: string
  applicationId: string
  evaluationId: string
  sourceId: string
  beforeAuthorizationRuns: number
  unauthorizedHttp: number
  unapprovedRouteHttp: number
  authorization: { id: string; status: string; purpose: string; sourceManifestDigest: string }
  repeatExecutionId: string
  concurrentExecutionId: string
  authorizedSources: Source[]
  run: {
    count: number
    id: string
    taskId: string
    origin: string
    status: string
    dispatchIntentId: string
    mandateId: string
    specRevisionId: string
    manifestDigest: string
    approvalPolicy: string
    executionId: string
    entries: Entry[]
  }
  replay: {
    publicRequests: number
    discoveryRequests: number
    privateRequests: number
    reads: { inboxItemId: string; bodyDigest: string }[]
    draftDigest: string
  }
  publicArtifact: { id: string; memberHttp: number; sha256: string }
  draft: {
    id: string
    runId: string
    status: string
    sha256: string
    ownerDownloadDigest: string
    ownerHttp: number
    cacheControl: string
    memberHttp: number
    publishHttp: number
  }
  ownerHttp: number[]
  memberHttp: number[]
  visibility: { observed: number; leaks: number }[]
  privateDirectoriesObserved: number
  workspaceClean: boolean
  revocation: { ownerHttp: number; ownerRoomHasRevokedTitle: boolean }
  provenance: { assemblyDigest: string; eventsDigest: string }
}

const uuid = (value: unknown) =>
  typeof value === 'string' && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(value)

export function checkRd04c2(input: unknown, eventsBytes: string, expectedAssemblyDigest?: string) {
  const r = input as Result
  assert(r?.schemaVersion === 1, 'wrong evidence version')
  assert(isSha256(r.provenance.assemblyDigest), 'missing production assembly fingerprint')
  assert.equal(r.provenance.eventsDigest, sha256(eventsBytes), 'event fingerprint mismatch')
  if (expectedAssemblyDigest !== undefined)
    assert.equal(r.provenance.assemblyDigest, expectedAssemblyDigest, 'production assembly changed')
  const events = eventsBytes
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line) as Event)
  if (r.mode === 'revoke_before_first_read') {
    const negative = input as {
      runId: string
      delivery: number
      correctionHttp: number
      runStatus: string
      executionId: string
      executionStatus: string
      authorizedExecutionId: string
      privateRequests: number
      toolResults: number
      drafts: number
      reads: number
      privateDirectoriesObserved: number
      workspaceClean: boolean
    }
    assert(uuid(negative.runId) && uuid(negative.executionId))
    assert.equal(negative.executionId, negative.authorizedExecutionId)
    assert.equal(negative.delivery, 2)
    assert.equal(negative.correctionHttp, 200)
    assert.equal(negative.executionStatus, 'revoked')
    assert(['failed', 'cancelled'].includes(negative.runStatus), 'revoked Run did not stop')
    assert.equal(negative.privateRequests, 1)
    assert.equal(negative.toolResults, 0)
    assert.equal(negative.drafts, 0)
    assert.equal(negative.reads, 0)
    assert.equal(negative.privateDirectoriesObserved, 2)
    assert.equal(negative.workspaceClean, true)
    assert(
      events.length > 0 &&
        events.every(
          (event) =>
            event.component === 'hub.work_input' &&
            event.type === 'work_input.receipt' &&
            event.runId === negative.runId &&
            event.read?.length === 0,
        ),
      'missing or wrong delivery-only proof',
    )
    assert(
      events.some(
        (event) => event.digestVerified === true && event.delivered?.length === negative.delivery,
      ),
    )
    return
  }
  assert.equal(r.mode, 'loopback_model_replay', 'wrong evidence mode')
  assert(
    [
      r.projectId,
      r.discussionTaskId,
      r.comparisonTaskId,
      r.taskId,
      r.specRevisionId,
      r.applicationId,
      r.evaluationId,
      r.sourceId,
      r.authorization.id,
      r.run.id,
      r.run.dispatchIntentId,
      r.run.mandateId,
      r.publicArtifact.id,
      r.draft.id,
    ].every(uuid),
    'missing durable identities',
  )
  assert.equal(new Set([r.taskId, r.discussionTaskId, r.comparisonTaskId]).size, 3)
  assert.equal(r.beforeAuthorizationRuns, 0)
  assert.equal(r.unauthorizedHttp, 404)
  assert.equal(r.unapprovedRouteHttp, 409)
  assert.equal(r.authorization.id, r.repeatExecutionId)
  assert.equal(r.authorization.id, r.concurrentExecutionId)
  assert.equal(r.authorization.status, 'authorized')
  assert.equal(r.authorization.purpose, 'private_draft')
  assert(isSha256(r.authorization.sourceManifestDigest) && isSha256(r.run.manifestDigest))
  assert.equal(r.run.count, 1)
  assert.equal(r.run.executionId, r.authorization.id)
  assert.equal(r.run.taskId, r.taskId)
  assert.equal(r.run.origin, 'mandate')
  assert.equal(r.run.status, 'completed')
  assert.equal(r.run.approvalPolicy, 'approval_required')
  assert.equal(r.run.specRevisionId, r.specRevisionId)
  assert.deepEqual(r.authorizedSources.map(({ kind }) => kind).sort(), ['artifact', 'task_message'])
  assert.equal(
    r.authorizedSources.find(({ kind }) => kind === 'task_message')?.sourceId,
    r.sourceId,
  )
  const evidence = r.authorizedSources.find(({ kind }) => kind === 'artifact')
  assert(
    evidence?.sourceId === r.publicArtifact.id &&
      evidence.sourceVersion === r.publicArtifact.sha256,
  )
  assert.equal(evidence.sourceDigest, r.publicArtifact.sha256)
  assert.equal(r.run.entries.length, r.authorizedSources.length)
  assert.equal(
    new Set(r.run.entries.map(({ inboxItemId }) => inboxItemId)).size,
    r.run.entries.length,
  )
  assert.equal(r.replay.reads.length, r.run.entries.length)
  for (const entry of r.run.entries) {
    assert(uuid(entry.inboxItemId) && entry.sourceType === 'discovery_source')
    const authorized = r.authorizedSources.find(({ sourceId }) => sourceId === entry.sourceId)
    assert(authorized, 'Run received an unauthorized input')
    assert.equal(entry.sourceVersion, authorized.sourceVersion)
    assert.equal(entry.sourceDigest, authorized.sourceDigest)
    assert.equal(entry.authorizationGeneration, authorized.authorizationGeneration)
    assert(isSha256(entry.sourceDigest) && isSha256(entry.bodyDigest))
    assert.equal(
      entry.bodyDigest,
      authorized.kind === 'artifact' ? entry.sourceDigest : sha256(sourceBody),
    )
    const reads = r.replay.reads.filter(({ inboxItemId }) => inboxItemId === entry.inboxItemId)
    assert.equal(reads.length, 1, 'missing or duplicate observed DSH tool result')
    assert.equal(reads[0]!.bodyDigest, entry.bodyDigest)
  }
  assert(
    events.length >= 3 && events.every((event) => event.runId === r.run.id),
    'Run evidence missing',
  )
  const receipts = events.filter((event) => event.component === 'hub.work_input')
  assert(
    receipts.every(
      (row) =>
        row.type === 'work_input.receipt' &&
        row.manifestDigest === r.run.manifestDigest &&
        row.digestVerified === true &&
        row.missing?.length === 0 &&
        Number.isInteger(row.receiptSeq),
    ),
    'Hub did not verify the frozen input receipt',
  )
  const ids = r.run.entries.map(({ inboxItemId }) => inboxItemId).sort()
  assert(
    receipts.some(
      (row) =>
        row.read?.toSorted().join(',') === ids.join(',') &&
        row.delivered?.toSorted().join(',') === ids.join(','),
    ),
    'no complete delivery and read receipt',
  )
  const reads = receipts.flatMap((row) => row.readEvents ?? [])
  assert.deepEqual(reads.map(({ inboxItemId }) => inboxItemId).sort(), ids)
  assert(reads.every(({ digestVerified }) => digestVerified === true))
  assert.equal(r.replay.discoveryRequests, 1)
  assert.equal(r.replay.publicRequests, 3)
  assert.equal(r.replay.privateRequests, ids.length + 3)
  assert.equal(r.publicArtifact.memberHttp, 200)
  assert.equal(r.draft.ownerHttp, 200)
  assert.equal(r.draft.cacheControl, 'private, no-store')
  assert.equal(r.draft.memberHttp, 404)
  assert.equal(r.draft.publishHttp, 404)
  assert.equal(r.draft.status, 'candidate')
  assert.equal(r.draft.runId, r.run.id)
  assert(isSha256(r.draft.sha256) && r.draft.sha256 === r.draft.ownerDownloadDigest)
  assert.equal(r.draft.sha256, r.replay.draftDigest)
  assert.deepEqual(r.ownerHttp, [200, 404, 404, 404])
  assert.deepEqual(r.memberHttp, [404, 404, 200])
  assert.equal(r.privateDirectoriesObserved, 2)
  assert.equal(r.workspaceClean, true)
  assert.deepEqual(r.revocation, { ownerHttp: 404, ownerRoomHasRevokedTitle: false })
  assert.equal(r.visibility.length, 3, 'HTTP, live WebSocket and replay are required')
  assert(
    r.visibility.every(
      ({ observed, leaks }) => Number.isInteger(observed) && observed > 0 && leaks === 0,
    ),
    'private marker leaked or an observation is missing',
  )
}

export async function verifyRd04c2(resultPath: string, expectedAssemblyDigest?: string) {
  const [result, events] = await Promise.all([
    readFile(resultPath, 'utf8'),
    readFile(join(dirname(resultPath), 'events.jsonl'), 'utf8'),
  ])
  checkRd04c2(JSON.parse(result), events, expectedAssemblyDigest)
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await verifyRd04c2(
    process.argv[2] ?? 'artifacts/evidence/rd04c2/result.json',
    await fingerprintProductionAssembly(fileURLToPath(new URL('..', import.meta.url))),
  )
  console.log('RD-04c2 evidence PASS')
}
