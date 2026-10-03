/**
 * 运行完成通知的两个面（P1-UX-13 / #259）：
 *
 * - `RunNotifications`（**无头**，挂在 AppShell，宽窄屏都在）：tab 标题徽标 +
 *   「进任务房间即已读」。徽标逻辑不能只挂在侧栏里——窄屏没有侧栏。
 * - `NotificationBell`（侧栏一行，宽屏）：开/关完成提醒；**点击时才**请求浏览器
 *   权限（加载时自动请求是骚扰）。浏览器不支持 → 不渲染（不做死控件）；
 *   已被拒 → 给一行说明（怎么恢复是用户的事，我们只如实说）。
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

  if (support === 'unsupported') return null
  if (support === 'denied') {
    return <p className="app-sidebar-notify-hint">浏览器已拒绝通知权限</p>
  }

  const onToggle = (): void => {
    if (enabled) {
      setPreference(false)
      setEnabled(false)
      return
    }
    void requestNotificationPermission().then((permission) => {
      // 请求后同步真实状态：『已被拒』要立刻变成只读说明，不能继续装可点。
      setSupport(notificationSupport())
      if (permission === 'granted') {
        setPreference(true)
        setEnabled(true)
      }
    })
  }

  return (
    <button
      type="button"
      className="button button-quiet app-sidebar-notify-toggle"
      aria-pressed={enabled}
      onClick={onToggle}
    >
      完成提醒{enabled ? '：已开' : '：已关'}
    </button>
  )
}
