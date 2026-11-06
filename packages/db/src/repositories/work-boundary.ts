import { and, asc, eq } from 'drizzle-orm'
import type { DbHandle } from '../client.js'
import {
  workRunBoundaries,
  type NewWorkRunBoundaryRow,
  type WorkRunBoundaryRow,
} from '../schema/work.js'

export type { NewWorkRunBoundaryRow, WorkRunBoundaryRow } from '../schema/work.js'

/**
 * ADR-0028 §17.1（RD-03d3）：Run 终态事务内落边界标记；同一 Run 的重复终态收敛
 * 或重启补写由 run_id 唯一性收敛，不产生第二条复核。
 */
export async function insertWorkRunBoundary(
  handle: DbHandle,
  values: NewWorkRunBoundaryRow,
): Promise<WorkRunBoundaryRow | undefined> {
  const [row] = await handle
    .insert(workRunBoundaries)
    .values(values)
    .onConflictDoNothing()
    .returning()
  return row
}

export async function getWorkRunBoundary(handle: DbHandle, id: string) {
  const [row] = await handle.select().from(workRunBoundaries).where(eq(workRunBoundaries.id, id))
  return row
}

export async function getWorkRunBoundaryForUpdate(handle: DbHandle, id: string) {
  const [row] = await handle
    .select()
    .from(workRunBoundaries)
    .where(eq(workRunBoundaries.id, id))
    .for('update')
  return row
}

export async function getWorkRunBoundaryByRun(handle: DbHandle, runId: string) {
  const [row] = await handle
    .select()
    .from(workRunBoundaries)
    .where(eq(workRunBoundaries.runId, runId))
  return row
}

/** 待复核边界；tick 每轮限量处理，剩余留给下一轮，避免单轮长时间占用 Task/Work 锁。 */
export async function listPendingWorkRunBoundaries(handle: DbHandle, limit = 20) {
  return handle
    .select()
    .from(workRunBoundaries)
    .where(eq(workRunBoundaries.status, 'pending'))
    .orderBy(asc(workRunBoundaries.createdAt), asc(workRunBoundaries.id))
    .limit(limit)
}

export async function markWorkRunBoundaryEnqueued(
  handle: DbHandle,
  id: string,
  evaluationId: string,
  now: Date,
) {
  const [row] = await handle
    .update(workRunBoundaries)
    .set({ status: 'enqueued', evaluationId, updatedAt: now })
    .where(and(eq(workRunBoundaries.id, id), eq(workRunBoundaries.status, 'pending')))
    .returning()
  return row
}

export async function markWorkRunBoundarySkipped(
  handle: DbHandle,
  id: string,
  reason: string,
  now: Date,
) {
  const [row] = await handle
    .update(workRunBoundaries)
    .set({ status: 'skipped', reason, updatedAt: now })
    .where(and(eq(workRunBoundaries.id, id), eq(workRunBoundaries.status, 'pending')))
    .returning()
  return row
}
