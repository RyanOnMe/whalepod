import { and, count, desc, eq, gt, inArray, isNull, lte, ne, or, sql } from 'drizzle-orm'
import { alias } from 'drizzle-orm/pg-core'
import type { DbHandle } from '../client.js'
import { runs } from '../schema/run.js'
import type { RunRow } from './run.js'
import {
  dispatchIntents,
  routerDecisions,
  workMandates,
  workQuestionAnswers,
  workQuestions,
  works,
  type DispatchIntentRow,
  type NewDispatchIntentRow,
  type NewRouterDecisionRow,
  type NewWorkMandateRow,
  type NewWorkQuestionAnswerRow,
  type NewWorkQuestionRow,
  type NewWorkRow,
  type RouterDecisionRow,
  type WorkMandateRow,
  type WorkQuestionAnswerRow,
  type WorkQuestionRow,
  type WorkRow,
} from '../schema/work.js'

export type {
  DispatchIntentRow,
  NewDispatchIntentRow,
  NewRouterDecisionRow,
  NewWorkMandateRow,
  NewWorkQuestionAnswerRow,
  NewWorkQuestionRow,
  NewWorkRow,
  RouterDecisionRow,
  WorkMandateRow,
  WorkQuestionAnswerRow,
  WorkQuestionRow,
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
  readonly humanOwnerUserId?: string
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

/**
 * ADR-0028 §8（RD-03d2a）：按意图 id 取消单条尚未派发的意图；回答 deny/cancel/retry 时用。
 * 已 dispatched/终态的行不受影响（返回 undefined），由调用方决定是否视为无副作用。
 */
export async function cancelDispatchIntentById(
  handle: DbHandle,
  id: string,
  reason: string,
  now: Date,
): Promise<DispatchIntentRow | undefined> {
  const [row] = await handle
    .update(dispatchIntents)
    .set({
      status: 'cancelled',
      resolutionReason: reason,
      cancelledAt: now,
      updatedAt: now,
    })
    .where(
      and(eq(dispatchIntents.id, id), inArray(dispatchIntents.status, ['proposed', 'approved'])),
    )
    .returning()
  return row
}

/** RD-03d2a：写入问题账本；同一 decisionId 的 open 唯一性由部分索引兜底。 */
export async function insertWorkQuestion(
  handle: DbHandle,
  values: NewWorkQuestionRow,
): Promise<WorkQuestionRow> {
  const [row] = await handle.insert(workQuestions).values(values).returning()
  if (row === undefined) throw new Error('insert work question returned no row')
  return row
}

export async function getOpenWorkQuestion(
  handle: DbHandle,
  decisionId: string,
): Promise<WorkQuestionRow | undefined> {
  const [row] = await handle
    .select()
    .from(workQuestions)
    .where(and(eq(workQuestions.decisionId, decisionId), eq(workQuestions.status, 'open')))
    .limit(1)
  return row
}

/** 同一确定性决定的任意状态问题；已回答/已关闭的决定不因重复准入重新开问。 */
export async function getWorkQuestionByDecision(
  handle: DbHandle,
  decisionId: string,
): Promise<WorkQuestionRow | undefined> {
  const [row] = await handle
    .select()
    .from(workQuestions)
    .where(eq(workQuestions.decisionId, decisionId))
    .orderBy(desc(workQuestions.createdAt), desc(workQuestions.id))
    .limit(1)
  return row
}

/** 回答路径锁 Work 之后再锁问题；锁序与宿主事务保持一致（Task → Work → question）。 */
export async function getWorkQuestionForUpdate(
  handle: DbHandle,
  workId: string,
  decisionId: string,
): Promise<WorkQuestionRow | undefined> {
  const [row] = await handle
    .select()
    .from(workQuestions)
    .where(and(eq(workQuestions.workId, workId), eq(workQuestions.decisionId, decisionId)))
    .orderBy(desc(workQuestions.createdAt), desc(workQuestions.id))
    .limit(1)
    .for('update')
  return row
}

export async function listOpenWorkQuestions(
  handle: DbHandle,
  workId: string,
  limit = 50,
): Promise<WorkQuestionRow[]> {
  return handle
    .select()
    .from(workQuestions)
    .where(and(eq(workQuestions.workId, workId), eq(workQuestions.status, 'open')))
    .orderBy(desc(workQuestions.createdAt), desc(workQuestions.id))
    .limit(limit)
}

/** 只允许 open → answered；并发回答的败者拿到 undefined。 */
export async function markWorkQuestionAnswered(
  handle: DbHandle,
  id: string,
  now: Date,
): Promise<WorkQuestionRow | undefined> {
  const [row] = await handle
    .update(workQuestions)
    .set({ status: 'answered', answeredAt: now, closedAt: now, updatedAt: now })
    .where(and(eq(workQuestions.id, id), eq(workQuestions.status, 'open')))
    .returning()
  return row
}

export async function insertWorkQuestionAnswer(
  handle: DbHandle,
  values: NewWorkQuestionAnswerRow,
): Promise<WorkQuestionAnswerRow> {
  const [row] = await handle.insert(workQuestionAnswers).values(values).returning()
  if (row === undefined) throw new Error('insert work question answer returned no row')
  return row
}

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

/** 自动派工：候选评估失败但意图仍可重试时，只更新候选/排除理由，不推进状态。 */
export async function setDispatchIntentCandidates(
  handle: DbHandle,
  id: string,
  candidates: unknown[],
  exclusionReasons: unknown[],
  now: Date,
): Promise<DispatchIntentRow | undefined> {
  const [row] = await handle
    .update(dispatchIntents)
    .set({ candidates, exclusionReasons, updatedAt: now })
    .where(
      and(eq(dispatchIntents.id, id), inArray(dispatchIntents.status, ['proposed', 'approved'])),
    )
    .returning()
  return row
}

/**
 * ADR-0028 §6（RD-03b）：autoDispatch='existing_task' 的系统派工。
 * 不经过人类 approve，但必须同时落 `approvalBasis='mandate'` 与 approvedAt，
 * 满足 `dispatch_intent_status_fields`；CAS 只允许 proposed，防止与人工 approve 竞态。
 */
export async function markDispatchIntentAutoDispatched(
  handle: DbHandle,
  id: string,
  runId: string,
  target: {
    agentId: string
    profileRevisionId: string
    deviceId: string
    workspaceId: string
    actionClass: string
    candidates: unknown[]
    exclusionReasons: unknown[]
  },
  now: Date,
): Promise<DispatchIntentRow | undefined> {
  const [row] = await handle
    .update(dispatchIntents)
    .set({
      status: 'dispatched',
      approvalBasis: 'mandate',
      approvedAt: now,
      dispatchedAt: now,
      runId,
      agentId: target.agentId,
      profileRevisionId: target.profileRevisionId,
      deviceId: target.deviceId,
      workspaceId: target.workspaceId,
      actionClass: target.actionClass,
      candidates: target.candidates,
      exclusionReasons: target.exclusionReasons,
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

/** 某工作已发生的机器 Run 总数（maxRunsPerWork 硬闸）。 */
export async function countMachineRunsForWork(handle: DbHandle, workKey: string): Promise<number> {
  const [row] = await handle
    .select({ value: count() })
    .from(runs)
    .where(and(eq(runs.workKey, workKey), eq(runs.origin, 'mandate')))
  return row?.value ?? 0
}

/** 某工作已失败/取消/丢失的机器 Run 数（maxAttempts 硬闸）。 */
export async function countFailedMachineRunsForWork(
  handle: DbHandle,
  workKey: string,
): Promise<number> {
  const [row] = await handle
    .select({ value: count() })
    .from(runs)
    .where(
      and(
        eq(runs.workKey, workKey),
        eq(runs.origin, 'mandate'),
        inArray(runs.status, ['failed', 'cancelled', 'lost']),
      ),
    )
  return row?.value ?? 0
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

/**
 * ADR-0028 §9（RD-03c2）：需要实时失效的在途机器 Run 事实。
 *
 * SQL 只做粗筛（work 缺失/非 active/mandate 指针变了/当前 Mandate 非 active 或
 * 到期）；活跃 Run 自己的 `waiting(auto, run:<id>)` 也会被粗筛命中，由调用方的
 * reason 映射排除健康行。200 上限是单 tick 的保护，不是正确性依赖。
 */
export interface MachineRunMandateFacts {
  readonly runId: string
  readonly deviceId: string
  readonly mandateId: string | null
  readonly status: RunRow['status']
  readonly workState: WorkRow['state'] | null
  readonly workResumeMode: WorkRow['resumeMode'] | null
  readonly workResumeCondition: string | null
  readonly workMandateId: string | null
  readonly mandateStatus: WorkMandateRow['status'] | null
  readonly mandateExpiresAt: Date | null
  /** 当前 Work 指针指向的 Mandate（与 run.mandateId 不同时用于区分 paused/revoked/changed）。 */
  readonly currentMandateStatus: WorkMandateRow['status'] | null
  readonly currentMandateExpiresAt: Date | null
}

export interface ListMachineRunsForInvalidationOptions {
  readonly now: Date
  /** 只扫某个 Work（Mandate 变更回调）；缺省为全局周期清扫。 */
  readonly workId?: string
  readonly limit?: number
}

export async function listMachineRunsForMandateInvalidation(
  handle: DbHandle,
  options: ListMachineRunsForInvalidationOptions,
): Promise<MachineRunMandateFacts[]> {
  const currentMandates = alias(workMandates, 'current_work_mandates')
  const suspicious = or(
    isNull(works.id),
    ne(works.state, 'active'),
    sql`${works.mandateId} is distinct from ${runs.mandateId}`,
    isNull(workMandates.id),
    ne(workMandates.status, 'active'),
    lte(workMandates.expiresAt, options.now),
  )
  const rows = await handle
    .select({
      runId: runs.id,
      deviceId: runs.deviceId,
      mandateId: runs.mandateId,
      status: runs.status,
      workState: works.state,
      workResumeMode: works.resumeMode,
      workResumeCondition: works.resumeCondition,
      workMandateId: works.mandateId,
      mandateStatus: workMandates.status,
      mandateExpiresAt: workMandates.expiresAt,
      currentMandateStatus: currentMandates.status,
      currentMandateExpiresAt: currentMandates.expiresAt,
    })
    .from(runs)
    .leftJoin(works, eq(works.workKey, runs.workKey))
    .leftJoin(workMandates, eq(workMandates.id, runs.mandateId))
    .leftJoin(currentMandates, eq(currentMandates.id, works.mandateId))
    .where(
      and(
        eq(runs.origin, 'mandate'),
        inArray(runs.status, ['running', 'waiting_approval']),
        isNull(runs.mandateInvalidatedAt),
        options.workId === undefined ? undefined : eq(works.id, options.workId),
        suspicious,
      ),
    )
    .orderBy(runs.createdAt, runs.id)
    .limit(options.limit ?? 200)
  return rows
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
