import { and, desc, eq, gt, inArray, lte, ne, sql } from 'drizzle-orm'
import type { DbHandle } from '../client.js'
import { runs } from '../schema/run.js'
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

/**
 * ADR-0028 §9：新 Mandate/撤权/改派/退休后，proposed 与已 approved 但未派发的意图
 * 都不得再被批准或派发。已 dispatched 的意图是终态，Run 的后续失败不回写意图。
 */
export async function cancelOpenDispatchIntents(
  handle: DbHandle,
  workId: string,
  now: Date,
): Promise<DispatchIntentRow[]> {
  return handle
    .update(dispatchIntents)
    .set({ status: 'cancelled', cancelledAt: now, updatedAt: now })
    .where(
      and(
        eq(dispatchIntents.workId, workId),
        inArray(dispatchIntents.status, ['proposed', 'approved']),
      ),
    )
    .returning()
}

/** @deprecated 保留旧导出名，语义已扩展为 proposed+approved；新代码用 cancelOpenDispatchIntents。 */
export const cancelProposedDispatchIntents = cancelOpenDispatchIntents

export async function getDispatchIntentForUpdate(
  handle: DbHandle,
  id: string,
): Promise<DispatchIntentRow | undefined> {
  const [row] = await handle
    .select()
    .from(dispatchIntents)
    .where(eq(dispatchIntents.id, id))
    .limit(1)
    .for('update')
  return row
}

export async function approveDispatchIntent(
  handle: DbHandle,
  id: string,
  now: Date,
): Promise<DispatchIntentRow | undefined> {
  const [row] = await handle
    .update(dispatchIntents)
    .set({
      status: 'approved',
      approvalBasis: 'human',
      approvedAt: now,
      updatedAt: now,
    })
    .where(
      and(
        eq(dispatchIntents.id, id),
        eq(dispatchIntents.status, 'proposed'),
        gt(dispatchIntents.expiresAt, now),
      ),
    )
    .returning()
  return row
}

/** approved/proposed 意图到期：落 expired 终态，避免永远停在可重试的 approved。 */
export async function expireDispatchIntent(
  handle: DbHandle,
  id: string,
  reason: string,
  now: Date,
): Promise<DispatchIntentRow | undefined> {
  const [row] = await handle
    .update(dispatchIntents)
    .set({
      status: 'expired',
      resolutionReason: reason,
      updatedAt: now,
    })
    .where(
      and(
        eq(dispatchIntents.id, id),
        inArray(dispatchIntents.status, ['proposed', 'approved']),
        lte(dispatchIntents.expiresAt, now),
      ),
    )
    .returning()
  return row
}

export async function rejectDispatchIntent(
  handle: DbHandle,
  id: string,
  reason: string,
  now: Date,
): Promise<DispatchIntentRow | undefined> {
  const [row] = await handle
    .update(dispatchIntents)
    .set({
      status: 'rejected',
      resolutionReason: reason,
      rejectedAt: now,
      updatedAt: now,
    })
    .where(
      and(
        eq(dispatchIntents.id, id),
        inArray(dispatchIntents.status, ['proposed', 'approved']),
        gt(dispatchIntents.expiresAt, now),
      ),
    )
    .returning()
  return row
}

export async function markDispatchIntentDispatched(
  handle: DbHandle,
  id: string,
  runId: string,
  target: {
    agentId: string
    profileRevisionId: string
    deviceId: string
    workspaceId: string
    actionClass: string
  },
  now: Date,
): Promise<DispatchIntentRow | undefined> {
  const [row] = await handle
    .update(dispatchIntents)
    .set({
      status: 'dispatched',
      runId,
      agentId: target.agentId,
      profileRevisionId: target.profileRevisionId,
      deviceId: target.deviceId,
      workspaceId: target.workspaceId,
      actionClass: target.actionClass,
      dispatchedAt: now,
      updatedAt: now,
    })
    .where(
      and(
        eq(dispatchIntents.id, id),
        eq(dispatchIntents.status, 'approved'),
        gt(dispatchIntents.expiresAt, now),
      ),
    )
    .returning()
  return row
}

/**
 * 某工作尚未真正开始执行的机器 Run（queued / run.start 已受理但 Runtime 未 ready）。
 *
 * 只返回 `run.mandateId` 与当前 work mandate 不一致的行：Mandate 新建/暂停/恢复/撤销
 * 会推进 work.mandateId，旧 Run 才是被取代的那一批。no-op（resume 已 active）与同 key
 * 重放不会改 work.mandateId，因此不会误伤仍是当前授权的 queued Run。
 */
export async function listCancellableMachineRunIdsForWork(
  handle: DbHandle,
  workId: string,
  currentMandateId: string | null,
): Promise<string[]> {
  const rows = await handle
    .select({ runId: dispatchIntents.runId })
    .from(dispatchIntents)
    .innerJoin(runs, eq(runs.id, dispatchIntents.runId))
    .where(
      and(
        eq(dispatchIntents.workId, workId),
        eq(dispatchIntents.status, 'dispatched'),
        eq(runs.origin, 'mandate'),
        inArray(runs.status, ['queued', 'dispatching']),
        currentMandateId === null ? undefined : ne(runs.mandateId, currentMandateId),
      ),
    )
  return rows.flatMap((row) => (row.runId === null ? [] : [row.runId]))
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
