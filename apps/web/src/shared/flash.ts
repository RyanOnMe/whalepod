/**
 * 一次性提示（#141 接受页 → 项目页的「已加入 <团队名>」）。
 *
 * 接受邀请成功后要跳回项目页，提示语必须跨路由存活一次。放在 sessionStorage：
 * 刷新同标签页仍在（不影响新标签页/新浏览器的状态）——提示语是
 * 「刚刚发生了什么」的一次性事实，不是持久状态。密钥/Token 一律不进这里
 * （只放团队名这种已对成员可见的值）。
 *
 * **读取分两步（#267）**：`peekFlash()` 只读不清、`clearFlash()` 单独清。
 * 为什么不是「读即清除」的一步 `takeFlash()`：FlashBanner 在 `useState` 初始化器里
 * 读——那是**渲染期**。React 可以丢弃一次渲染（并发渲染被导航打断时就是这么干的），
 * 渲染期就把消息吃掉，就会出现「消息没了、却没人看见」。#267 实测：/login 的到达有
 * 两条路径（订阅者 setFlash+navigate 与根 loader 重定向），这条流程里 FlashBanner
 * 挂载了三次；渲染期消费就是 CI 偶发红的根。改成「渲染只读 → 提交显示的 effect 里清」。
 */
const KEY = 'whalepod.flash'

export function setFlash(message: string): void {
  try {
    window.sessionStorage.setItem(KEY, message)
  } catch {
    // 隐私模式/存储被禁：提示语丢了不影响加入结果，不抛给用户。
  }
}

/** 只读不清（渲染期安全）。没有（或存储不可用）返回 null。 */
export function peekFlash(): string | null {
  try {
    return window.sessionStorage.getItem(KEY)
  } catch {
    return null
  }
}

/** 清除（在「已经显示出来」的 effect 里调）。存储不可用时不抛。 */
export function clearFlash(): void {
  try {
    window.sessionStorage.removeItem(KEY)
  } catch {
    // 同上：清理失败不抛给用户。
  }
}
