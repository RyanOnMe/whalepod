#!/usr/bin/env tsx
/** Mutate a verified campaign in memory; never modify its sealed evidence files. */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Rd05aBinding, Rd05aEvidence, Rd05aEvent } from './lib/rd05a-evidence.js'
import { checkRd05a } from './verify-rd05a-acceptance.js'

const sha256 = (value: string) => createHash('sha256').update(value).digest('hex')
const changedDigest = sha256('RD05a deliberately substituted bytes')
const changedId = 'ffffffff-ffff-4fff-8fff-ffffffffffff'
type Sample = { evidence: Rd05aEvidence; events: Rd05aEvent[] }
type Mutation = { name: string; apply: (sample: Sample) => void }

const mutations: Mutation[] = [
  ...(['provider', 'model', 'endpoint', 'account', 'policyGeneration'] as const).map(
    (field): Mutation => ({
      name: `authorized Executor changed ${field}`,
      apply: ({ evidence: r }) => {
        Object.assign(r.slow.authorization.executor, {
          [field]: field === 'policyGeneration' ? 2 : 'substituted',
        })
      },
    }),
  ),
  {
    name: 'authorized Executor digest changed',
    apply: ({ evidence: r }) => {
      r.slow.authorization.executorDigest = changedDigest
    },
  },
  ...(['coordination', 'executor'] as const).flatMap((ledger) =>
    (['reservedTokens', 'reservedCostMicros'] as const).map((field): Mutation => ({
      name: `${ledger} settlement changed ${field}`,
      apply: ({ evidence: r }) => {
        r.accounting[ledger].find((row) => row.phase === 'settled')![field] += 1
      },
    })),
  ),
  {
    name: 'missing owner lifecycle mirror',
    apply: ({ events }) => {
      const index = events.findIndex(
        (event) => event.component === 'hub.run' && event.audience === 'owner',
      )
      events.splice(index, 1)
    },
  },
  {
    name: 'duplicate project lifecycle mirror',
    apply: ({ events }) => {
      events.push(
        structuredClone(
          events.find((event) => event.component === 'hub.run' && event.audience === 'project')!,
        ),
      )
    },
  },
  {
    name: 'different commit',
    apply: ({ evidence: r }) => {
      r.provenance.commit = r.provenance.commit === '0'.repeat(40) ? '1'.repeat(40) : '0'.repeat(40)
    },
  },
  {
    name: 'different harness',
    apply: ({ evidence: r }) => {
      r.provenance.harnessDigest = changedDigest
    },
  },
  {
    name: 'different production assembly',
    apply: ({ evidence: r }) => {
      r.provenance.assemblyDigest = changedDigest
    },
  },
  {
    name: 'legacy acceptance substituted',
    apply: ({ evidence: r }) => {
      Object.assign(r, { mode: 'loopback_tool_error_followup' })
    },
  },
  {
    name: 'third member',
    apply: ({ evidence: r }) => {
      r.members.count = 3
    },
  },
  {
    name: 'Run in different project',
    apply: ({ evidence: r }) => {
      r.runs[0]!.projectId = changedId
    },
  },
  {
    name: 'missing positive Run',
    apply: ({ evidence: r }) => {
      r.runs.pop()
    },
  },
  {
    name: 'extra positive Run',
    apply: ({ evidence: r }) => {
      r.runs.push({ ...structuredClone(r.runs[0]!), id: changedId })
    },
  },
  {
    name: 'duplicate positive role',
    apply: ({ evidence: r }) => {
      r.runs.find((run) => run.role === 'continuation')!.role = 'bootstrap'
    },
  },
  {
    name: 'first snapshot changed',
    apply: ({ evidence: r }) => {
      r.fast.firstSnapshot = changedDigest
    },
  },
  {
    name: 'supplement inserted in original snapshot',
    apply: ({ evidence: r }) => {
      r.runs.find((run) => run.role === 'bootstrap')!.itemIds.push(r.fast.supplement.itemId)
    },
  },
  {
    name: 'ingress Router invoked',
    apply: ({ evidence: r }) => {
      r.fast.supplement.routerInvoked = true
    },
  },
  {
    name: 'ingress Router request',
    apply: ({ evidence: r }) => {
      r.fast.supplement.routerCalls = 1
    },
  },
  {
    name: 'ingress Router evaluation',
    apply: ({ evidence: r }) => {
      r.fast.supplement.routerRows = 1
    },
  },
  {
    name: 'ingress Run dispatched',
    apply: ({ evidence: r }) => {
      r.fast.supplement.runCount = 1
    },
  },
  {
    name: 'extra fast inbox item',
    apply: ({ evidence: r }) => {
      r.fast.inbox.push({ ...r.fast.inbox[0]!, id: changedId })
    },
  },
  {
    name: 'missing consumption',
    apply: ({ evidence: r }) => {
      r.fast.consumptions.pop()
    },
  },
  {
    name: 'missing boundary Router evaluation',
    apply: ({ evidence: r }) => {
      r.fast.evaluations.pop()
    },
  },
  {
    name: 'wait replaced with dispatch',
    apply: ({ evidence: r }) => {
      r.fast.applications.find((row) => row.decision === 'wait')!.decision = 'dispatch'
    },
  },
  {
    name: 'manual continuation approval',
    apply: ({ evidence: r }) => {
      r.fast.intents.find((row) => row.id !== r.fast.bootstrapIntentId)!.approvalBasis = 'manual'
    },
  },
  {
    name: 'wrong fast actual tool body',
    apply: ({ evidence: r }) => {
      r.fast.replay.toolReads[0]!.bodyDigest = changedDigest
    },
  },
  {
    name: 'fast draft leaked',
    apply: ({ evidence: r }) => {
      r.fast.draft.memberHttp = 200
    },
  },
  {
    name: 'unpublished corroboration',
    apply: ({ evidence: r }) => {
      r.fast.publicArtifact.status = 'candidate'
    },
  },
  {
    name: 'extra discovery Task',
    apply: ({ evidence: r }) => {
      r.slow.createdTaskIds.push(changedId)
    },
  },
  {
    name: 'preauthorization Run',
    apply: ({ evidence: r }) => {
      r.slow.beforeAuthorizationRuns = 1
    },
  },
  {
    name: 'wrong account accepted',
    apply: ({ evidence: r }) => {
      r.slow.wrongAccountHttp = 200
    },
  },
  {
    name: 'nonowner authorization visible',
    apply: ({ evidence: r }) => {
      r.slow.nonownerHttp = 200
    },
  },
  {
    name: 'live-only authorization',
    apply: ({ evidence: r }) => {
      r.slow.authorization.liveOnlyGrantCount = 1
    },
  },
  {
    name: 'repeat execution duplicated',
    apply: ({ evidence: r }) => {
      r.slow.repeatExecutionId = changedId
    },
  },
  {
    name: 'concurrent execution duplicated',
    apply: ({ evidence: r }) => {
      r.slow.concurrentExecutionId = changedId
    },
  },
  {
    name: 'second target Run',
    apply: ({ evidence: r }) => {
      r.slow.targetRunCount = 2
    },
  },
  {
    name: 'missing authorized source',
    apply: ({ evidence: r }) => {
      r.slow.authorization.sources.pop()
    },
  },
  {
    name: 'different source version',
    apply: ({ evidence: r }) => {
      r.slow.entries[0]!.sourceVersion += '-substituted'
    },
  },
  {
    name: 'different source digest',
    apply: ({ evidence: r }) => {
      r.slow.entries[0]!.sourceDigest = changedDigest
    },
  },
  {
    name: 'different authorization generation',
    apply: ({ evidence: r }) => {
      r.slow.entries[0]!.authorizationGeneration += '-substituted'
    },
  },
  {
    name: 'missing actual source read',
    apply: ({ evidence: r }) => {
      r.slow.replay.toolReads.pop()
    },
  },
  {
    name: 'wrong actual source body',
    apply: ({ evidence: r }) => {
      r.slow.replay.toolReads[0]!.bodyDigest = changedDigest
    },
  },
  {
    name: 'missing tool error',
    apply: ({ evidence: r }) => {
      r.slow.replay.toolErrors = []
    },
  },
  {
    name: 'duplicate tool error',
    apply: ({ evidence: r }) => {
      r.slow.replay.toolErrors.push(structuredClone(r.slow.replay.toolErrors[0]!))
    },
  },
  {
    name: 'wrong error call',
    apply: ({ evidence: r }) => {
      r.slow.replay.toolErrors[0]!.callId += '-substituted'
    },
  },
  {
    name: 'assistant text rather than tool error',
    apply: ({ evidence: r }) => {
      r.slow.replay.toolErrors[0]!.role = 'assistant'
    },
  },
  {
    name: 'success text rather than actual tool error',
    apply: ({ evidence: r }) => {
      r.slow.replay.toolErrors[0]!.resultDigest = sha256('RD04C2_PRIVATE_TOOL_ERROR_ONLY')
    },
  },
  {
    name: 'formal publication allowed',
    apply: ({ evidence: r }) => {
      r.slow.draft.publishHttp = 200
    },
  },
  {
    name: 'cached private draft',
    apply: ({ evidence: r }) => {
      r.slow.draft.cacheControl = 'public'
    },
  },
  {
    name: 'private draft downloaded different bytes',
    apply: ({ evidence: r }) => {
      r.slow.draft.ownerDownloadDigest = changedDigest
    },
  },
  {
    name: 'positive private directories absent',
    apply: ({ evidence: r }) => {
      r.slow.privateDirectoriesObserved = 0
    },
  },
  {
    name: 'positive workspace left behind',
    apply: ({ evidence: r }) => {
      r.slow.workspaceClean = false
    },
  },
  {
    name: 'revoked owner still downloads',
    apply: ({ evidence: r }) => {
      r.slow.revocation.ownerHttp = 200
    },
  },
  {
    name: 'negative reuses positive Task',
    apply: ({ evidence: r }) => {
      r.revokeBeforeRead.taskId = r.slow.taskId
    },
  },
  {
    name: 'negative Run survives revocation',
    apply: ({ evidence: r }) => {
      r.revokeBeforeRead.runStatus = 'completed'
    },
  },
  {
    name: 'negative performs read',
    apply: ({ evidence: r }) => {
      r.revokeBeforeRead.reads = 1
    },
  },
  {
    name: 'negative receives tool body',
    apply: ({ evidence: r }) => {
      r.revokeBeforeRead.toolResults = 1
    },
  },
  {
    name: 'negative creates draft',
    apply: ({ evidence: r }) => {
      r.revokeBeforeRead.drafts = 1
    },
  },
  {
    name: 'negative workspace left behind',
    apply: ({ evidence: r }) => {
      r.revokeBeforeRead.workspaceClean = false
    },
  },
  {
    name: 'missing stage',
    apply: ({ evidence: r }) => {
      r.stages.pop()
    },
  },
  {
    name: 'extra positive task',
    apply: ({ evidence: r }) => {
      r.stages[2]!.taskCount++
    },
  },
  {
    name: 'missing human publication',
    apply: ({ evidence: r }) => {
      r.humanActions.positive = r.humanActions.positive.filter(
        (row) => row.action !== 'publication',
      )
    },
  },
  {
    name: 'missing separate correction',
    apply: ({ evidence: r }) => {
      r.humanActions.corrections = []
    },
  },
  {
    name: 'paid request',
    apply: ({ evidence: r }) => {
      r.paidRequests = 1
    },
  },
]

mutations.push(
  {
    name: 'negative delivery substituted from positive Run',
    apply: ({ evidence: r, events }) => {
      for (const receipt of r.revokeBeforeRead.receipts)
        receipt.entriesDelivered = [...r.runs.find((run) => run.role === 'discovery')!.itemIds]
      for (const event of events)
        if (event.type === 'work_input.receipt' && event.runId === r.revokeBeforeRead.runId)
          event.entriesDelivered = [...r.runs.find((run) => run.role === 'discovery')!.itemIds]
    },
  },
  {
    name: 'negative authorized source changed',
    apply: ({ evidence: r }) => {
      r.revokeBeforeRead.sources[0]!.sourceVersion = 'wrong-version'
    },
  },
  {
    name: 'negative manifest source changed',
    apply: ({ evidence: r }) => {
      r.revokeBeforeRead.entries[0]!.sourceId = changedId
    },
  },
  {
    name: 'negative source digest changed',
    apply: ({ evidence: r }) => {
      r.revokeBeforeRead.sourceManifestDigest = changedDigest
    },
  },
  {
    name: 'negative reused positive inbox item',
    apply: ({ evidence: r }) => {
      r.revokeBeforeRead.entries[0]!.inboxItemId = r.runs[0]!.itemIds[0]!
    },
  },
  {
    name: 'local model call disguised as inference',
    apply: ({ evidence: r }) => {
      r.accounting.localEvaluations.push({
        id: changedId,
        projectId: r.projectId,
        purpose: 'inference',
        status: 'completed',
        modelStarted: true as false,
      })
    },
  },
  {
    name: 'local inference omitted from stability',
    apply: ({ evidence: r }) => {
      r.accounting.localEvaluations.push({
        id: changedId,
        projectId: r.projectId,
        purpose: 'inference',
        status: 'completed',
        modelStarted: false,
      })
    },
  },
  {
    name: 'missing per-purpose accounting',
    apply: ({ evidence: r }) => {
      Object.assign(r, { accounting: undefined })
    },
  },
  {
    name: 'duplicate coordination settlement',
    apply: ({ evidence: r }) => {
      r.accounting.coordination.push(structuredClone(r.accounting.coordination[0]!))
    },
  },
  {
    name: 'missing coordination settlement',
    apply: ({ evidence: r }) => {
      r.accounting.coordination.pop()
    },
  },
  {
    name: 'wrong coordination attempt',
    apply: ({ evidence: r }) => {
      r.accounting.coordination[0]!.attempt = 2
    },
  },
  {
    name: 'wrong coordination purpose',
    apply: ({ evidence: r }) => {
      r.accounting.coordination[0]!.purpose = 'inference'
    },
  },
  {
    name: 'wrong coordination Project',
    apply: ({ evidence: r }) => {
      r.accounting.coordination[0]!.projectId = changedId
    },
  },
  {
    name: 'wrong coordination Work',
    apply: ({ evidence: r }) => {
      r.accounting.coordination[0]!.workKey = changedId
    },
  },
  {
    name: 'reservation has actual usage',
    apply: ({ evidence: r }) => {
      r.accounting.coordination.find((row) => row.phase === 'reserved')!.usage = {
        inputTokens: 1,
        outputTokens: 1,
        costMicros: 0,
        provider: 'replay',
        model: 'replay',
      }
    },
  },
  {
    name: 'reservation has charge mode',
    apply: ({ evidence: r }) => {
      r.accounting.executor.find((row) => row.phase === 'reserved')!.chargeMode = 'actual'
    },
  },
  {
    name: 'settlement missing charge mode',
    apply: ({ evidence: r }) => {
      r.accounting.executor.find((row) => row.phase === 'settled')!.chargeMode = null
    },
  },
  {
    name: 'negative reservation',
    apply: ({ evidence: r }) => {
      r.accounting.executor[0]!.reservedTokens = -1
    },
  },
  {
    name: 'duplicate ordinary Executor charge',
    apply: ({ evidence: r }) => {
      r.accounting.executor.push(structuredClone(r.accounting.executor[0]!))
    },
  },
  {
    name: 'missing ordinary Executor charge',
    apply: ({ evidence: r }) => {
      r.accounting.executor.pop()
    },
  },
  {
    name: 'unmetered discovery charged ordinary ledger',
    apply: ({ evidence: r }) => {
      r.accounting.executor[0]!.runId = r.runs.find((run) => run.role === 'discovery')!.id
    },
  },
  {
    name: 'Executor wrong Mandate',
    apply: ({ evidence: r }) => {
      r.accounting.executor[0]!.mandateId = changedId
    },
  },
  {
    name: 'missing replay metering disclosure',
    apply: ({ evidence: r }) => {
      r.accounting.replay.pop()
    },
  },
  {
    name: 'duplicate replay metering disclosure',
    apply: ({ evidence: r }) => {
      r.accounting.replay.push(structuredClone(r.accounting.replay[0]!))
    },
  },
  {
    name: 'unmetered replay claimed ordinary',
    apply: ({ evidence: r }) => {
      r.accounting.replay.find((row) => row.mode === 'loopback_unmetered')!.mode = 'ordinary_ledger'
    },
  },
  {
    name: 'model requests reported zero',
    apply: ({ evidence: r }) => {
      r.accounting.replay[0]!.requests = 0
    },
  },
  {
    name: 'live-only dispatch billing present',
    apply: ({ evidence: r }) => {
      r.accounting.replay[0]!.liveDispatchRows = 1
    },
  },
  {
    name: 'live-only attempt billing present',
    apply: ({ evidence: r }) => {
      r.accounting.replay[0]!.liveAttemptRows = 1
    },
  },
  {
    name: 'stability window absent',
    apply: ({ evidence: r }) => {
      r.stability.observedMs = 0
    },
  },
  {
    name: 'stability changed final Run set',
    apply: ({ evidence: r }) => {
      r.stability.after.runIds.push(changedId)
    },
  },
)

for (const group of ['setup', 'positive', 'corrections', 'negative'] as const) {
  for (const action of ['run', 'evaluate', 'followup', 'dispatch'] as const) {
    mutations.push({
      name: `hidden ${action} action in ${group}`,
      apply: ({ evidence: r }) => {
        r.humanActions[group].push({ action, subjectId: r.fast.supplement.source.sourceId })
      },
    })
  }
}
for (const surface of ['http', 'ws_live', 'ws_replay']) {
  for (const field of ['observed', 'draftLeaks', 'toolErrorLeaks'] as const) {
    mutations.push({
      name: `${surface} ${field} fails`,
      apply: ({ evidence: r }) => {
        r.slow.visibility.find((row) => row.surface === surface)![field] =
          field === 'observed' ? 0 : 1
      },
    })
  }
}
for (const type of [
  'work_input.receipt',
  'tool_read.observed',
  'tool_error.observed',
  'campaign.stage',
  'run.status',
  'runtime.ready',
  'run.completed',
] as const) {
  mutations.push(
    {
      name: `missing ${type} event after rehash`,
      apply: (sample) => {
        sample.events.splice(
          sample.events.findIndex((event) => event.type === type),
          1,
        )
      },
    },
    {
      name: `duplicate ${type} event after rehash`,
      apply: (sample) => {
        sample.events.push(structuredClone(sample.events.find((event) => event.type === type)!))
      },
    },
  )
}
for (const runSide of ['fast', 'slow', 'revokeBeforeRead'] as const) {
  mutations.push(
    {
      name: `${runSide} missing captured receipts`,
      apply: ({ evidence: r }) => {
        r[runSide].receipts = []
      },
    },
    {
      name: `${runSide} unverified receipt`,
      apply: ({ evidence: r }) => {
        r[runSide].receipts[0]!.digestVerified = false
      },
    },
    {
      name: `${runSide} wrong receipt manifest`,
      apply: ({ evidence: r }) => {
        r[runSide].receipts[0]!.manifestDigest = changedDigest
      },
    },
  )
}
mutations.push(
  {
    name: 'all semantic events removed after rehash',
    apply: (sample) => {
      sample.events = []
    },
  },
  {
    name: 'receipt event and captured facts disagree',
    apply: ({ events }) => {
      Object.assign(
        events.find((event) => event.type === 'work_input.receipt')!,
        { manifestDigest: changedDigest },
      )
    },
  },
  {
    name: 'actual tool event and captured body disagree',
    apply: ({ events }) => {
      Object.assign(
        events.find((event) => event.type === 'tool_read.observed')!,
        { bodyDigest: changedDigest },
      )
    },
  },
  {
    name: 'error event wrong result after rehash',
    apply: ({ events }) => {
      Object.assign(
        events.find((event) => event.type === 'tool_error.observed')!,
        { resultDigest: changedDigest },
      )
    },
  },
  {
    name: 'stage event wrong campaign after rehash',
    apply: ({ events }) => {
      Object.assign(
        events.find((event) => event.type === 'campaign.stage')!,
        { campaignId: changedId },
      )
    },
  },
  {
    name: 'status snapshot wrong execution after rehash',
    apply: ({ events, evidence: r }) => {
      Object.assign(
        events.find(
          (event) =>
            event.type === 'run.status' &&
            event.runId === r.runs.find((run) => run.role === 'discovery')!.id,
        )!,
        { executionId: changedId },
      )
    },
  },
)

/** Return only a mutation count. No private body, rejected input, or local path is logged. */
export function checkRd05aEvidenceNegatives(
  input: unknown,
  eventsBytes: string,
  binding: Rd05aBinding,
): number {
  checkRd05a(input, eventsBytes, binding)
  const evidence = input as Rd05aEvidence
  const events = eventsBytes
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line) as Rd05aEvent)
  for (const mutation of mutations) {
    const sample = structuredClone({ evidence, events })
    mutation.apply(sample)
    const bytes = sample.events.map((event) => JSON.stringify(event)).join('\n') + '\n'
    sample.evidence.provenance.eventsDigest = sha256(bytes)
    assert.throws(
      () => checkRd05a(sample.evidence, bytes, binding),
      `accepted mutation: ${mutation.name}`,
    )
  }
  // This mutation alone deliberately keeps the old digest to test byte integrity.
  assert.throws(
    () => checkRd05a(evidence, eventsBytes + '\n', binding),
    'accepted substituted events bytes',
  )
  return mutations.length + 1
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const path = process.argv[2]
  assert(
    path && process.argv.length === 3,
    'usage: check-rd05a-evidence-negatives.ts <evidence/result.json>',
  )
  const { bindRd05a } = await import('./lib/rd05a-provenance.js')
  const binding = await bindRd05a(fileURLToPath(new URL('..', import.meta.url)))
  const [result, events] = await Promise.all([
    readFile(path, 'utf8'),
    readFile(join(dirname(path), 'events.jsonl'), 'utf8'),
  ])
  const count = checkRd05aEvidenceNegatives(JSON.parse(result), events, binding)
  console.log(`RD-05a evidence negatives PASS (${count} mutations)`)
}
