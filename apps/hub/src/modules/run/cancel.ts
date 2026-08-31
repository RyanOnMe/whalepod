/**
 * Run 取消的事务内写入（02 Task 6 Step 6 / 03 §3.2）。
 *
 * 抽出为独立函数，让 RunOrchestrator.cancel（P1-10）与 Task 取消（P1-06）
 * 共享同一份 run 侧写入逻辑——Task 取消带活跃 Run 时，Task transition 与
 * Run cancel Outbox 必须在同一 transaction 提交，由调用方传入同一个 tx。
 *
 * 调用方负责：行锁（for update）、权限校验、终态后视图回读。
 * 本函数只做状态迁移、Outbox 入队与 Team Event 追加。
 */
import { randomUUID } from 'node:crypto'
import { and, eq } from 'drizzle-orm'
import { decideApproval, transitionRun } from '@project311/domain'
import type { Outbox, RunRow, Tx } from '@project311/db'
import {
  appendTeamEvent,
  failInTransaction,
  findOutboxCommandsForRun,
  schema,
  setApprovalStatus,
  setRunStatus,
} from '@project311/db'
import { RunCancelSchema } from '@project311/protocol'

export interface CancelRunDeps {
  readonly outbox: Outbox
  readonly now: Date
}

/**
 * @param cause `user`（owner 自行取消）或 `admin`（Owner/Admin 代取消）；
 *   写入 run.cancel payload 供 Node 区分来源。
 * 终态 Run（completed/failed/lost）走最后 transitionRun 抛 INVALID_RUN_TRANSITION。
 */
export async function cancelRunInTransaction(
  tx: Tx,
  deps: CancelRunDeps,
  run: RunRow,
  cause: 'user' | 'admin',
): Promise<void> {
  // 幂等：重复取消不再入队第二条 run.cancel。
  if (run.status === 'cancel_requested' || run.status === 'cancelled') return

  if (run.status === 'queued') {
    transitionRun({ status: run.status }, { type: 'cancel_before_dispatch' })
    for (const pending of await findOutboxCommandsForRun(tx, {
      runId: run.id,
      pendingOnly: true,
    })) {
      await failInTransaction(tx, pending.id, deps.now)
    }
    await setRunStatus(tx, run.id, 'cancelled', { finishedAt: deps.now })
    await appendTeamEvent(tx, {
      type: 'run.changed',
      payload: { runId: run.id, taskId: run.taskId, status: 'cancelled' },
    })
    return
  }

  if (
    run.status === 'dispatching' ||
    run.status === 'running' ||
    run.status === 'waiting_approval'
  ) {
    transitionRun({ status: run.status }, { type: 'cancel_requested' })
    // G5-07：Run 取消联动关闭 pending Approval（03 §3.3 pending → cancelled）。
    // 撤回决定随 run.cancel 生效：Node 取消 Runtime，桥在 dispose 时收口全部
    // 挂起审批，无需逐条 approval.decide。
    await cancelPendingApprovalsInTransaction(tx, run, deps.now)
    const commandId = randomUUID()
    const payload = RunCancelSchema.shape.payload.parse({ commandId, runId: run.id, cause })
    await deps.outbox.enqueue(tx, {
      id: commandId,
      deviceId: run.deviceId,
      type: 'run.cancel',
      payload,
      notBefore: deps.now,
    })
    await setRunStatus(tx, run.id, 'cancel_requested')
    await appendTeamEvent(tx, {
      type: 'run.changed',
      payload: { runId: run.id, taskId: run.taskId, status: 'cancel_requested' },
    })
    return
  }

  // completed/failed/lost：非法边，抛 DomainError('INVALID_RUN_TRANSITION')。
  transitionRun({ status: run.status }, { type: 'cancel_requested' })
}

/**
 * 把 Run 上全部 pending Approval 置 cancelled 并广播 approval.changed。
 *
 * 两个触发面（同源折叠，保证「终态 Run 不挂 pending Approval」的账本不变式）：
 * - run.cancel（G5-07）：用户/管理员取消，事件 payload 不带 cause（既有形态）；
 * - Run 终态收敛（#52/ADR-0007）：Runtime 在悬置审批下的裁决（completed/failed）
 *   与表外越边的 Run 级降级收敛，传 cause='run_terminal_fold'——语义是「审批随
 *   Run 终态失效」，不是有人做出了决定（不得记 rejected/expired 伪造决定或计时）。
 *
 * 决定/失效随 Run 收口：Node 取消 Runtime 时，桥在 dispose 时收口全部挂起审批
 * （approval-port.cancelAll），无需逐条 approval.decide 下行。
 */
export async function cancelPendingApprovalsInTransaction(
  tx: Tx,
  run: RunRow,
  now: Date,
  cause?: 'run_terminal_fold',
): Promise<void> {
  const pending = await tx
    .select()
    .from(schema.approvals)
    .where(and(eq(schema.approvals.runId, run.id), eq(schema.approvals.status, 'pending')))
  for (const approval of pending) {
    // 领域门：cancel 决策不受 expiresAt 约束（03 §3.3 四条出边平权）。
    decideApproval(
      { status: approval.status, expiresAt: approval.expiresAt.getTime() },
      { type: 'cancel', at: now.getTime() },
    )
    // decided_by 记 Run owner：03 §2.6「必须等于 Run owner」的平凡满足
    //（折叠是系统写入，不存在人工决定者）。
    await setApprovalStatus(tx, approval.id, 'cancelled', run.ownerUserId, now)
    await appendTeamEvent(tx, {
      type: 'approval.changed',
      payload: {
        approvalId: approval.id,
        runId: run.id,
        taskId: run.taskId,
        status: 'cancelled',
        ...(cause === undefined ? {} : { cause }),
      },
    })
  }
}
