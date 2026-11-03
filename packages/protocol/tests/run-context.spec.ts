/**
 * ADR-0027（PC-05a）协议形状：快照清单代次规则、initialize 成对字段与回执谓词形状。
 */
import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import {
  ContextStateAckSchema,
  ContextStateSyncSchema,
  RuntimeContextLocalStateSchema,
  RunContextReceiptSchema,
  RunContextStateEntrySchema,
  RunContextStateSchema,
  RunProjectContextManifestEntrySchema,
  RunProjectContextEntryStatusSchema,
  RunStartProjectContextSchema,
  PROJECT_CONTEXT_CAPABILITY,
  PROJECT_CONTEXT_HEADER_MAX_CHARS,
  contextStateDigestInput,
} from '../src/run-context.js'
import { RuntimeInitializeSchema } from '../src/runtime-wire.js'
import {
  NodeHelloSchema,
  RunContextReceiptAckFrameSchema,
  RunStartSchema,
} from '../src/node-wire.js'

const ENTRY_ID = '01905f7c-0000-7000-8000-000000000951'
const DIGEST = 'a'.repeat(64)
const ENTRY = {
  entryId: ENTRY_ID,
  kind: 'decision' as const,
  title: '预算结论',
  revisionId: null,
  businessRef: 'taskSpec:01905f7c-0000-7000-8000-000000000201',
  digest: DIGEST,
  byteSize: 10,
  snapshotAuthorizationGeneration: null,
}
const HEADER_TEXT = `[project-context:0123456789abcdef]\n- ${ENTRY_ID}`

function envelope<T extends string>(type: T, payload: unknown) {
  return {
    protocolVersion: 1,
    messageId: randomUUID(),
    sentAt: new Date().toISOString(),
    type,
    payload,
  }
}

describe('PC-05b context state wire', () => {
  const entry = (overrides: Record<string, unknown> = {}) => ({
    entryId: ENTRY_ID,
    kind: 'observation' as const,
    state: 'frozen' as const,
    currentAuthorizationGeneration: null,
    reason: null,
    ...overrides,
  })

  it('covers the full revocation state enum', () => {
    for (const state of [
      'frozen',
      'retracted',
      'source_tombstoned',
      'permission_unknown',
      'permission_denied',
      'unavailable',
    ]) {
      expect(RunProjectContextEntryStatusSchema.parse(state)).toBe(state)
    }
    expect(RunProjectContextEntryStatusSchema.safeParse('revoked').success).toBe(false)
  })

  it('normalizes state digest input by entryId and ignores reason text', () => {
    const a = entry()
    const b = entry({ reason: '另一种文案' })
    expect(contextStateDigestInput(3, [a, b])).toBe(contextStateDigestInput(3, [b, a]))
    expect(contextStateDigestInput(3, [a])).not.toBe(contextStateDigestInput(4, [a]))
    expect(contextStateDigestInput(3, [a])).not.toBe(
      contextStateDigestInput(3, [entry({ state: 'retracted' })]),
    )
    expect(contextStateDigestInput(3, [a])).not.toBe(
      contextStateDigestInput(3, [entry({ currentAuthorizationGeneration: '2' })]),
    )
  })

  it('rejects source-derived state and generations on decision entries', () => {
    expect(
      RunContextStateEntrySchema.parse(entry({ kind: 'decision', state: 'retracted' })).state,
    ).toBe('retracted')
    expect(() =>
      RunContextStateEntrySchema.parse(
        entry({ kind: 'decision', currentAuthorizationGeneration: '2' }),
      ),
    ).toThrow()
    expect(() =>
      RunContextStateEntrySchema.parse(entry({ kind: 'decision', state: 'source_tombstoned' })),
    ).toThrow()
    expect(() =>
      RunContextStateEntrySchema.parse(entry({ kind: 'decision', state: 'permission_unknown' })),
    ).toThrow()
  })

  it('accepts full state, heartbeat, ack and the local state file shape', () => {
    const state = {
      commandId: randomUUID(),
      runId: randomUUID(),
      snapshotId: randomUUID(),
      stateVersion: 1,
      stateDigest: DIGEST,
      entries: [entry()],
      generatedAt: new Date().toISOString(),
    }
    expect(RunContextStateSchema.parse(state).stateVersion).toBe(1)
    expect(
      ContextStateSyncSchema.parse({
        commandId: state.commandId,
        runId: state.runId,
        snapshotId: state.snapshotId,
        stateVersion: 1,
        stateDigest: DIGEST,
        at: state.generatedAt,
      }).stateVersion,
    ).toBe(1)
    expect(
      ContextStateAckSchema.parse({
        runId: state.runId,
        snapshotId: state.snapshotId,
        stateVersion: 1,
        stateDigest: DIGEST,
        appliedAt: state.generatedAt,
        failedEntryIds: [],
      }).failedEntryIds,
    ).toEqual([])
    expect(
      RuntimeContextLocalStateSchema.parse({
        runId: state.runId,
        snapshotId: state.snapshotId,
        stateVersion: 0,
        stateDigest: state.stateDigest,
        entries: state.entries,
        syncedAt: state.generatedAt,
        paused: false,
      }).paused,
    ).toBe(false)
  })
})

describe('PC-05a run project context wire', () => {
  it('requires decision entries to have no source generation and source observations to have one', () => {
    expect(RunProjectContextManifestEntrySchema.parse(ENTRY).entryId).toBe(ENTRY_ID)
    expect(() =>
      RunProjectContextManifestEntrySchema.parse({
        ...ENTRY,
        snapshotAuthorizationGeneration: 'gen-1',
      }),
    ).toThrow()
    expect(() =>
      RunProjectContextManifestEntrySchema.parse({
        ...ENTRY,
        kind: 'observation',
        businessRef: null,
        revisionId: '01905f7c-0000-7000-8000-000000000952',
        snapshotAuthorizationGeneration: null,
      }),
    ).toThrow()
    expect(
      RunProjectContextManifestEntrySchema.parse({
        ...ENTRY,
        kind: 'observation',
        businessRef: 'run:01905f7c-0000-7000-8000-000000000953',
      }).snapshotAuthorizationGeneration,
    ).toBeNull()
  })

  it('accepts the run.start manifest and rejects a header over 4000 characters', () => {
    const payload = {
      snapshotId: '01905f7c-0000-7000-8000-000000000961',
      digest: DIGEST,
      headerText: HEADER_TEXT,
      headerDigest: DIGEST,
      manifest: [ENTRY],
    }
    expect(
      RunStartSchema.parse(
        envelope('run.start', {
          commandId: '01905f7c-0000-7000-8000-000000000971',
          runId: '01905f7c-0000-7000-8000-000000000972',
          taskId: '01905f7c-0000-7000-8000-000000000973',
          ownerUserId: '01905f7c-0000-7000-8000-000000000974',
          agent: {
            id: '01905f7c-0000-7000-8000-000000000975',
            profileRevisionId: '01905f7c-0000-7000-8000-000000000976',
            persona: 'p',
            provider: 'fixture',
            model: 'fixture',
            credentialSlot: 'default',
          },
          workspaceId: '01905f7c-0000-7000-8000-000000000977',
          expectedProfileDigest: DIGEST,
          expectedPluginPackDigest: DIGEST,
          prompt: 'go',
          projectContext: payload,
        }),
      ).payload.projectContext?.snapshotId,
    ).toBe(payload.snapshotId)
    expect(() =>
      RunStartProjectContextSchema.parse({
        ...payload,
        headerText: 'x'.repeat(PROJECT_CONTEXT_HEADER_MAX_CHARS + 1),
      }),
    ).toThrow()
  })

  it('requires the project context manifest and local directory to travel together', () => {
    const initialize = {
      runId: '01905f7c-0000-7000-8000-000000000981',
      workspacePath: '<workspace>',
      dshHomePath: '<home>',
      profileDigest: DIGEST,
      pluginPackDigest: DIGEST,
      provider: 'fixture',
      model: 'fixture',
      persona: 'p',
      projectContext: {
        snapshotId: '01905f7c-0000-7000-8000-000000000961',
        digest: DIGEST,
        headerText: HEADER_TEXT,
        headerDigest: DIGEST,
        entries: [ENTRY],
        entriesDir: '<runtime-context>/r1',
      },
    }
    expect(
      RuntimeInitializeSchema.parse(envelope('runtime.initialize', initialize)).payload
        .projectContext?.entries,
    ).toHaveLength(1)
    const { entriesDir: _entriesDir, ...withoutDir } = initialize.projectContext
    expect(() =>
      RuntimeInitializeSchema.parse(
        envelope('runtime.initialize', { ...initialize, projectContext: withoutDir }),
      ),
    ).toThrow()
  })

  it('accepts the capability declaration and rejects unknown capability strings', () => {
    const hello = {
      deviceId: '01905f7c-0000-7000-8000-000000000991',
      nodeVersion: 'v24.12.0',
      platform: 'darwin' as const,
      architecture: 'arm64',
      supportedProtocolVersions: [1] as [1],
      dshDistributionVersion: '0.1.0-rc.8',
      pluginPackDigests: [],
      contextCapabilities: [PROJECT_CONTEXT_CAPABILITY],
    }
    expect(
      NodeHelloSchema.parse(envelope('node.hello', hello)).payload.contextCapabilities,
    ).toEqual([PROJECT_CONTEXT_CAPABILITY])
    expect(() =>
      NodeHelloSchema.parse(
        envelope('node.hello', { ...hello, contextCapabilities: ['project-context.v2'] }),
      ),
    ).toThrow()
  })

  it('accepts the Node receipt with unique entry sets and monotonic sequence', () => {
    const receipt = {
      runId: '01905f7c-0000-7000-8000-000000000981',
      snapshotId: '01905f7c-0000-7000-8000-000000000961',
      receiptSeq: 1,
      headerDigest: DIGEST,
      nonceMatched: true,
      entriesDelivered: [ENTRY_ID],
      entriesRead: [],
      readEvents: [],
      missing: [],
      digestVerified: true,
      at: new Date().toISOString(),
    }
    expect(RunContextReceiptSchema.parse(receipt).receiptSeq).toBe(1)
    expect(() => RunContextReceiptSchema.parse({ ...receipt, receiptSeq: 0 })).toThrow()
    const ackPayload = {
      runId: receipt.runId,
      snapshotId: receipt.snapshotId,
      receiptSeq: 1,
      highestSeq: 1,
      result: 'accepted',
    }
    const ack = envelope('run.context_receipt_ack', ackPayload)
    expect(RunContextReceiptAckFrameSchema.parse(ack).payload.highestSeq).toBe(1)
    expect(() =>
      RunContextReceiptAckFrameSchema.parse({
        ...ack,
        payload: { ...ackPayload, result: 'done' },
      }),
    ).toThrow()
  })
})
