/**
 * 指数退避重连（02 Task 9 Step 5）。
 * base = min(30s, 250ms * 2^attempt)，再叠 0–20% full jitter。
 * 永久失败不无限重试：认证类（4401，由升级前 HTTP 401/403 映射而来）与
 * 4008（被更新连接替换/Token 撤销——本进程已不该再持有连接）一律停止。
 */
const BASE_MS = 250 as const
const CAP_MS = 30_000 as const
const JITTER_RATIO = 0.2 as const

export function nextBackoffMs(attempt: number, random: () => number = Math.random): number {
  const base = Math.min(CAP_MS, BASE_MS * 2 ** attempt)
  return Math.round(base * (1 + random() * JITTER_RATIO))
}

/** 永久关闭码：4401 认证拒绝（hub-socket 把升级前 HTTP 401/403 映射成它）；4008 被替换/被撤销。 */
export const PERMANENT_CLOSE_CODES = new Set([4001, 4008, 4401])

/** 是否应停止重连（永久失败或显式停止）。 */
export function shouldStopReconnect(closeCode: number | undefined): boolean {
  return closeCode !== undefined && PERMANENT_CLOSE_CODES.has(closeCode)
}
