/**
 * session 过期事件（#227 批次②）。
 *
 * 页面内（非导航）query/mutation 返回 AUTH_REQUIRED/SESSION_EXPIRED 时，
 * QueryCache/MutationCache 的 onError 在这里发事件；AppShell 订阅后跳 /login
 * 并带 from。用事件而不是在 cache 回调里直接 navigate：query-client 是纯模块
 * （无 router 上下文），跳转的决定权留给挂在 router 里的订阅者——测试也能
 * 用 memory router 干净断言。
 */

type Listener = () => void

const listeners = new Set<Listener>()

export function emitSessionExpired(): void {
  for (const listener of listeners) listener()
}

export function subscribeSessionExpired(listener: Listener): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}
