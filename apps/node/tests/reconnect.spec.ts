import { describe, expect, it } from 'vitest'
import { nextBackoffMs } from '../src/gateway/reconnect.js'

// P1-09：指数退避 250ms→30s + full jitter（02 Task 9 Step 5）。
describe('reconnect backoff (nextBackoffMs)', () => {
  it('无 jitter 下按 2^n 增长直到 30s 封顶', () => {
    expect(nextBackoffMs(0, () => 0)).toBe(250)
    expect(nextBackoffMs(1, () => 0)).toBe(500)
    expect(nextBackoffMs(2, () => 0)).toBe(1000)
    expect(nextBackoffMs(3, () => 0)).toBe(2000)
    expect(nextBackoffMs(4, () => 0)).toBe(4000)
    expect(nextBackoffMs(5, () => 0)).toBe(8000)
    expect(nextBackoffMs(6, () => 0)).toBe(16000)
    expect(nextBackoffMs(7, () => 0)).toBe(30000) // 封顶
    expect(nextBackoffMs(100, () => 0)).toBe(30000)
  })

  it('full jitter：值落在 [base, base*1.2) 区间', () => {
    for (let attempt = 0; attempt < 10; attempt += 1) {
      const base = Math.min(30_000, 250 * 2 ** attempt)
      const value = nextBackoffMs(attempt, () => 1) // random=1 → base*1.2
      expect(value).toBe(Math.round(base * 1.2))
      const lo = nextBackoffMs(attempt, () => 0)
      expect(lo).toBe(base)
    }
  })
})
