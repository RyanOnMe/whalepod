/**
 * #227 批次②：连接可视性。
 *
 * - 横幅只在「断线重连中」出现（首次连接与正常在线都不添乱）；
 * - RealtimeBridge 的状态回调写进 connection-store，且「断线→恢复」转换触发
 *   全量失效（断线窗口漏掉的持久事件靠这次补拉，不依赖 control 帧）；
 * - session 过期的全局跳转见 session-expiry.spec.tsx。
 */
import { act, screen, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { ALICE, loggedInHandlers, makeTask, ok } from './fixtures.js'
import type { MockHandler } from './fixtures.js'
import { renderApp, renderUi } from './render.js'
import { ConnectionBanner } from '../src/app/ConnectionBanner.js'
import {
  getConnectionStatus,
  resetConnectionStatusForTest,
  setConnectionStatus,
} from '../src/shared/realtime/connection-store.js'
import { setRealtimeSocketFactoryForTest } from '../src/app/realtime.js'
import type { TeamEventSocketCallbacks } from '../src/shared/realtime/socket.js'

describe('连接横幅（#227）', () => {
  it('断线重连中显示横幅并说明数据可能陈旧；恢复后消失；在线/首次连接不显示', async () => {
    resetConnectionStatusForTest()
    vi.useFakeTimers()
    const first = renderUi(<ConnectionBanner />)
    // 在线（open）：安静。
    act(() => setConnectionStatus('open'))
    expect(screen.queryByRole('status')).toBeNull()
    // 首次连接（connecting）：同样安静（页面初载本来就在等数据）。
    act(() => setConnectionStatus('connecting'))
    expect(screen.queryByRole('status')).toBeNull()
    // 断线重连（reconnecting）：必须说出来。
    act(() => setConnectionStatus('reconnecting'))
    expect(screen.getByRole('status')).toHaveTextContent('连接已断开，正在重连')
    expect(screen.getByRole('status')).toHaveTextContent('不是最新')
    // 恢复：#273 起消失是**两段式**——先收起（仍在 DOM 里、仍是 role=status，
    // 内容还在屏幕上，语义就不该先没），退场演完才卸载。
    act(() => setConnectionStatus('open'))
    expect(screen.getByRole('status')).toBeInTheDocument()
    expect(document.querySelector('.connection-banner-slot')).toHaveClass('leaving')
    act(() => {
      vi.advanceTimersByTime(200)
    })
    expect(screen.queryByRole('status')).toBeNull()
    first.unmount()
    vi.useRealTimers()
    resetConnectionStatusForTest()
  })

  it('RealtimeBridge 收到 open→reconnecting→open 时全量补拉（断线窗口漏事件的兜底）', async () => {
    resetConnectionStatusForTest()
    let roomGets = 0
    const task = makeTask({ assigneeUserId: ALICE.userId })
    const handlers: MockHandler[] = [
      {
        method: 'GET',
        url: new RegExp(`/api/v1/tasks/${task.id}$`),
        respond: () => {
          roomGets += 1
          return ok({
            task,
            comments: [],
            instructions: [],
            runs: [],
            artifacts: [],
          })
        },
      },
    ]
    // 捕获 RealtimeBridge 组装的回调：测试里手动驱动状态转换（不真连 WS）。
    let captured: TeamEventSocketCallbacks | undefined
    setRealtimeSocketFactoryForTest((_url, _cursorStore, callbacks) => {
      captured = callbacks
      return { connect: () => undefined, close: () => undefined }
    })
    const view = renderApp(`/tasks/${task.id}`, loggedInHandlers(ALICE, handlers))
    await screen.findByRole('heading', { name: task.title })
    const before = roomGets
    captured?.onStatusChange?.('reconnecting')
    expect(getConnectionStatus()).toBe('reconnecting')
    captured?.onStatusChange?.('open')
    // 断线恢复 → invalidateQueries 全量：task-room（active）被重新拉取。
    await waitFor(() => expect(roomGets).toBeGreaterThan(before))
    view.unmount()
    setRealtimeSocketFactoryForTest(undefined)
    resetConnectionStatusForTest()
  })

  it('未断线时 socket 状态回调不触发补拉（安静态不白拉）', async () => {
    resetConnectionStatusForTest()
    let roomGets = 0
    const task = makeTask({ assigneeUserId: ALICE.userId })
    const handlers: MockHandler[] = [
      {
        method: 'GET',
        url: new RegExp(`/api/v1/tasks/${task.id}$`),
        respond: () => {
          roomGets += 1
          return ok({ task, comments: [], instructions: [], runs: [], artifacts: [] })
        },
      },
    ]
    let captured: TeamEventSocketCallbacks | undefined
    setRealtimeSocketFactoryForTest((_url, _cursorStore, callbacks) => {
      captured = callbacks
      return { connect: () => undefined, close: () => undefined }
    })
    const view = renderApp(`/tasks/${task.id}`, loggedInHandlers(ALICE, handlers))
    await screen.findByRole('heading', { name: task.title })
    const before = roomGets
    // 一直是 open（无断线）：不应有额外请求。
    captured?.onStatusChange?.('open')
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(roomGets).toBe(before)
    view.unmount()
    setRealtimeSocketFactoryForTest(undefined)
    resetConnectionStatusForTest()
  })
})
