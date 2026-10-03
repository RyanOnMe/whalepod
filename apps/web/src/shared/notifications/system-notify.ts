/**
 * 系统通知（Notification API）的开关与投递（P1-UX-13 / #259）。
 *
 * - **默认关**：权限只在用户点侧栏铃铛时请求——加载就弹权限请求是骚扰，浏览器也
 *   要求用户手势；granted 不等于用户想要（浏览器里"允许"过一次就永久 granted）。
 * - **页面不活着就弹不了**：没有 service worker，不做推送订阅；文档写明这条边界。
 * - 所有浏览器面调用都 try/catch：权限策略、隐私模式、构造失败一律降级为「不弹」，
 *   徽标（本地水位）不受影响。
 */
export type NotificationSupport = 'unsupported' | 'default' | 'denied' | 'granted'

const PREFERENCE_KEY = 'whalepod.notifications.system'

export function notificationSupport(): NotificationSupport {
  try {
    return typeof Notification === 'undefined' ? 'unsupported' : Notification.permission
  } catch {
    return 'unsupported'
  }
}

/** 用户偏好（localStorage）开着、且浏览器已授权——两个条件缺一不弹。 */
export function notificationsEnabled(): boolean {
  return readPreference() && notificationSupport() === 'granted'
}

export function readPreference(): boolean {
  try {
    return window.localStorage.getItem(PREFERENCE_KEY) === 'on'
  } catch {
    return false
  }
}

export function setPreference(enabled: boolean): void {
  try {
    window.localStorage.setItem(PREFERENCE_KEY, enabled ? 'on' : 'off')
  } catch {
    // 存储不可写：偏好退回默认（关），不抛给用户。
  }
}

export async function requestNotificationPermission(): Promise<NotificationSupport> {
  try {
    if (typeof Notification === 'undefined') return 'unsupported'
    return await Notification.requestPermission()
  } catch {
    return 'unsupported'
  }
}

/** 投递一条系统通知；返回是否真的弹了（未开启/未授权/构造失败都是 false）。 */
export function showRunNotification(input: {
  title: string
  body: string
  onClick: () => void
}): boolean {
  if (!notificationsEnabled()) return false
  try {
    const notification = new Notification(input.title, { body: input.body })
    notification.onclick = () => {
      input.onClick()
    }
    return true
  } catch {
    return false
  }
}
