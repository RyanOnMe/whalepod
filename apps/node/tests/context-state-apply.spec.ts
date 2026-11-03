/**
 * ADR-0027 §6（PC-05b）：Node 应用完整状态时的来源代次闸。
 */
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { contextStateDigestInput, type RunContextState } from '@whalepod/protocol'
import type { PreparedProjectContext } from '../src/context/project-context.js'
import { applyRunContextState, initializePreparedContextState } from '../src/context/state.js'
import { MemoryContextStateStore } from '../src/context/state-store.js'

const RUN_ID = '01905f7c-0000-7000-8000-000000000301'
const SNAPSHOT_ID = '01905f7c-0000-7000-8000-000000000961'
const ENTRY_ID = '01905f7c-0000-7000-8000-000000000951'
const BODY = '# source fact\n'

let root: string
let dir: string
let prepared: PreparedProjectContext

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'wp-context-apply-'))
  dir = join(root, 'runtime-context')
  prepared = {
    runId: RUN_ID,
    dir,
    snapshotId: SNAPSHOT_ID,
    snapshotDigest: 'a'.repeat(64),
    headerText: 'header',
    headerDigest: 'b'.repeat(64),
    entries: [
      {
        entryId: ENTRY_ID,
        kind: 'observation',
        title: 'source fact',
        revisionId: '01905f7c-0000-7000-8000-000000000971',
        businessRef: null,
        digest: createHash('sha256').update(BODY).digest('hex'),
        byteSize: Buffer.byteLength(BODY, 'utf8'),
        snapshotAuthorizationGeneration: '3',
      },
    ],
  }
  rmSync(dir, { recursive: true, force: true })
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

function state(
  generation: string | null,
  version = 2,
  entryState: 'frozen' | 'retracted' = 'frozen',
): RunContextState {
  const entries = [
    {
      entryId: ENTRY_ID,
      kind: 'observation' as const,
      state: entryState,
      currentAuthorizationGeneration: generation,
      reason: entryState === 'frozen' ? null : 'source_revoked',
    },
  ]
  return {
    runId: RUN_ID,
    snapshotId: SNAPSHOT_ID,
    stateVersion: version,
    stateDigest: createHash('sha256')
      .update(contextStateDigestInput(version, entries))
      .digest('hex'),
    entries,
    generatedAt: new Date().toISOString(),
  }
}

function mkdirs(): void {
  // prepared.dir 需要先存在；写一个目录与条目文件，模拟已下载副本。
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, ENTRY_ID), BODY)
}

describe('PC-05b applyRunContextState generation gate', () => {
  it('rejects a state whose source generation is older than the frozen snapshot', async () => {
    mkdirs()
    const store = new MemoryContextStateStore()
    const result = await applyRunContextState(
      {
        runtimeHomeFor: (runId) => join(root, 'runtime-home', runId),
        store,
        now: () => new Date(),
        log: () => {},
      },
      prepared,
      state('2'),
    )
    expect(result.applied).toBe(false)
    expect(store.get(RUN_ID)).toBeUndefined()
    expect(existsSync(join(dir, ENTRY_ID))).toBe(true)
  })

  it('accepts the frozen generation and newer generations', async () => {
    mkdirs()
    const store = new MemoryContextStateStore()
    const first = await applyRunContextState(
      {
        runtimeHomeFor: (runId) => join(root, 'runtime-home', runId),
        store,
        now: () => new Date(),
        log: () => {},
      },
      prepared,
      state('3'),
    )
    expect(first.applied).toBe(true)
    expect(store.get(RUN_ID)?.stateVersion).toBe(2)

    const second = await applyRunContextState(
      {
        runtimeHomeFor: (runId) => join(root, 'runtime-home', runId),
        store,
        now: () => new Date(),
        log: () => {},
      },
      prepared,
      state('4', 3),
    )
    expect(second.applied).toBe(true)
    expect(store.get(RUN_ID)?.stateVersion).toBe(3)
    expect(existsSync(join(dir, ENTRY_ID))).toBe(true)
  })

  it('applies a revocation frame even when the source generation is gone', async () => {
    mkdirs()
    const store = new MemoryContextStateStore()
    const result = await applyRunContextState(
      {
        runtimeHomeFor: (runId) => join(root, 'runtime-home', runId),
        store,
        now: () => new Date(),
        log: () => {},
      },
      prepared,
      state(null, 2, 'retracted'),
    )
    expect(result.applied).toBe(true)
    expect(result.deleted).toBe(1)
    expect(existsSync(join(dir, ENTRY_ID))).toBe(false)
  })

  it('pauses reused state when its frozen generation regressed before run.start', async () => {
    mkdirs()
    const store = new MemoryContextStateStore()
    store.upsert(state('2'), new Date().toISOString())
    await initializePreparedContextState(
      {
        runtimeHomeFor: (runId) => join(root, 'runtime-home', runId),
        store,
        now: () => new Date(),
        log: () => {},
      },
      prepared,
    )
    expect(store.get(RUN_ID)).toMatchObject({
      paused: true,
      pauseReason: 'generation_regression',
    })
    const file = JSON.parse(readFileSync(join(dir, 'state.json'), 'utf8')) as { paused: boolean }
    expect(file.paused).toBe(true)
  })

  it('rejects an older or same-version-conflicting frame without touching local state', async () => {
    mkdirs()
    const deps = {
      runtimeHomeFor: (runId: string) => join(root, 'runtime-home', runId),
      store: new MemoryContextStateStore(),
      now: () => new Date(),
      log: () => {},
    }
    const applied = await applyRunContextState(deps, prepared, state('3', 2, 'retracted'))
    expect(applied.applied).toBe(true)
    expect(existsSync(join(dir, ENTRY_ID))).toBe(false)

    const older = await applyRunContextState(deps, prepared, state('3', 1, 'frozen'))
    expect(older.applied).toBe(false)
    expect(deps.store.get(RUN_ID)?.stateVersion).toBe(2)
    expect(deps.store.get(RUN_ID)?.entries[0]?.state).toBe('retracted')
  })

  it('fails closed and still deletes sibling revocations when one frozen generation regressed', async () => {
    const secondId = '01905f7c-0000-7000-8000-000000000952'
    const secondBody = '# second source\n'
    const preparedWithSecond: PreparedProjectContext = {
      ...prepared,
      entries: [
        ...prepared.entries,
        {
          entryId: secondId,
          kind: 'observation',
          title: 'second source',
          revisionId: '01905f7c-0000-7000-8000-000000000972',
          businessRef: null,
          digest: createHash('sha256').update(secondBody).digest('hex'),
          byteSize: Buffer.byteLength(secondBody, 'utf8'),
          snapshotAuthorizationGeneration: '3',
        },
      ],
    }
    mkdirs()
    writeFileSync(join(dir, secondId), secondBody)
    const store = new MemoryContextStateStore()
    const entries = [
      {
        entryId: ENTRY_ID,
        kind: 'observation' as const,
        state: 'frozen' as const,
        currentAuthorizationGeneration: '2',
        reason: null,
      },
      {
        entryId: secondId,
        kind: 'observation' as const,
        state: 'retracted' as const,
        currentAuthorizationGeneration: null,
        reason: 'entry_corrected',
      },
    ]
    const regressedAndRevoked = {
      runId: RUN_ID,
      snapshotId: SNAPSHOT_ID,
      stateVersion: 2,
      stateDigest: createHash('sha256').update(contextStateDigestInput(2, entries)).digest('hex'),
      entries,
      generatedAt: new Date().toISOString(),
    }
    const result = await applyRunContextState(
      {
        runtimeHomeFor: (runId) => join(root, 'runtime-home', runId),
        store,
        now: () => new Date(),
        log: () => {},
      },
      preparedWithSecond,
      regressedAndRevoked,
    )
    expect(result.applied).toBe(false)
    expect(result.deleted).toBe(1)
    expect(existsSync(join(dir, ENTRY_ID))).toBe(true)
    expect(existsSync(join(dir, secondId))).toBe(false)
    expect(store.get(RUN_ID)).toBeUndefined()
  })
})
