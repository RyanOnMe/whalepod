/** 固定窗口限流器单元测试（02 Task 5 Step 7）。 */
import { describe, expect, it } from 'vitest'
import { RateLimiter } from '../src/modules/auth/rate-limit.js'

describe('RateLimiter', () => {
  it('配额内放行，第 max+1 次拒绝', () => {
    const limiter = new RateLimiter(3, 60_000)
    expect(limiter.tryAcquire('k', 1_000)).toBe(true)
    expect(limiter.tryAcquire('k', 1_000)).toBe(true)
    expect(limiter.tryAcquire('k', 1_000)).toBe(true)
    expect(limiter.tryAcquire('k', 1_000)).toBe(false)
  })

  it('窗口过后重置', () => {
    const limiter = new RateLimiter(1, 60_000)
    expect(limiter.tryAcquire('k', 1_000)).toBe(true)
    expect(limiter.tryAcquire('k', 2_000)).toBe(false)
    expect(limiter.tryAcquire('k', 61_001)).toBe(true)
  })

  it('不同 key 互不影响', () => {
    const limiter = new RateLimiter(1, 60_000)
    expect(limiter.tryAcquire('a', 1_000)).toBe(true)
    expect(limiter.tryAcquire('b', 1_000)).toBe(true)
    expect(limiter.tryAcquire('a', 1_000)).toBe(false)
  })
})
