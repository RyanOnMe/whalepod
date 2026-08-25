import { asc, eq, gt } from 'drizzle-orm'
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

export async function listRunEvents(handle: DbHandle, runId: string): Promise<RunEventRow[]> {
  return handle
    .select()
    .from(runEvents)
    .where(eq(runEvents.runId, runId))
    .orderBy(asc(runEvents.seq))
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
