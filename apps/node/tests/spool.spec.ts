/**
 * Command/Event spool 单测（P1-12；02 Task 12 Step 4/7）。
 *
 * 判定基线：
 * - Node 在 ack run.start 前先把 command 落本地 SQLite（崩溃恢复：重开后 pending 仍在）；
 * - runtime 事件按 (runId, seq) 先落 spool 再发 Hub，Hub ack 后删除；
 * - 重复 command / 重复 (runId, seq) 幂等（重复投递确定性结果）；
 * - 数据库 WAL + synchronous=FULL（掉电不丢已确认状态）。
 */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { CommandStore } from '../src/spool/command-store.js'
import { EventStore } from '../src/spool/event-store.js'
import { openStateDatabase } from '../src/state/db.js'

let root: string

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'p311-spool-'))
})

afterAll(async () => {
  await rm(root, { recursive: true, force: true })
})

describe('CommandStore', () => {
  it('record 后 pending 可见；重复 commandId 幂等；markAcked 后不再 pending', async () => {
    const store = new CommandStore(join(root, `cmd-${Date.now()}.sqlite`))
    const command = {
      commandId: 'c-1',
      runId: 'r-1',
      type: 'run.start' as const,
      payload: { nonce: 'n-1' },
    }
    expect(store.record(command)).toBe('recorded')
    expect(store.record(command)).toBe('duplicate')
    expect(store.pending().map((c) => c.commandId)).toEqual(['c-1'])

    store.markAcked('c-1')
    expect(store.pending()).toEqual([])
    store.close()
  })

  it('崩溃恢复：进程重开（同一库文件）后未 ack 的 command 仍在', async () => {
    const path = join(root, `cmd-recover-${Date.now()}.sqlite`)
    const first = new CommandStore(path)
    first.record({ commandId: 'c-2', runId: 'r-2', type: 'run.cancel', payload: {} })
    first.close()

    const second = new CommandStore(path)
    expect(second.pending().map((c) => c.commandId)).toEqual(['c-2'])
    second.close()
  })

  it('pending 按 receivedAt/id 稳定排序', async () => {
    const store = new CommandStore(join(root, `cmd-order-${Date.now()}.sqlite`))
    store.record({ commandId: 'c-b', runId: 'r', type: 'run.start', payload: {} })
    store.record({ commandId: 'c-a', runId: 'r', type: 'run.start', payload: {} })
    expect(store.pending().map((c) => c.commandId)).toEqual(['c-b', 'c-a'])
    store.close()
  })
})

describe('EventStore', () => {
  it('append 后 pending 按 seq 升序；重复 (runId, seq) 幂等；ack 删除', async () => {
    const store = new EventStore(join(root, `evt-${Date.now()}.sqlite`))
    store.append('r-1', 2, 'delta-2')
    store.append('r-1', 1, 'delta-1')
    store.append('r-1', 2, 'delta-2-duplicate')

    expect(store.pending('r-1').map((e) => e.seq)).toEqual([1, 2])
    expect(store.pending('r-1').map((e) => e.payload)).toEqual(['delta-1', 'delta-2'])

    store.ack('r-1', 1)
    expect(store.pending('r-1').map((e) => e.seq)).toEqual([2])
    store.ack('r-1', 2)
    expect(store.pending('r-1')).toEqual([])
    store.close()
  })

  it('崩溃恢复：未 ack 的事件重开仍在（Hub 未确认不丢）', async () => {
    const path = join(root, `evt-recover-${Date.now()}.sqlite`)
    const first = new EventStore(path)
    first.append('r-9', 1, 'keep-me')
    first.close()

    const second = new EventStore(path)
    expect(second.pending('r-9').map((e) => e.payload)).toEqual(['keep-me'])
    second.close()
  })

  it('数据库为 WAL + synchronous=FULL', async () => {
    const db = openStateDatabase(join(root, `pragma-${Date.now()}.sqlite`))
    const journal = db.prepare('pragma journal_mode').get() as { journal_mode: string }
    const sync = db.prepare('pragma synchronous').get() as { synchronous: number }
    expect(journal.journal_mode.toLowerCase()).toBe('wal')
    expect(Number(sync.synchronous)).toBe(2) // 2 = FULL
    db.close()
  })
})
