/**
 * P1-13 owner 直播 delta 缓冲（03 §8：run.live_delta 不落库、只到 owner）。
 *
 * 模块级单例：WS 事件路由（event-router 的 onLive）append；React 组件经
 * useSyncExternalStore 订阅。设计约束：
 * - 只进内存：刷新即丢是协议语义（持久事实走 run_event / GET events 补）。
 * - 可丢但有序：deltaSeq 乱序/缺口不补（重连后由 run.completed 的 finalText
 *   兜底完整内容）；每 run 缓冲封顶，超长保留尾部（最新内容优先）。
 * - 不知道也不猜订阅者是不是 owner：非 owner 连接根本收不到 live 帧（Hub 扇出
 *   保证），这里不做二次过滤。
 */
export const RUN_LIVE_BUFFER_MAX_CHARS = 64 * 1024
/**
 * 最多同时留多少个 Run 的缓冲。终态段的"未持久化直播"要在记录里可查，所以不能一进终态就丢；
 * 但也不能随会话里的 Run 数无限占位（每个封顶 64KB）——超出上限时丢**最早**建槽的那个。
 */
export const RUN_LIVE_BUFFER_MAX_SLOTS = 8

interface RunLiveSlot {
  text: string
  /** 已见的最大 deltaSeq（观测用；不做缺口填补）。 */
  lastSeq: number
}

const slots = new Map<string, RunLiveSlot>()
const listeners = new Map<string, Set<() => void>>()

function slotOf(runId: string): RunLiveSlot {
  let slot = slots.get(runId)
  if (slot === undefined) {
    // Map 保持插入序：队首就是最早建槽的那个。
    while (slots.size >= RUN_LIVE_BUFFER_MAX_SLOTS) {
      const oldest = slots.keys().next().value
      if (oldest === undefined) break
      dropRunLive(oldest)
    }
    slot = { text: '', lastSeq: 0 }
    slots.set(runId, slot)
  }
  return slot
}

/** WS onLive 的唯一入口（event-router 接线）。 */
export function appendLiveDelta(runId: string, deltaSeq: number, text: string): void {
  const slot = slotOf(runId)
  slot.lastSeq = Math.max(slot.lastSeq, deltaSeq)
  slot.text =
    slot.text.length + text.length > RUN_LIVE_BUFFER_MAX_CHARS
      ? (slot.text + text).slice(-RUN_LIVE_BUFFER_MAX_CHARS)
      : slot.text + text
  for (const listener of listeners.get(runId) ?? []) listener()
}

/** useSyncExternalStore 的 subscribe：返回取消函数。 */
export function subscribeRunLive(runId: string, listener: () => void): () => void {
  let set = listeners.get(runId)
  if (set === undefined) {
    set = new Set()
    listeners.set(runId, set)
  }
  set.add(listener)
  return () => {
    set.delete(listener)
    if (set.size === 0) listeners.delete(runId)
  }
}

/** useSyncExternalStore 的 getSnapshot（字符串引用不变 = 无变化，渲染稳定）。 */
export function getRunLiveText(runId: string): string {
  return slots.get(runId)?.text ?? ''
}

/** 释放某个 Run 的缓冲（超出槽位上限时的清场入口；终态段的记录仍靠它保到看不着为止）。 */
export function dropRunLive(runId: string): void {
  slots.delete(runId)
}

/** 测试专用：清空全部缓冲与订阅。 */
export function resetRunLiveBuffers(): void {
  slots.clear()
  listeners.clear()
}
