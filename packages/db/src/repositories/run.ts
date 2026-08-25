import { asc, eq } from 'drizzle-orm'
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

export async function getApproval(handle: DbHandle, id: string): Promise<ApprovalRow | undefined> {
  const [row] = await handle.select().from(approvals).where(eq(approvals.id, id)).limit(1)
  return row
}
