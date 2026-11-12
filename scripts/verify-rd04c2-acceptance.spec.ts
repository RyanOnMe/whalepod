import { describe, expect, it } from 'vitest'
import { sha256 } from './lib/acceptance-provenance.js'
import { sourceBody } from './lib/rd04c2-replay.js'
import { checkRd04c2 } from './verify-rd04c2-acceptance.js'

const id = (n: number) => '11111111-1111-4111-8111-' + n.toString().padStart(12, '0')
const assemblyDigest = 'a'.repeat(64)
const binding = { commit: 'b'.repeat(40), harnessDigest: 'c'.repeat(64) }
const resultDigest = sha256('Error: unknown work input item: RD04C2_PRIVATE_TOOL_ERROR_ONLY')

function receipt() {
  const sources = [
    {
      kind: 'artifact',
      sourceId: id(5),
      sourceVersion: 'd'.repeat(64),
      sourceDigest: 'd'.repeat(64),
      authorizationGeneration: 'published:1',
    },
    {
      kind: 'task_message',
      sourceId: id(6),
      sourceVersion: '2026-11-12T08:51:42.426Z',
      sourceDigest: 'e'.repeat(64),
      authorizationGeneration: 'author:1',
    },
  ]
  const entries = sources.map((source, index) => ({
    ...source,
    inboxItemId: id(20 + index),
    sourceType: 'discovery_source',
    bodyDigest: source.kind === 'artifact' ? source.sourceDigest : sha256(sourceBody),
  }))
  const toolError = {
    callId: 'private-read-error',
    toolName: 'read_work_input',
    role: 'tool',
    resultDigest,
  }
  const events = [
    {
      component: 'hub.work_input',
      type: 'work_input.receipt',
      runId: id(10),
      manifestDigest: 'f'.repeat(64),
      digestVerified: true,
      receiptSeq: 1,
      delivered: entries.map((entry) => entry.inboxItemId),
      read: entries.map((entry) => entry.inboxItemId),
      readEvents: entries.map((entry) => ({
        inboxItemId: entry.inboxItemId,
        digestVerified: true,
      })),
      missing: [],
    },
    { component: 'hub.run', type: 'run.started', runId: id(10) },
    { component: 'hub.run', type: 'run.completed', runId: id(10) },
    { component: 'acceptance.replay', type: 'tool_error.observed', runId: id(10), ...toolError },
  ]
  const bytes = events.map((event) => JSON.stringify(event)).join('\n') + '\n'
  const result = {
    schemaVersion: 2,
    mode: 'loopback_tool_error_followup',
    projectId: id(1),
    discussionTaskId: id(2),
    comparisonTaskId: id(3),
    taskId: id(4),
    specRevisionId: id(7),
    applicationId: id(8),
    evaluationId: id(9),
    sourceId: id(6),
    beforeAuthorizationRuns: 0,
    unauthorizedHttp: 404,
    unapprovedRouteHttp: 409,
    authorization: {
      id: id(11),
      status: 'authorized',
      purpose: 'private_draft',
      sourceManifestDigest: 'f'.repeat(64),
    },
    repeatExecutionId: id(11),
    concurrentExecutionId: id(11),
    authorizedSources: sources,
    run: {
      count: 1,
      id: id(10),
      taskId: id(4),
      origin: 'mandate',
      status: 'completed',
      dispatchIntentId: id(12),
      mandateId: id(13),
      specRevisionId: id(7),
      manifestDigest: 'f'.repeat(64),
      approvalPolicy: 'approval_required',
      executionId: id(11),
      entries,
    },
    replay: {
      publicRequests: 3,
      discoveryRequests: 1,
      privateRequests: 6,
      reads: entries.map(({ inboxItemId, bodyDigest }) => ({ inboxItemId, bodyDigest })),
      draftDigest: 'a'.repeat(64),
      toolErrors: [toolError],
    },
    publicArtifact: { id: id(5), memberHttp: 200, sha256: 'd'.repeat(64) },
    draft: {
      id: id(14),
      runId: id(10),
      status: 'candidate',
      sha256: 'a'.repeat(64),
      ownerDownloadDigest: 'a'.repeat(64),
      ownerHttp: 200,
      cacheControl: 'private, no-store',
      memberHttp: 404,
      publishHttp: 404,
    },
    ownerHttp: [200, 404, 404, 404],
    memberHttp: [404, 404, 200],
    visibility: ['http', 'ws_live', 'ws_replay'].map((surface) => ({
      surface,
      observed: 3,
      leaks: 0,
      toolErrorLeaks: 0,
    })),
    privateDirectoriesObserved: 2,
    workspaceClean: true,
    revocation: { ownerHttp: 404, ownerRoomHasRevokedTitle: false },
    provenance: { assemblyDigest, eventsDigest: sha256(bytes), ...binding },
  }
  return { result, events, bytes }
}

describe('RD-04c2 private tool error evidence judge', () => {
  it('accepts an observed production tool error with three independently observed private surfaces', () => {
    const { result, bytes } = receipt()
    expect(() => checkRd04c2(result, bytes, assemblyDigest, binding)).not.toThrow()
  })

  const negatives: [string, (r: ReturnType<typeof receipt>['result']) => void][] = [
    [
      'missing error',
      (r) => {
        r.replay.toolErrors = []
      },
    ],
    [
      'duplicate error',
      (r) => {
        r.replay.toolErrors.push(r.replay.toolErrors[0]!)
      },
    ],
    [
      'wrong call',
      (r) => {
        r.replay.toolErrors[0]!.callId = 'other-call'
      },
    ],
    [
      'wrong tool',
      (r) => {
        r.replay.toolErrors[0]!.toolName = 'write'
      },
    ],
    [
      'assistant text instead of tool error',
      (r) => {
        r.replay.toolErrors[0]!.role = 'assistant'
      },
    ],
    [
      'successful tool text containing the marker',
      (r) => {
        r.replay.toolErrors[0]!.resultDigest = sha256('RD04C2_PRIVATE_TOOL_ERROR_ONLY')
      },
    ],
    [
      'legacy request count',
      (r) => {
        r.replay.privateRequests--
      },
    ],
    [
      'wrong assembly',
      (r) => {
        r.provenance.assemblyDigest = 'd'.repeat(64)
      },
    ],
    [
      'wrong commit',
      (r) => {
        r.provenance.commit = 'd'.repeat(40)
      },
    ],
    [
      'wrong harness',
      (r) => {
        r.provenance.harnessDigest = 'd'.repeat(64)
      },
    ],
    [
      'missing surface',
      (r) => {
        r.visibility.pop()
      },
    ],
    [
      'duplicate surface',
      (r) => {
        r.visibility[1]!.surface = 'http'
      },
    ],
  ]
  for (const index of [0, 1, 2]) {
    negatives.push(
      [
        'unobserved surface ' + index,
        (r) => {
          r.visibility[index]!.observed = 0
        },
      ],
      [
        'error leak on surface ' + index,
        (r) => {
          r.visibility[index]!.toolErrorLeaks = 1
        },
      ],
      [
        'draft leak on surface ' + index,
        (r) => {
          r.visibility[index]!.leaks = 1
        },
      ],
    )
  }
  it.each(negatives)('rejects %s', (_, mutate) => {
    const { result, bytes } = receipt()
    mutate(result)
    expect(() => checkRd04c2(result, bytes, assemblyDigest, binding)).toThrow()
  })

  it.each(['removed', 'duplicate', 'wrong run', 'wrong result'])(
    'rejects %s error event even after rehashing events',
    (change) => {
      const { result, events } = receipt()
      if (change === 'removed') events.pop()
      else if (change === 'duplicate') events.push(events.at(-1)!)
      else if (change === 'wrong run') events.at(-1)!.runId = id(99)
      else Object.assign(events.at(-1)!, { resultDigest: sha256('success') })
      const bytes = events.map((event) => JSON.stringify(event)).join('\n') + '\n'
      result.provenance.eventsDigest = sha256(bytes)
      expect(() => checkRd04c2(result, bytes, assemblyDigest, binding)).toThrow()
    },
  )

  it('requires an independently supplied current commit and harness binding', () => {
    const { result, bytes } = receipt()
    expect(() => checkRd04c2(result, bytes, assemblyDigest)).toThrow()
  })

  it('retains the original v1 success verdict only for historical evidence', () => {
    const { result, events } = receipt()
    result.schemaVersion = 1
    result.mode = 'loopback_model_replay'
    result.replay.privateRequests--
    result.replay.toolErrors = []
    events.pop()
    const bytes = events.map((event) => JSON.stringify(event)).join('\n') + '\n'
    result.provenance.eventsDigest = sha256(bytes)
    expect(() => checkRd04c2(result, bytes, assemblyDigest)).not.toThrow()
    expect(() => checkRd04c2(result, bytes, assemblyDigest, binding)).toThrow()
  })
})
