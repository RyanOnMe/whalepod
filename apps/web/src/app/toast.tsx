/**
 * 轻量 toast（#229 批次③；#308 起由 Swipe Toast 适配卡承载）：短暂的成败反馈通道。
 *
 * 此前成功反馈四种写法并存（Plugin 页本地 notice、常驻段落、flash 跨路由、
 * 无提示）。这里给的是**就地短暂反馈**：role=status + aria-live=polite（温和
 * 播报，不抢 alert 通道）、4 秒自动消退、最多 3 条（新的挤掉最旧的）。
 * 跨路由的一次性事实仍走 flash（toast 挂在当前路由树的 body portal 上，
 * 路由切换即卸载）；需要用户阅读并行动的错误仍走 ErrorBanner。
 *
 * store 与 connection-store 同款（模块级 external store，useSyncExternalStore 消费）。
 *
 * #273 两段式消失：`leaving` 先置真（CSS 把退场演完），到点才真的从数组里移除。
 * 「4 秒消退」这个**承诺不变**——退场从 `4s - 退场时长` 开始，4 秒时已经不在屏幕上了；
 * 挤掉最旧的一条同样先退场，不再瞬间摘除（摘得太快会让栈突然塌一下）。
 *
 * #308：**计时器从 store 挪到卡片**。原因不是重构，是「读的时候不该消失」——
 * 盲的 setTimeout 没法暂停；卡片持有真实剩余时间后，悬停/聚焦/页面隐藏/正在拖拽
 * 都会停住计时与 fuse，离开后按剩余时间继续。四条关闭路径（滑动 / Escape /
 * 关闭按钮 / 真实到期）都只调 `markLeaving`，不改变上面的堆叠与退场契约。
 */
import { useSyncExternalStore, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import SwipeToast from '../vendor/react-bits-micro/SwipeToast.js'
import { EXIT_PRESENCE_MS } from '../shared/motion.js'

export interface ToastItem {
  id: number
  message: string
  /** #273：正在退场（还在 DOM 里，CSS 演完才由计时器移除）。 */
  leaving: boolean
}

const MAX_TOASTS = 3
const TOAST_TTL_MS = 4_000
/** 卡片的 fuse 与计时器共用这一个值：可见窗口 = 4 秒全额减去退场占用的那段。 */
const VISIBLE_WINDOW_MS = TOAST_TTL_MS - EXIT_PRESENCE_MS

let toasts: ToastItem[] = []
let nextId = 1
const listeners = new Set<() => void>()

function notify(): void {
  for (const listener of listeners) listener()
}

function removeToast(id: number): void {
  toasts = toasts.filter((item) => item.id !== id)
  notify()
}

/** 标记退场（幂等：已经在退场的再标记一次不会重排计时器）。 */
function markLeaving(id: number): void {
  const target = toasts.find((item) => item.id === id)
  if (target === undefined || target.leaving) return
  toasts = toasts.map((item) => (item.id === id ? { ...item, leaving: true } : item))
  notify()
  setTimeout(() => removeToast(id), EXIT_PRESENCE_MS)
}

export function pushToast(message: string): void {
  const item: ToastItem = { id: nextId, message, leaving: false }
  nextId += 1
  toasts = [...toasts, item]
  notify()
  // 超容：挤掉**仍在场**的最旧一条（已经在退场的不重复计入）。
  const present = toasts.filter((toast) => !toast.leaving)
  if (present.length > MAX_TOASTS) {
    const oldest = present[0]
    if (oldest !== undefined) markLeaving(oldest.id)
  }
}

function getToasts(): ToastItem[] {
  return toasts
}

function subscribeToasts(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/** 测试隔离。 */
export function resetToastsForTest(): void {
  toasts = []
  listeners.clear()
}

export function ToastHost(): ReactNode {
  const current = useSyncExternalStore(subscribeToasts, getToasts)
  if (current.length === 0) return null
  return createPortal(
    <div className="toast-stack" role="status" aria-live="polite" data-testid="toast-stack">
      {current.map((item) => (
        <SwipeToast
          key={item.id}
          message={item.message}
          leaving={item.leaving}
          durationMs={VISIBLE_WINDOW_MS}
          onExpire={() => markLeaving(item.id)}
          onDismiss={() => markLeaving(item.id)}
        />
      ))}
    </div>,
    document.body,
  )
}
