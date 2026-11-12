#!/usr/bin/env tsx
/** Independent, fail-closed RD-05a judge. No old acceptance verdict is trusted. */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import type {
  Rd05aBinding,
  Rd05aDraft,
  Rd05aEvidence,
  Rd05aEvent,
  Rd05aReceipt,
  Rd05aRun,
  Rd05aSource,
  Rd05aToolRead,
} from './lib/rd05a-evidence.js'

const sha256 = (value: string) => createHash('sha256').update(value).digest('hex')
function sourceManifestDigest(sources: Rd05aSource[]) {
  const canonical = (value: unknown): string => {
    if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']'
    if (value && typeof value === 'object')
      return (
        '{' +
        Object.entries(value)
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([key, nested]) => JSON.stringify(key) + ':' + canonical(nested))
          .join(',') +
        '}'
      )
    return JSON.stringify(value)
  }
  return sha256(
    canonical(
      sources.map(({ kind, sourceId, sourceVersion, sourceDigest, authorizationGeneration }) => ({
        kind,
        sourceId,
        sourceVersion,
        sourceDigest,
        authorizationGeneration,
      })),
    ),
  )
}
function uuid(value: unknown, label: string): asserts value is string {
  assert(
    typeof value === 'string' && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(value),
    label,
  )
}
function digest(value: unknown, label: string): asserts value is string {
  assert(typeof value === 'string' && /^[a-f0-9]{64}$/.test(value), label)
}
function time(value: unknown): number {
  assert(typeof value === 'string' && Number.isFinite(Date.parse(value)), 'missing valid timestamp')
  return Date.parse(value)
}
function unique(values: readonly string[], label: string) {
  assert.equal(new Set(values).size, values.length, label)
}
function sameIds(actual: readonly string[], expected: readonly string[], label: string) {
  unique(actual, label)
  assert.deepEqual([...actual].sort(), [...expected].sort(), label)
}
function one<T>(values: readonly T[], label: string): T {
  assert.equal(values.length, 1, label)
  return values[0]!
}
function source(value: Rd05aSource) {
  assert(['task_message', 'artifact'].includes(value.kind), 'unknown source kind')
  uuid(value.sourceId, 'missing source id')
  assert(
    typeof value.sourceVersion === 'string' && value.sourceVersion.length > 0,
    'missing source version',
  )
  digest(value.sourceDigest, 'missing source digest')
  assert(
    typeof value.authorizationGeneration === 'string' && value.authorizationGeneration.length > 0,
    'missing source authorization generation',
  )
}

/** Evidence is hashes/identities/counts, never a private-body or local-path archive. */
function redacted(value: unknown): void {
  if (typeof value === 'string') {
    assert(!value.startsWith('/') && !/^[a-zA-Z]:[\\/]/.test(value), 'absolute path in evidence')
    return
  }
  if (Array.isArray(value)) {
    value.forEach(redacted)
    return
  }
  if (value && typeof value === 'object') {
    for (const [key, nested] of Object.entries(value)) {
      assert(
        !/^(?:body|content|text|prompt|password|token|apiKey|secret)$/i.test(key),
        'unredacted field in evidence',
      )
      redacted(nested)
    }
  }
}

/** Keep every captured snapshot. Delivery/read sets are cumulative; readEvents are
 * newly observed reads, not another copy of the cumulative set. Transport may reorder
 * rows, so validate by receiptSeq, never by database query arrival order.
 */
function receipts(
  rows: Rd05aReceipt[],
  runId: string,
  manifest: string,
  itemIds: string[],
  mustRead: boolean,
) {
  assert(rows.length > 0, 'missing work-input receipts')
  unique(
    rows.map((row) => row.id),
    'duplicate receipt identity',
  )
  const ordered = [...rows].sort((a, b) => a.receiptSeq - b.receiptSeq)
  let previousSeq = 0
  let delivered: string[] = []
  let read: string[] = []
  const actualReads: string[] = []
  for (const row of ordered) {
    uuid(row.id, 'missing receipt identity')
    assert.equal(row.runId, runId, 'receipt Run changed')
    assert.equal(row.manifestDigest, manifest, 'receipt manifest changed')
    assert(
      Number.isSafeInteger(row.receiptSeq) && row.receiptSeq > previousSeq,
      'invalid receipt sequence',
    )
    previousSeq = row.receiptSeq
    assert.equal(row.digestVerified, true, 'unverified receipt')
    assert.deepEqual(row.missing, [], 'receipt missing input')
    unique(row.entriesDelivered, 'duplicate delivery')
    unique(row.entriesRead, 'duplicate cumulative read')
    assert(
      row.entriesDelivered.every((id) => itemIds.includes(id)),
      'unknown delivered input',
    )
    assert(
      row.entriesRead.every((id) => row.entriesDelivered.includes(id)),
      'read without delivery',
    )
    assert(
      delivered.every((id) => row.entriesDelivered.includes(id)),
      'delivery snapshot regressed',
    )
    assert(
      read.every((id) => row.entriesRead.includes(id)),
      'read snapshot regressed',
    )
    const newlyRead = row.entriesRead.filter((id) => !read.includes(id))
    sameIds(
      row.readEvents.map((event) => event.inboxItemId),
      newlyRead,
      'actual read delta does not match snapshot',
    )
    for (const event of row.readEvents) {
      assert.equal(event.digestVerified, true, 'unverified actual read')
      time(event.at)
      actualReads.push(event.inboxItemId)
    }
    delivered = row.entriesDelivered
    read = row.entriesRead
  }
  sameIds(delivered, itemIds, 'final delivery incomplete')
  sameIds(read, mustRead ? itemIds : [], 'final read coverage incomplete')
  sameIds(actualReads, mustRead ? itemIds : [], 'missing or duplicate actual read')
}

function draft(value: Rd05aDraft, runId: string, owner: string, privateExecution: boolean) {
  uuid(value.id, 'missing draft identity')
  assert.equal(value.runId, runId, 'wrong draft producer')
  assert.equal(value.ownerUserId, owner, 'wrong draft owner')
  assert.equal(value.status, 'candidate', 'draft formally published')
  digest(value.sha256, 'missing draft digest')
  assert.equal(value.ownerDownloadDigest, value.sha256, 'download differs from actual draft')
  assert.equal(value.ownerHttp, 200, 'owner draft unavailable')
  assert.equal(value.memberHttp, 404, 'draft visible to another member')
  if (privateExecution) {
    assert.equal(value.cacheControl, 'private, no-store', 'private execution can be cached')
    assert([403, 404, 409].includes(value.publishHttp ?? 0), 'formal publication not blocked')
  } else assert.equal(value.publishHttp, null, 'fast draft publication was attempted')
}

function reads(
  observed: Rd05aToolRead[],
  expected: { runId: string; inboxItemId: string; bodyDigest: string }[],
) {
  assert.equal(observed.length, expected.length, 'missing or extra actual model tool read')
  unique(
    observed.map((row) => `${row.runId}:${row.callId}`),
    'duplicate model tool call',
  )
  for (const wanted of expected) {
    const row = one(
      observed.filter(
        (row) => row.runId === wanted.runId && row.inboxItemId === wanted.inboxItemId,
      ),
      'actual model tool read',
    )
    assert(
      typeof row.callId === 'string' && row.callId.length > 0,
      'missing real tool call identity',
    )
    digest(row.bodyDigest, 'missing actual tool body digest')
    assert.equal(row.bodyDigest, wanted.bodyDigest, 'actual model tool body differs')
  }
}

function fastFlow(r: Rd05aEvidence, bootstrap: Rd05aRun, continuation: Rd05aRun) {
  const f = r.fast
  for (const value of [
    f.taskId,
    f.discussionTaskId,
    f.workKey,
    f.mandateId,
    f.subscriptionId,
    f.bootstrapIntentId,
  ])
    uuid(value, 'missing fast identity')
  assert.notEqual(f.taskId, f.discussionTaskId, 'venue and discussion Task reused')
  assert.equal(bootstrap.taskId, f.taskId)
  assert.equal(continuation.taskId, f.taskId)
  for (const run of [bootstrap, continuation]) {
    assert.equal(run.workKey, f.workKey)
    assert.equal(run.mandateId, f.mandateId)
  }
  assert.equal(f.bootstrapIntentId, bootstrap.dispatchIntentId)
  assert.equal(f.firstSnapshot, bootstrap.manifestDigest, 'first frozen snapshot changed')
  assert.notEqual(
    bootstrap.manifestDigest,
    continuation.manifestDigest,
    'continuation reused frozen snapshot',
  )
  assert(
    time(continuation.startedAt) >= time(bootstrap.finishedAt),
    'continuation overlaps bootstrap',
  )
  assert.equal(f.statusBeforeBoundary, 'pending')
  source(f.bootstrapSource)
  source(f.supplement.source)
  assert.equal(f.bootstrapSource.kind, 'task_message')
  assert.equal(f.supplement.source.kind, 'task_message')
  assert.equal(f.supplement.authorId, r.members.ownerId, 'fast source must be authored by A')
  assert.notEqual(f.bootstrapSource.sourceId, f.supplement.source.sourceId)
  const s = f.supplement
  uuid(s.itemId, 'missing supplement inbox identity')
  assert.equal(s.replayedMessageId, s.source.sourceId)
  assert.equal(s.admissionCount, 1)
  assert.equal(s.outcome, 'deliver')
  assert.equal(s.reason, 'subscription_match')
  assert.equal(s.subscriptionId, f.subscriptionId)
  assert.equal(s.admissionSubscriptionId, f.subscriptionId)
  assert.equal(s.admissionItemId, s.itemId)
  assert.equal(s.status, 'pending')
  assert.equal(s.routerInvoked, false)
  for (const count of [s.routerCalls, s.routerRows, s.runCount])
    assert.equal(count, 0, 'ingress invoked orchestration')
  assert.equal(f.inbox.length, 2, 'fast requires exactly two inbox items')
  unique(
    f.inbox.map((row) => row.id),
    'duplicate fast inbox item',
  )
  sameIds(continuation.itemIds, [s.itemId], 'wrong continuation input')
  assert.equal(bootstrap.itemIds.length, 1)
  assert(!bootstrap.itemIds.includes(s.itemId), 'first frozen snapshot includes late supplement')
  assert.equal(f.consumptions.length, 2, 'exactly two persisted consumptions')
  assert.equal(f.intents.length, 2, 'exactly two mandate intents')
  assert.equal(f.boundaries.length, 2, 'exactly two terminal boundaries')
  assert.equal(f.evaluations.length, 2, 'exactly two boundary Router evaluations')
  unique(
    f.evaluations.map((row) => row.id),
    'duplicate Router evaluation',
  )
  assert.equal(f.applications.length, 2)
  assert.deepEqual(f.replay.routerCalls, [
    { decision: 'dispatch', sources: 2, evidence: 1 },
    { decision: 'wait', sources: 1, evidence: 1 },
  ])
  assert(
    f.receipts.every((row) => [bootstrap.id, continuation.id].includes(row.runId)),
    'unknown fast receipt Run',
  )

  for (const [index, run] of [bootstrap, continuation].entries()) {
    const item = one(
      f.inbox.filter((row) => row.id === run.itemIds[0]),
      'frozen fast inbox item',
    )
    uuid(item.id, 'missing inbox identity')
    assert.equal(
      item.sourceId,
      index === 0 ? f.bootstrapSource.sourceId : s.source.sourceId,
      'wrong original source identity',
    )
    assert.equal(item.status, 'consumed')
    digest(item.bodyDigest, 'missing source tool body digest')
    receipts(
      f.receipts.filter((row) => row.runId === run.id),
      run.id,
      run.manifestDigest,
      run.itemIds,
      true,
    )
    const consumption = one(
      f.consumptions.filter((row) => row.runId === run.id),
      'persisted fast consumption',
    )
    const receipt = one(
      f.receipts.filter((row) => row.id === consumption.receiptId),
      'consumption receipt join',
    )
    assert.equal(consumption.inboxItemId, item.id)
    assert.equal(consumption.manifestDigest, run.manifestDigest)
    assert.equal(consumption.kind, 'consumed')
    assert.equal(receipt.runId, run.id)
    const read = one(
      receipt.readEvents.filter((event) => event.inboxItemId === item.id),
      'consumption actual read',
    )
    assert.equal(consumption.readAt, read.at)
    const intent = one(
      f.intents.filter((row) => row.runId === run.id),
      'mandate dispatch join',
    )
    assert.equal(intent.id, run.dispatchIntentId)
    assert.equal(intent.status, 'dispatched')
    assert.equal(intent.approvalBasis, 'mandate')
    assert.equal(intent.mandateId, f.mandateId)
    const boundary = one(
      f.boundaries.filter((row) => row.runId === run.id),
      'terminal boundary join',
    )
    assert.equal(boundary.triggerKey, `run-terminal:${run.id}`)
    assert.equal(boundary.status, 'enqueued')
    uuid(boundary.evaluationId, 'missing boundary evaluation')
    const evaluation = one(
      f.evaluations.filter((row) => row.id === boundary.evaluationId),
      'Router evaluation join',
    )
    const application = one(
      f.applications.filter((row) => row.evaluationId === evaluation.id),
      'Router application join',
    )
    const decision = index === 0 ? 'dispatch' : 'wait'
    assert.equal(evaluation.status, 'completed')
    assert.equal(evaluation.decision, decision)
    assert.equal(application.status, 'applied')
    assert.equal(application.decision, decision)
    sameIds(
      evaluation.readEntryIds,
      evaluation.entries.map((entry) => entry.id),
      'Router manifest not completely read',
    )
    const published = one(
      evaluation.entries.filter((entry) => entry.kind === 'evidence'),
      'published Router corroboration',
    )
    assert.equal(published.sourceId, f.publicArtifact.id)
    assert.equal(published.digest, f.publicArtifact.sha256)
    const supplement = one(
      evaluation.entries.filter(
        (entry) =>
          entry.kind === 'source' && entry.sourceId === `task_message:${s.source.sourceId}`,
      ),
      'Router supplement source',
    )
    assert.equal(supplement.digest, f.inbox.find((row) => row.id === s.itemId)!.bodyDigest)
    const coverage = one(
      evaluation.coverage.filter((row) => row.inputId === supplement.id),
      'Router supplement coverage',
    )
    assert.equal(coverage.status, index === 0 ? 'uncovered' : 'unknown')
    assert.deepEqual(coverage.evidenceIds, [])
    assert.equal(
      evaluation.entries.filter((entry) => entry.kind === 'source').length,
      index === 0 ? 2 : 1,
    )
    assert.equal(evaluation.coverage.length, index === 0 ? 2 : 1)
    if (index === 0) {
      const original = one(
        evaluation.entries.filter(
          (entry) =>
            entry.kind === 'source' &&
            entry.sourceId === `task_message:${f.bootstrapSource.sourceId}`,
        ),
        'original Router source',
      )
      assert.equal(
        original.digest,
        f.inbox.find((row) => row.id === bootstrap.itemIds[0])!.bodyDigest,
      )
      const covered = one(
        evaluation.coverage.filter((row) => row.inputId === original.id),
        'original coverage',
      )
      assert.equal(covered.status, 'covered')
      assert.deepEqual(covered.evidenceIds, [published.id])
      assert.equal(application.runId, continuation.id)
      assert.equal(application.intentId, continuation.dispatchIntentId)
      assert.equal(application.waitId, null)
    } else {
      assert.equal(application.runId, null)
      assert.equal(application.intentId, null)
      assert.equal(application.waitId, f.wait.id)
      assert.equal(f.wait.evaluationId, evaluation.id)
    }
  }
  reads(
    f.replay.toolReads,
    [bootstrap, continuation].map((run) => ({
      runId: run.id,
      inboxItemId: run.itemIds[0]!,
      bodyDigest: f.inbox.find((item) => item.id === run.itemIds[0])!.bodyDigest,
    })),
  )
  uuid(f.wait.id, 'missing wait identity')
  assert.equal(f.wait.status, 'open')
  const published = f.publicArtifact
  uuid(published.id, 'missing published artifact identity')
  assert.equal(published.runId, bootstrap.id)
  assert.equal(published.ownerUserId, r.members.ownerId)
  digest(published.sha256, 'missing published bytes digest')
  assert.equal(published.status, 'published')
  assert.equal(published.memberHttp, 200)
  assert(time(published.publishedAt) <= time(bootstrap.finishedAt), 'publication after first Run')
  draft(f.draft, continuation.id, r.members.ownerId, false)
  assert.notEqual(f.draft.id, published.id)
}

function slowFlow(r: Rd05aEvidence, run: Rd05aRun) {
  const s = r.slow
  for (const value of [
    s.taskId,
    s.specRevisionId,
    s.applicationId,
    s.evaluationId,
    s.authorization.id,
  ])
    uuid(value, 'missing discovery identity')
  unique(
    [r.fast.taskId, r.fast.discussionTaskId, s.taskId],
    'discovery must create a separate Task',
  )
  assert.equal(run.taskId, s.taskId)
  assert.equal(run.specRevisionId, s.specRevisionId)
  sameIds(s.createdTaskIds, [s.taskId], 'exactly one discovery Task')
  source(s.source)
  assert.equal(s.source.kind, 'task_message')
  assert.equal(s.sourceAuthorId, r.members.memberId, 'discovery source must be authored by B')
  unique(
    [s.source.sourceId, r.fast.bootstrapSource.sourceId, r.fast.supplement.source.sourceId],
    'fast and slow sources reused',
  )
  assert.equal(s.beforeAuthorizationRuns, 0)
  assert.equal(s.wrongAccountHttp, 409)
  assert.equal(s.nonownerHttp, 404)
  const auth = s.authorization
  assert.equal(auth.ownerUserId, r.members.ownerId)
  assert.equal(auth.status, 'authorized')
  assert.equal(auth.purpose, 'private_draft')
  assert.equal(
    auth.liveOnlyGrantCount,
    0,
    'live-only authorization cannot substitute frozen exact sources',
  )
  assert.equal(
    auth.sourceManifestDigest,
    sourceManifestDigest(auth.sources),
    'exact source manifest digest changed',
  )
  for (const value of [s.repeatExecutionId, s.concurrentExecutionId, s.executionId])
    assert.equal(value, auth.id, 'execution idempotency broken')
  assert.equal(s.targetRunCount, 1)
  assert.equal(s.approvalPolicy, 'approval_required')
  assert.equal(auth.sources.length, 2)
  unique(
    auth.sources.map((row) => row.sourceId),
    'duplicate authorized source',
  )
  auth.sources.forEach(source)
  assert.deepEqual(auth.sources.map((row) => row.kind).sort(), ['artifact', 'task_message'])
  assert.deepEqual(
    one(
      auth.sources.filter((row) => row.kind === 'task_message'),
      'authorized B comment',
    ),
    s.source,
  )
  const published = one(
    auth.sources.filter((row) => row.kind === 'artifact'),
    'authorized A artifact',
  )
  assert.equal(published.sourceId, r.fast.publicArtifact.id)
  assert.equal(published.sourceVersion, r.fast.publicArtifact.sha256)
  assert.equal(published.sourceDigest, r.fast.publicArtifact.sha256)
  assert.equal(s.entries.length, 2)
  sameIds(
    s.entries.map((entry) => entry.inboxItemId),
    run.itemIds,
    'frozen Run manifest inputs',
  )
  unique(
    s.entries.map((entry) => entry.sourceId),
    'duplicate private source entry',
  )
  for (const entry of s.entries) {
    uuid(entry.inboxItemId, 'missing private inbox identity')
    assert.equal(entry.sourceType, 'discovery_source')
    const authorized = one(
      auth.sources.filter((row) => row.sourceId === entry.sourceId),
      'unauthorized frozen source',
    )
    assert.equal(entry.sourceVersion, authorized.sourceVersion)
    assert.equal(entry.sourceDigest, authorized.sourceDigest)
    assert.equal(entry.authorizationGeneration, authorized.authorizationGeneration)
    digest(entry.bodyDigest, 'missing real private source body digest')
    if (authorized.kind === 'artifact')
      assert.equal(entry.bodyDigest, authorized.sourceDigest, 'artifact tool body changed')
  }
  receipts(s.receipts, run.id, run.manifestDigest, run.itemIds, true)
  reads(
    s.replay.toolReads,
    s.entries.map((entry) => ({
      runId: run.id,
      inboxItemId: entry.inboxItemId,
      bodyDigest: entry.bodyDigest,
    })),
  )
  assert.equal(s.replay.discoveryRequests, 1)
  assert.equal(s.replay.privateRequests, s.entries.length + 4)
  // Constants are intentionally checked here, not delegated to the c2 verifier.
  assert.deepEqual(
    s.replay.toolErrors,
    [
      {
        callId: 'private-read-error',
        toolName: 'read_work_input',
        role: 'tool',
        resultDigest: sha256('Error: unknown work input item: RD04C2_PRIVATE_TOOL_ERROR_ONLY'),
      },
    ],
    'actual c2 tool error missing',
  )
  draft(s.draft, run.id, r.members.ownerId, true)
  assert.equal(s.replay.draftDigest, s.draft.sha256)
  unique([r.fast.publicArtifact.id, r.fast.draft.id, s.draft.id], 'artifact identities reused')
  assert.equal(s.publicArtifactMemberHttp, 200)
  assert.deepEqual(s.visibility.map((row) => row.surface).sort(), ['http', 'ws_live', 'ws_replay'])
  for (const surface of s.visibility) {
    assert(
      Number.isSafeInteger(surface.observed) && surface.observed > 0,
      'unobserved private surface',
    )
    assert.equal(surface.draftLeaks, 0, 'draft leak')
    assert.equal(surface.toolErrorLeaks, 0, 'tool error leak')
  }
  assert.equal(s.privateDirectoriesObserved, 2)
  assert.equal(s.workspaceClean, true)
  assert.deepEqual(s.revocation, {
    executionId: auth.id,
    status: 'revoked',
    ownerHttp: 404,
    ownerRoomHasRevokedTitle: false,
  })
}

function negativeFlow(r: Rd05aEvidence) {
  const n = r.revokeBeforeRead
  for (const value of [n.projectId, n.taskId, n.workKey, n.sourceId, n.executionId, n.runId])
    uuid(value, 'missing negative identity')
  assert.equal(n.projectId, r.projectId)
  unique(
    [r.fast.taskId, r.fast.discussionTaskId, r.slow.taskId, n.taskId],
    'negative requires fresh Task',
  )
  unique(
    [
      r.fast.bootstrapSource.sourceId,
      r.fast.supplement.source.sourceId,
      r.slow.source.sourceId,
      n.sourceId,
    ],
    'negative requires fresh comment',
  )
  assert.notEqual(n.executionId, r.slow.executionId)
  assert(!r.runs.some((run) => run.id === n.runId), 'negative counted as a positive Run')
  assert.equal(n.executionId, n.authorizedExecutionId)
  assert.equal(n.delivery, 2)
  assert.equal(n.correctionHttp, 200)
  assert.equal(n.executionStatus, 'revoked')
  assert(['failed', 'cancelled'].includes(n.runStatus), 'negative Run did not stop')
  assert.equal(n.privateRequests, 1)
  for (const count of [n.toolResults, n.drafts, n.reads])
    assert.equal(count, 0, 'revoke-before-read leaked an effect')
  assert(n.receipts.length > 0, 'negative delivery proof missing')
  const final = [...n.receipts].sort((a, b) => a.receiptSeq - b.receiptSeq).at(-1)!
  digest(final.manifestDigest, 'missing negative manifest digest')
  assert.equal(final.entriesDelivered.length, n.delivery)
  final.entriesDelivered.forEach((value) => uuid(value, 'missing negative inbox identity'))
  receipts(n.receipts, n.runId, final.manifestDigest, final.entriesDelivered, false)
  assert.equal(n.privateDirectoriesObserved, 2)
  assert.equal(n.workspaceClean, true)
}

function stagesAndActions(
  r: Rd05aEvidence,
  bootstrap: Rd05aRun,
  continuation: Rd05aRun,
  discovery: Rd05aRun,
) {
  const negative = r.revokeBeforeRead
  assert.equal(r.stages.length, 4, 'missing campaign stage')
  const names = ['fast_stable', 'discovery_created', 'slow_complete', 'revoke_before_read_complete']
  let previous = 0
  for (const [index, stage] of r.stages.entries()) {
    assert.equal(stage.stage, names[index])
    const at = time(stage.at)
    assert(at > previous, 'campaign stages out of order')
    previous = at
    assert.equal(stage.taskCount, [2, 3, 3, 4][index])
    sameIds(
      stage.runIds,
      index < 2
        ? [bootstrap.id, continuation.id]
        : index === 2
          ? [bootstrap.id, continuation.id, discovery.id]
          : [bootstrap.id, continuation.id, discovery.id, negative.runId],
      'campaign stage Run counts changed',
    )
  }
  assert(time(r.stages[0]!.at) >= time(continuation.finishedAt))
  assert(
    time(discovery.startedAt) >= time(r.stages[1]!.at),
    'discovery started before fast stable/catalog stage',
  )
  assert(time(r.stages[2]!.at) >= time(discovery.finishedAt))
  assert(time(r.generatedAt) >= time(r.stages[3]!.at))
  for (const group of Object.values(r.humanActions)) {
    assert(Array.isArray(group), 'missing human action ledger')
    for (const row of group) {
      uuid(row.subjectId, 'missing action subject')
      assert(
        !['run', 'evaluate', 'followup', 'dispatch'].includes(row.action),
        'hidden per-supplement human intervention',
      )
    }
  }
  assert(r.humanActions.setup.length > 0, 'missing initial setup ledger')
  assert(
    r.humanActions.setup.every((row) => row.action === 'setup'),
    'business actions hidden in setup',
  )
  assert.deepEqual(
    r.humanActions.positive,
    [
      { action: 'bootstrap', subjectId: r.fast.taskId },
      { action: 'publication', subjectId: r.fast.publicArtifact.id },
      { action: 'catalogVerification', subjectId: r.slow.applicationId },
      { action: 'executionAuthorization', subjectId: r.slow.executionId },
    ],
    'positive human action budget changed',
  )
  assert.deepEqual(
    r.humanActions.corrections,
    [{ action: 'correction', subjectId: r.slow.executionId }],
    'positive correction ledger missing',
  )
  const actions = r.humanActions.negative
  assert(
    actions.every((row) =>
      ['setup', 'catalogVerification', 'executionAuthorization', 'correction'].includes(row.action),
    ),
    'negative action classification changed',
  )
  assert(
    actions.filter((row) => row.action === 'setup').length >= 3 &&
      actions.some((row) => row.action === 'setup' && row.subjectId === r.projectId) &&
      actions.some((row) => row.action === 'setup' && row.subjectId === r.members.memberId) &&
      !actions.some((row) => row.action === 'setup' && row.subjectId === negative.taskId),
    'missing negative setup',
  )
  one(
    actions.filter((row) => row.action === 'catalogVerification'),
    'negative catalog verification',
  )
  assert.deepEqual(
    actions.filter((row) => row.action === 'executionAuthorization'),
    [{ action: 'executionAuthorization', subjectId: negative.executionId }],
  )
  assert.deepEqual(
    actions.filter((row) => row.action === 'correction'),
    [{ action: 'correction', subjectId: negative.executionId }],
  )
}

function accounting(r: Rd05aEvidence) {
  const count = (value: unknown) => {
    assert(Number.isSafeInteger(value) && (value as number) >= 0, 'invalid accounting quantity')
  }
  const usage = (
    value: { inputTokens: number; outputTokens: number; costMicros: number } | null,
  ) => {
    if (value === null) return
    assert(value && typeof value === 'object', 'missing usage disclosure')
    for (const amount of [value.inputTokens, value.outputTokens, value.costMicros]) count(amount)
  }
  const settlement = (row: {
    phase: string
    reservedTokens: number
    reservedCostMicros: number
    chargeMode: string | null
    usage: { inputTokens: number; outputTokens: number; costMicros: number } | null
  }) => {
    count(row.reservedTokens)
    count(row.reservedCostMicros)
    assert(['reserved', 'settled'].includes(row.phase), 'invalid accounting phase')
    if (row.phase === 'reserved') {
      assert.equal(row.chargeMode, null, 'reservation has a charge mode')
      assert.equal(row.usage, null, 'reservation has actual usage')
    } else {
      assert(
        ['actual', 'reserved'].includes(row.chargeMode ?? ''),
        'missing settlement charge mode',
      )
      usage(row.usage)
      if (row.chargeMode === 'actual') assert(row.usage, 'actual charge is missing usage')
    }
  }
  const a = r.accounting
  assert(a && typeof a === 'object', 'missing per-purpose accounting')
  const evaluationIds = [
    ...r.fast.evaluations.map((row) => row.id),
    r.slow.evaluationId,
    r.revokeBeforeRead.evaluationId,
  ]
  evaluationIds.forEach((value) => uuid(value, 'missing accounting evaluation identity'))
  unique(evaluationIds, 'duplicate accounting evaluation identity')
  sameIds(
    r.stability.before.evaluationIds,
    evaluationIds,
    'accounting and stability evaluations differ',
  )
  assert.equal(
    a.coordination.length,
    evaluationIds.length * 2,
    'missing or duplicate coordination charge',
  )
  unique(
    a.coordination.map((row) => row.id),
    'duplicate coordination ledger identity',
  )
  for (const row of a.coordination) {
    uuid(row.id, 'missing coordination ledger identity')
    assert(evaluationIds.includes(row.evaluationId), 'unknown coordination charge')
    assert.equal(row.attempt, 1, 'unexpected coordination retry charge')
    assert.equal(row.projectId, r.projectId, 'coordination charged another Project')
    const router = r.fast.evaluations.some((evaluation) => evaluation.id === row.evaluationId)
    assert.equal(row.purpose, router ? 'router' : 'discovery', 'wrong charged coordination purpose')
    assert.equal(row.workKey, router ? r.fast.workKey : null, 'wrong charged coordination Work')
    settlement(row)
    if (row.usage !== null) {
      assert(
        typeof row.usage.provider === 'string' && row.usage.provider.length > 0,
        'missing usage provider',
      )
      assert(
        typeof row.usage.model === 'string' && row.usage.model.length > 0,
        'missing usage model',
      )
    }
  }
  for (const evaluationId of evaluationIds) {
    for (const phase of ['reserved', 'settled'])
      one(
        a.coordination.filter((row) => row.evaluationId === evaluationId && row.phase === phase),
        'coordination reserve/settlement pair',
      )
  }
  const ordinary = r.runs.filter((run) => run.role !== 'discovery')
  assert.equal(
    a.executor.length,
    ordinary.length * 2,
    'missing or duplicate ordinary Executor charge',
  )
  unique(
    a.executor.map((row) => row.id),
    'duplicate Executor ledger identity',
  )
  for (const row of a.executor) {
    uuid(row.id, 'missing Executor ledger identity')
    const run = one(
      ordinary.filter((run) => run.id === row.runId),
      'unknown or unmetered Executor charge',
    )
    assert.equal(row.projectId, run.projectId, 'Executor charged another Project')
    assert.equal(row.workKey, run.workKey, 'Executor charged another Work')
    assert.equal(row.mandateId, run.mandateId, 'Executor charged another Mandate')
    settlement(row)
  }
  for (const run of ordinary) {
    for (const phase of ['reserved', 'settled'])
      one(
        a.executor.filter((row) => row.runId === run.id && row.phase === phase),
        'Executor reserve/settlement pair',
      )
  }
  const expected = [
    ...r.runs.map((run) => ({
      runId: run.id,
      mode: run.role === 'discovery' ? 'loopback_unmetered' : 'ordinary_ledger',
      requests: run.role === 'discovery' ? r.slow.replay.privateRequests : 4,
    })),
    {
      runId: r.revokeBeforeRead.runId,
      mode: 'loopback_unmetered',
      requests: r.revokeBeforeRead.privateRequests,
    },
  ]
  assert.equal(a.replay.length, expected.length, 'missing or duplicate replay usage disclosure')
  for (const wanted of expected) {
    const row = one(
      a.replay.filter((row) => row.runId === wanted.runId),
      'replay usage disclosure',
    )
    assert.equal(row.mode, wanted.mode, 'replay metering mode changed')
    assert.equal(row.requests, wanted.requests, 'replay requests undercounted or duplicated')
    assert.equal(row.liveDispatchRows, 0, 'loopback entered live-only dispatch billing')
    assert.equal(row.liveAttemptRows, 0, 'loopback entered live-only attempt billing')
  }
}

/** Compare captured facts to every required semantic event, not only the file hash.
 * Private discovery lifecycle is deliberately a labelled DB observation; it is never
 * misrepresented as raw Runtime content suppressed by the production privacy policy.
 */
function eventChain(r: Rd05aEvidence, events: Rd05aEvent[]) {
  const expected: Rd05aEvent[] = [
    {
      component: 'acceptance.snapshot',
      type: 'campaign.stability',
      campaignId: r.campaignId,
      ...r.stability,
    },
    ...[...r.fast.receipts, ...r.slow.receipts, ...r.revokeBeforeRead.receipts].map((row) => ({
      component: 'hub.work_input' as const,
      type: 'work_input.receipt' as const,
      ...row,
    })),
    ...[...r.fast.replay.toolReads, ...r.slow.replay.toolReads].map((row) => ({
      component: 'acceptance.replay' as const,
      type: 'tool_read.observed' as const,
      ...row,
    })),
    ...r.slow.replay.toolErrors.map((row) => ({
      component: 'acceptance.replay' as const,
      type: 'tool_error.observed' as const,
      runId: r.runs.find((run) => run.role === 'discovery')!.id,
      ...row,
    })),
    ...r.stages.map((row) => ({
      component: 'acceptance.campaign' as const,
      type: 'campaign.stage' as const,
      campaignId: r.campaignId,
      ...row,
    })),
    ...r.runs.map((run) => ({
      component: 'acceptance.snapshot' as const,
      type: 'run.status' as const,
      runId: run.id,
      status: run.status,
      projectId: run.projectId,
      taskId: run.taskId,
      workKey: run.workKey,
      executionId: run.role === 'discovery' ? r.slow.executionId : null,
    })),
    {
      component: 'acceptance.snapshot',
      type: 'run.status',
      runId: r.revokeBeforeRead.runId,
      status: r.revokeBeforeRead.runStatus,
      projectId: r.revokeBeforeRead.projectId,
      taskId: r.revokeBeforeRead.taskId,
      workKey: r.revokeBeforeRead.workKey,
      executionId: r.revokeBeforeRead.executionId,
    },
  ]
  const lifecycle = events.filter((event) => event.component === 'hub.run')
  assert.equal(lifecycle.length, 4, 'missing or extra ordinary Run lifecycle evidence')
  for (const run of r.runs.filter((run) => run.role !== 'discovery')) {
    for (const type of ['runtime.ready', 'run.completed']) {
      const event = one(
        lifecycle.filter((event) => event.type === type && event.runId === run.id),
        'ordinary Run lifecycle event',
      )
      assert(['owner', 'project'].includes(event.audience), 'wrong lifecycle audience')
    }
  }
  const observed = events.filter((event) => event.component !== 'hub.run')
  assert.equal(observed.length, expected.length, 'missing or extra semantic event')
  // Sort canonical key/value trees, not serialized insertion order from two producers.
  const canonical = (value: unknown): string => {
    if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']'
    if (value && typeof value === 'object')
      return (
        '{' +
        Object.entries(value)
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([key, nested]) => JSON.stringify(key) + ':' + canonical(nested))
          .join(',') +
        '}'
      )
    return JSON.stringify(value)
  }
  assert.deepEqual(
    observed.map(canonical).sort(),
    expected.map(canonical).sort(),
    'captured receipts, errors, stages or status observations differ',
  )
}

export function checkRd05a(
  input: unknown,
  eventsBytes: string,
  expectedBinding: Rd05aBinding,
): void {
  const r = input as Rd05aEvidence
  assert(r && typeof r === 'object', 'missing RD-05a evidence')
  assert.equal(r.schemaVersion, 1, 'wrong schema')
  assert.equal(r.mode, 'rd05a_loopback_combined', 'wrong campaign mode')
  assert(
    expectedBinding && typeof expectedBinding === 'object',
    'independent provenance binding required',
  )
  assert(/^[a-f0-9]{40}$/.test(expectedBinding.commit), 'invalid independent commit')
  digest(expectedBinding.harnessDigest, 'invalid independent harness digest')
  digest(expectedBinding.assemblyDigest, 'invalid independent assembly digest')
  for (const key of ['commit', 'harnessDigest', 'assemblyDigest'] as const)
    assert.equal(r.provenance[key], expectedBinding[key], 'independent provenance binding changed')
  digest(r.provenance.eventsDigest, 'missing events digest')
  assert.equal(r.provenance.eventsDigest, sha256(eventsBytes), 'events bytes changed')
  redacted(r)
  uuid(r.campaignId, 'missing campaign UUID')
  uuid(r.projectId, 'missing project UUID')
  time(r.generatedAt)
  uuid(r.members.ownerId, 'missing owner UUID')
  uuid(r.members.memberId, 'missing member UUID')
  assert.notEqual(r.members.ownerId, r.members.memberId)
  assert.equal(r.members.count, 2)
  assert.deepEqual(r.assembly, {
    hub: 'production-package-bin',
    node: 'production-package-replay-assembly',
    runtime: 'production-dsh-package-bin',
    database: 'postgresql',
    model: 'loopback-http-replay',
  })
  for (const claim of [r.modelQuality, r.humanEfficiency, r.invoice]) assert.equal(claim, 'not_run')
  assert.equal(r.paidRequests, 0)
  assert.equal(r.runs.length, 3, 'exactly three positive Runs required')
  unique(
    r.runs.map((run) => run.id),
    'duplicate positive Run identity',
  )
  const bootstrap = one(
    r.runs.filter((run) => run.role === 'bootstrap'),
    'bootstrap role',
  )
  const continuation = one(
    r.runs.filter((run) => run.role === 'continuation'),
    'continuation role',
  )
  const discovery = one(
    r.runs.filter((run) => run.role === 'discovery'),
    'discovery role',
  )
  for (const run of r.runs) {
    for (const value of [
      run.id,
      run.projectId,
      run.taskId,
      run.workKey,
      run.dispatchIntentId,
      run.mandateId,
      run.specRevisionId,
    ])
      uuid(value, 'missing durable Run identity')
    assert.equal(run.projectId, r.projectId)
    assert.equal(run.status, 'completed')
    assert.equal(run.origin, 'mandate')
    digest(run.manifestDigest, 'missing frozen Run manifest digest')
    assert(time(run.finishedAt) >= time(run.startedAt))
    assert(
      (run.role === 'discovery' && run.dshSessionId === null) ||
        run.dshSessionId === `whalepod-run-${run.id}`,
      'invalid Runtime session binding',
    )
    run.itemIds.forEach((value) => uuid(value, 'missing frozen input identity'))
    unique(run.itemIds, 'duplicate frozen input')
  }
  fastFlow(r, bootstrap, continuation)
  slowFlow(r, discovery)
  negativeFlow(r)
  stagesAndActions(r, bootstrap, continuation, discovery)
  accounting(r)
  const stable = r.stability
  assert(
    Number.isFinite(stable.observedMs) && stable.observedMs >= 2000,
    'missing two-second stability window',
  )
  assert(
    time(stable.finishedAt) - time(stable.startedAt) >= 2000,
    'invalid stability wall-clock interval',
  )
  assert(
    time(stable.startedAt) >= time(r.stages[3]!.at),
    'stability precedes final campaign closure',
  )
  assert(time(r.generatedAt) >= time(stable.finishedAt), 'evidence predates stability observation')
  const expectedTasks = [
    r.fast.taskId,
    r.fast.discussionTaskId,
    r.slow.taskId,
    r.revokeBeforeRead.taskId,
  ]
  const expectedRuns = [...r.runs.map((run) => run.id), r.revokeBeforeRead.runId]
  sameIds(stable.before.taskIds, expectedTasks, 'stability Task baseline mismatch')
  sameIds(stable.before.runIds, expectedRuns, 'stability Run baseline mismatch')
  assert.equal(
    stable.before.evaluationIds.length,
    4,
    'stability requires all four coordination evaluations',
  )
  unique(stable.before.evaluationIds, 'duplicate stability evaluation')
  stable.before.evaluationIds.forEach((value) => uuid(value, 'invalid stability evaluation'))
  for (const value of [...r.fast.evaluations.map((row) => row.id), r.slow.evaluationId])
    assert(stable.before.evaluationIds.includes(value), 'stability missing campaign evaluation')
  for (const key of ['taskIds', 'runIds', 'evaluationIds'] as const)
    sameIds(stable.after[key], stable.before[key], 'campaign self-excited during stability window')
  assert(eventsBytes.trim().length > 0, 'missing events')
  const events = eventsBytes
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line) as Rd05aEvent)
  redacted(events)
  eventChain(r, events)
}

export async function verifyRd05a(path: string, expectedBinding: Rd05aBinding): Promise<void> {
  const [result, events] = await Promise.all([
    readFile(path, 'utf8'),
    readFile(join(dirname(path), 'events.jsonl'), 'utf8'),
  ])
  checkRd05a(JSON.parse(result), events, expectedBinding)
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const path = process.argv[2]
  assert(
    path && process.argv.length === 3,
    'usage: verify-rd05a-acceptance.ts <evidence/result.json>',
  )
  const { bindRd05a } = await import('./lib/rd05a-provenance.js')
  const binding = await bindRd05a(fileURLToPath(new URL('..', import.meta.url)))
  await verifyRd05a(path, binding)
  console.log(
    'RD-05a combined loopback evidence PASS (model quality, efficiency and invoice not_run)',
  )
}
