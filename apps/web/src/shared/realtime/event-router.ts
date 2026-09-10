/**
 * P1-08 Browser 帧路由（02 Task 8 Step 5）。
 *
 * 纯逻辑、零依赖：queryClient 用最小结构类型（结构兼容 TanStack Query，不引依赖）。
 * - persistent → 按事件类型 invalidate 缓存键 + cursor 只在 handler 成功后提交；
 * - live → 交给注入的 live sink（P1-13 ownerRunBuffer 接线点）；
 * - control(resync.required) → 触发注入的快照重拉回调；
 * - 未登记事件类型 fail-closed：不改任何状态，立即触发快照重拉回调（03 §11）。
 *
 * 缓存键契约（**必须与 app/query-client.ts 的 queryKeys 逐个对齐**；#140 之前这里
 * 把任务级事件失效到 ['task', id]，而 Task Room 的真实查询键是 queryKeys.taskRoom
 * = ['task-room', id]——前缀不匹配 = 命中零个查询，远程变化永远刷不进任务房间，
 * 而既有 E2E 靠 reload 驱动，全门绿也照不出来）：
 *   project.changed      → ['projects']
 *   task.changed         → ['task-room', taskId]    （取不到 taskId 时降级 ['task-room'] 前缀）
 *   comment.created      → ['task-room', taskId]    （评论时间线挂在 task room）
 *   run.changed/run.event→ ['run', runId]           （降级 ['run'] 前缀，同时覆盖 runEvents）
 *   approval.changed     → ['task-room', taskId]    （审批卡在 task room）
 *   artifact.changed     → ['task-room', taskId]    （产物列表在 task room）
 *   device.changed       → ['devices']
 * 一个事件可以命中多个查询（返回数组），例如将来 task.changed 还要带上项目任务列表。
 */
import type { ClientFrame, ClientPersistentEvent } from '@whalepod/protocol'

/** 结构最小化：只依赖 invalidateQueries（TanStack Query 的 QueryClient 天然满足）。 */
export interface QueryClientLike {
  invalidateQueries(opts: { queryKey: readonly unknown[] }): Promise<void>
}

export interface ApplyFrameDeps {
  readonly cursorStore: { commit(cursor: string): void }
  /** control / 未知事件 → 上层全量快照重拉。 */
  readonly resync: (latestCursor?: string) => void
  /** live delta 去向：P1-13 ownerRunBuffer 接线点（deltaSeq 供有序性观测）。 */
  readonly onLive?: (runId: string, deltaSeq: number, deltaText: string) => void
}

function payloadString(payload: unknown, key: string): string | undefined {
  if (typeof payload !== 'object' || payload === null) return undefined
  const value = (payload as Record<string, unknown>)[key]
  return typeof value === 'string' ? value : undefined
}

/** 一次事件要失效的缓存键集合（可多个）。 */
type CacheKeys = readonly (readonly unknown[])[]

/**
 * 能取到实体 id 就失效精确键，否则降级到该前缀键（前缀失效覆盖同族全部查询，不猜形状）。
 * 前缀必须与 queryKeys 的字面量一致：['task-room'] 覆盖 ['task-room', id]；
 * ['run'] 覆盖 ['run', id] 与 ['run', id, 'events']。
 */
function keysWith(payload: unknown, idKey: string, prefix: string): CacheKeys {
  const id = payloadString(payload, idKey)
  return id !== undefined ? [[prefix, id]] : [[prefix]]
}

const EVENT_KEY_BUILDERS: Readonly<Record<string, (payload: unknown) => CacheKeys>> = {
  'project.changed': () => [['projects']],
  'task.changed': (payload) => keysWith(payload, 'taskId', 'task-room'),
  'comment.created': (payload) => keysWith(payload, 'taskId', 'task-room'),
  'run.changed': (payload) => keysWith(payload, 'runId', 'run'),
  'run.event': (payload) => keysWith(payload, 'runId', 'run'),
  'approval.changed': (payload) => keysWith(payload, 'taskId', 'task-room'),
  'artifact.changed': (payload) => keysWith(payload, 'taskId', 'task-room'),
  'device.changed': () => [['devices']],
}

export async function applyClientFrame(
  queryClient: QueryClientLike,
  envelope: ClientFrame,
  deps: ApplyFrameDeps,
): Promise<void> {
  if (envelope.kind === 'persistent') {
    const build = EVENT_KEY_BUILDERS[envelope.event.type]
    if (build === undefined) {
      // 未登记事件类型：fail-closed，不改 UI，立即重拉快照（03 §11）。
      deps.resync(envelope.cursor)
      return
    }
    for (const queryKey of build(envelope.event.payload)) {
      await queryClient.invalidateQueries({ queryKey })
    }
    deps.cursorStore.commit(envelope.cursor) // parse + handler 成功后才推进
    return
  }
  if (envelope.kind === 'live') {
    deps.onLive?.(envelope.runId, envelope.deltaSeq, envelope.delta.text)
    return
  }
  // control: resync.required → 上层全量快照重拉（服务端随后 close 4009）。
  deps.resync(envelope.latestCursor)
}

/** 供映射表测试/接线方断言用：事件类型 → 缓存键集合（payload 齐备时）。 */
export function keysForPersistentEvent(event: ClientPersistentEvent): CacheKeys | undefined {
  return EVENT_KEY_BUILDERS[event.type]?.(event.payload)
}
