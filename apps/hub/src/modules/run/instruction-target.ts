/**
 * 执行区指令的**执行目标解析**（P1-196 切片③c-2b；ADR-0010 决策 2 的执行区入口）。
 *
 * 问题：执行区里说一句「让 Agent 干这个」时，Hub 必须知道**在哪台机器、哪个工作区**跑——
 * 建 Run 的既有 API 要求显式传 `deviceId` + `workspaceId`（那是人在 UI 上选的）。
 *
 * 产品决策（2026-09-11 拍板）：**自动三段式 + 可显式覆盖**——
 *   ① 该 Task **上一个 Run** 用过的设备/工作区（"接着说"的直觉：还在这台机器这个目录里干）；
 *   ② 否则：**责任人名下**最近在线的设备 + 它的可用工作区；
 *   ③ 都不行 → **明确拒绝**（`DEVICE_OFFLINE`），不猜、不建 Run。
 * 指令显式带 `deviceId` / `workspaceId` 时**覆盖**以上全部，但仍校验归属与可用性。
 *
 * 「在线」的判据**复用既有那一套**（不在线 = `devices.dsh_distribution_version is null`，
 * 即 `node.hello` 还没上报；`queries.ts:getDeviceDshDistributionVersion` 用的同一个事实），
 * 不另造一套，避免「路由说在线、解析说离线」这种两套真相。
 */
import { and, desc, eq, isNotNull, isNull } from 'drizzle-orm'
import type { DbHandle } from '@whalepod/db'
import { schema } from '@whalepod/db'
import { RunCommandError } from './errors.js'

export interface RunTarget {
  deviceId: string
  workspaceId: string
  /** 目标是怎么被选中的——审计与 UI 提示都要能说清（"沿用上一轮" vs "自动选" vs "显式指定"）。 */
  source: 'explicit' | 'last_run' | 'assignee_device'
}

export interface ResolveRunTargetInput {
  taskId: string
  /** 责任人（③c-2b 沿用「只有责任人能驱动」，授权泛化见切片④）。 */
  assigneeUserId: string
  /** 指令显式指定的目标（覆盖自动规则）。 */
  deviceId?: string
  workspaceId?: string
}

/**
 * 解析执行目标。返回 `undefined` = **没有可用的执行目标**（调用方据此回 409 `DEVICE_OFFLINE`
 * 且不建 Run、不落指令——"不猜"是这条链的产品要求）。
 */
export async function resolveRunTarget(
  handle: DbHandle,
  input: ResolveRunTargetInput,
): Promise<RunTarget | undefined> {
  if (input.deviceId !== undefined || input.workspaceId !== undefined) {
    const explicit = await resolveExplicit(handle, input)
    return explicit
  }

  const fromLastRun = await resolveFromLastRun(handle, input.taskId)
  if (fromLastRun !== undefined) return fromLastRun

  return resolveFromAssigneeDevices(handle, input.assigneeUserId)
}

/** 显式指定：设备必须属于责任人、未撤销、已 hello；工作区必须属于该设备且 available。 */
async function resolveExplicit(
  handle: DbHandle,
  input: ResolveRunTargetInput,
): Promise<RunTarget | undefined> {
  // 只给 workspaceId 也要能用（评审 B2）：设备由 `workspace.device_id` **确定性推导**，不是猜。
  // 此前直接 `return undefined` → 路由回 409「把设备弄上线」，与真实原因（缺 deviceId）无关且误导；
  // 契约（03 §2.2 / protocol 的字段注释）明说可用 workspaceId 显式覆盖。
  let deviceId = input.deviceId
  if (deviceId === undefined) {
    if (input.workspaceId === undefined) return undefined
    const workspace = await findWorkspace(handle, input.workspaceId)
    if (workspace === undefined) {
      throw new RunCommandError('VALIDATION_FAILED', 'the specified workspace does not exist')
    }
    deviceId = workspace.deviceId
  }
  const [device] = await handle
    .select()
    .from(schema.devices)
    .where(eq(schema.devices.id, deviceId))
    .limit(1)
  if (device === undefined) return undefined
  if (device.ownerUserId !== input.assigneeUserId) {
    throw new RunCommandError('FORBIDDEN', 'the target device does not belong to the task assignee')
  }
  if (device.revokedAt !== null) {
    throw new RunCommandError('DEVICE_OFFLINE', 'the target device has been revoked')
  }
  if (device.dshDistributionVersion === null) {
    throw new RunCommandError('DEVICE_OFFLINE', 'the target device has not reported node.hello yet')
  }

  const workspace =
    input.workspaceId !== undefined
      ? await findWorkspace(handle, input.workspaceId)
      : await findAvailableWorkspaceForDevice(handle, device.id)
  if (workspace === undefined) return undefined
  if (workspace.deviceId !== device.id) {
    throw new RunCommandError('VALIDATION_FAILED', 'the workspace does not belong to the device')
  }
  if (!workspace.available) {
    throw new RunCommandError('VALIDATION_FAILED', 'the workspace is not available')
  }
  return { deviceId: device.id, workspaceId: workspace.id, source: 'explicit' }
}

/** ① 上一个 Run 用过的设备/工作区（最近一次优先；越过后仍要过可用性校验）。 */
async function resolveFromLastRun(
  handle: DbHandle,
  taskId: string,
): Promise<RunTarget | undefined> {
  const priorRuns = await handle
    .select({
      deviceId: schema.runs.deviceId,
      workspaceId: schema.runs.workspaceId,
      createdAt: schema.runs.createdAt,
    })
    .from(schema.runs)
    .where(eq(schema.runs.taskId, taskId))
    .orderBy(desc(schema.runs.createdAt))
    .limit(5)

  for (const prior of priorRuns) {
    const [device] = await handle
      .select()
      .from(schema.devices)
      .where(eq(schema.devices.id, prior.deviceId))
      .limit(1)
    if (device === undefined || device.revokedAt !== null) continue
    if (device.dshDistributionVersion === null) continue // 设备不在线：换下一台候选
    const workspace = await findWorkspace(handle, prior.workspaceId)
    if (workspace === undefined || !workspace.available) continue
    return { deviceId: device.id, workspaceId: workspace.id, source: 'last_run' }
  }
  return undefined
}

/** ② 责任人名下最近在线的设备 + 它的某个可用工作区。 */
async function resolveFromAssigneeDevices(
  handle: DbHandle,
  assigneeUserId: string,
): Promise<RunTarget | undefined> {
  const candidates = await handle
    .select()
    .from(schema.devices)
    .where(
      and(
        eq(schema.devices.ownerUserId, assigneeUserId),
        isNull(schema.devices.revokedAt),
        // 「在线」= 已 hello（与 queries.ts 的 DEVICE_OFFLINE 判据同一事实）：
        // 直接在 SQL 里筛掉没上报过的设备，别把「不在线」带进候选再靠 JS 兜。
        isNotNull(schema.devices.dshDistributionVersion),
      ),
    )
    .orderBy(desc(schema.devices.lastSeenAt))
  for (const device of candidates) {
    if (device.dshDistributionVersion === null) continue // 类型收窄：isNotNull 之后仍可能被并发清空
    const workspace = await findAvailableWorkspaceForDevice(handle, device.id)
    if (workspace === undefined) continue
    return { deviceId: device.id, workspaceId: workspace.id, source: 'assignee_device' }
  }
  return undefined
}

async function findWorkspace(handle: DbHandle, workspaceId: string) {
  const [workspace] = await handle
    .select()
    .from(schema.workspaces)
    .where(eq(schema.workspaces.id, workspaceId))
    .limit(1)
  return workspace
}

async function findAvailableWorkspaceForDevice(handle: DbHandle, deviceId: string) {
  const [workspace] = await handle
    .select()
    .from(schema.workspaces)
    .where(and(eq(schema.workspaces.deviceId, deviceId), eq(schema.workspaces.available, true)))
    .orderBy(desc(schema.workspaces.lastCheckedAt))
    .limit(1)
  return workspace
}
