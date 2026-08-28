/**
 * P1-08 Browser 帧路由（02 Task 8 Step 5）。
 *
 * 纯逻辑、零依赖：queryClient 用最小结构类型（结构兼容 TanStack Query，不引依赖）。
 * - persistent → 按事件类型 invalidate 缓存键 + cursor 只在 handler 成功后提交；
 * - live → 交给注入的 live sink（P1-13 ownerRunBuffer 接线点）；
 * - control(resync.required) → 触发注入的快照重拉回调；
 * - 未登记事件类型 fail-closed：不改任何状态，立即触发快照重拉回调（03 §11）。
 *
 * 缓存键契约（与 P1-07 Task Room 查询键的接线约定，PR body 有记录）：
 *   project.changed      → ['projects']
 *   task.changed         → ['task', taskId]          （取不到 taskId 时降级 ['tasks']）
 *   comment.created      → ['task', taskId]          （评论时间线挂在 task room）
 *   run.changed/run.event→ ['run', runId]            （降级 ['runs']）
 *   approval.changed     → ['task', taskId]          （审批卡在 task room）
 *   artifact.changed     → ['task', taskId]          （产物列表在 task room）
 *   device.changed       → ['devices']
 */
import type { ClientFrame, ClientPersistentEvent } from '@project311/protocol'

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

/** 能取到实体 id 就 invalidate 精确键，否则降级到该实体的粗键（不猜形状）。 */
function keyWith(
  payload: unknown,
  idKey: string,
  exactKey: string,
  coarseKey: string,
): readonly unknown[] {
  const id = payloadString(payload, idKey)
  return id !== undefined ? [exactKey, id] : [coarseKey]
}

const EVENT_KEY_BUILDERS: Readonly<Record<string, (payload: unknown) => readonly unknown[]>> = {
  'project.changed': () => ['projects'],
  'task.changed': (payload) => keyWith(payload, 'taskId', 'task', 'tasks'),
  'comment.created': (payload) => keyWith(payload, 'taskId', 'task', 'tasks'),
  'run.changed': (payload) => keyWith(payload, 'runId', 'run', 'runs'),
  'run.event': (payload) => keyWith(payload, 'runId', 'run', 'runs'),
  'approval.changed': (payload) => keyWith(payload, 'taskId', 'task', 'tasks'),
  'artifact.changed': (payload) => keyWith(payload, 'taskId', 'task', 'tasks'),
  'device.changed': () => ['devices'],
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
    await queryClient.invalidateQueries({ queryKey: build(envelope.event.payload) })
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

/** 供映射表测试/接线方断言用：事件类型 → 缓存键（payload 齐备时）。 */
export function keysForPersistentEvent(
  event: ClientPersistentEvent,
): readonly unknown[] | undefined {
  return EVENT_KEY_BUILDERS[event.type]?.(event.payload)
}
