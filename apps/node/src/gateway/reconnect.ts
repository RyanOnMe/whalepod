/**
 * 指数退避重连（02 Task 9 Step 5）。
 * base = min(30s, 250ms * 2^attempt)，再叠 0–20% full jitter。
 * 认证失败（Hub 401/403）不无限重试：调用方应在永久错误时停止。
 */
const BASE_MS = 250 as const
const CAP_MS = 30_000 as const
const JITTER_RATIO = 0.2 as const

export function nextBackoffMs(attempt: number, random: () => number = Math.random): number {
  const base = Math.min(CAP_MS, BASE_MS * 2 ** attempt)
  return Math.round(base * (1 + random() * JITTER_RATIO))
}

export const AUTH_FAILURE_CLOSE_CODES = new Set([4001, 4401])

/** 是否应停止重连（认证类失败或显式停止）。 */
export function shouldStopReconnect(closeCode: number | undefined): boolean {
  return closeCode !== undefined && AUTH_FAILURE_CLOSE_CODES.has(closeCode)
}
