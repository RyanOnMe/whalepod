/**
 * ADR-0027 §6（PC-05b）：删除重试队列必须复核当前状态与已读集合，不能在条目
 * 恢复或已读后继续删除，也不能把仍有待清理项的 Run 误报为已恢复。
 */
import { createHash } from 'node:crypto'
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { contextStateDigestInput, type RunContextState } from '@whalepod/protocol'
import type { PreparedProjectContext } from '../src/context/project-context.js'
import { applyContextStateSync, drainContextCleanupQueue } from '../src/context/state.js'
import { MemoryContextStateStore } from '../src/context/state-store.js'

const RUN_ID = '01905f7c-0000-7000-8000-000000000301'
const SNAPSHOT_ID = '01905f7c-0000-7000-8000-000000000961'
const ENTRY_ID = '01905f7c-0000-7000-8000-000000000951'
const BODY = '# source fact\n'
const NOW = new Date('2026-11-03T00:00:00.000Z')

let root: string
let dir: string
let prepared: PreparedProjectContext

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'wp-context-cleanup-'))
  dir = join(root, 'runtime-context')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, ENTRY_ID), BODY)
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
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

function state(entryState: 'frozen' | 'retracted'): RunContextState {
  const entries = [
    {
      entryId: ENTRY_ID,
      kind: 'observation' as const,
      state: entryState,
      currentAuthorizationGeneration: entryState === 'frozen' ? '3' : null,
      reason: entryState === 'frozen' ? null : 'entry_corrected',
    },
  ]
  return {
    runId: RUN_ID,
    snapshotId: SNAPSHOT_ID,
    stateVersion: 1,
    stateDigest: createHash('sha256').update(contextStateDigestInput(1, entries)).digest('hex'),
    entries,
    generatedAt: NOW.toISOString(),
  }
}

function deps(store: MemoryContextStateStore) {
  return {
    runtimeHomeFor: (runId: string) => join(root, 'runtime-home', runId),
    store,
    now: () => NOW,
    log: () => {},
  }
}

describe('PC-05b cleanup retry queue', () => {
  it('deletes a still-revoked unread copy, clears the task and resumes the run', async () => {
    const store = new MemoryContextStateStore()
    store.upsert(state('retracted'), NOW.toISOString())
    store.setPaused(RUN_ID, true)
    store.enqueueCleanup(RUN_ID, ENTRY_ID, new Date(NOW.getTime() - 1000).toISOString(), 'busy')
    const result = await drainContextCleanupQueue(deps(store), () => prepared)
    expect(result).toMatchObject({ retried: 1, failed: 0, resumedRuns: [RUN_ID] })
    expect(existsSync(join(dir, ENTRY_ID))).toBe(false)
    expect(store.pendingCleanupCount(RUN_ID)).toBe(0)
    expect(store.get(RUN_ID)?.paused).toBe(false)
  })

  it('does not delete a restored frozen copy and clears the stale task', async () => {
    const store = new MemoryContextStateStore()
    store.upsert(state('frozen'), NOW.toISOString())
    store.setPaused(RUN_ID, true)
    store.enqueueCleanup(RUN_ID, ENTRY_ID, new Date(NOW.getTime() - 1000).toISOString(), 'busy')
    const result = await drainContextCleanupQueue(deps(store), () => prepared)
    expect(result).toMatchObject({ retried: 0, failed: 0, resumedRuns: [RUN_ID] })
    expect(existsSync(join(dir, ENTRY_ID))).toBe(true)
    expect(store.pendingCleanupCount(RUN_ID)).toBe(0)
  })

  it('does not delete a copy that was read after the task was queued', async () => {
    const store = new MemoryContextStateStore()
    store.upsert(state('retracted'), NOW.toISOString())
    store.markRead(RUN_ID, SNAPSHOT_ID, ENTRY_ID)
    store.setPaused(RUN_ID, true)
    store.enqueueCleanup(RUN_ID, ENTRY_ID, new Date(NOW.getTime() - 1000).toISOString(), 'busy')
    const result = await drainContextCleanupQueue(deps(store), () => prepared)
    expect(result).toMatchObject({ retried: 0, failed: 0, resumedRuns: [RUN_ID] })
    expect(existsSync(join(dir, ENTRY_ID))).toBe(true)
  })

  it('keeps the task and paused state when the Run has no prepared copy yet', async () => {
    const store = new MemoryContextStateStore()
    store.upsert(state('retracted'), NOW.toISOString())
    store.setPaused(RUN_ID, true)
    store.enqueueCleanup(RUN_ID, ENTRY_ID, new Date(NOW.getTime() - 1000).toISOString(), 'busy')
    const result = await drainContextCleanupQueue(deps(store), () => undefined)
    expect(result.resumedRuns).toEqual([])
    expect(store.pendingCleanupCount(RUN_ID)).toBe(1)
    expect(store.get(RUN_ID)?.paused).toBe(true)
  })

  it('does not clear a generation-regression pause when the cleanup queue is empty', async () => {
    const store = new MemoryContextStateStore()
    store.upsert(state('frozen'), NOW.toISOString())
    store.setPaused(RUN_ID, true, 'generation_regression')
    store.enqueueCleanup(RUN_ID, ENTRY_ID, new Date(NOW.getTime() - 1000).toISOString(), 'busy')
    const result = await drainContextCleanupQueue(deps(store), () => prepared, RUN_ID)
    expect(result).toMatchObject({ retried: 0, failed: 0, resumedRuns: [] })
    expect(existsSync(join(dir, ENTRY_ID))).toBe(true)
    expect(store.get(RUN_ID)).toMatchObject({
      paused: true,
      pauseReason: 'generation_regression',
    })
  })

  it('keeps a generation-regression pause through failed and successful cleanup retries', async () => {
    const store = new MemoryContextStateStore()
    store.upsert(state('retracted'), NOW.toISOString())
    store.setPaused(RUN_ID, true, 'generation_regression')
    // 删除与隔离都失败：unlink 目标是目录，quarantine 目标被普通文件占住。
    rmSync(join(dir, ENTRY_ID))
    mkdirSync(join(dir, ENTRY_ID))
    mkdirSync(join(root, 'runtime-home', RUN_ID), { recursive: true })
    writeFileSync(join(root, 'runtime-home', RUN_ID, 'quarantine'), 'blocked')
    store.enqueueCleanup(RUN_ID, ENTRY_ID, new Date(NOW.getTime() - 1000).toISOString(), 'busy')
    const failed = await drainContextCleanupQueue(deps(store), () => prepared, RUN_ID)
    expect(failed.failed).toBe(1)
    expect(store.get(RUN_ID)).toMatchObject({
      paused: true,
      pauseReason: 'generation_regression',
    })

    // 重试成功清除 pending 后，代次倒退仍必须保持 paused。
    rmSync(join(dir, ENTRY_ID), { recursive: true })
    writeFileSync(join(dir, ENTRY_ID), BODY)
    rmSync(join(root, 'runtime-home', RUN_ID, 'quarantine'))
    store.enqueueCleanup(RUN_ID, ENTRY_ID, new Date(NOW.getTime() - 1000).toISOString(), 'retry')
    const recovered = await drainContextCleanupQueue(deps(store), () => prepared, RUN_ID)
    expect(recovered).toMatchObject({ retried: 1, failed: 0, resumedRuns: [] })
    expect(store.get(RUN_ID)).toMatchObject({
      paused: true,
      pauseReason: 'generation_regression',
    })
    expect(existsSync(join(dir, ENTRY_ID))).toBe(false)
  })

  it('never overwrites a newer state file with an older stored version', async () => {
    const store = new MemoryContextStateStore()
    const older = state('frozen')
    store.upsert(older, NOW.toISOString())
    const newer = { ...older, stateVersion: 3, stateDigest: 'c'.repeat(64) }
    writeFileSync(
      join(dir, 'state.json'),
      JSON.stringify({
        runId: newer.runId,
        snapshotId: newer.snapshotId,
        stateVersion: newer.stateVersion,
        stateDigest: newer.stateDigest,
        entries: newer.entries,
        syncedAt: NOW.toISOString(),
        paused: true,
      }),
    )
    const result = await applyContextStateSync(deps(store), prepared, {
      runId: RUN_ID,
      snapshotId: SNAPSHOT_ID,
      stateVersion: 1,
      stateDigest: older.stateDigest,
      at: NOW.toISOString(),
    })
    expect(result.pull).toBe(false)
    const file = JSON.parse(readFileSync(join(dir, 'state.json'), 'utf8')) as {
      stateVersion: number
      stateDigest: string
    }
    expect(file).toMatchObject({ stateVersion: 3, stateDigest: 'c'.repeat(64) })
  })
})
