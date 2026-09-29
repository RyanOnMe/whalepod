/**
 * P1-13 Browser 实时链路组合根（02 Task 8 Step 5 + Task 13）。
 *
 * 登录后的 AppShell 挂一次：CursorStore（已提交 cursor 跨重连持久化）+
 * TeamEventSocket（退避重连）+ applyClientFrame（持久事件 → query 失效，
 * live → ownerRunBuffer）。resync.required / 未知帧 → 全量失效重拉快照
 * （03 §11 的 fail-closed：宁可多拉，不可呈现旧状态）。
 *
 * 测试注入面：走真实 router 的用例会挂载本组件；`setRealtimeSocketFactoryForTest`
 * 以 no-op socket 替换真实连接（不改协议行为，只是不联网）。
 */
import { useQueryClient } from '@tanstack/react-query'
import { useEffect } from 'react'
import { applyClientFrame } from '../shared/realtime/event-router.js'
import { CursorStore } from '../shared/realtime/cursor-store.js'
import { TeamEventSocket } from '../shared/realtime/socket.js'
import type { TeamEventSocketCallbacks } from '../shared/realtime/socket.js'
import { appendLiveDelta } from '../shared/realtime/run-buffer.js'
import { setConnectionStatus } from '../shared/realtime/connection-store.js'

export interface RealtimeSocketHandle {
  connect(): void
  close(): void
}

type SocketFactory = (
  url: string,
  cursorStore: CursorStore,
  callbacks: TeamEventSocketCallbacks,
) => RealtimeSocketHandle

let socketFactoryOverride: SocketFactory | undefined

/** 测试用：替换 socket 工厂（传 undefined 还原真实 TeamEventSocket）。 */
export function setRealtimeSocketFactoryForTest(factory: SocketFactory | undefined): void {
  socketFactoryOverride = factory
}

function socketUrl(): string {
  const scheme = window.location.protocol === 'https:' ? 'wss' : 'ws'
  return `${scheme}://${window.location.host}/ws/v1/client`
}

export function RealtimeBridge(): null {
  const queryClient = useQueryClient()
  useEffect(() => {
    const cursorStore = new CursorStore()
    const resync = () => void queryClient.invalidateQueries()
    // #227：断线窗口漏掉的持久事件，在「重连成功」那一刻全量补拉兜底
    // （refetchOnWindowFocus 已关，fetch 通着不会自愈；此前只有 control 帧
    // 触发 resync——服务端不主动发就永远旧下去）。
    let wasReconnecting = false
    const callbacks: TeamEventSocketCallbacks = {
      onFrame: (frame) =>
        applyClientFrame(queryClient, frame, {
          cursorStore,
          resync,
          onLive: (runId, deltaSeq, deltaText) => appendLiveDelta(runId, deltaSeq, deltaText),
        }),
      onResync: resync,
      onStatusChange: (status) => {
        setConnectionStatus(status)
        if (status === 'reconnecting') {
          wasReconnecting = true
        } else if (status === 'open' && wasReconnecting) {
          wasReconnecting = false
          resync()
        }
      },
    }
    const socket =
      socketFactoryOverride?.(socketUrl(), cursorStore, callbacks) ??
      new TeamEventSocket({ url: socketUrl(), cursorStore, callbacks })
    socket.connect()
    return () => socket.close()
  }, [queryClient])
  return null
}
