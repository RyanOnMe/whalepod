/**
 * ADR-0027 §6（PC-05b）：Node 上下文状态与清理重试队列的持久语义。
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { RunContextState } from '@whalepod/protocol'
import { MemoryContextStateStore, SqliteContextStateStore } from '../src/context/state-store.js'

const RUN_ID = '01905f7c-0000-7000-8000-000000000301'
const SNAPSHOT_ID = '01905f7c-0000-7000-8000-000000000961'
const ENTRY_ID = '01905f7c-0000-7000-8000-000000000951'
const DIGEST = 'a'.repeat(64)

function state(version: number, entryState: 'frozen' | 'retracted' = 'frozen'): RunContextState {
  return {
    runId: RUN_ID,
    snapshotId: SNAPSHOT_ID,
    stateVersion: version,
    stateDigest: DIGEST,
    entries: [
      {
        entryId: ENTRY_ID,
        kind: 'observation',
        state: entryState,
        currentAuthorizationGeneration: null,
        reason: entryState === 'frozen' ? null : 'entry_corrected',
      },
    ],
    generatedAt: new Date().toISOString(),
  }
}

describe('context state stores', () => {
  let root: string
  let path: string

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'wp-context-state-'))
    path = join(root, 'state.sqlite')
  })

  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

  it('persists state, delivered/read sets across reopen and refuses older versions', () => {
    const first = new SqliteContextStateStore(path)
    first.upsert(state(2), '2026-11-03T00:00:00.000Z')
    first.markDelivered(RUN_ID, SNAPSHOT_ID, [ENTRY_ID])
    first.markRead(RUN_ID, SNAPSHOT_ID, ENTRY_ID)
    first.setPaused(RUN_ID, true, 'generation_regression')
    first.upsert(state(1), '2026-11-03T00:00:01.000Z')
    first.close()

    const second = new SqliteContextStateStore(path)
    const stored = second.get(RUN_ID)
    expect(stored).toMatchObject({
      stateVersion: 2,
      stateDigest: DIGEST,
      delivered: [ENTRY_ID],
      read: [ENTRY_ID],
      paused: true,
      pauseReason: 'generation_regression',
    })
    expect(stored?.entries[0]?.state).toBe('frozen')
    second.markRead(RUN_ID, SNAPSHOT_ID, ENTRY_ID)
    expect(second.get(RUN_ID)?.read).toEqual([ENTRY_ID])
  })

  it('keeps a due-only cleanup queue and records retry backoff', () => {
    const store = new SqliteContextStateStore(path)
    const now = new Date('2026-11-03T00:00:00.000Z')
    store.enqueueCleanup(RUN_ID, ENTRY_ID, '2026-11-03T00:30:00.000Z', 'busy')
    expect(store.dueCleanup(now)).toEqual([])
    expect(store.dueCleanup(new Date('2026-11-03T01:00:00.000Z'))).toHaveLength(1)
    store.recordCleanupFailure(RUN_ID, ENTRY_ID, '2026-11-03T02:00:00.000Z', 'still busy')
    expect(store.dueCleanup(new Date('2026-11-03T01:30:00.000Z'))).toEqual([])
    expect(store.dueCleanup(new Date('2026-11-03T02:30:00.000Z'))[0]?.attempts).toBe(1)
    store.clearCleanup(RUN_ID, ENTRY_ID)
    expect(store.pendingCleanupCount(RUN_ID)).toBe(0)
  })

  it('memory store mirrors the persistence contract', () => {
    const store = new MemoryContextStateStore()
    store.upsert(state(2), '2026-11-03T00:00:00.000Z')
    store.upsert(state(1), '2026-11-03T00:00:01.000Z')
    expect(store.get(RUN_ID)?.stateVersion).toBe(2)
    store.markRead(RUN_ID, SNAPSHOT_ID, ENTRY_ID)
    expect(store.get(RUN_ID)?.read).toEqual([ENTRY_ID])
  })

  it('rejects same-version different-digest frames and reports whether stored', () => {
    for (const store of [new SqliteContextStateStore(path), new MemoryContextStateStore()]) {
      expect(store.upsert(state(2), '2026-11-03T00:00:00.000Z')).toBe(true)
      expect(
        store.upsert({ ...state(2), stateDigest: 'b'.repeat(64) }, '2026-11-03T00:00:01.000Z'),
      ).toBe(false)
      expect(store.get(RUN_ID)?.stateDigest).toBe(DIGEST)
      expect(store.upsert(state(3), '2026-11-03T00:00:02.000Z')).toBe(true)
      expect(store.get(RUN_ID)?.stateVersion).toBe(3)
    }
  })

  it('resets delivered/read and paused when a new snapshot is initialized', () => {
    for (const store of [new SqliteContextStateStore(path), new MemoryContextStateStore()]) {
      store.upsert(state(2), '2026-11-03T00:00:00.000Z')
      store.markDelivered(RUN_ID, SNAPSHOT_ID, [ENTRY_ID])
      store.markRead(RUN_ID, SNAPSHOT_ID, ENTRY_ID)
      store.setPaused(RUN_ID, true)
      store.putInitial(
        RUN_ID,
        '01905f7c-0000-7000-8000-000000000962',
        state(2).entries,
        DIGEST,
        '2026-11-03T00:00:01.000Z',
      )
      expect(store.get(RUN_ID)).toMatchObject({
        snapshotId: '01905f7c-0000-7000-8000-000000000962',
        stateVersion: 0,
        paused: false,
        delivered: [],
        read: [],
      })
    }
  })
})
