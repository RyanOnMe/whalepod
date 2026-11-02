import { and, desc, eq, sql } from 'drizzle-orm'
import type { DbHandle } from '../client.js'
import {
  dispatchIntents,
  routerDecisions,
  workMandates,
  works,
  type DispatchIntentRow,
  type NewDispatchIntentRow,
  type NewRouterDecisionRow,
  type NewWorkMandateRow,
  type NewWorkRow,
  type RouterDecisionRow,
  type WorkMandateRow,
  type WorkRow,
} from '../schema/work.js'

export type {
  DispatchIntentRow,
  NewDispatchIntentRow,
  NewRouterDecisionRow,
  NewWorkMandateRow,
  NewWorkRow,
  RouterDecisionRow,
  WorkMandateRow,
  WorkRow,
} from '../schema/work.js'

// ADR-0028（RD-01）：work / work_mandate / router_decision / dispatch_intent 的持久化原语。
// 状态迁移与准入规则由 Hub 命令层裁决；「一个 Task 至多一份未退休工作」与
// 「同一来源版本只裁决一次」由部分/普通唯一索引兜底。

export async function insertWork(handle: DbHandle, values: NewWorkRow): Promise<WorkRow> {
  const [row] = await handle.insert(works).values(values).returning()
  if (row === undefined) throw new Error('insert work returned no row')
  return row
}

export async function getWorkById(handle: DbHandle, id: string): Promise<WorkRow | undefined> {
  const [row] = await handle.select().from(works).where(eq(works.id, id)).limit(1)
  return row
}

export async function getWorkByIdForUpdate(
  handle: DbHandle,
  id: string,
): Promise<WorkRow | undefined> {
  const [row] = await handle.select().from(works).where(eq(works.id, id)).limit(1).for('update')
  return row
}

export async function getWorkByKey(
  handle: DbHandle,
  workKey: string,
): Promise<WorkRow | undefined> {
  const [row] = await handle.select().from(works).where(eq(works.workKey, workKey)).limit(1)
  return row
}

export async function getWorkByKeyForUpdate(
  handle: DbHandle,
  workKey: string,
): Promise<WorkRow | undefined> {
  const [row] = await handle
    .select()
    .from(works)
    .where(eq(works.workKey, workKey))
    .limit(1)
    .for('update')
  return row
}

export async function getCurrentWorkByTask(
  handle: DbHandle,
  taskId: string,
): Promise<WorkRow | undefined> {
  const [row] = await handle
    .select()
    .from(works)
    .where(and(eq(works.taskId, taskId), sql`${works.state} <> 'retired'`))
    .limit(1)
  return row
}

export async function listWorksByTask(handle: DbHandle, taskId: string): Promise<WorkRow[]> {
  return handle
    .select()
    .from(works)
    .where(eq(works.taskId, taskId))
    .orderBy(desc(works.createdAt), desc(works.id))
}

export interface WorkPatch {
  readonly state?: WorkRow['state']
  readonly resumeMode?: WorkRow['resumeMode']
  readonly resumeCondition?: string | null
  readonly mandateId?: string | null
  readonly retiredAt?: Date | null
  readonly updatedAt?: Date
}

export async function updateWork(
  handle: DbHandle,
  id: string,
  patch: WorkPatch,
): Promise<WorkRow | undefined> {
  const [row] = await handle
    .update(works)
    .set({ ...patch, updatedAt: patch.updatedAt ?? new Date() })
    .where(eq(works.id, id))
    .returning()
  return row
}

export async function insertWorkMandate(
  handle: DbHandle,
  values: NewWorkMandateRow,
): Promise<WorkMandateRow> {
  const [row] = await handle.insert(workMandates).values(values).returning()
  if (row === undefined) throw new Error('insert work mandate returned no row')
  return row
}

export async function getWorkMandate(
  handle: DbHandle,
  id: string,
): Promise<WorkMandateRow | undefined> {
  const [row] = await handle.select().from(workMandates).where(eq(workMandates.id, id)).limit(1)
  return row
}

export async function getWorkMandateForUpdate(
  handle: DbHandle,
  id: string,
): Promise<WorkMandateRow | undefined> {
  const [row] = await handle
    .select()
    .from(workMandates)
    .where(eq(workMandates.id, id))
    .limit(1)
    .for('update')
  return row
}

export async function getLatestWorkMandate(
  handle: DbHandle,
  workId: string,
): Promise<WorkMandateRow | undefined> {
  const [row] = await handle
    .select()
    .from(workMandates)
    .where(eq(workMandates.workId, workId))
    .orderBy(desc(workMandates.version))
    .limit(1)
  return row
}

export async function listWorkMandates(
  handle: DbHandle,
  workId: string,
): Promise<WorkMandateRow[]> {
  return handle
    .select()
    .from(workMandates)
    .where(eq(workMandates.workId, workId))
    .orderBy(desc(workMandates.version))
}

export async function insertRouterDecision(
  handle: DbHandle,
  values: NewRouterDecisionRow,
): Promise<RouterDecisionRow | undefined> {
  const [row] = await handle
    .insert(routerDecisions)
    .values(values)
    .onConflictDoNothing()
    .returning()
  return row
}

export async function getRouterDecisionById(
  handle: DbHandle,
  id: string,
): Promise<RouterDecisionRow | undefined> {
  const [row] = await handle
    .select()
    .from(routerDecisions)
    .where(eq(routerDecisions.id, id))
    .limit(1)
  return row
}

export async function getRouterDecisionBySource(
  handle: DbHandle,
  workId: string,
  sourceType: RouterDecisionRow['sourceType'],
  sourceId: string,
  sourceVersion: string,
  sourceDigest: string,
): Promise<RouterDecisionRow | undefined> {
  const [row] = await handle
    .select()
    .from(routerDecisions)
    .where(
      and(
        eq(routerDecisions.workId, workId),
        eq(routerDecisions.sourceType, sourceType),
        eq(routerDecisions.sourceId, sourceId),
        eq(routerDecisions.sourceVersion, sourceVersion),
        eq(routerDecisions.sourceDigest, sourceDigest),
      ),
    )
    .limit(1)
  return row
}

export async function listRouterDecisions(
  handle: DbHandle,
  workId: string,
  limit: number,
): Promise<RouterDecisionRow[]> {
  return handle
    .select()
    .from(routerDecisions)
    .where(eq(routerDecisions.workId, workId))
    .orderBy(desc(routerDecisions.createdAt), desc(routerDecisions.id))
    .limit(limit)
}

export async function insertDispatchIntent(
  handle: DbHandle,
  values: NewDispatchIntentRow,
): Promise<DispatchIntentRow> {
  const [row] = await handle.insert(dispatchIntents).values(values).returning()
  if (row === undefined) throw new Error('insert dispatch intent returned no row')
  return row
}

export async function getDispatchIntent(
  handle: DbHandle,
  id: string,
): Promise<DispatchIntentRow | undefined> {
  const [row] = await handle
    .select()
    .from(dispatchIntents)
    .where(eq(dispatchIntents.id, id))
    .limit(1)
  return row
}

/** ADR-0028 §9：新 Mandate/撤权/退休后，旧 proposed 意图不得再被批准或派发。 */
export async function cancelProposedDispatchIntents(
  handle: DbHandle,
  workId: string,
  now: Date,
): Promise<DispatchIntentRow[]> {
  return handle
    .update(dispatchIntents)
    .set({ status: 'cancelled', cancelledAt: now, updatedAt: now })
    .where(and(eq(dispatchIntents.workId, workId), eq(dispatchIntents.status, 'proposed')))
    .returning()
}

export async function getDispatchIntentByDecision(
  handle: DbHandle,
  decisionId: string,
): Promise<DispatchIntentRow | undefined> {
  const [row] = await handle
    .select()
    .from(dispatchIntents)
    .where(eq(dispatchIntents.decisionId, decisionId))
    .limit(1)
  return row
}

export async function listDispatchIntents(
  handle: DbHandle,
  workId: string,
  limit: number,
): Promise<DispatchIntentRow[]> {
  return handle
    .select()
    .from(dispatchIntents)
    .where(eq(dispatchIntents.workId, workId))
    .orderBy(desc(dispatchIntents.createdAt), desc(dispatchIntents.id))
    .limit(limit)
}
