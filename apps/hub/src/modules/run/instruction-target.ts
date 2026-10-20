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
 * 「在线」的判据**与设备读面同一事实**：`lastSeenAt` 落在 `DEVICE_ONLINE_WINDOW_MS`（30s）
 * 内（`deriveDeviceStatus`，/devices 列表与 #393 客户端闸用的也是它）。版本列非空只说明
 * 「曾经 hello 过」——断连后它不会清空，不能单独当在线用（#394：续跑曾据此建出注定失败的
 * Run）。版本列仍保留为「从未 hello」的精确拒绝分支。
 */
import { and, desc, eq, isNotNull, isNull } from 'drizzle-orm'
import type { DbHandle } from '@whalepod/db'
import { schema } from '@whalepod/db'
import { deriveDeviceStatus } from '../device/pairing.js'
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
  /**
   * 工作区不可用时抛哪个码。默认 VALIDATION_FAILED（显式新执行的历史口径）；
   * 续跑沿用来源工作区时传 WORKSPACE_UNAVAILABLE，保留 orchestrator 的 409 语义。
   */
  unavailableWorkspaceCode?: 'VALIDATION_FAILED' | 'WORKSPACE_UNAVAILABLE'
}

/**
 * 解析执行目标。返回 `undefined` = **没有可用的执行目标**（调用方据此回 409 `DEVICE_OFFLINE`
 * 且不建 Run、不落指令——"不猜"是这条链的产品要求）。
 */
export async function resolveRunTarget(
  handle: DbHandle,
  input: ResolveRunTargetInput,
  clock: () => Date = () => new Date(),
): Promise<RunTarget | undefined> {
  // 一次解析共用同一个 now：候选之间的在线判定不能各自漂移。
  // 时钟可注入：orchestrator 刷 lastSeenAt 用的是域时钟（测试里是固定值），
  // 目标解析若各自取真实时间，两边会在测试/回放里互相判成离线。
  const now = clock()
  if (input.deviceId !== undefined || input.workspaceId !== undefined) {
    const explicit = await resolveExplicit(handle, input, now)
    return explicit
  }

  const fromLastRun = await resolveFromLastRun(handle, input.taskId, input.assigneeUserId, now)
  if (fromLastRun !== undefined) return fromLastRun

  return resolveFromAssigneeDevices(handle, input.assigneeUserId, now)
}

/** 与 /devices 读面同一事实：未撤销且 lastSeenAt 在 30s 在线窗口内。 */
function isDeviceOnline(
  device: { revokedAt: Date | null; lastSeenAt: Date | null },
  now: Date,
): boolean {
  return deriveDeviceStatus(device, now) === 'online'
}

/** 显式指定：设备必须属于责任人、未撤销、在线；工作区必须属于该设备且 available。 */
async function resolveExplicit(
  handle: DbHandle,
  input: ResolveRunTargetInput,
  now: Date,
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
    // 撤销是永久失效，必须保留 orchestrator/客户端都认识的 DEVICE_REVOKED；
    // 降级成 DEVICE_OFFLINE 会让 UI 的撤销专属说明与 Q5 的 409 判据失真。
    throw new RunCommandError('DEVICE_REVOKED', 'the target device has been revoked')
  }
  if (device.dshDistributionVersion === null) {
    throw new RunCommandError('DEVICE_OFFLINE', 'the target device has not reported node.hello yet')
  }
  if (!isDeviceOnline(device, now)) {
    throw new RunCommandError('DEVICE_OFFLINE', 'the target device is offline')
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
    throw new RunCommandError(
      input.unavailableWorkspaceCode ?? 'VALIDATION_FAILED',
      'the workspace is not available',
    )
  }
  return { deviceId: device.id, workspaceId: workspace.id, source: 'explicit' }
}

/** ① 上一个 Run 用过的设备/工作区（最近一次优先；越过后仍要过可用性校验）。 */
async function resolveFromLastRun(
  handle: DbHandle,
  taskId: string,
  assigneeUserId: string,
  now: Date,
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
    // 归属校验（评审观察 6）：解析结果必须落在**责任人**的设备/工作区上。
    // 少了这一条，历史 Run 若指向他人的设备，这里会照样返回它，直到建 Run 时才以一句
    // 与真实原因无关的 403 结束——fail-closed 但误导。
    if (device.ownerUserId !== assigneeUserId) continue
    if (device.dshDistributionVersion === null) continue // 从未 hello：换下一台候选
    if (!isDeviceOnline(device, now)) continue // 已断连（版本列不清）：换下一台候选
    const workspace = await findWorkspace(handle, prior.workspaceId)
    if (workspace === undefined || !workspace.available) continue
    if (workspace.ownerUserId !== assigneeUserId) continue
    return { deviceId: device.id, workspaceId: workspace.id, source: 'last_run' }
  }
  return undefined
}

/** ② 责任人名下最近在线的设备 + 它的某个可用工作区。 */
async function resolveFromAssigneeDevices(
  handle: DbHandle,
  assigneeUserId: string,
  now: Date,
): Promise<RunTarget | undefined> {
  const candidates = await handle
    .select()
    .from(schema.devices)
    .where(
      and(
        eq(schema.devices.ownerUserId, assigneeUserId),
        isNull(schema.devices.revokedAt),
        // SQL 先筛掉「从未 hello」的设备；断连（lastSeenAt 超窗）在下面用同一个
        // deriveDeviceStatus 跳过。版本列只证明曾经 hello，不能单独当在线。
        isNotNull(schema.devices.dshDistributionVersion),
      ),
    )
    .orderBy(desc(schema.devices.lastSeenAt))
  for (const device of candidates) {
    if (device.dshDistributionVersion === null) continue // 类型收窄：isNotNull 之后仍可能被并发清空
    if (!isDeviceOnline(device, now)) continue // 断连（版本列不清）：换下一台候选
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
