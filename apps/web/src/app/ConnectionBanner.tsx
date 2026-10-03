/**
 * 断线横幅（#227 批次②）。
 *
 * 只在 reconnecting（连上过又断了）时出现；首次连接与正常在线保持安静——
 * 横幅的价值是告诉用户「你看到的可能不是最新数据」，页面初载本来就在等数据。
 * role=status + aria-live=polite：屏幕阅读器会温和播报，不抢 alert 的紧急通道。
 *
 * #273 进出有交代：横幅插在 `<main>` **上方的正常流**里，原先 `return null` 会把整页
 * 内容瞬间顶下去、弹回来——那不是淡入淡出能盖住的布局跳动。现在：
 *   · 外层槽位用 `grid-template-rows: 0fr ↔ 1fr` 展开/收起（高度可过渡，不用写死 px）；
 *   · `usePresence` 把卸载推迟到退场演完之后（`EXIT_PRESENCE_MS`，与 CSS 同一个数）；
 *   · 退场期间**仍然是 `role=status`**：内容还没消失，语义就不该先消失。
 */
import { useSyncExternalStore, type ReactNode } from 'react'
import {
  getConnectionStatus,
  subscribeConnectionStatus,
} from '../shared/realtime/connection-store.js'
import { EXIT_PRESENCE_MS } from '../shared/motion.js'
import { usePresence } from '../shared/usePresence.js'

export function ConnectionBanner(): ReactNode {
  const status = useSyncExternalStore(subscribeConnectionStatus, getConnectionStatus)
  const presence = usePresence(status === 'reconnecting' ? true : null, EXIT_PRESENCE_MS)
  if (presence.value === null) return null
  return (
    <div className={`connection-banner-slot${presence.leaving ? ' leaving' : ''}`}>
      <div className="connection-banner" role="status" data-testid="connection-banner">
        连接已断开，正在重连…显示的可能不是最新数据。
      </div>
    </div>
  )
}
