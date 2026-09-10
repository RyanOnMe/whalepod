/**
 * 启动恢复 reconciler（02-第一阶段实施计划.md Task 10 Step 6）。
 *
 * Hub 重启后扫描未终态 Run，以 dispatch_outbox 表为事实来源：
 * - queued：确保存在待投 run.start；行被作废（failed）时按原 payload 换发新
 *   commandId 重投（R8 判据：不得存在永久无命令的 queued Run）。
 * - dispatching/running/waiting_approval/cancel_requested：Device 租约
 *   （lastSeenAt，30 秒，03 §3.2）过期 → lost(RUNTIME_LOST)；租约内但最近心跳
 *   已不含该 Run → lost；否则补一条 run.status_request 探活。
 *
 * 每个 Run 独立事务：单个坏行不阻塞其他 Run 的恢复。
 */
import { randomUUID } from 'node:crypto'
import { eq, inArray } from 'drizzle-orm'
import type { Database, RunRow } from '@project311/db'
import {
  ACTIVE_RUN_STATUSES,
  appendTeamEvent,
  findOutboxCommandsForRun,
  Outbox,
  schema,
  setRunStatus,
} from '@project311/db'
import { RunStatusRequestSchema } from '@project311/protocol'
import { transitionRun } from '@project311/domain'
import { cancelPendingApprovalsInTransaction } from './cancel.js'

// 活跃态集合的单一事实源在 @project311/db（与 run_one_active_per_task 部分唯一索引
// 谓词一致）；此处再导出，orchestrator 与 run 模块的既有导入路径不变。
export { ACTIVE_RUN_STATUSES }

/** Node 最近一次心跳投影（§3.2：断线先写连接投影，不立即改 Run）。 */
export interface DeviceActivity {
  at: Date
  activeRunIds: ReadonlySet<string>
}

/** Device 租约（03 §3.2：30 秒无心跳进入 lost）。 */
export const DEVICE_LEASE_MS = 30_000 as const

export interface ReconcileDeps {
  database: Database
  outbox: Outbox
  /** orchestrator 的内存心跳投影（进程重启后为空，退化为只看 lastSeenAt）。 */
  activity: ReadonlyMap<string, DeviceActivity>
  now: () => Date
}

export async function reconcileLeases(deps: ReconcileDeps, now: Date): Promise<number> {
  const activeRuns = await deps.database.db
    .select()
    .from(schema.runs)
    .where(inArray(schema.runs.status, [...ACTIVE_RUN_STATUSES]))
  let acted = 0
  for (const run of activeRuns) {
    try {
      if (await reconcileOne(deps, run, now)) acted += 1
    } catch {
      // 单个 Run 的恢复失败不阻塞其余；下一轮 reconcile 会重试。
    }
  }
  return acted
}

async function reconcileOne(deps: ReconcileDeps, run: RunRow, now: Date): Promise<boolean> {
  return deps.database.transaction(async (tx) => {
    const [locked] = await tx
      .select()
      .from(schema.runs)
      .where(eq(schema.runs.id, run.id))
      .for('update')
    if (locked === undefined || !(ACTIVE_RUN_STATUSES as readonly string[]).includes(locked.status))
      return false

    if (locked.status === 'queued') {
      const pending = await findOutboxCommandsForRun(tx, {
        runId: locked.id,
        type: 'run.start',
        pendingOnly: true,
      })
      if (pending.length > 0) return false
      const existing = await findOutboxCommandsForRun(tx, { runId: locked.id, type: 'run.start' })
      const template = existing[0]
      if (template !== undefined) {
        // 原 payload 仍在（含 prompt）；换发新 commandId 重投，commandId 不复用。
        const commandId = randomUUID()
        await deps.outbox.enqueue(tx, {
          id: commandId,
          deviceId: locked.deviceId,
          type: 'run.start',
          payload: { ...(template.payload as Record<string, unknown>), commandId },
          notBefore: now,
        })
      } else {
        // 行整体丢失属数据损坏（run.start 与 Run 本应原子提交）：
        // prompt 无法重建，不得让 Run 永久挂在 queued，失败闭环。
        transitionRun({ status: locked.status }, { type: 'failed' })
        await setRunStatus(tx, locked.id, 'failed', {
          failureCode: 'INTERNAL_ERROR',
          failureSummary: 'dispatch command missing for queued run',
          finishedAt: now,
        })
        await appendTeamEvent(tx, {
          type: 'run.changed',
          payload: { runId: locked.id, taskId: locked.taskId, status: 'failed' },
        })
      }
      return true
    }

    const [device] = await tx
      .select()
      .from(schema.devices)
      .where(eq(schema.devices.id, locked.deviceId))
    const leaseFresh =
      device?.lastSeenAt !== null &&
      device?.lastSeenAt !== undefined &&
      now.getTime() - device.lastSeenAt.getTime() <= DEVICE_LEASE_MS
    const heartbeat = deps.activity.get(locked.deviceId)
    const heartbeatFresh =
      heartbeat !== undefined && now.getTime() - heartbeat.at.getTime() <= DEVICE_LEASE_MS
    // #119 新生儿宽限：「心跳新鲜但未列出」只在 Run 年龄超过一个租约窗口后才
    // 构成定罪——节点要等下一个 10s 心跳才有机会把新 Run 列进 activeRunIds，
    // 窗口内宣判会把活 Run 打成 lost（alpha.2 狗食三跑三判，最速 +353ms，
    // 且事件继续落账成僵尸 Run）。宽限与 DEVICE_LEASE_MS 同口径：「多新算
    // 来不及报」与「多久沉默算死」用同一把尺。
    const runAgeMs = now.getTime() - locked.createdAt.getTime()
    const nodeLostRun =
      heartbeatFresh && !heartbeat.activeRunIds.has(locked.id) && runAgeMs > DEVICE_LEASE_MS

    if (!leaseFresh || nodeLostRun) {
      transitionRun({ status: locked.status }, { type: 'lease_expired' })
      // ADR-0007 不变式「终态 Run 不挂 pending Approval」对 lease→lost 同样
      // 生效（#84：此前只靠 approval-expiry 10 分钟清扫兜底，窗口内账本违反
      // 不变式）。与终态收敛同一事务、同一 cause——折叠是系统写入，非人工决定。
      await cancelPendingApprovalsInTransaction(tx, locked, now, 'run_terminal_fold')
      await setRunStatus(tx, locked.id, 'lost', {
        failureCode: 'RUNTIME_LOST',
        failureSummary: 'device lease expired or node no longer runs this run',
        finishedAt: now,
      })
      await appendTeamEvent(tx, {
        type: 'run.changed',
        payload: { runId: locked.id, taskId: locked.taskId, status: 'lost' },
      })
      return true
    }

    // 在线设备上的活跃 Run：补 run.status_request 收敛 dispatching/running 真相。
    const pendingRequest = await findOutboxCommandsForRun(tx, {
      runId: locked.id,
      type: 'run.status_request',
      pendingOnly: true,
    })
    if (pendingRequest.length > 0) return false
    const commandId = randomUUID()
    await deps.outbox.enqueue(tx, {
      id: commandId,
      deviceId: locked.deviceId,
      type: 'run.status_request',
      payload: RunStatusRequestSchema.shape.payload.parse({ commandId, runId: locked.id }),
      notBefore: now,
    })
    return true
  })
}
