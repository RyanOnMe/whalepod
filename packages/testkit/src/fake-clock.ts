/**
 * 手动时钟（P1-10；02-第一阶段实施计划.md Task 10 Files）。
 * 需要推进租约/退避时间的测试用它注入 `now: () => Date`，替代 vi.useFakeTimers
 * 对真实 PostgreSQL 驱动的干扰。
 */
export class FakeClock {
  private current: Date

  constructor(start: Date = new Date('2026-01-01T00:00:00.000Z')) {
    this.current = new Date(start.getTime())
  }

  now(): Date {
    return new Date(this.current.getTime())
  }

  advance(ms: number): Date {
    this.current = new Date(this.current.getTime() + ms)
    return this.now()
  }
}
