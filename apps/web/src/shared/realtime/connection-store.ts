/**
 * 实时连接状态（#227 批次②）。
 *
 * 模块级 external store：TeamEventSocket 经 RealtimeBridge 写入，
 * ConnectionBanner 用 useSyncExternalStore 订阅——横幅不进 React 树的状态
 * 也能被组件读到，测试可以直接 set 驱动。
 *
 * 语义（与 socket.ts 的上报一一对应）：
 *   connecting     —— 首次建立中（页面初载本来就在等数据，**安静**，不显示横幅）；
 *   open           —— 在线；
 *   reconnecting   —— 连上过又断了、退避重连中（**必须可见**：此刻页面显示的
 *                     是静默旧数据，用户得知道自己看的是什么年代的）。
 */

export type ConnectionStatus = 'connecting' | 'open' | 'reconnecting'

type Listener = () => void

let status: ConnectionStatus = 'connecting'
const listeners = new Set<Listener>()

export function getConnectionStatus(): ConnectionStatus {
  return status
}

export function setConnectionStatus(next: ConnectionStatus): void {
  if (next === status) return
  status = next
  for (const listener of listeners) listener()
}

export function subscribeConnectionStatus(listener: Listener): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/** 测试隔离：每个用例从干净的「首次连接中」出发。 */
export function resetConnectionStatusForTest(): void {
  status = 'connecting'
  listeners.clear()
}
