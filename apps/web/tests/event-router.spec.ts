/**
 * P1-08 event-router 单元验收（node 环境、纯逻辑；02 Task 8 Step 5）。
 *
 * - persistent → invalidate 映射缓存键；cursor 只在 parse+handler 成功后提交；
 * - live → 交给注入的 live sink，不碰 cursor；
 * - control（resync.required）→ 触发快照重拉回调；
 * - 未知事件类型 fail-closed：不改 UI，立即触发快照重拉。
 */
import { describe, expect, it, vi } from 'vitest'
import { applyClientFrame, keysForPersistentEvent } from '../src/shared/realtime/event-router.js'
import type { ApplyFrameDeps, QueryClientLike } from '../src/shared/realtime/event-router.js'
import { CursorStore } from '../src/shared/realtime/cursor-store.js'
import { controlFrame, liveFrame, persistentFrame } from './frames.js'

function fakeQueryClient(): QueryClientLike & { calls: Array<{ queryKey: readonly unknown[] }> } {
  const calls: Array<{ queryKey: readonly unknown[] }> = []
  return {
    calls,
    invalidateQueries: vi.fn(async (opts: { queryKey: readonly unknown[] }) => {
      calls.push(opts)
    }),
  }
}

function makeDeps(overrides: Partial<ApplyFrameDeps> = {}): {
  deps: ApplyFrameDeps
  cursorStore: CursorStore
  resync: ReturnType<typeof vi.fn>
  onLive: ReturnType<typeof vi.fn>
} {
  const cursorStore = new CursorStore()
  const resync = vi.fn()
  const onLive = vi.fn()
  return {
    cursorStore,
    resync,
    onLive,
    deps: { cursorStore, resync, onLive, ...overrides },
  }
}

describe('applyClientFrame (event-router)', () => {
  it('invalidates the mapped cache key and commits the cursor only after success', async () => {
    const queryClient = fakeQueryClient()
    const { cursorStore, deps } = makeDeps()
    // 首个失效调用被挂住，后续调用立即完成——用于证明「cursor 只在 handler 全部
    // 完成后才推进」（task.changed 现在命中两个键，见 #137 实时接线）。
    let release!: () => void
    let released = false
    queryClient.invalidateQueries = vi.fn(async (opts: { queryKey: readonly unknown[] }) => {
      if (!released) {
        await new Promise<void>((resolve) => {
          release = () => {
            released = true
            resolve()
          }
        })
      }
      queryClient.calls.push(opts)
    })
    const pending = applyClientFrame(
      queryClient,
      persistentFrame('task.changed', { taskId: 't-1' }, '42'),
      deps,
    )
    expect(queryClient.calls).toHaveLength(0) // handler 未完成：尚未提交
    release()
    await pending
    // task.changed 命中两个键：任务房间 + 项目任务列表（payload 无 projectId 时
    // 后者降级为前缀键 ['project-tasks']）——见 #137 的实时接线。
    expect(queryClient.calls).toEqual([
      { queryKey: ['task-room', 't-1'] },
      // 切片⑥e 新增：task.changed 也要失效权限页（服务端授权/撤销发的就是它）。
      { queryKey: ['instruction-grants', 't-1'] },
      { queryKey: ['project-tasks'] },
    ])
    expect(cursorStore.load()).toBe('42')
  })

  it('does not commit the cursor when the handler fails', async () => {
    const queryClient = fakeQueryClient()
    queryClient.invalidateQueries = vi.fn(() => Promise.reject(new Error('cache down')))
    const { cursorStore, resync, deps } = makeDeps()
    await expect(
      applyClientFrame(queryClient, persistentFrame('task.changed', { taskId: 't-1' }, '42'), deps),
    ).rejects.toThrow('cache down')
    expect(cursorStore.load()).toBe('0') // 未推进
    expect(resync).not.toHaveBeenCalled()
  })

  it('maps every registered persistent event type to its cache key', () => {
    // 键字面量必须与 app/query-client.ts 的 queryKeys 一致：
    // Task Room 是 queryKeys.taskRoom = ['task-room', id]（#140 前这里错写成
    // ['task', id]，前缀不匹配 → 远程变化刷不进任务房间，且本测试把 bug 钉成了期望）。
    const keys: Array<[string, unknown, readonly (readonly unknown[])[]]> = [
      ['project.changed', {}, [['projects']]],
      [
        'task.changed',
        { taskId: 't-1', projectId: 'p-1' },
        [
          ['task-room', 't-1'],
          // 切片⑥e：权限页的键也必须被 task.changed 失效——服务端授权/撤销发的就是
          // task.changed，漏了它，责任人撤销时对方的权限页永远不更新（而服务端已 403）。
          ['instruction-grants', 't-1'],
          ['project-tasks', 'p-1'],
        ],
      ],
      ['comment.created', { taskId: 't-1' }, [['task-room', 't-1']]],
      ['run.changed', { runId: 'r-1' }, [['run', 'r-1']]],
      ['run.event', { runId: 'r-1' }, [['run', 'r-1']]],
      ['approval.changed', { taskId: 't-1' }, [['task-room', 't-1']]],
      ['artifact.changed', { taskId: 't-1' }, [['task-room', 't-1']]],
      ['device.changed', {}, [['devices']]],
    ]
    for (const [type, payload, expected] of keys) {
      expect(keysForPersistentEvent(persistentFrame(type, payload).event)).toEqual(expected)
    }
  })

  it('falls back to the queryKeys prefix when the payload lacks the entity id', () => {
    // 降级键必须是真前缀：['task-room'] 覆盖 ['task-room', id]；
    // ['run'] 覆盖 ['run', id] 与 ['run', id, 'events']。
    expect(keysForPersistentEvent(persistentFrame('task.changed', {}).event)).toEqual([
      ['task-room'],
      ['instruction-grants'],
      ['project-tasks'],
    ])
    expect(keysForPersistentEvent(persistentFrame('run.changed', {}).event)).toEqual([['run']])
  })

  it('forwards live frames to the live sink without touching the cursor', async () => {
    const queryClient = fakeQueryClient()
    const { cursorStore, onLive, deps } = makeDeps()
    await applyClientFrame(queryClient, liveFrame('r-9', 'streaming…'), deps)
    expect(onLive).toHaveBeenCalledWith('r-9', expect.any(Number), 'streaming…')
    expect(cursorStore.load()).toBe('0')
    expect(queryClient.calls).toHaveLength(0)
  })

  it('triggers resync on control frames without committing the cursor', async () => {
    const queryClient = fakeQueryClient()
    const { cursorStore, resync, deps } = makeDeps()
    await applyClientFrame(queryClient, controlFrame('88'), deps)
    expect(resync).toHaveBeenCalledWith('88')
    expect(cursorStore.load()).toBe('0')
    expect(queryClient.calls).toHaveLength(0)
  })

  it('ignores unknown event types fail-closed: no UI change, immediate snapshot resync', async () => {
    const queryClient = fakeQueryClient()
    const { cursorStore, resync, deps } = makeDeps()
    const unknown = persistentFrame('everything.changed', {}, '55')
    await applyClientFrame(queryClient, unknown, deps)
    expect(resync).toHaveBeenCalledWith('55')
    expect(queryClient.calls).toHaveLength(0) // 未改 UI
    expect(cursorStore.load()).toBe('0') // 未推进 cursor
  })
})
