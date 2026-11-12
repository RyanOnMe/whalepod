import { createHash } from 'node:crypto'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { describe, expect, it } from 'vitest'
import type {
  Rd05aBinding,
  Rd05aDraft,
  Rd05aEvidence,
  Rd05aEvent,
  Rd05aReceipt,
  Rd05aRun,
  Rd05aSource,
} from './lib/rd05a-evidence.js'
import { checkRd05a, verifyRd05a } from './verify-rd05a-acceptance.js'
import { checkRd05aEvidenceNegatives } from './check-rd05a-evidence-negatives.js'

const id = (n: number) => `11111111-1111-4111-8111-${n.toString().padStart(12, '0')}`
const hash = (value: string) => createHash('sha256').update(value).digest('hex')
const at = (second: number) => `2026-11-12T09:00:${second.toString().padStart(2, '0')}.000Z`
const binding: Rd05aBinding = {
  commit: 'a'.repeat(40),
  harnessDigest: hash('independently measured harness'),
  assemblyDigest: hash('independently measured production assembly'),
}
const toolError = {
  callId: 'private-read-error',
  toolName: 'read_work_input',
  role: 'tool',
  resultDigest: hash('Error: unknown work input item: RD04C2_PRIVATE_TOOL_ERROR_ONLY'),
}

function sourceManifestDigest(sources: Rd05aSource[]) {
  const canonical = (value: unknown): string => {
    if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']'
    if (value && typeof value === 'object')
      return (
        '{' +
        Object.entries(value)
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([key, item]) => JSON.stringify(key) + ':' + canonical(item))
          .join(',') +
        '}'
      )
    return JSON.stringify(value)
  }
  return hash(canonical(sources))
}

function source(n: number, body: string): Rd05aSource {
  return {
    kind: 'task_message',
    sourceId: id(n),
    sourceVersion: at(n),
    sourceDigest: hash('source envelope:' + body),
    authorizationGeneration: 'author:1',
  }
}

function run(role: Rd05aRun['role'], n: number, itemIds: string[]): Rd05aRun {
  return {
    role,
    id: id(n),
    projectId: id(2),
    taskId: role === 'discovery' ? id(12) : id(10),
    status: 'completed',
    origin: 'mandate',
    workKey: role === 'discovery' ? id(25) : id(20),
    dshSessionId: `whalepod-run-${id(n)}`,
    dispatchIntentId: id(n + 100),
    mandateId: role === 'discovery' ? id(26) : id(21),
    specRevisionId: role === 'discovery' ? id(27) : id(28),
    manifestDigest: hash('frozen manifest ' + n),
    itemIds,
    startedAt: at(n === 30 ? 0 : n === 31 ? 10 : 30),
    finishedAt: at(n === 30 ? 9 : n === 31 ? 19 : 39),
  }
}

function receipt(n: number, target: Rd05aRun, readAt: string): Rd05aReceipt {
  return {
    id: id(n),
    runId: target.id,
    manifestDigest: target.manifestDigest,
    receiptSeq: 1,
    digestVerified: true,
    entriesDelivered: [...target.itemIds],
    entriesRead: [...target.itemIds],
    readEvents: target.itemIds.map((inboxItemId) => ({
      inboxItemId,
      at: readAt,
      digestVerified: true,
    })),
    missing: [],
  }
}

function draft(n: number, target: Rd05aRun): Rd05aDraft {
  return {
    id: id(n),
    runId: target.id,
    ownerUserId: id(3),
    status: 'candidate',
    sha256: hash('private draft ' + n),
    ownerDownloadDigest: hash('private draft ' + n),
    ownerHttp: 200,
    memberHttp: 404,
    cacheControl: 'private, no-store',
    publishHttp: 404,
  }
}

/** Deliberately synthetic. No old report is copied, imported, or accepted as proof. */
function fixture() {
  const bootstrapSource = source(40, 'original venue instructions')
  const supplement = source(41, 'add the owner supplement without changing the frozen first Run')
  const discoverySource = source(42, 'member B asks for the independent shuttle plan')
  const bootstrap = run('bootstrap', 30, [id(50)])
  const continuation = run('continuation', 31, [id(51)])
  const discovery = run('discovery', 32, [id(52), id(53)])
  const publicDigest = hash('published venue artifact from owner A')
  const artifactSource: Rd05aSource = {
    kind: 'artifact',
    sourceId: id(60),
    sourceVersion: publicDigest,
    sourceDigest: publicDigest,
    authorizationGeneration: 'published:1',
  }
  const fastReceipts = [receipt(70, bootstrap, at(2)), receipt(71, continuation, at(12))]
  const slowReceipt = receipt(72, discovery, at(32))
  const entries = [discoverySource, artifactSource].map((entry, index) => ({
    ...entry,
    inboxItemId: discovery.itemIds[index]!,
    sourceType: 'discovery_source',
    bodyDigest: index === 0 ? hash('actual discovery comment tool body') : publicDigest,
  }))
  const slowDraft = draft(62, discovery)
  const negativeReceipt = receipt(
    73,
    {
      ...discovery,
      id: id(33),
      manifestDigest: hash('negative frozen manifest'),
      itemIds: [id(54), id(55)],
    },
    at(43),
  )
  negativeReceipt.entriesRead = []
  negativeReceipt.readEvents = []

  const evidence: Rd05aEvidence = {
    schemaVersion: 1,
    mode: 'rd05a_loopback_combined',
    campaignId: id(1),
    generatedAt: at(52),
    projectId: id(2),
    members: { ownerId: id(3), memberId: id(4), count: 2 },
    assembly: {
      hub: 'production-package-bin',
      node: 'production-package-replay-assembly',
      runtime: 'production-dsh-package-bin',
      database: 'postgresql',
      model: 'loopback-http-replay',
    },
    modelQuality: 'not_run',
    humanEfficiency: 'not_run',
    invoice: 'not_run',
    paidRequests: 0,
    provenance: { ...binding, eventsDigest: '' },
    runs: [bootstrap, continuation, discovery],
    stages: [
      { stage: 'fast_stable', at: at(20), taskCount: 2, runIds: [bootstrap.id, continuation.id] },
      {
        stage: 'discovery_created',
        at: at(25),
        taskCount: 3,
        runIds: [bootstrap.id, continuation.id],
      },
      {
        stage: 'slow_complete',
        at: at(40),
        taskCount: 3,
        runIds: [bootstrap.id, continuation.id, discovery.id],
      },
      {
        stage: 'revoke_before_read_complete',
        at: at(48),
        taskCount: 4,
        runIds: [bootstrap.id, continuation.id, discovery.id, id(33)],
      },
    ],
    stability: {
      startedAt: at(48),
      finishedAt: at(51),
      observedMs: 2500,
      before: {
        taskIds: [id(10), id(11), id(12), id(13)],
        runIds: [id(30), id(31), id(32), id(33)],
        evaluationIds: [id(90), id(91), id(93), id(94)],
      },
      after: {
        taskIds: [id(10), id(11), id(12), id(13)],
        runIds: [id(30), id(31), id(32), id(33)],
        evaluationIds: [id(90), id(91), id(93), id(94)],
      },
    },
    accounting: {
      coordination: [id(90), id(91), id(93), id(94)].flatMap((evaluationId, index) =>
        ['reserved', 'settled'].map((phase, phaseIndex) => ({
          id: id(200 + index * 2 + phaseIndex),
          evaluationId,
          purpose: index < 2 ? 'router' : 'discovery',
          attempt: 1,
          phase,
          projectId: id(2),
          workKey: index < 2 ? id(20) : null,
          reservedTokens: 1000,
          reservedCostMicros: 100,
          chargeMode: phase === 'reserved' ? null : 'actual',
          usage:
            phase === 'reserved'
              ? null
              : {
                  inputTokens: 300,
                  outputTokens: 70,
                  costMicros: 0,
                  provider: 'loopback',
                  model: 'replay',
                },
        })),
      ),
      executor: [bootstrap, continuation].flatMap((target, index) =>
        ['reserved', 'settled'].map((phase, phaseIndex) => ({
          id: id(220 + index * 2 + phaseIndex),
          runId: target.id,
          phase,
          projectId: id(2),
          workKey: id(20),
          mandateId: id(21),
          reservedTokens: 1000,
          reservedCostMicros: 100,
          chargeMode: phase === 'reserved' ? null : 'actual',
          usage:
            phase === 'reserved' ? null : { inputTokens: 200, outputTokens: 50, costMicros: 0 },
        })),
      ),
      replay: [bootstrap, continuation, discovery]
        .map((target, index) => ({
          runId: target.id,
          mode: index < 2 ? ('ordinary_ledger' as const) : ('loopback_unmetered' as const),
          requests: index < 2 ? 4 : 6,
          liveDispatchRows: 0,
          liveAttemptRows: 0,
        }))
        .concat([
          {
            runId: id(33),
            mode: 'loopback_unmetered',
            requests: 1,
            liveDispatchRows: 0,
            liveAttemptRows: 0,
          },
        ]),
    },
    humanActions: {
      setup: [{ action: 'setup', subjectId: id(2) }],
      positive: [
        { action: 'bootstrap', subjectId: id(10) },
        { action: 'publication', subjectId: id(60) },
        { action: 'catalogVerification', subjectId: id(80) },
        { action: 'executionAuthorization', subjectId: id(81) },
      ],
      corrections: [{ action: 'correction', subjectId: id(81) }],
      negative: [
        { action: 'setup', subjectId: id(85) },
        { action: 'setup', subjectId: id(2) },
        { action: 'setup', subjectId: id(4) },
        { action: 'catalogVerification', subjectId: id(83) },
        { action: 'executionAuthorization', subjectId: id(84) },
        { action: 'correction', subjectId: id(84) },
      ],
    },
    fast: {
      taskId: id(10),
      discussionTaskId: id(11),
      workKey: id(20),
      mandateId: id(21),
      subscriptionId: id(22),
      bootstrapIntentId: bootstrap.dispatchIntentId,
      firstSnapshot: bootstrap.manifestDigest,
      bootstrapSource,
      statusBeforeBoundary: 'pending',
      supplement: {
        source: supplement,
        authorId: id(3),
        itemId: id(51),
        replayedMessageId: supplement.sourceId,
        admissionCount: 1,
        outcome: 'deliver',
        reason: 'subscription_match',
        subscriptionId: id(22),
        admissionItemId: id(51),
        admissionSubscriptionId: id(22),
        status: 'pending',
        routerInvoked: false,
        routerCalls: 0,
        routerRows: 0,
        runCount: 0,
      },
      inbox: [
        {
          id: id(50),
          sourceId: bootstrapSource.sourceId,
          status: 'consumed',
          bodyDigest: hash('actual bootstrap tool body'),
        },
        {
          id: id(51),
          sourceId: supplement.sourceId,
          status: 'consumed',
          bodyDigest: hash('actual supplement tool body'),
        },
      ],
      receipts: fastReceipts,
      consumptions: fastReceipts.map((row) => ({
        receiptId: row.id,
        runId: row.runId,
        inboxItemId: row.entriesRead[0]!,
        kind: 'consumed',
        manifestDigest: row.manifestDigest,
        readAt: row.readEvents[0]!.at,
      })),
      intents: [bootstrap, continuation].map((row) => ({
        id: row.dispatchIntentId,
        runId: row.id,
        status: 'dispatched',
        approvalBasis: 'mandate',
        mandateId: id(21),
      })),
      boundaries: [bootstrap, continuation].map((row, index) => ({
        runId: row.id,
        evaluationId: id(90 + index),
        triggerKey: `run-terminal:${row.id}`,
        status: 'enqueued',
      })),
      evaluations: [bootstrap, continuation].map((_, index) => ({
        id: id(90 + index),
        status: 'completed',
        decision: index === 0 ? 'dispatch' : 'wait',
        coverage: [
          ...(index === 0 ? [{ inputId: id(100), status: 'covered', evidenceIds: [id(102)] }] : []),
          { inputId: id(101), status: index === 0 ? 'uncovered' : 'unknown', evidenceIds: [] },
        ],
        readEntryIds: index === 0 ? [id(100), id(101), id(102)] : [id(101), id(102)],
        entries: [
          ...(index === 0
            ? [
                {
                  id: id(100),
                  kind: 'source',
                  sourceId: `task_message:${bootstrapSource.sourceId}`,
                  digest: hash('actual bootstrap tool body'),
                },
              ]
            : []),
          {
            id: id(101),
            kind: 'source',
            sourceId: `task_message:${supplement.sourceId}`,
            digest: hash('actual supplement tool body'),
          },
          {
            id: id(102),
            kind: 'evidence',
            sourceId: artifactSource.sourceId,
            digest: publicDigest,
          },
        ],
      })),
      applications: [
        {
          evaluationId: id(90),
          decision: 'dispatch',
          status: 'applied',
          runId: continuation.id,
          intentId: continuation.dispatchIntentId,
          waitId: null,
        },
        {
          evaluationId: id(91),
          decision: 'wait',
          status: 'applied',
          runId: null,
          intentId: null,
          waitId: id(92),
        },
      ],
      wait: { id: id(92), evaluationId: id(91), status: 'open' },
      replay: {
        routerCalls: [
          { decision: 'dispatch', sources: 2, evidence: 1 },
          { decision: 'wait', sources: 1, evidence: 1 },
        ],
        toolReads: [bootstrap, continuation].map((row, index) => ({
          runId: row.id,
          callId: `read-${index + 1}`,
          inboxItemId: row.itemIds[0]!,
          bodyDigest: hash(
            index === 0 ? 'actual bootstrap tool body' : 'actual supplement tool body',
          ),
        })),
      },
      publicArtifact: {
        id: artifactSource.sourceId,
        runId: bootstrap.id,
        ownerUserId: id(3),
        sha256: publicDigest,
        status: 'published',
        memberHttp: 200,
        publishedAt: at(8),
      },
      draft: { ...draft(61, continuation), cacheControl: null, publishHttp: null },
    },
    slow: {
      taskId: id(12),
      specRevisionId: id(27),
      applicationId: id(80),
      evaluationId: id(93),
      source: discoverySource,
      sourceAuthorId: id(4),
      createdTaskIds: [id(12)],
      beforeAuthorizationRuns: 0,
      wrongAccountHttp: 409,
      nonownerHttp: 404,
      authorization: {
        id: id(81),
        ownerUserId: id(3),
        status: 'authorized',
        purpose: 'private_draft',
        sourceManifestDigest: sourceManifestDigest([discoverySource, artifactSource]),
        sources: [discoverySource, artifactSource],
        liveOnlyGrantCount: 0,
      },
      repeatExecutionId: id(81),
      concurrentExecutionId: id(81),
      targetRunCount: 1,
      executionId: id(81),
      approvalPolicy: 'approval_required',
      entries,
      receipts: [slowReceipt],
      replay: {
        discoveryRequests: 1,
        privateRequests: 6,
        toolReads: entries.map((entry, index) => ({
          runId: discovery.id,
          callId: `private-read-${index}`,
          inboxItemId: entry.inboxItemId,
          bodyDigest: entry.bodyDigest,
        })),
        toolErrors: [toolError],
        draftDigest: slowDraft.sha256,
      },
      draft: slowDraft,
      publicArtifactMemberHttp: 200,
      visibility: ['http', 'ws_live', 'ws_replay'].map((surface) => ({
        surface: surface as 'http' | 'ws_live' | 'ws_replay',
        observed: 3,
        draftLeaks: 0,
        toolErrorLeaks: 0,
      })),
      privateDirectoriesObserved: 2,
      workspaceClean: true,
      revocation: {
        executionId: id(81),
        status: 'revoked',
        ownerHttp: 404,
        ownerRoomHasRevokedTitle: false,
      },
    },
    revokeBeforeRead: {
      projectId: id(2),
      taskId: id(13),
      workKey: id(29),
      evaluationId: id(94),
      sourceId: id(43),
      executionId: id(84),
      authorizedExecutionId: id(84),
      runId: id(33),
      delivery: 2,
      correctionHttp: 200,
      runStatus: 'failed',
      executionStatus: 'revoked',
      privateRequests: 1,
      toolResults: 0,
      drafts: 0,
      reads: 0,
      receipts: [negativeReceipt],
      privateDirectoriesObserved: 2,
      workspaceClean: true,
    },
  }
  const events: Rd05aEvent[] = [
    {
      component: 'acceptance.snapshot',
      type: 'campaign.stability',
      campaignId: evidence.campaignId,
      ...structuredClone(evidence.stability),
    },
    ...[...fastReceipts, slowReceipt, negativeReceipt].map((row) => ({
      component: 'hub.work_input' as const,
      type: 'work_input.receipt' as const,
      ...structuredClone(row),
    })),
    ...[...evidence.fast.replay.toolReads, ...evidence.slow.replay.toolReads].map((row) => ({
      component: 'acceptance.replay' as const,
      type: 'tool_read.observed' as const,
      ...structuredClone(row),
    })),
    {
      component: 'acceptance.replay',
      type: 'tool_error.observed',
      runId: discovery.id,
      ...toolError,
    },
    ...evidence.stages.map((stage) => ({
      component: 'acceptance.campaign' as const,
      type: 'campaign.stage' as const,
      campaignId: evidence.campaignId,
      ...structuredClone(stage),
    })),
    ...evidence.runs.slice(0, 2).flatMap((row) => [
      {
        component: 'hub.run' as const,
        type: 'runtime.ready' as const,
        runId: row.id,
        audience: 'owner' as const,
      },
      {
        component: 'hub.run' as const,
        type: 'run.completed' as const,
        runId: row.id,
        audience: 'owner' as const,
      },
    ]),
    ...evidence.runs.map((row) => ({
      component: 'acceptance.snapshot' as const,
      type: 'run.status' as const,
      runId: row.id,
      status: row.status,
      projectId: row.projectId,
      taskId: row.taskId,
      workKey: row.workKey,
      executionId: row.role === 'discovery' ? evidence.slow.executionId : null,
    })),
    {
      component: 'acceptance.snapshot',
      type: 'run.status',
      runId: id(33),
      status: 'failed',
      projectId: id(2),
      taskId: id(13),
      workKey: id(29),
      executionId: id(84),
    },
  ]
  return { evidence, events }
}

type Fixture = ReturnType<typeof fixture>
type Mutation = [string, (value: Fixture) => void]
function seal(value: Fixture) {
  const bytes = value.events.map((event) => JSON.stringify(event)).join('\n') + '\n'
  value.evidence.provenance.eventsDigest = hash(bytes)
  return bytes
}

// Every mutation starts from a clone, including independent event objects. Rehashing is
// intentional: a recomputed file digest must not conceal missing semantic evidence.
const negatives: Mutation[] = [
  [
    'missing accounting',
    ({ evidence: r }) => {
      Object.assign(r, { accounting: undefined })
    },
  ],
  [
    'duplicate coordination charge',
    ({ evidence: r }) => {
      r.accounting.coordination.push(structuredClone(r.accounting.coordination[1]!))
    },
  ],
  [
    'missing coordination settlement',
    ({ evidence: r }) => {
      r.accounting.coordination.pop()
    },
  ],
  [
    'wrong coordination attempt',
    ({ evidence: r }) => {
      r.accounting.coordination[0]!.attempt = 2
    },
  ],
  [
    'wrong coordination purpose',
    ({ evidence: r }) => {
      r.accounting.coordination[0]!.purpose = 'discovery'
    },
  ],
  [
    'wrong coordination project',
    ({ evidence: r }) => {
      r.accounting.coordination[0]!.projectId = id(999)
    },
  ],
  [
    'discovery charged Work',
    ({ evidence: r }) => {
      r.accounting.coordination[4]!.workKey = r.fast.workKey
    },
  ],
  [
    'Router missing Work charge',
    ({ evidence: r }) => {
      r.accounting.coordination[0]!.workKey = null
    },
  ],
  [
    'reserved coordination has actual charge',
    ({ evidence: r }) => {
      r.accounting.coordination[0]!.chargeMode = 'actual'
    },
  ],
  [
    'reserved coordination has usage',
    ({ evidence: r }) => {
      r.accounting.coordination[0]!.usage = structuredClone(r.accounting.coordination[1]!.usage)
    },
  ],
  [
    'invalid settlement charge mode',
    ({ evidence: r }) => {
      r.accounting.coordination[1]!.chargeMode = 'free'
    },
  ],
  [
    'negative coordination reserve',
    ({ evidence: r }) => {
      r.accounting.coordination[0]!.reservedTokens = -1
    },
  ],
  [
    'negative coordination usage',
    ({ evidence: r }) => {
      r.accounting.coordination[1]!.usage!.inputTokens = -1
    },
  ],
  [
    'missing coordination provider',
    ({ evidence: r }) => {
      r.accounting.coordination[1]!.usage!.provider = ''
    },
  ],
  [
    'missing negative evaluation identity',
    ({ evidence: r }) => {
      r.revokeBeforeRead.evaluationId = ''
    },
  ],
  [
    'duplicate ordinary settlement',
    ({ evidence: r }) => {
      r.accounting.executor.push(structuredClone(r.accounting.executor[1]!))
    },
  ],
  [
    'missing ordinary settlement',
    ({ evidence: r }) => {
      r.accounting.executor.pop()
    },
  ],
  [
    'wrong executor mandate',
    ({ evidence: r }) => {
      r.accounting.executor[0]!.mandateId = id(999)
    },
  ],
  [
    'private Run in ordinary ledger',
    ({ evidence: r }) => {
      r.accounting.executor[0]!.runId = r.runs[2]!.id
    },
  ],
  [
    'wrong executor Work',
    ({ evidence: r }) => {
      r.accounting.executor[0]!.workKey = id(999)
    },
  ],
  [
    'executor settlement missing charge mode',
    ({ evidence: r }) => {
      r.accounting.executor[1]!.chargeMode = null
    },
  ],
  [
    'executor negative usage',
    ({ evidence: r }) => {
      r.accounting.executor[1]!.usage!.outputTokens = -1
    },
  ],
  [
    'missing replay usage disclosure',
    ({ evidence: r }) => {
      r.accounting.replay.pop()
    },
  ],
  [
    'duplicate replay usage disclosure',
    ({ evidence: r }) => {
      r.accounting.replay.push(structuredClone(r.accounting.replay[0]!))
    },
  ],
  [
    'private replay claims metered',
    ({ evidence: r }) => {
      r.accounting.replay[2]!.mode = 'ordinary_ledger'
    },
  ],
  [
    'ordinary replay claims unmetered',
    ({ evidence: r }) => {
      r.accounting.replay[0]!.mode = 'loopback_unmetered'
    },
  ],
  [
    'ordinary requests undercounted',
    ({ evidence: r }) => {
      r.accounting.replay[0]!.requests = 3
    },
  ],
  [
    'private requests reported zero',
    ({ evidence: r }) => {
      r.accounting.replay[2]!.requests = 0
    },
  ],
  [
    'negative requests reported zero',
    ({ evidence: r }) => {
      r.accounting.replay[3]!.requests = 0
    },
  ],
  [
    'live-only dispatch present',
    ({ evidence: r }) => {
      r.accounting.replay[2]!.liveDispatchRows = 1
    },
  ],
  [
    'live-only attempt present',
    ({ evidence: r }) => {
      r.accounting.replay[3]!.liveAttemptRows = 1
    },
  ],
  [
    'stability shorter than two seconds',
    ({ evidence: r }) => {
      r.stability.observedMs = 1999
    },
  ],
  [
    'stability interval reversed',
    ({ evidence: r }) => {
      r.stability.finishedAt = at(47)
    },
  ],
  [
    'stability begins before closure',
    ({ evidence: r }) => {
      r.stability.startedAt = at(46)
    },
  ],
  [
    'stability adds Run',
    ({ evidence: r }) => {
      r.stability.after.runIds.push(id(999))
    },
  ],
  [
    'stability adds Task',
    ({ evidence: r }) => {
      r.stability.after.taskIds.push(id(999))
    },
  ],
  [
    'stability adds evaluation',
    ({ evidence: r }) => {
      r.stability.after.evaluationIds.push(id(999))
    },
  ],
  [
    'stability baseline omits final Run',
    ({ evidence: r }) => {
      r.stability.before.runIds.pop()
    },
  ],
  [
    'stability baseline evaluation missing',
    ({ evidence: r }) => {
      r.stability.before.evaluationIds.pop()
    },
  ],
  [
    'missing stability event after rehash',
    (value) => {
      value.events = value.events.filter((event) => event.type !== 'campaign.stability')
    },
  ],
  [
    'source-manifest confused with Run digest',
    ({ evidence: r }) => {
      r.slow.authorization.sourceManifestDigest = r.runs[2]!.manifestDigest
    },
  ],
  ['wrong schema', ({ evidence: r }) => Object.assign(r, { schemaVersion: 2 })],
  [
    'old report mode',
    ({ evidence: r }) => Object.assign(r, { mode: 'loopback_tool_error_followup' }),
  ],
  [
    'invalid campaign id',
    ({ evidence: r }) => {
      r.campaignId = 'campaign'
    },
  ],
  [
    'invalid timestamp',
    ({ evidence: r }) => {
      r.generatedAt = ''
    },
  ],
  [
    'third member',
    ({ evidence: r }) => {
      r.members.count = 3
    },
  ],
  [
    'same two members',
    ({ evidence: r }) => {
      r.members.memberId = r.members.ownerId
    },
  ],
  [
    'source assembly shortcut',
    ({ evidence: r }) => Object.assign(r.assembly, { runtime: 'source-file' }),
  ],
  ['claimed model quality', ({ evidence: r }) => Object.assign(r, { modelQuality: 'passed' })],
  [
    'claimed human efficiency',
    ({ evidence: r }) => Object.assign(r, { humanEfficiency: 'passed' }),
  ],
  ['claimed supplier invoice', ({ evidence: r }) => Object.assign(r, { invoice: 'verified' })],
  [
    'paid request',
    ({ evidence: r }) => {
      r.paidRequests = 1
    },
  ],
  [
    'changed commit',
    ({ evidence: r }) => {
      r.provenance.commit = 'b'.repeat(40)
    },
  ],
  [
    'changed harness',
    ({ evidence: r }) => {
      r.provenance.harnessDigest = hash('other harness')
    },
  ],
  [
    'changed assembly',
    ({ evidence: r }) => {
      r.provenance.assemblyDigest = hash('other assembly')
    },
  ],
  [
    'missing positive role',
    ({ evidence: r }) => {
      r.runs.pop()
    },
  ],
  [
    'extra positive Run',
    ({ evidence: r }) => {
      r.runs.push({ ...r.runs[2]!, id: id(900) })
    },
  ],
  [
    'duplicated positive identity',
    ({ evidence: r }) => {
      r.runs[1]!.id = r.runs[0]!.id
    },
  ],
  [
    'duplicated role',
    ({ evidence: r }) => {
      r.runs[1]!.role = 'bootstrap'
    },
  ],
  [
    'cross-project Run',
    ({ evidence: r }) => {
      r.runs[2]!.projectId = id(900)
    },
  ],
  [
    'reused Runtime session',
    ({ evidence: r }) => {
      r.runs[1]!.dshSessionId = r.runs[0]!.dshSessionId
    },
  ],
  [
    'non-mandate Run',
    ({ evidence: r }) => {
      r.runs[1]!.origin = 'manual'
    },
  ],
  [
    'unfinished positive Run',
    ({ evidence: r }) => {
      r.runs[1]!.status = 'running'
    },
  ],
  [
    'overlapping continuation',
    ({ evidence: r }) => {
      r.runs[1]!.startedAt = r.runs[0]!.startedAt
    },
  ],
  [
    'discovery before fast stable',
    ({ evidence: r }) => {
      r.runs[2]!.startedAt = at(15)
    },
  ],
  [
    'mutated first frozen snapshot',
    ({ evidence: r }) => {
      r.fast.firstSnapshot = hash('changed snapshot')
    },
  ],
  [
    'original snapshot contains supplement',
    ({ evidence: r }) => {
      r.runs[0]!.itemIds.push(r.fast.supplement.itemId)
    },
  ],
  [
    'continuation reruns original item',
    ({ evidence: r }) => {
      r.runs[1]!.itemIds = [...r.runs[0]!.itemIds]
    },
  ],
  [
    'same first and continuation manifest',
    ({ evidence: r }) => {
      r.runs[1]!.manifestDigest = r.runs[0]!.manifestDigest
    },
  ],
  [
    'extra fast inbox item',
    ({ evidence: r }) => {
      r.fast.inbox.push({ ...r.fast.inbox[0]!, id: id(900) })
    },
  ],
  [
    'wrong bootstrap source',
    ({ evidence: r }) => {
      r.fast.bootstrapSource.sourceId = id(900)
    },
  ],
  [
    'missing explicit bootstrap version',
    ({ evidence: r }) => {
      r.fast.bootstrapSource.sourceVersion = ''
    },
  ],
  [
    'wrong supplement source',
    ({ evidence: r }) => {
      r.fast.supplement.source.sourceId = id(900)
    },
  ],
  [
    'wrong fast author',
    ({ evidence: r }) => {
      r.fast.supplement.authorId = r.members.memberId
    },
  ],
  [
    'missing explicit fast grant generation',
    ({ evidence: r }) => {
      r.fast.supplement.source.authorizationGeneration = ''
    },
  ],
  [
    'duplicate supplement admission',
    ({ evidence: r }) => {
      r.fast.supplement.admissionCount = 2
    },
  ],
  [
    'failed source replay identity',
    ({ evidence: r }) => {
      r.fast.supplement.replayedMessageId = id(900)
    },
  ],
  [
    'wrong admission item',
    ({ evidence: r }) => {
      r.fast.supplement.admissionItemId = id(900)
    },
  ],
  [
    'wrong admission subscription',
    ({ evidence: r }) => {
      r.fast.supplement.admissionSubscriptionId = id(900)
    },
  ],
  [
    'wrong source subscription',
    ({ evidence: r }) => {
      r.fast.supplement.subscriptionId = id(900)
    },
  ],
  [
    'wrong admission outcome',
    ({ evidence: r }) => {
      r.fast.supplement.outcome = 'reject'
    },
  ],
  [
    'wrong admission reason',
    ({ evidence: r }) => {
      r.fast.supplement.reason = 'manual'
    },
  ],
  [
    'not pending at boundary',
    ({ evidence: r }) => {
      r.fast.statusBeforeBoundary = 'consumed'
    },
  ],
  [
    'ingress invoked Router',
    ({ evidence: r }) => {
      r.fast.supplement.routerInvoked = true
    },
  ],
  [
    'ingress Router call',
    ({ evidence: r }) => {
      r.fast.supplement.routerCalls = 1
    },
  ],
  [
    'ingress Router row',
    ({ evidence: r }) => {
      r.fast.supplement.routerRows = 1
    },
  ],
  [
    'ingress started Run',
    ({ evidence: r }) => {
      r.fast.supplement.runCount = 1
    },
  ],
  [
    'extra boundary evaluation',
    ({ evidence: r }) => {
      r.fast.evaluations.push(structuredClone(r.fast.evaluations[0]!))
    },
  ],
  [
    'missing boundary',
    ({ evidence: r }) => {
      r.fast.boundaries.pop()
    },
  ],
  [
    'wrong boundary run',
    ({ evidence: r }) => {
      r.fast.boundaries[0]!.runId = id(900)
    },
  ],
  [
    'wrong terminal trigger',
    ({ evidence: r }) => {
      r.fast.boundaries[0]!.triggerKey = 'manual'
    },
  ],
  [
    'failed Router evaluation',
    ({ evidence: r }) => {
      r.fast.evaluations[0]!.status = 'failed'
    },
  ],
  [
    'manual continuation intent',
    ({ evidence: r }) => {
      r.fast.intents[1]!.approvalBasis = 'manual'
    },
  ],
  [
    'wrong continuation mandate',
    ({ evidence: r }) => {
      r.fast.intents[1]!.mandateId = id(900)
    },
  ],
  [
    'wrong dispatch target',
    ({ evidence: r }) => {
      r.fast.applications[0]!.runId = r.runs[0]!.id
    },
  ],
  [
    'dispatch instead of final wait',
    ({ evidence: r }) => {
      r.fast.applications[1]!.decision = 'dispatch'
    },
  ],
  [
    'wrong wait join',
    ({ evidence: r }) => {
      r.fast.wait.evaluationId = r.fast.evaluations[0]!.id
    },
  ],
  [
    'Router missing read',
    ({ evidence: r }) => {
      r.fast.evaluations[0]!.readEntryIds.pop()
    },
  ],
  [
    'Router cites private draft',
    ({ evidence: r }) => {
      r.fast.evaluations[1]!.entries.find((entry) => entry.kind === 'evidence')!.sourceId =
        r.fast.draft.id
    },
  ],
  [
    'Router wrong published digest',
    ({ evidence: r }) => {
      r.fast.evaluations[0]!.entries.find((entry) => entry.kind === 'evidence')!.digest =
        hash('wrong body')
    },
  ],
  [
    'Router covered unread supplement',
    ({ evidence: r }) => {
      r.fast.evaluations[0]!.coverage[1]!.status = 'covered'
    },
  ],
  [
    'Router omitted bootstrap coverage',
    ({ evidence: r }) => {
      r.fast.evaluations[0]!.coverage.shift()
    },
  ],
  [
    'Router replay wrong decisions',
    ({ evidence: r }) => {
      r.fast.replay.routerCalls[1]!.decision = 'dispatch'
    },
  ],
  [
    'missing consumption',
    ({ evidence: r }) => {
      r.fast.consumptions.pop()
    },
  ],
  [
    'wrong consumption receipt',
    ({ evidence: r }) => {
      r.fast.consumptions[0]!.receiptId = id(900)
    },
  ],
  [
    'wrong consumption manifest',
    ({ evidence: r }) => {
      r.fast.consumptions[0]!.manifestDigest = hash('wrong')
    },
  ],
  [
    'wrong consumption timestamp',
    ({ evidence: r }) => {
      r.fast.consumptions[0]!.readAt = at(49)
    },
  ],
  [
    'fast actual tool body mismatch',
    ({ evidence: r }) => {
      r.fast.replay.toolReads[0]!.bodyDigest = hash('fabricated body')
    },
  ],
  [
    'missing fast actual tool read',
    ({ evidence: r }) => {
      r.fast.replay.toolReads.pop()
    },
  ],
  [
    'wrong public producer',
    ({ evidence: r }) => {
      r.fast.publicArtifact.runId = r.runs[1]!.id
    },
  ],
  [
    'wrong public owner',
    ({ evidence: r }) => {
      r.fast.publicArtifact.ownerUserId = r.members.memberId
    },
  ],
  [
    'unpublished corroboration',
    ({ evidence: r }) => {
      r.fast.publicArtifact.status = 'candidate'
    },
  ],
  [
    'published after first Run',
    ({ evidence: r }) => {
      r.fast.publicArtifact.publishedAt = at(19)
    },
  ],
  [
    'public access absent',
    ({ evidence: r }) => {
      r.fast.publicArtifact.memberHttp = 404
    },
  ],
  [
    'fast draft accidentally published',
    ({ evidence: r }) => {
      r.fast.draft.publishHttp = 200
    },
  ],
  [
    'missing discovery Task',
    ({ evidence: r }) => {
      r.slow.createdTaskIds = []
    },
  ],
  [
    'extra discovery Task',
    ({ evidence: r }) => {
      r.slow.createdTaskIds.push(id(900))
    },
  ],
  [
    'discovery reuses original Task',
    ({ evidence: r }) => {
      r.slow.taskId = r.fast.taskId
    },
  ],
  [
    'wrong discovery Task join',
    ({ evidence: r }) => {
      r.runs[2]!.taskId = r.fast.taskId
    },
  ],
  [
    'wrong source author B',
    ({ evidence: r }) => {
      r.slow.sourceAuthorId = r.members.ownerId
    },
  ],
  [
    'same source for fast and slow',
    ({ evidence: r }) => {
      r.slow.source.sourceId = r.fast.supplement.source.sourceId
    },
  ],
  [
    'Run before authorization',
    ({ evidence: r }) => {
      r.slow.beforeAuthorizationRuns = 1
    },
  ],
  [
    'wrong account accepted',
    ({ evidence: r }) => {
      r.slow.wrongAccountHttp = 200
    },
  ],
  [
    'nonowner authorization visible',
    ({ evidence: r }) => {
      r.slow.nonownerHttp = 200
    },
  ],
  [
    'wrong execution owner',
    ({ evidence: r }) => {
      r.slow.authorization.ownerUserId = r.members.memberId
    },
  ],
  [
    'not authorized',
    ({ evidence: r }) => {
      r.slow.authorization.status = 'pending'
    },
  ],
  [
    'formal execution purpose',
    ({ evidence: r }) => {
      r.slow.authorization.purpose = 'formal_publish'
    },
  ],
  [
    'live-only read grant',
    ({ evidence: r }) => {
      r.slow.authorization.liveOnlyGrantCount = 1
    },
  ],
  [
    'repeat spawned execution',
    ({ evidence: r }) => {
      r.slow.repeatExecutionId = id(900)
    },
  ],
  [
    'concurrent spawned execution',
    ({ evidence: r }) => {
      r.slow.concurrentExecutionId = id(900)
    },
  ],
  [
    'execution ID mismatch',
    ({ evidence: r }) => {
      r.slow.executionId = id(900)
    },
  ],
  [
    'multiple target Runs',
    ({ evidence: r }) => {
      r.slow.targetRunCount = 2
    },
  ],
  [
    'missing frozen source',
    ({ evidence: r }) => {
      r.slow.authorization.sources.pop()
    },
  ],
  [
    'duplicate source',
    ({ evidence: r }) => {
      r.slow.authorization.sources[1] = structuredClone(r.slow.authorization.sources[0]!)
    },
  ],
  [
    'unauthorized source entry',
    ({ evidence: r }) => {
      r.slow.entries[0]!.sourceId = id(900)
    },
  ],
  [
    'changed frozen source version',
    ({ evidence: r }) => {
      r.slow.entries[0]!.sourceVersion = at(49)
    },
  ],
  [
    'changed frozen source digest',
    ({ evidence: r }) => {
      r.slow.entries[0]!.sourceDigest = hash('changed')
    },
  ],
  [
    'changed frozen source generation',
    ({ evidence: r }) => {
      r.slow.entries[0]!.authorizationGeneration = 'author:2'
    },
  ],
  [
    'wrong entry kind',
    ({ evidence: r }) => {
      r.slow.entries[0]!.sourceType = 'task_message'
    },
  ],
  [
    'wrong artifact source version',
    ({ evidence: r }) => {
      r.slow.authorization.sources[1]!.sourceVersion = hash('stale artifact')
    },
  ],
  [
    'wrong artifact source digest',
    ({ evidence: r }) => {
      r.slow.authorization.sources[1]!.sourceDigest = hash('stale artifact')
    },
  ],
  [
    'wrong frozen manifest join',
    ({ evidence: r }) => {
      r.slow.authorization.sourceManifestDigest = hash('wrong manifest')
    },
  ],
  [
    'wrong spec join',
    ({ evidence: r }) => {
      r.slow.specRevisionId = id(900)
    },
  ],
  [
    'automatic approval policy',
    ({ evidence: r }) => {
      r.slow.approvalPolicy = 'automatic'
    },
  ],
  [
    'duplicate private inbox item',
    ({ evidence: r }) => {
      r.slow.entries[1]!.inboxItemId = r.slow.entries[0]!.inboxItemId
    },
  ],
  [
    'extra private source',
    ({ evidence: r }) => {
      r.slow.entries.push({ ...r.slow.entries[0]!, inboxItemId: id(900) })
    },
  ],
  [
    'missing real private read',
    ({ evidence: r }) => {
      r.slow.replay.toolReads.pop()
    },
  ],
  [
    'wrong actual tool body',
    ({ evidence: r }) => {
      r.slow.replay.toolReads[0]!.bodyDigest = hash('forged body')
    },
  ],
  [
    'public actual tool body differs',
    ({ evidence: r }) => {
      r.slow.entries[1]!.bodyDigest = hash('not public bytes')
    },
  ],
  [
    'missing tool error',
    ({ evidence: r }) => {
      r.slow.replay.toolErrors = []
    },
  ],
  [
    'duplicate tool error',
    ({ evidence: r }) => {
      r.slow.replay.toolErrors.push(structuredClone(toolError))
    },
  ],
  [
    'wrong error call',
    ({ evidence: r }) => {
      r.slow.replay.toolErrors[0]!.callId = 'other'
    },
  ],
  [
    'wrong error tool',
    ({ evidence: r }) => {
      r.slow.replay.toolErrors[0]!.toolName = 'write'
    },
  ],
  [
    'assistant instead of tool error',
    ({ evidence: r }) => {
      r.slow.replay.toolErrors[0]!.role = 'assistant'
    },
  ],
  [
    'success merely contains error marker',
    ({ evidence: r }) => {
      r.slow.replay.toolErrors[0]!.resultDigest = hash('RD04C2_PRIVATE_TOOL_ERROR_ONLY')
    },
  ],
  [
    'extra discovery inference',
    ({ evidence: r }) => {
      r.slow.replay.discoveryRequests = 2
    },
  ],
  [
    'missing post-error model turn',
    ({ evidence: r }) => {
      r.slow.replay.privateRequests = 5
    },
  ],
  [
    'draft not actual model output',
    ({ evidence: r }) => {
      r.slow.replay.draftDigest = hash('other draft')
    },
  ],
  [
    'public positive control failed',
    ({ evidence: r }) => {
      r.slow.publicArtifactMemberHttp = 404
    },
  ],
  [
    'missing visibility surface',
    ({ evidence: r }) => {
      r.slow.visibility.pop()
    },
  ],
  [
    'duplicate visibility surface',
    ({ evidence: r }) => {
      r.slow.visibility[1]!.surface = 'http'
    },
  ],
  [
    'wrong private directory count',
    ({ evidence: r }) => {
      r.slow.privateDirectoriesObserved = 1
    },
  ],
  [
    'positive private workspace not cleaned',
    ({ evidence: r }) => {
      r.slow.workspaceClean = false
    },
  ],
  [
    'wrong revoked execution',
    ({ evidence: r }) => {
      r.slow.revocation.executionId = id(900)
    },
  ],
  [
    'execution not revoked',
    ({ evidence: r }) => {
      r.slow.revocation.status = 'authorized'
    },
  ],
  [
    'revoked owner still reads',
    ({ evidence: r }) => {
      r.slow.revocation.ownerHttp = 200
    },
  ],
  [
    'revoked title remains in owner room',
    ({ evidence: r }) => {
      r.slow.revocation.ownerRoomHasRevokedTitle = true
    },
  ],
  [
    'negative wrong project',
    ({ evidence: r }) => {
      r.revokeBeforeRead.projectId = id(900)
    },
  ],
  [
    'negative reused Task',
    ({ evidence: r }) => {
      r.revokeBeforeRead.taskId = r.slow.taskId
    },
  ],
  [
    'negative reused source',
    ({ evidence: r }) => {
      r.revokeBeforeRead.sourceId = r.slow.source.sourceId
    },
  ],
  [
    'negative reused execution',
    ({ evidence: r }) => {
      r.revokeBeforeRead.executionId = r.slow.executionId
    },
  ],
  [
    'negative reused Run',
    ({ evidence: r }) => {
      r.revokeBeforeRead.runId = r.runs[2]!.id
    },
  ],
  [
    'negative wrong authorization',
    ({ evidence: r }) => {
      r.revokeBeforeRead.authorizedExecutionId = id(900)
    },
  ],
  [
    'negative missing delivery',
    ({ evidence: r }) => {
      r.revokeBeforeRead.delivery = 0
    },
  ],
  [
    'negative correction failed',
    ({ evidence: r }) => {
      r.revokeBeforeRead.correctionHttp = 500
    },
  ],
  [
    'negative execution survives',
    ({ evidence: r }) => {
      r.revokeBeforeRead.executionStatus = 'authorized'
    },
  ],
  [
    'negative Run completes',
    ({ evidence: r }) => {
      r.revokeBeforeRead.runStatus = 'completed'
    },
  ],
  [
    'negative extra request',
    ({ evidence: r }) => {
      r.revokeBeforeRead.privateRequests = 2
    },
  ],
  [
    'negative successful tool result',
    ({ evidence: r }) => {
      r.revokeBeforeRead.toolResults = 1
    },
  ],
  [
    'negative draft exists',
    ({ evidence: r }) => {
      r.revokeBeforeRead.drafts = 1
    },
  ],
  [
    'negative body read',
    ({ evidence: r }) => {
      r.revokeBeforeRead.reads = 1
    },
  ],
  [
    'negative missing receipt',
    ({ evidence: r }) => {
      r.revokeBeforeRead.receipts = []
    },
  ],
  [
    'negative actual receipt contains read',
    ({ evidence: r }) => {
      r.revokeBeforeRead.receipts[0]!.entriesRead = [id(54)]
    },
  ],
  [
    'negative wrong directory count',
    ({ evidence: r }) => {
      r.revokeBeforeRead.privateDirectoriesObserved = 0
    },
  ],
  [
    'negative private workspace not cleaned',
    ({ evidence: r }) => {
      r.revokeBeforeRead.workspaceClean = false
    },
  ],
  [
    'missing stage',
    ({ evidence: r }) => {
      r.stages.pop()
    },
  ],
  [
    'extra initial task',
    ({ evidence: r }) => {
      r.stages[0]!.taskCount = 3
    },
  ],
  [
    'extra discovery task at checkpoint',
    ({ evidence: r }) => {
      r.stages[1]!.taskCount = 4
    },
  ],
  [
    'negative counted as positive',
    ({ evidence: r }) => {
      r.stages[2]!.runIds.push(r.revokeBeforeRead.runId)
    },
  ],
  [
    'missing final negative Run checkpoint',
    ({ evidence: r }) => {
      r.stages[3]!.runIds.pop()
    },
  ],
  [
    'invalid stage order',
    ({ evidence: r }) => {
      r.stages[1]!.at = at(15)
    },
  ],
  [
    'missing human publication action',
    ({ evidence: r }) => {
      r.humanActions.positive.splice(1, 1)
    },
  ],
  [
    'duplicate human authorization',
    ({ evidence: r }) => {
      r.humanActions.positive.push({
        action: 'executionAuthorization',
        subjectId: r.slow.executionId,
      })
    },
  ],
  [
    'wrong human publication subject',
    ({ evidence: r }) => {
      r.humanActions.positive[1]!.subjectId = r.fast.draft.id
    },
  ],
  [
    'missing positive correction',
    ({ evidence: r }) => {
      r.humanActions.corrections = []
    },
  ],
  [
    'negative actions hidden in positive group',
    ({ evidence: r }) => {
      r.humanActions.positive.push(...r.humanActions.negative)
    },
  ],
]

for (const group of ['setup', 'positive', 'corrections', 'negative'] as const) {
  for (const action of ['run', 'evaluate', 'followup', 'dispatch'] as const) {
    negatives.push([
      `hidden ${action} in ${group} action ledger`,
      ({ evidence: r }) => {
        r.humanActions[group].push({ action, subjectId: r.fast.supplement.source.sourceId })
      },
    ])
  }
}
for (const side of ['fast', 'slow'] as const) {
  negatives.push(
    [
      `${side} draft wrong producer`,
      ({ evidence: r }) => {
        r[side].draft.runId = r.runs[0]!.id
      },
    ],
    [
      `${side} draft wrong owner`,
      ({ evidence: r }) => {
        r[side].draft.ownerUserId = r.members.memberId
      },
    ],
    [
      `${side} draft formally published`,
      ({ evidence: r }) => {
        r[side].draft.status = 'published'
      },
    ],
    [
      `${side} draft owner unavailable`,
      ({ evidence: r }) => {
        r[side].draft.ownerHttp = 404
      },
    ],
    [
      `${side} draft leaked to member`,
      ({ evidence: r }) => {
        r[side].draft.memberHttp = 200
      },
    ],
    [
      `${side} download hash mismatch`,
      ({ evidence: r }) => {
        r[side].draft.ownerDownloadDigest = hash('wrong download')
      },
    ],
  )
}
negatives.push(
  [
    'slow formal publish allowed',
    ({ evidence: r }) => {
      r.slow.draft.publishHttp = 200
    },
  ],
  [
    'slow formal publish unobserved',
    ({ evidence: r }) => {
      r.slow.draft.publishHttp = null
    },
  ],
  [
    'slow cache permits storage',
    ({ evidence: r }) => {
      r.slow.draft.cacheControl = 'public'
    },
  ],
)
for (const index of [0, 1, 2]) {
  negatives.push(
    [
      `surface ${index} unobserved`,
      ({ evidence: r }) => {
        r.slow.visibility[index]!.observed = 0
      },
    ],
    [
      `surface ${index} draft leaked`,
      ({ evidence: r }) => {
        r.slow.visibility[index]!.draftLeaks = 1
      },
    ],
    [
      `surface ${index} tool error leaked`,
      ({ evidence: r }) => {
        r.slow.visibility[index]!.toolErrorLeaks = 1
      },
    ],
  )
}
for (const [label, get] of [
  ['fast', (r: Rd05aEvidence) => r.fast.receipts[0]!],
  ['slow', (r: Rd05aEvidence) => r.slow.receipts[0]!],
  ['negative', (r: Rd05aEvidence) => r.revokeBeforeRead.receipts[0]!],
] as const) {
  negatives.push(
    [
      `${label} receipt unverified`,
      ({ evidence: r }) => {
        get(r).digestVerified = false
      },
    ],
    [
      `${label} receipt wrong manifest`,
      ({ evidence: r }) => {
        get(r).manifestDigest = hash('wrong receipt')
      },
    ],
    [
      `${label} receipt missing input`,
      ({ evidence: r }) => {
        get(r).missing = [id(999)]
      },
    ],
    [
      `${label} receipt wrong Run`,
      ({ evidence: r }) => {
        get(r).runId = id(999)
      },
    ],
    [
      `${label} invalid receipt sequence`,
      ({ evidence: r }) => {
        get(r).receiptSeq = 0
      },
    ],
    [
      `${label} duplicate delivery`,
      ({ evidence: r }) => {
        get(r).entriesDelivered.push(get(r).entriesDelivered[0]!)
      },
    ],
  )
}

function removeEvent(value: Fixture, type: Rd05aEvent['type']) {
  const index = value.events.findIndex((event) => event.type === type)
  expect(index).toBeGreaterThanOrEqual(0)
  value.events.splice(index, 1)
}
for (const type of [
  'work_input.receipt',
  'tool_read.observed',
  'tool_error.observed',
  'campaign.stage',
  'runtime.ready',
  'run.completed',
  'run.status',
] as const) {
  negatives.push([`missing ${type} event after rehash`, (value) => removeEvent(value, type)])
  negatives.push([
    `duplicate ${type} event after rehash`,
    (value) => {
      value.events.push(structuredClone(value.events.find((event) => event.type === type)!))
    },
  ])
}
negatives.push(
  [
    'no events even after rehash',
    (value) => {
      value.events = []
    },
  ],
  [
    'wrong event component after rehash',
    (value) => {
      Object.assign(value.events[0]!, { component: 'forged' })
    },
  ],
  [
    'receipt read event wrong digest after rehash',
    (value) => {
      const event = value.events.find((row) => row.type === 'work_input.receipt')! as Rd05aReceipt
      event.readEvents[0]!.digestVerified = false
    },
  ],
  [
    'receipt facts differ after rehash',
    (value) => {
      const event = value.events.find((row) => row.type === 'work_input.receipt')! as Rd05aReceipt
      event.entriesRead = []
    },
  ],
  [
    'actual tool body event differs after rehash',
    (value) => {
      Object.assign(
        value.events.find((row) => row.type === 'tool_read.observed')!,
        { bodyDigest: hash('other body') },
      )
    },
  ],
  [
    'tool error event wrong Run after rehash',
    (value) => {
      Object.assign(
        value.events.find((row) => row.type === 'tool_error.observed')!,
        { runId: id(999) },
      )
    },
  ],
  [
    'tool error event wrong body after rehash',
    (value) => {
      Object.assign(
        value.events.find((row) => row.type === 'tool_error.observed')!,
        { resultDigest: hash('success') },
      )
    },
  ],
  [
    'stage event another campaign after rehash',
    (value) => {
      Object.assign(
        value.events.find((row) => row.type === 'campaign.stage')!,
        { campaignId: id(999) },
      )
    },
  ],
  [
    'stage event wrong task count after rehash',
    (value) => {
      Object.assign(
        value.events.find((row) => row.type === 'campaign.stage')!,
        { taskCount: 99 },
      )
    },
  ],
  [
    'event for unrelated Run after rehash',
    (value) => {
      value.events.push({
        component: 'hub.run',
        type: 'runtime.ready',
        runId: id(999),
        audience: 'owner',
      })
    },
  ],
)

function multipleSnapshots(value: Fixture) {
  const target = value.evidence.slow.receipts[0]!
  const delivered = {
    ...structuredClone(target),
    id: id(74),
    receiptSeq: 1,
    entriesRead: [],
    readEvents: [],
  }
  const firstRead = {
    ...structuredClone(target),
    id: id(75),
    receiptSeq: 2,
    entriesRead: target.entriesRead.slice(0, 1),
    readEvents: target.readEvents.slice(0, 1),
  }
  const finalRead = {
    ...structuredClone(target),
    receiptSeq: 3,
    readEvents: target.readEvents.slice(1),
  }
  value.evidence.slow.receipts = [delivered, firstRead, finalRead]
  value.events = value.events.filter(
    (event) => !(event.type === 'work_input.receipt' && event.runId === target.runId),
  )
  value.events.push(
    ...value.evidence.slow.receipts.map((row) => ({
      component: 'hub.work_input' as const,
      type: 'work_input.receipt' as const,
      ...structuredClone(row),
    })),
  )
}

for (const change of [
  'missing final read',
  'duplicate sequence',
  'regressed cumulative reads',
  'duplicate actual read',
  'snapshot status',
  'snapshot execution',
  'snapshot task',
] as const) {
  negatives.push([
    change,
    (value) => {
      if (change.startsWith('snapshot')) {
        const event = value.events.find(
          (event) => event.type === 'run.status' && event.runId === value.evidence.runs[2]!.id,
        )!
        if (change === 'snapshot status') Object.assign(event, { status: 'running' })
        else if (change === 'snapshot execution') Object.assign(event, { executionId: id(999) })
        else Object.assign(event, { taskId: id(999) })
        return
      }
      multipleSnapshots(value)
      const rows = value.evidence.slow.receipts
      if (change === 'missing final read') rows.pop()
      else if (change === 'duplicate sequence') rows[2]!.receiptSeq = 2
      else if (change === 'regressed cumulative reads')
        rows[2]!.entriesRead = rows[2]!.entriesRead.slice(1)
      else rows[2]!.readEvents.push(structuredClone(rows[1]!.readEvents[0]!))
      // Keep event claims equal to the mutated captured rows; semantic coverage must fail too.
      value.events = value.events.filter(
        (event) =>
          !(event.type === 'work_input.receipt' && event.runId === value.evidence.runs[2]!.id),
      )
      value.events.push(
        ...rows.map((row) => ({
          component: 'hub.work_input' as const,
          type: 'work_input.receipt' as const,
          ...structuredClone(row),
        })),
      )
    },
  ])
}

describe('RD-05a independent combined campaign judge', () => {
  it('discloses reserved fallback and missing usage without inventing zero private billing', () => {
    const value = fixture()
    for (const row of [
      ...value.evidence.accounting.coordination,
      ...value.evidence.accounting.executor,
    ])
      if (row.phase === 'settled') {
        row.chargeMode = 'reserved'
        row.usage = null
      }
    expect(() => checkRd05a(value.evidence, seal(value), binding)).not.toThrow()
  })
  it('executes every standalone mutation check on both single and multiple receipt snapshots', () => {
    for (const multi of [false, true]) {
      const value = fixture()
      if (multi) multipleSnapshots(value)
      const before = structuredClone(value)
      const bytes = seal(value)
      expect(checkRd05aEvidenceNegatives(value.evidence, bytes, binding)).toBeGreaterThan(100)
      expect(value.events).toEqual(before.events)
      expect(value.evidence).toEqual({ ...before.evidence, provenance: value.evidence.provenance })
    }
  })

  it('accepts cumulative multi-receipt snapshots and delta read events without inventing private lifecycle', () => {
    const value = fixture()
    multipleSnapshots(value)
    value.evidence.runs[2]!.dshSessionId = null
    for (const event of value.events) if (event.component === 'hub.run') event.audience = 'project'
    expect(() => checkRd05a(value.evidence, seal(value), binding)).not.toThrow()
  })

  it('accepts exactly three positive roles and a separate fourth revoke-before-read Run', () => {
    const value = fixture()
    expect(() => checkRd05a(value.evidence, seal(value), binding)).not.toThrow()
  })

  it.each(negatives)('rejects %s', (_, mutate) => {
    const value = structuredClone(fixture())
    mutate(value)
    expect(() => checkRd05a(value.evidence, seal(value), binding)).toThrow()
  })

  it('requires the independently supplied binding, never the evidence self-claim', () => {
    const value = fixture()
    expect(() =>
      checkRd05a(value.evidence, seal(value), undefined as unknown as Rd05aBinding),
    ).toThrow()
  })

  it('rejects an unchanged events digest with changed bytes', () => {
    const value = fixture()
    const bytes = seal(value)
    expect(() => checkRd05a(value.evidence, bytes + '\n', binding)).toThrow()
  })

  it.each([null, {}, [], { schemaVersion: 1 }, { fast: {}, slow: {} }])(
    'fails closed for incomplete input %j',
    (input) => {
      expect(() => checkRd05a(input, '', binding)).toThrow()
    },
  )

  it('reads only the requested result and its adjacent events and uses the caller binding', async () => {
    // Disposable synthetic parser inputs are not acceptance evidence or a retained evidence pack.
    const directory = await mkdtemp(join(tmpdir(), 'whalepod-rd05a-judge-spec-'))
    try {
      const value = fixture()
      const bytes = seal(value)
      const path = join(directory, 'result.json')
      await writeFile(path, JSON.stringify(value.evidence))
      await writeFile(join(directory, 'events.jsonl'), bytes)
      await expect(verifyRd05a(path, binding)).resolves.toBeUndefined()
      await expect(verifyRd05a(path, { ...binding, commit: 'f'.repeat(40) })).rejects.toThrow()
      await rm(join(directory, 'events.jsonl'))
      await expect(verifyRd05a(path, binding)).rejects.toThrow()
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })
})
