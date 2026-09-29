/**
 * 断线横幅（#227 批次②）。
 *
 * 只在 reconnecting（连上过又断了）时出现；首次连接与正常在线保持安静——
 * 横幅的价值是告诉用户「你看到的可能不是最新数据」，页面初载本来就在等数据。
 * role=status + aria-live=polite：屏幕阅读器会温和播报，不抢 alert 的紧急通道。
 */
import { useSyncExternalStore, type ReactNode } from 'react'
import {
  getConnectionStatus,
  subscribeConnectionStatus,
} from '../shared/realtime/connection-store.js'

export function ConnectionBanner(): ReactNode {
  const status = useSyncExternalStore(subscribeConnectionStatus, getConnectionStatus)
  if (status !== 'reconnecting') return null
  return (
    <div className="connection-banner" role="status" data-testid="connection-banner">
      连接已断开，正在重连…显示的可能不是最新数据。
    </div>
  )
}
