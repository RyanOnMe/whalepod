/**
 * ADR-0027 §6（PC-05b-3）：终态清理队列的 Node SQLite 持久化语义。
 *
 * 判定基线：
 * - Run home 事实（homePath/entryCount）随 run.start 落盘，进程重启后仍可取；
 * - 终态任务只登记一次，重复终态帧不重置状态/到期时间/尝试次数；
 * - `due` 只发到期任务，`notDone` 供启动清扫忽略 due_at；
 * - deferred/cleanup_pending/done 的迁移与 attempts 计数在重启后保持。
 */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  MemoryRunTerminalCleanupStore,
  SqliteRunTerminalCleanupStore,
} from '../src/run/terminal-cleanup.js'

let root: string
let dbPath: string

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'wp-terminal-cleanup-'))
  dbPath = join(root, 'terminal-cleanup.sqlite')
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

function task(runId: string, dueAt = '2026-11-03T10:00:00.000Z') {
  return {
    runId,
    homePath: `/state/runtime-home/${runId}`,
    entryCount: 0,
    ownsHome: true,
    sessionReady: true,
    runTerminalAt: '2026-11-03T09:00:00.000Z',
    dueAt,
  }
}

describe('SqliteRunTerminalCleanupStore', () => {
  it('Run home 事实跨进程可取，重复终态帧不重置已登记任务', () => {
    const first = new SqliteRunTerminalCleanupStore(dbPath)
    first.putFacts(
      {
        runId: 'run-1',
        homePath: '/state/runtime-home/run-1',
        entryCount: 3,
        ownsHome: true,
        sessionReady: false,
        dshSessionId: null,
      },
      '2026-11-03T09:00:00.000Z',
    )
    first.schedule(task('run-1'))
    first.markSessionReady('run-1', 'session-run-1', '2026-11-03T09:30:00.000Z')

    const second = new SqliteRunTerminalCleanupStore(dbPath)
    expect(second.getFacts('run-1')).toEqual({
      runId: 'run-1',
      homePath: '/state/runtime-home/run-1',
      entryCount: 3,
      ownsHome: true,
      sessionReady: true,
      dshSessionId: 'session-run-1',
    })
    expect(second.get('run-1')).toMatchObject({
      state: 'pending',
      entryCount: 0,
      attempts: 0,
      lastError: null,
    })

    // 重复终态帧（不同到期时间/条目数）不得覆盖第一次登记。
    second.schedule({ ...task('run-1', '2026-11-04T10:00:00.000Z'), entryCount: 9 })
    expect(second.get('run-1')).toMatchObject({
      state: 'pending',
      entryCount: 0,
      dueAt: '2026-11-03T10:00:00.000Z',
    })
  })

  it('reopen 只删除 done 行，pending/deferred 任务保持原状', () => {
    for (const store of [
      new SqliteRunTerminalCleanupStore(dbPath),
      new MemoryRunTerminalCleanupStore(),
    ]) {
      store.schedule(task('run-done'))
      store.markDone('run-done', '2026-11-03T10:00:00.000Z')
      store.schedule(task('run-pending'))
      store.reopen('run-done')
      store.reopen('run-pending')
      expect(store.get('run-done')).toBeUndefined()
      expect(store.get('run-pending')?.state).toBe('pending')
    }
  })

  it('markSessionReady 同步更新已存在的清理任务（ready 晚于任务登记）', () => {
    const store = new SqliteRunTerminalCleanupStore(dbPath)
    store.schedule({ ...task('run-3'), sessionReady: false })
    expect(store.get('run-3')?.sessionReady).toBe(false)
    store.markSessionReady('run-3', 'session-run-3', '2026-11-03T10:00:00.000Z')
    expect(store.get('run-3')?.sessionReady).toBe(true)
    expect(store.getFacts('run-3')).toBeUndefined() // facts 不存在：不凭空造事实
  })

  it('重复 putFacts 不降级已 ready 的 session 事实（崩溃后重处理未 ack 命令）', () => {
    for (const store of [
      new SqliteRunTerminalCleanupStore(dbPath),
      new MemoryRunTerminalCleanupStore(),
    ]) {
      store.putFacts(
        {
          runId: 'run-ready',
          homePath: '/state/runtime-home/source',
          entryCount: 1,
          ownsHome: false,
          sessionReady: true,
          dshSessionId: 'session-ready',
        },
        '2026-11-03T09:00:00.000Z',
      )
      store.putFacts(
        {
          runId: 'run-ready',
          homePath: '/state/runtime-home/source',
          entryCount: 1,
          ownsHome: false,
          sessionReady: false,
          dshSessionId: null,
        },
        '2026-11-03T09:01:00.000Z',
      )
      expect(store.getFacts('run-ready')).toMatchObject({
        sessionReady: true,
        dshSessionId: 'session-ready',
      })
    }
  })

  it('factsNotScheduled 只返回有 facts 但没有清理任务的 Run', () => {
    const store = new SqliteRunTerminalCleanupStore(dbPath)
    store.putFacts(
      {
        runId: 'run-a',
        homePath: '/state/runtime-home/run-a',
        entryCount: 2,
        ownsHome: true,
        sessionReady: false,
        dshSessionId: null,
      },
      '2026-11-03T09:00:00.000Z',
    )
    store.putFacts(
      {
        runId: 'run-b',
        homePath: '/state/runtime-home/run-b',
        entryCount: 0,
        ownsHome: false,
        sessionReady: true,
        dshSessionId: 'session-run-b',
      },
      '2026-11-03T09:00:00.000Z',
    )
    store.putFacts(
      {
        runId: 'run-c',
        homePath: '/state/runtime-home/run-c',
        entryCount: 0,
        ownsHome: true,
        sessionReady: false,
        dshSessionId: null,
      },
      '2026-11-03T09:00:00.000Z',
    )
    store.schedule(task('run-b'))
    store.schedule(task('run-c'))
    store.markDone('run-c', '2026-11-03T10:00:00.000Z')

    expect(store.factsNotScheduled().map((facts) => facts.runId)).toEqual(['run-a'])
  })

  it('due 只发到期未完成任务；notDone 供启动清扫忽略 due_at', () => {
    const store = new SqliteRunTerminalCleanupStore(dbPath)
    store.schedule(task('due-now', '2026-11-03T09:59:00.000Z'))
    store.schedule(task('future', '2026-11-03T11:00:00.000Z'))

    expect(store.due(new Date('2026-11-03T10:00:00.000Z')).map((item) => item.runId)).toEqual([
      'due-now',
    ])
    expect(store.notDone().map((item) => item.runId)).toEqual(['due-now', 'future'])
  })

  it('deferred/cleanup_pending/done 跨重启保持，cleanup_pending 累计 attempts', () => {
    const first = new SqliteRunTerminalCleanupStore(dbPath)
    first.schedule(task('run-1'))
    first.schedule(task('run-2'))
    first.markDeferred('run-1', '2026-11-03T11:00:00.000Z', '2026-11-03T10:00:00.000Z')
    first.markFailure('run-2', 'ENOTEMPTY', '2026-11-03T11:00:00.000Z', '2026-11-03T10:00:00.000Z')

    const second = new SqliteRunTerminalCleanupStore(dbPath)
    expect(second.get('run-1')).toMatchObject({
      state: 'deferred',
      dueAt: '2026-11-03T11:00:00.000Z',
      attempts: 0,
    })
    expect(second.get('run-2')).toMatchObject({
      state: 'cleanup_pending',
      lastError: 'ENOTEMPTY',
      attempts: 1,
    })

    second.markFailure('run-2', 'EACCES', '2026-11-03T12:00:00.000Z', '2026-11-03T10:30:00.000Z')
    second.markDone('run-1', '2026-11-03T10:30:00.000Z')
    const third = new SqliteRunTerminalCleanupStore(dbPath)
    expect(third.get('run-2')).toMatchObject({ state: 'cleanup_pending', attempts: 2 })
    expect(third.get('run-1')).toMatchObject({ state: 'done', lastError: null })
    expect(third.notDone().map((item) => item.runId)).toEqual(['run-2'])
    // done 任务不会再被 due/失败迁移拉回队列。
    third.markFailure('run-1', 'late', '2026-11-03T13:00:00.000Z', '2026-11-03T10:31:00.000Z')
    expect(third.get('run-1')?.state).toBe('done')
  })
})
