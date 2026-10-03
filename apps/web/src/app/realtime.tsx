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
import type { QueryClient } from '@tanstack/react-query'
import { useEffect, useRef } from 'react'
import { useLocation, useNavigate } from 'react-router'
import { applyClientFrame } from '../shared/realtime/event-router.js'
import { CursorStore } from '../shared/realtime/cursor-store.js'
import { TeamEventSocket } from '../shared/realtime/socket.js'
import type { TeamEventSocketCallbacks } from '../shared/realtime/socket.js'
import { appendLiveDelta } from '../shared/realtime/run-buffer.js'
import { setConnectionStatus } from '../shared/realtime/connection-store.js'
import { observeRunCompletion } from '../shared/notifications/observe.js'
import { showRunNotification } from '../shared/notifications/system-notify.js'
import { matchTaskRoute } from '../shared/notifications/route.js'
import { RUN_STATUS_LABEL } from '../shared/format.js'
import type { RecentTaskView } from '../shared/api/types.js'
import { queryKeys } from './query-client.js'

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

/**
 * #259：通知正文里的任务名——只查已有缓存（侧栏「最近任务」常驻、按最近活动排序，
 * 刚跑完的 Run 所属任务几乎必在其中），查不到返回 null 由展示层用占位。零新请求。
 */
function recentTaskTitle(queryClient: QueryClient, taskId: string): string | null {
  const recent = queryClient.getQueryData<RecentTaskView[]>(queryKeys.recentTasks)
  return recent?.find((item) => item.id === taskId)?.title ?? null
}

export function RealtimeBridge(): null {
  const queryClient = useQueryClient()
  const navigate = useNavigate()
  const location = useLocation()
  // socket 只在挂载时建一次：路由信息经 ref 带进帧回调——依赖变化重建连接会丢游标、
  // 白白重放一次窗口（#259）。
  const pathnameRef = useRef(location.pathname)
  const navigateRef = useRef(navigate)
  useEffect(() => {
    pathnameRef.current = location.pathname
  }, [location.pathname])
  useEffect(() => {
    navigateRef.current = navigate
  }, [navigate])

  useEffect(() => {
    const cursorStore = new CursorStore()
    const resync = () => void queryClient.invalidateQueries()
    // #259：重放（24h 窗口）与「当场发生」的分界——早于挂载的终态只进徽标、不弹系统通知。
    const mountedAt = Date.now()
    // #227：断线窗口漏掉的持久事件，在「重连成功」那一刻全量补拉兜底
    // （refetchOnWindowFocus 已关，fetch 通着不会自愈；此前只有 control 帧
    // 触发 resync——服务端不主动发就永远旧下去）。
    let wasReconnecting = false
    const callbacks: TeamEventSocketCallbacks = {
      onFrame: (frame) => {
        // #259 通知是尽力而为：任何异常都不许挡住下面的缓存失效与 cursor 提交
        // （挡了就退化成永久重放窗口）。
        try {
          observeRunCompletion(frame, {
            mountedAt,
            isViewingTask: (taskId) => matchTaskRoute(pathnameRef.current) === taskId,
            taskTitleFor: (taskId) => recentTaskTitle(queryClient, taskId),
            notify: (notice) => {
              showRunNotification({
                title: notice.taskTitle ?? '任务',
                body: `运行${RUN_STATUS_LABEL[notice.status]}`,
                onClick: () => {
                  window.focus()
                  navigateRef.current(`/tasks/${notice.taskId}`)
                },
              })
            },
          })
        } catch {
          // 见上：通知失败不改变实时链路的任何行为。
        }
        void applyClientFrame(queryClient, frame, {
          cursorStore,
          resync,
          onLive: (runId, deltaSeq, deltaText) => appendLiveDelta(runId, deltaSeq, deltaText),
        })
      },
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
