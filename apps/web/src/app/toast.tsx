/**
 * 轻量 toast（#229 批次③）：短暂的成败反馈通道。
 *
 * 此前成功反馈四种写法并存（Plugin 页本地 notice、常驻段落、flash 跨路由、
 * 无提示）。这里给的是**就地短暂反馈**：role=status + aria-live=polite（温和
 * 播报，不抢 alert 通道）、4 秒自动消退、最多 3 条（新的挤掉最旧的）。
 * 跨路由的一次性事实仍走 flash（toast 挂在当前路由树的 body portal 上，
 * 路由切换即卸载）；需要用户阅读并行动的错误仍走 ErrorBanner。
 *
 * store 与 connection-store 同款（模块级 external store，useSyncExternalStore 消费）。
 */
import { useSyncExternalStore, type ReactNode } from 'react'
import { createPortal } from 'react-dom'

export interface ToastItem {
  id: number
  message: string
}

const MAX_TOASTS = 3
const TOAST_TTL_MS = 4_000

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

export function pushToast(message: string): void {
  const item: ToastItem = { id: nextId, message }
  nextId += 1
  toasts = [...toasts, item].slice(-MAX_TOASTS)
  notify()
  setTimeout(() => removeToast(item.id), TOAST_TTL_MS)
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
        <div key={item.id} className="toast-item">
          {item.message}
        </div>
      ))}
    </div>,
    document.body,
  )
}
