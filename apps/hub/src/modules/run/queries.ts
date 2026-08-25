import type { RunRow } from '@project311/db'
import { getRun, listRunsByTask } from '@project311/db'
import type { DbHandle } from '@project311/db'

/** run_status 枚举（03 §3.2），从 db schema 推断，不另持一份字面量。 */
export type RunStatus = RunRow['status']

/**
 * Run 的 JSON 视图（03 §2.6 run 表；时间为 ISO 字符串）。
 * 必须 JSON 可序列化：transactCommand 把它写进 command_receipt 供幂等重放。
 */
export interface RunView {
  id: string
  taskId: string
  ownerUserId: string
  agentId: string
  profileRevisionId: string
  deviceId: string
  workspaceId: string
  status: RunStatus
  dshSessionId: string | null
  failureCode: string | null
  failureSummary: string | null
  rerunOfRunId: string | null
  profileDigest: string
  pluginPackDigest: string
  dshDistributionVersion: string
  createdAt: string
  startedAt: string | null
  finishedAt: string | null
}

export function toRunView(row: RunRow): RunView {
  return {
    id: row.id,
    taskId: row.taskId,
    ownerUserId: row.ownerUserId,
    agentId: row.agentId,
    profileRevisionId: row.profileRevisionId,
    deviceId: row.deviceId,
    workspaceId: row.workspaceId,
    status: row.status,
    dshSessionId: row.dshSessionId,
    failureCode: row.failureCode,
    failureSummary: row.failureSummary,
    rerunOfRunId: row.rerunOfRunId,
    profileDigest: row.profileDigest,
    pluginPackDigest: row.pluginPackDigest,
    dshDistributionVersion: row.dshDistributionVersion,
    createdAt: row.createdAt.toISOString(),
    startedAt: row.startedAt?.toISOString() ?? null,
    finishedAt: row.finishedAt?.toISOString() ?? null,
  }
}

export async function getRunView(handle: DbHandle, runId: string): Promise<RunView | undefined> {
  const row = await getRun(handle, runId)
  return row === undefined ? undefined : toRunView(row)
}

export async function listRunViewsByTask(handle: DbHandle, taskId: string): Promise<RunView[]> {
  const rows = await listRunsByTask(handle, taskId)
  return rows.map(toRunView)
}
