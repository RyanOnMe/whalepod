import { eq } from 'drizzle-orm'
import type { ApprovalRow, RunRow } from '@whalepod/db'
import { getRun, listRunsByTask, schema } from '@whalepod/db'
import type { DbHandle } from '@whalepod/db'
import { deriveDeviceStatus } from '../device/pairing.js'
import { RunCommandError } from './errors.js'

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
  resumeFromRunId: string | null
  /** 本 Run 固化的审批档（#241）：运行卡据此标记「完全权限」。 */
  approvalPolicy: 'approval_required' | 'full_access'
  /** 任务约定绑定（#378）：null = 未绑定（历史 Run 不回填，显示「未绑定」）。 */
  specRevisionId: string | null
  /** Run 用途（#378）：business / agreement_draft / handoff_draft。 */
  purpose: RunRow['purpose']
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
    resumeFromRunId: row.resumeFromRunId,
    approvalPolicy: row.approvalPolicy,
    specRevisionId: row.specRevisionId,
    purpose: row.purpose,
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
 * （node.hello 上报，migration 0002）。缺行 / 尚未 hello（null）/ **已断连**（lastSeenAt
 * 超出 30s 在线窗口）→ undefined，routes 据此映射 DEVICE_OFFLINE。
 * **已撤销**抛 DEVICE_REVOKED（不降级成离线）：撤销是永久失效，orchestrator 与客户端
 * 都按这个词给专属说明；此前只读版本列时由 orchestrator 抛，现在写路径提前判也要保留。
 *
 * #394：版本列只写不清，单独用它会把「三天没心跳」的设备当成在线；这里与 /devices
 * 读面共用 `deriveDeviceStatus`，写路径不再有第二套「在线」真相。
 */
export async function getDeviceDshDistributionVersion(
  handle: DbHandle,
  deviceId: string,
): Promise<string | undefined> {
  const [row] = await handle
    .select({
      version: schema.devices.dshDistributionVersion,
      lastSeenAt: schema.devices.lastSeenAt,
      revokedAt: schema.devices.revokedAt,
    })
    .from(schema.devices)
    .where(eq(schema.devices.id, deviceId))
    .limit(1)
  if (row === undefined || row.version === null) return undefined
  if (row.revokedAt !== null) {
    throw new RunCommandError('DEVICE_REVOKED', 'the target device has been revoked')
  }
  if (deriveDeviceStatus({ revokedAt: null, lastSeenAt: row.lastSeenAt }, new Date()) !== 'online')
    return undefined
  return row.version
}
