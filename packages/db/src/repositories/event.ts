import { and, asc, eq, gt, inArray } from 'drizzle-orm'
import type { DbHandle } from '../client.js'
import { teamEvents } from '../schema/outbox.js'
import { runEvents } from '../schema/run.js'

export type RunEventRow = typeof runEvents.$inferSelect
export type TeamEventRow = typeof teamEvents.$inferSelect

export interface NewRunEvent {
  id: string
  runId: string
  seq: number
  type: string
  audience: RunEventRow['audience']
  /** 已过对应 Zod schema 与脱敏策略；单条上限 32 KiB 由 CHECK 兜底。 */
  payload: unknown
  occurredAt: Date
}

/**
 * 追加持久 Run Event。Node 断线重发会产生同 (run_id, seq) 的重复行，
 * 按 03 §2.6 幂等去重：重复追加返回 appended=false，不产生第二行。
 */
export async function appendRunEvent(
  handle: DbHandle,
  event: NewRunEvent,
): Promise<{ appended: boolean }> {
  const rows = await handle
    .insert(runEvents)
    .values(event)
    .onConflictDoNothing({ target: [runEvents.runId, runEvents.seq] })
    .returning({ id: runEvents.id })
  return { appended: rows.length > 0 }
}

export interface ListRunEventsOptions {
  /** 受众过滤（03 §5：member 只见 project；run owner 加见 owner；team admin 加见 admin）。 */
  readonly audiences?: readonly RunEventRow['audience'][]
  /** 只取 seq 大于该值的事件（增量拉取）。 */
  readonly afterSeq?: number
  readonly limit?: number
}

/** Run Event 时间线：seq 升序；受众/游标/条数可选过滤（P1-13 GET /runs/:id/events）。 */
export async function listRunEvents(
  handle: DbHandle,
  runId: string,
  options: ListRunEventsOptions = {},
): Promise<RunEventRow[]> {
  const conditions = [eq(runEvents.runId, runId)]
  if (options.audiences !== undefined) {
    conditions.push(inArray(runEvents.audience, [...options.audiences]))
  }
  if (options.afterSeq !== undefined) conditions.push(gt(runEvents.seq, options.afterSeq))
  let query = handle
    .select()
    .from(runEvents)
    .where(and(...conditions))
    .orderBy(asc(runEvents.seq))
    .$dynamic()
  if (options.limit !== undefined) query = query.limit(options.limit)
  return query
}

/**
 * 连续水位（run.event_ack 的 throughSeq）：从 1 起无缺口的最大 seq。
 * 单列有序扫描（seq 是 bigint mode:number，避开聚合的 int8 驱动层陷阱）；
 * 缺口存在时绝不 ack 越过缺口（否则 spool 会误删未达事件）。
 */
export async function runEventWatermark(handle: DbHandle, runId: string): Promise<number> {
  const rows = await handle
    .select({ seq: runEvents.seq })
    .from(runEvents)
    .where(eq(runEvents.runId, runId))
    .orderBy(asc(runEvents.seq))
  let watermark = 0
  for (const { seq } of rows) {
    if (seq !== watermark + 1) break
    watermark = seq
  }
  return watermark
}

export interface NewTeamEvent {
  type: string
  payload: unknown
}

/** 追加持久 Team Event；返回行里的 id 即 Browser WS 补发用的 cursor（03 §5）。 */
export async function appendTeamEvent(
  handle: DbHandle,
  event: NewTeamEvent,
): Promise<TeamEventRow> {
  const [row] = await handle.insert(teamEvents).values(event).returning()
  if (row === undefined) throw new Error('insert team event returned no row')
  return row
}

/** 重连补发：列出 cursor 之后的持久 Team Event。 */
export async function listTeamEvents(
  handle: DbHandle,
  afterCursor: number = 0,
): Promise<TeamEventRow[]> {
  return handle
    .select()
    .from(teamEvents)
    .where(gt(teamEvents.id, afterCursor))
    .orderBy(asc(teamEvents.id))
}
