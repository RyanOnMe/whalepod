/**
 * 单实例 Hub 的内存固定窗口限流器（02 Global Constraints：第一阶段不加 Redis）。
 * 配额：登录每 IP + username 每 15 分钟 10 次；Setup/Invite accept 每 IP 每 15 分钟 20 次
 * （02 Task 5 Step 7）。窗口长度与上限经 HubConfig.rateLimit 注入，测试用小配额驱动。
 */
export class RateLimiter {
  private readonly buckets = new Map<string, { count: number; resetAt: number }>()

  constructor(
    private readonly max: number,
    private readonly windowMs: number,
  ) {}

  /** 记录一次尝试；返回本次是否在配额内（超出返回 false）。 */
  tryAcquire(key: string, now: number = Date.now()): boolean {
    const bucket = this.buckets.get(key)
    if (bucket === undefined || now >= bucket.resetAt) {
      this.buckets.set(key, { count: 1, resetAt: now + this.windowMs })
      return true
    }
    bucket.count += 1
    return bucket.count <= this.max
  }
}
