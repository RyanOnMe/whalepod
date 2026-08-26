/**
 * P1-08 进程内实时订阅（02 Task 8 Step 3/4、03 §5）。
 *
 * - 持久事件 fan-out 用进程内轮询（默认 ~250ms tick 查新 id），NOTIFY/LISTEN
 *   是文档明示可缓做的优化，未做（docs/agent/run-orchestrator-acceptance.md 边界段）。
 * - 回放/订阅交接用服务端 high-water mark：`startFrom(cursor)` 只轮询 cursor 之后的新事件。
 * - owner-only live delta 经 `publishLive` 注入面分发（P1-13 run 模块接线前，测试用注入 seam）；
 *   非 owner 订阅者永远收不到（04 §6.2：Alice 的连接永不出现 Bob 的 owner 帧）。
 */
import { ClientFrameSchema } from '@project311/protocol'
import type { TeamEventStore } from './team-event-store.js'
import { buildPersistentWire } from './team-event-store.js'
import type { WarnFn } from './team-event-store.js'

export const DEFAULT_POLL_INTERVAL_MS = 250

export interface LiveDelta {
  readonly runId: string
  readonly deltaSeq: number
  readonly text: string
  readonly ownerUserId: string
}

/** 订阅帧出口：返回 'overflow' 表示该连接背压超限，由连接层 resync+close 4009。 */
export type SinkResult = 'accepted' | 'overflow'
export type FrameSink = (wire: string) => SinkResult

export interface RealtimeSubscription {
  /** 从该 cursor（不含事件本身）开始轮询新持久事件（02 Step 3 交接点）。 */
  startFrom(cursor: number): void
  stop(): void
}

export interface RealtimeHubOptions {
  readonly store: TeamEventStore
  readonly pollIntervalMs?: number
  readonly now?: () => Date
  readonly warn?: WarnFn
}

export interface RealtimeHub {
  readonly activeSubscriptionCount: () => number
  subscribe(spec: { readonly ownerUserId: string; readonly sink: FrameSink }): RealtimeSubscription
  /** P1-13 直播帧注入面：只投给 run owner 已建立的连接。 */
  publishLive(delta: LiveDelta): void
  close(): void
}

class TeamEventSubscription implements RealtimeSubscription {
  private cursor = 0
  private stopped = true
  private timer: ReturnType<typeof setTimeout> | undefined

  constructor(
    readonly ownerUserId: string,
    private readonly sink: FrameSink,
    private readonly hub: RealtimeHubImpl,
  ) {}

  startFrom(cursor: number): void {
    this.cursor = cursor
    this.stopped = false
    this.schedule()
  }

  stop(): void {
    this.stopped = true
    if (this.timer !== undefined) clearTimeout(this.timer)
    this.timer = undefined
    void this.hub.detach(this)
  }

  /** live 帧不走轮询：由 hub 按 owner 直接投递。 */
  pushLive(wire: string): void {
    if (this.stopped) return
    void this.sink(wire)
  }

  private schedule(): void {
    if (this.stopped) return
    this.timer = setTimeout(() => {
      void this.tick()
    }, this.hub.pollIntervalMs)
  }

  private async tick(): Promise<void> {
    if (this.stopped) return
    try {
      const highWater = await this.hub.store.latestCursor()
      if (highWater > this.cursor) {
        const events = await this.hub.store.listAfter(this.cursor, highWater)
        for (const event of events) {
          const wire = buildPersistentWire(event, this.hub.warn)
          // 未知类型事件跳过但推进 cursor（客户端按成功收到的帧推进，缺口由
          // 服务端轮询自然跳过，不重复读坏行）。
          this.cursor = event.id
          if (wire === null) continue
          if (this.sink(wire) === 'overflow') {
            this.stopped = true
            return
          }
        }
      }
      this.schedule()
    } catch (error) {
      this.hub.warn?.('team event poll failed; will retry', {
        errorName: error instanceof Error ? error.name : String(error),
      })
      this.schedule()
    }
  }
}

class RealtimeHubImpl implements RealtimeHub {
  readonly pollIntervalMs: number
  readonly warn: WarnFn | undefined
  private readonly subscriptions = new Set<TeamEventSubscription>()

  constructor(
    readonly store: TeamEventStore,
    options: RealtimeHubOptions,
  ) {
    this.pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS
    this.warn = options.warn
  }

  activeSubscriptionCount(): number {
    return this.subscriptions.size
  }

  subscribe(spec: {
    readonly ownerUserId: string
    readonly sink: FrameSink
  }): RealtimeSubscription {
    const subscription = new TeamEventSubscription(spec.ownerUserId, spec.sink, this)
    this.subscriptions.add(subscription)
    return subscription
  }

  publishLive(delta: LiveDelta): void {
    const parsed = ClientFrameSchema.parse({
      protocolVersion: 1,
      kind: 'live',
      runId: delta.runId,
      audience: 'owner',
      deltaSeq: delta.deltaSeq,
      delta: { text: delta.text },
    })
    const wire = JSON.stringify(parsed)
    for (const subscription of this.subscriptions) {
      // 受众过滤只认 run owner：非 owner 连接在此分支外，永不可见（04 §6.2）。
      if (subscription.ownerUserId === delta.ownerUserId) subscription.pushLive(wire)
    }
  }

  detach(subscription: TeamEventSubscription): void {
    this.subscriptions.delete(subscription)
  }

  close(): void {
    for (const subscription of this.subscriptions) subscription.stop()
    this.subscriptions.clear()
  }
}

export function createRealtimeHub(options: RealtimeHubOptions): RealtimeHub {
  return new RealtimeHubImpl(options.store, options)
}
