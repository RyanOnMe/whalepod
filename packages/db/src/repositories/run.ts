import { and, asc, count, eq, inArray } from 'drizzle-orm'
import type { DbHandle } from '../client.js'
import { approvals, runs } from '../schema/run.js'

export type RunRow = typeof runs.$inferSelect
export type ApprovalRow = typeof approvals.$inferSelect

/** 固化列按 03 §2.6：owner/agent/revision/device/workspace/digest 创建后不可变。 */
export interface NewRun {
  id: string
  taskId: string
  ownerUserId: string
  agentId: string
  profileRevisionId: string
  deviceId: string
  workspaceId: string
  profileDigest: string
  pluginPackDigest: string
  dshDistributionVersion: string
  status?: RunRow['status']
  rerunOfRunId?: string
  dshSessionId?: string
  failureCode?: string
  failureSummary?: string
}

export async function insertRun(handle: DbHandle, run: NewRun): Promise<RunRow> {
  const [row] = await handle.insert(runs).values(run).returning()
  if (row === undefined) throw new Error('insert run returned no row')
  return row
}

export async function getRun(handle: DbHandle, id: string): Promise<RunRow | undefined> {
  const [row] = await handle.select().from(runs).where(eq(runs.id, id)).limit(1)
  return row
}

export async function listRunsByTask(handle: DbHandle, taskId: string): Promise<RunRow[]> {
  return handle.select().from(runs).where(eq(runs.taskId, taskId)).orderBy(asc(runs.createdAt))
}

/**
 * 某 Task 上的活跃 Run（与 run_one_active_per_task 部分唯一索引谓词一致；
 * 03 §3.2）。Task 取消/重新指派/提交验收前据此判断「是否存在活跃 Run」。
 * 本常量为活跃态集合的单一事实源；apps/hub 的 run reconciler 从此处导入
 * 并再导出（勿在 hub 侧另定义副本）。
 */
export const ACTIVE_RUN_STATUSES = [
  'queued',
  'dispatching',
  'running',
  'waiting_approval',
  'cancel_requested',
] as const

export async function listActiveRunsByTask(handle: DbHandle, taskId: string): Promise<RunRow[]> {
  return handle
    .select()
    .from(runs)
    .where(and(eq(runs.taskId, taskId), inArray(runs.status, [...ACTIVE_RUN_STATUSES])))
}

export interface RunStatusPatch {
  startedAt?: Date
  finishedAt?: Date
  failureCode?: string
  failureSummary?: string
  dshSessionId?: string
}

export async function setRunStatus(
  handle: DbHandle,
  id: string,
  status: RunRow['status'],
  patch: RunStatusPatch = {},
): Promise<RunRow | undefined> {
  const [row] = await handle
    .update(runs)
    .set({
      status,
      ...(patch.startedAt !== undefined ? { startedAt: patch.startedAt } : {}),
      ...(patch.finishedAt !== undefined ? { finishedAt: patch.finishedAt } : {}),
      ...(patch.failureCode !== undefined ? { failureCode: patch.failureCode } : {}),
      ...(patch.failureSummary !== undefined ? { failureSummary: patch.failureSummary } : {}),
      ...(patch.dshSessionId !== undefined ? { dshSessionId: patch.dshSessionId } : {}),
    })
    .where(eq(runs.id, id))
    .returning()
  return row
}

export interface NewApproval {
  id: string
  runId: string
  callId: string
  toolName: string
  reason: string
  preview: unknown
  expiresAt: Date
  status?: ApprovalRow['status']
  decidedBy?: string
  decidedAt?: Date
}

export async function insertApproval(
  handle: DbHandle,
  approval: NewApproval,
): Promise<ApprovalRow> {
  const [row] = await handle.insert(approvals).values(approval).returning()
  if (row === undefined) throw new Error('insert approval returned no row')
  return row
}

/**
 * P1-13 双受众去重：同一 callId 的 approval.requested 会产 owner/project 两条
 * run_event（同一 approvalId），第二条到达时按 id 幂等跳过（inserted=false）。
 * 与 appendRunEvent 的 (runId,seq) 幂等同哲学：事件源重放不产生第二行。
 */
export async function insertApprovalIfAbsent(
  handle: DbHandle,
  approval: NewApproval,
): Promise<{ inserted: boolean }> {
  const rows = await handle
    .insert(approvals)
    .values(approval)
    .onConflictDoNothing({ target: [approvals.id] })
    .returning({ id: approvals.id })
  return { inserted: rows.length > 0 }
}

export async function getApproval(handle: DbHandle, id: string): Promise<ApprovalRow | undefined> {
  const [row] = await handle.select().from(approvals).where(eq(approvals.id, id)).limit(1)
  return row
}

/**
 * 写入 Approval 已决终态（03 §3.3）。
 * 注意：decided_by 必须等于 Run owner 的约束由调用方保证（orchestrator 传入
 * run.ownerUserId），本函数只做行更新，不校验该不变式。
 */
export async function setApprovalStatus(
  handle: DbHandle,
  id: string,
  status: ApprovalRow['status'],
  decidedBy: string,
  decidedAt: Date,
): Promise<ApprovalRow | undefined> {
  const [row] = await handle
    .update(approvals)
    .set({ status, decidedBy, decidedAt })
    .where(eq(approvals.id, id))
    .returning()
  return row
}

/** Run 上仍为 pending 的 Approval 数（waiting_approval 语义，03 §3.2 特殊规则）。 */
export async function countPendingApprovals(handle: DbHandle, runId: string): Promise<number> {
  const [row] = await handle
    .select({ value: count() })
    .from(approvals)
    .where(and(eq(approvals.runId, runId), eq(approvals.status, 'pending')))
  return row?.value ?? 0
}
