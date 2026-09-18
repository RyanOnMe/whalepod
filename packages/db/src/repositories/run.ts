import { and, asc, count, eq, inArray } from 'drizzle-orm'
import type { DbHandle } from '../client.js'
import { approvals, runs } from '../schema/run.js'
import { devices, workspaces } from '../schema/device.js'
import { taskMessages } from '../schema/project.js'

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
  /**
   * #119：出生时间必须由调用方领域时钟显式给出，不吃 DB 默认值——reconcile
   * 的新生儿宽限拿 createdAt 与领域时钟对表，DB 墙钟会让测试与生产时钟语义分叉。
   */
  createdAt: Date
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

/**
 * 某 Task 的运行记录，**按创建时间升序**（Task Room 时间线的顺序）。
 *
 * `createdAt` 是毫秒精度的时间戳，同毫秒建两次在真实路径上被 `run_one_active_per_task`
 * 串行化挡住，但排序本身不该靠这条外部不变式：#162 的 Run 呈现用「第 N 次运行」这种
 * **位置派生**的句柄（`apps/web/src/features/task/runLabels.ts`），并列时若顺序不定，
 * 屏上的 N 会跟着飘。所以补 `asc(runs.id)` 作第二排序键，让顺序全序确定。
 */
export async function listRunsByTask(handle: DbHandle, taskId: string): Promise<RunRow[]> {
  return handle
    .select()
    .from(runs)
    .where(eq(runs.taskId, taskId))
    .orderBy(asc(runs.createdAt), asc(runs.id))
}

/**
 * 本任务所有 Run 的落点显示名（#211 B1）：`runId → { deviceName, workspaceName }`。
 *
 * 一次 LEFT JOIN（不 N+1）：设备/工作区行不在时对应名给 null（不丢 Run 行——
 * 读模型把 null 画成"未知设备"，见 `toTaskRoomRun`）。**只取 name**：id 这类
 * 内部标识不出团队投影（02 Step 1 收窄后的口径）。
 */
export async function listRunPlacementNames(
  handle: DbHandle,
  taskId: string,
): Promise<Map<string, { deviceName: string | null; workspaceName: string | null }>> {
  const rows = await handle
    .select({
      runId: runs.id,
      deviceName: devices.name,
      workspaceName: workspaces.name,
    })
    .from(runs)
    .leftJoin(devices, eq(runs.deviceId, devices.id))
    .leftJoin(workspaces, eq(runs.workspaceId, workspaces.id))
    .where(eq(runs.taskId, taskId))
  return new Map(
    rows.map((row) => [
      row.runId,
      { deviceName: row.deviceName, workspaceName: row.workspaceName },
    ]),
  )
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

/**
 * 终态集合（03 §3.2）：写进这些状态后 Run 不再推进。
 *
 * **导出为单一事实源**（#187 评审 N3）：此前这个集合在 3 处各写一份
 *（本文件、`apps/hub/.../orchestrator.ts`、`.../followup.ts`），改一处就会漂移。
 */
export const TERMINAL_RUN_STATUSES: ReadonlySet<RunRow['status']> = new Set([
  'completed',
  'failed',
  'cancelled',
  'lost',
])

/**
 * Hub 侧「指令为什么没被受理」的理由标签（#187 评审 N4）：写进
 * `task_message.instruction_error_code`，与 Node ack 透传的 wire ErrorCode 分属两套词表
 *（见 03 §2.2）。集中定义，避免两侧各写裸字符串。
 */
export const INSTRUCTION_REFUSAL = {
  /** Run 已经答完：追问只能改走新回合。 */
  RUN_TERMINAL: 'RUN_TERMINAL',
  /** 取消已经在路上，排队必然被终态打断。 */
  RUN_CANCELLING: 'RUN_CANCELLING',
} as const

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
  // 派生状态维护（ADR-0009 决策 3）：Run 进终态时，该 Run 上仍 pending 的追问一律落
  // rejected(RUN_TERMINAL)——否则「等待审批时追问 → 取消 → lost」会让消息永久停在 pending
  //（Node 已死，ack 永远不会来；outbox 对瞬时错误没有重试上限）。放在这里是因为
  // `setRunStatus` 是**所有**终态迁移的唯一收敛点（16 处调用），漏挂一个路径就会留口子；
  // 而 `settleInstruction` 只从 pending 收敛，所以多挂点、重复调用都安全。
  if (row !== undefined && TERMINAL_RUN_STATUSES.has(status)) {
    await handle
      .update(taskMessages)
      .set({
        instructionState: 'rejected',
        instructionErrorCode: INSTRUCTION_REFUSAL.RUN_TERMINAL,
        instructionErrorMessage: `run reached ${status} before the followup was accepted`,
      })
      .where(and(eq(taskMessages.runId, id), eq(taskMessages.instructionState, 'pending')))
  }
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

/** 该 Device 是否承载该 Task 的 Run（Node Artifact 下载授权判据，P1-15）。 */
export async function deviceHasRunOnTask(
  handle: DbHandle,
  deviceId: string,
  taskId: string,
): Promise<boolean> {
  const [row] = await handle
    .select({ id: runs.id })
    .from(runs)
    .where(and(eq(runs.deviceId, deviceId), eq(runs.taskId, taskId)))
    .limit(1)
  return row !== undefined
}
