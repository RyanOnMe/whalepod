/**
 * P1-08 持久 Team Event cursor 存储（02 Task 8 Step 3、03 §5）。
 *
 * - high-water mark 与补发全以 event id 为准（team_event.id 单调递增，即 wire cursor）。
 * - 24 小时保留窗口：cursor 早于窗口最老事件时必须 resync，绝不猜测缺失事件（R3）。
 * - team_event 表当前为单 Team 结构（无 team_id 列）：第一阶段 Hub 单一工作区，
 *   多团队迁移时再补 team_id 过滤（02 Task 8 伪代码里的 actor.teamId 在此落地为全局游标）。
 */
import { and, asc, gt, lt, lte, max } from 'drizzle-orm'
import type { DbHandle } from '@whalepod/db'
import { schema } from '@whalepod/db'
import { ClientFrameSchema } from '@whalepod/protocol'

export const TEAM_EVENT_RETENTION_MS = 24 * 60 * 60 * 1000

export interface TeamEventRecord {
  readonly id: number
  readonly type: string
  readonly payload: unknown
  readonly occurredAt: Date
}

export type WarnFn = (message: string, context?: Record<string, unknown>) => void

export interface TeamEventStoreOptions {
  readonly now?: () => Date
  readonly retentionMs?: number
}

export class TeamEventStore {
  private readonly now: () => Date
  private readonly retentionMs: number

  constructor(
    private readonly db: DbHandle,
    options: TeamEventStoreOptions = {},
  ) {
    this.now = options.now ?? (() => new Date())
    this.retentionMs = options.retentionMs ?? TEAM_EVENT_RETENTION_MS
  }

  /** 当前 high-water mark：下一个待补发游标（仓库为空时 0）。 */
  async latestCursor(): Promise<number> {
    const [row] = await this.db.select({ value: max(schema.teamEvents.id) }).from(schema.teamEvents)
    return row?.value ?? 0
  }

  /**
   * 保留窗口边界：id <= 返回值的持久事件已过期（被清出窗口）。
   * 客户端 cursor 早于或等于它时无法完整补发，必须 resync。
   */
  async lastExpiredCursor(): Promise<number> {
    const cutoff = new Date(this.now().getTime() - this.retentionMs)
    const [row] = await this.db
      .select({ value: max(schema.teamEvents.id) })
      .from(schema.teamEvents)
      .where(lt(schema.teamEvents.occurredAt, cutoff))
    return row?.value ?? 0
  }

  /** 回放：补发 (cursor, highWater] 区间内的持久事件，按 id 升序（02 Step 3 伪代码）。 */
  async listAfter(cursor: number, highWater: number): Promise<TeamEventRecord[]> {
    const rows = await this.db
      .select()
      .from(schema.teamEvents)
      .where(and(gt(schema.teamEvents.id, cursor), lte(schema.teamEvents.id, highWater)))
      .orderBy(asc(schema.teamEvents.id))
    return rows.map((row) => ({
      id: row.id,
      type: row.type,
      payload: row.payload,
      occurredAt: row.occurredAt,
    }))
  }
}

/**
 * 持久事件 → wire 帧（JSON 字符串）。帧一律过 ClientFrameSchema 构造（protocolVersion=1）；
 * 未知事件类型 fail-closed：返回 null 由调用方跳过（客户端绝不会收到未登记事件）。
 */
export function buildPersistentWire(event: TeamEventRecord, warn?: WarnFn): string | null {
  const parsed = ClientFrameSchema.safeParse({
    protocolVersion: 1,
    kind: 'persistent',
    cursor: String(event.id),
    occurredAt: event.occurredAt.toISOString(),
    event: { type: event.type, payload: event.payload },
  })
  if (!parsed.success) {
    warn?.('skip unparseable team event (fail-closed)', {
      eventId: event.id,
      eventType: event.type,
    })
    return null
  }
  return JSON.stringify(parsed.data)
}
