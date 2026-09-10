import { eq } from 'drizzle-orm'
import type { ApprovalRow, RunRow } from '@whalepod/db'
import { getRun, listRunsByTask, schema } from '@whalepod/db'
import type { DbHandle } from '@whalepod/db'

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

/**
 * Approval 决策接口的 JSON 视图（03 §2.6 approval 表；时间为 ISO 字符串）。
 * preview 是 Node 侧已脱敏的参数摘要（z.json()），Hub 不做二次改写。
 */
export interface ApprovalView {
  id: string
  runId: string
  callId: string
  toolName: string
  reason: string
  preview: unknown
  status: ApprovalRow['status']
  requestedAt: string
  expiresAt: string
  decidedBy: string | null
  decidedAt: string | null
}

export function toApprovalView(row: ApprovalRow): ApprovalView {
  return {
    id: row.id,
    runId: row.runId,
    callId: row.callId,
    toolName: row.toolName,
    reason: row.reason,
    preview: row.preview,
    status: row.status,
    requestedAt: row.requestedAt.toISOString(),
    expiresAt: row.expiresAt.toISOString(),
    decidedBy: row.decidedBy,
    decidedAt: row.decidedAt?.toISOString() ?? null,
  }
}

export async function listRunViewsByTask(handle: DbHandle, taskId: string): Promise<RunView[]> {
  const rows = await listRunsByTask(handle, taskId)
  return rows.map(toRunView)
}

/**
 * `dshDistributionVersionFor` 的真实实现（#37）：读 device.dsh_distribution_version
 * （node.hello 上报，migration 0002）。缺行或尚未 hello（null）→ undefined，
 * routes 据此映射 DEVICE_OFFLINE；P1-09 落地 hello 回填后此处即取到真实值。
 */
export async function getDeviceDshDistributionVersion(
  handle: DbHandle,
  deviceId: string,
): Promise<string | undefined> {
  const [row] = await handle
    .select({ version: schema.devices.dshDistributionVersion })
    .from(schema.devices)
    .where(eq(schema.devices.id, deviceId))
    .limit(1)
  return row?.version ?? undefined
}
