import { and, asc, desc, eq, isNull, sql } from 'drizzle-orm'
import type { DbHandle } from '../client.js'
import { coordinationEvaluations } from '../schema/coordination.js'
import {
  routerApplications,
  workWaits,
  type NewRouterApplicationRow,
  type NewWorkWaitRow,
} from '../schema/work.js'

export type {
  RouterApplicationRow,
  NewRouterApplicationRow,
  WorkWaitRow,
  NewWorkWaitRow,
} from '../schema/work.js'

/**
 * ADR-0028 §17（RD-03r2）：应用记录以 evaluationId 幂等。并发应用时只有第一个
 * 插入者返回行，其余调用方回读同一行。
 */
export async function insertRouterApplication(handle: DbHandle, values: NewRouterApplicationRow) {
  const [row] = await handle
    .insert(routerApplications)
    .values(values)
    .onConflictDoNothing()
    .returning()
  return row
}

export async function getRouterApplication(handle: DbHandle, evaluationId: string) {
  const [row] = await handle
    .select()
    .from(routerApplications)
    .where(eq(routerApplications.evaluationId, evaluationId))
  return row
}

export async function listRouterApplicationsForWork(handle: DbHandle, workId: string, limit = 50) {
  return handle
    .select()
    .from(routerApplications)
    .where(eq(routerApplications.workId, workId))
    .orderBy(desc(routerApplications.appliedAt), desc(routerApplications.evaluationId))
    .limit(limit)
}

/** 已完成但尚未应用/拒收的 Router 评估；tick 用于崩溃/重启后的补做。 */
export async function listUnappliedRouterEvaluations(handle: DbHandle, limit = 20) {
  return handle
    .select({ evaluation: coordinationEvaluations })
    .from(coordinationEvaluations)
    .leftJoin(routerApplications, eq(routerApplications.evaluationId, coordinationEvaluations.id))
    .where(
      and(
        eq(coordinationEvaluations.purpose, 'router'),
        eq(coordinationEvaluations.status, 'completed'),
        isNull(routerApplications.evaluationId),
      ),
    )
    .orderBy(asc(coordinationEvaluations.finishedAt), asc(coordinationEvaluations.id))
    .limit(limit)
}

export async function insertWorkWait(handle: DbHandle, values: NewWorkWaitRow) {
  const [row] = await handle.insert(workWaits).values(values).onConflictDoNothing().returning()
  return row
}

export async function getWorkWait(handle: DbHandle, id: string) {
  const [row] = await handle.select().from(workWaits).where(eq(workWaits.id, id))
  return row
}

export async function getWorkWaitForUpdate(handle: DbHandle, id: string) {
  const [row] = await handle.select().from(workWaits).where(eq(workWaits.id, id)).for('update')
  return row
}

export async function getWorkWaitByEvaluation(handle: DbHandle, evaluationId: string) {
  const [row] = await handle
    .select()
    .from(workWaits)
    .where(eq(workWaits.evaluationId, evaluationId))
  return row
}

export async function getOpenWorkWait(handle: DbHandle, workId: string) {
  const [row] = await handle
    .select()
    .from(workWaits)
    .where(and(eq(workWaits.workId, workId), eq(workWaits.status, 'open')))
  return row
}

export async function listWorkWaits(handle: DbHandle, workId: string, limit = 50) {
  return handle
    .select()
    .from(workWaits)
    .where(eq(workWaits.workId, workId))
    .orderBy(desc(workWaits.createdAt), desc(workWaits.id))
    .limit(limit)
}

export async function closeWorkWait(
  handle: DbHandle,
  id: string,
  status: 'resumed' | 'expired' | 'superseded' | 'cancelled',
  now: Date,
) {
  const [row] = await handle
    .update(workWaits)
    .set({ status, updatedAt: now })
    .where(and(eq(workWaits.id, id), eq(workWaits.status, 'open')))
    .returning()
  return row
}

/**
 * 显式重评的代次：每次重评递增并返回新值；并发两次只有一次生效，另一次读回
 * 已经递增后的值，保证同一代次可去重。
 */
export async function advanceWorkWaitGeneration(handle: DbHandle, id: string, now: Date) {
  const [row] = await handle
    .update(workWaits)
    .set({ generation: sql`${workWaits.generation}+1`, updatedAt: now })
    .where(eq(workWaits.id, id))
    .returning()
  return row
}

/** 已开 wait 到期但尚未关闭的扫描面（#518 接自动调度；本切片只暴露显式入口）。 */
export async function listExpiredOpenWorkWaits(handle: DbHandle, now: Date, limit = 20) {
  return handle
    .select()
    .from(workWaits)
    .where(and(eq(workWaits.status, 'open'), sql`${workWaits.deadlineAt} <= ${now}`))
    .orderBy(asc(workWaits.deadlineAt), asc(workWaits.id))
    .limit(limit)
}
