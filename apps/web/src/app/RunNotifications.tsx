/**
 * 运行完成通知的两个面（P1-UX-13 / #259；#308 起开关本体是 Micro 铃铛）：
 *
 * - `RunNotifications`（**无头**，挂在 AppShell，宽窄屏都在）：tab 标题徽标 +
 *   「进任务房间即已读」。徽标逻辑不能只挂在侧栏里——窄屏没有侧栏。
 * - `NotificationBell`（侧栏一行，宽屏）：开/关完成提醒；**点击时才**请求浏览器
 *   权限（加载时自动请求是骚扰）。浏览器不支持 → 不渲染（不做死控件）；
 *   已被拒 → 给一行说明（怎么恢复是用户的事，我们只如实说）。
 *
 * #308 的两条约束（判据在 tests/run-notifications.spec.tsx）：
 * 1. **控件完全受控**：`pressed` 只在真实授权且偏好写入之后才变真——不能在请求
 *    在途或未授权时先亮起来；请求在途期间禁止重复触发。
 * 2. **徽标只显示真实未读数**，与 `document.title` 同源（同一个 store、同一份水位）。
 */
import { useEffect, useState, useSyncExternalStore, type ReactNode } from 'react'
import { useLocation } from 'react-router'
import {
  clearTaskNotifications,
  getUnseenRuns,
  subscribeNotifications,
} from '../shared/notifications/store.js'
import {
  notificationSupport,
  notificationsEnabled,
  requestNotificationPermission,
  setPreference,
} from '../shared/notifications/system-notify.js'
import { matchTaskRoute } from '../shared/notifications/route.js'
import BellToggle from '../vendor/react-bits-micro/BellToggle.js'

const BASE_TITLE = 'WhalePod'

export function RunNotifications(): null {
  const unseen = useSyncExternalStore(subscribeNotifications, getUnseenRuns, getUnseenRuns)
  const location = useLocation()
  const taskId = matchTaskRoute(location.pathname)

  useEffect(() => {
    document.title = unseen.length === 0 ? BASE_TITLE : `(${unseen.length}) ${BASE_TITLE}`
  }, [unseen.length])
  // 登出/卸载时还原标题：徽标是「本次会话还欠你几条」，不该跟着登录页。
  useEffect(
    () => () => {
      document.title = BASE_TITLE
    },
    [],
  )
  useEffect(() => {
    if (taskId !== null) clearTaskNotifications(taskId)
  }, [taskId])

  return null
}

export function NotificationBell(): ReactNode {
  const [support, setSupport] = useState(notificationSupport)
  const [enabled, setEnabled] = useState(notificationsEnabled)
  const [pending, setPending] = useState(false)
  const unseen = useSyncExternalStore(subscribeNotifications, getUnseenRuns, getUnseenRuns)

  if (support === 'unsupported') return null
  if (support === 'denied') {
    return <p className="app-sidebar-notify-hint">浏览器已拒绝通知权限</p>
  }

  const onToggle = (): void => {
    if (pending) return
    if (enabled) {
      setPreference(false)
      setEnabled(false)
      return
    }
    setPending(true)
    void requestNotificationPermission().then((permission) => {
      // 请求后同步真实状态：『已被拒』要立刻变成只读说明，不能继续装可点。
      setSupport(notificationSupport())
      setPending(false)
      if (permission === 'granted') {
        setPreference(true)
        setEnabled(true)
      }
    })
  }

  return (
    <span className="app-sidebar-notify">
      <BellToggle
        label="完成提醒"
        offLabel="完成提醒：已关"
        onLabel="完成提醒：已开"
        pressed={enabled}
        count={unseen.length}
        pending={pending}
        onChange={onToggle}
      />
    </span>
  )
}
