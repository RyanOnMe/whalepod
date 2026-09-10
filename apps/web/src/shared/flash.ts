/**
 * 一次性提示（#141 接受页 → 项目页的「已加入 <团队名>」）。
 *
 * 接受邀请成功后要跳回项目页，提示语必须跨路由存活一次。放在 sessionStorage：
 * 刷新同标签页仍在（不影响新标签页/新浏览器的状态），读取即清除——提示语是
 * 「刚刚发生了什么」的一次性事实，不是持久状态。密钥/Token 一律不进这里
 * （只放团队名这种已对成员可见的值）。
 */
const KEY = 'whalepod.flash'

export function setFlash(message: string): void {
  try {
    window.sessionStorage.setItem(KEY, message)
  } catch {
    // 隐私模式/存储被禁：提示语丢了不影响加入结果，不抛给用户。
  }
}

/** 读取并清除；没有（或存储不可用）返回 null。 */
export function takeFlash(): string | null {
  try {
    const message = window.sessionStorage.getItem(KEY)
    if (message !== null) window.sessionStorage.removeItem(KEY)
    return message
  } catch {
    return null
  }
}
