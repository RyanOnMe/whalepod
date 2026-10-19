/** E2E 网络故障缝：只控制 socket 连接，不写产品状态或业务数据。 */
export class ConnectionFault {
  private until = 0
  private heldBy: string | null = null
  private lastReleased: string | null = null
  private blockedAttempts = 0
  constructor(private readonly now: () => number = Date.now) {}

  dropFor(ms: number): void {
    if (!Number.isFinite(ms) || ms <= 0)
      throw new Error('offline duration must be positive and finite')
    if (this.heldBy !== null) throw new Error('held connection fault cannot expire by timer')
    this.until = this.now() + ms
  }
  hold(id: string): void {
    if (!id || (this.heldBy !== null && this.heldBy !== id))
      throw new Error('connection fault already held or invalid id')
    this.heldBy = id
  }
  release(id: string): void {
    if (this.heldBy === null && this.lastReleased === id) return
    if (!id || id !== this.heldBy) throw new Error('connection fault id mismatch')
    this.heldBy = null
    this.lastReleased = id
    this.until = 0
  }
  blockConnection(): boolean {
    const blocked = this.snapshot().offline
    if (blocked) this.blockedAttempts += 1
    return blocked
  }
  snapshot() {
    return {
      component: 'node.gateway' as const,
      held: this.heldBy !== null,
      faultId: this.heldBy,
      offline: this.heldBy !== null || this.now() < this.until,
      blockedConnectionAttempts: this.blockedAttempts,
    }
  }
}
