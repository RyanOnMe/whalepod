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
import { transitionRun } from '@project311/domain'
import type { Outbox, RunRow, Tx } from '@project311/db'
import {
  appendTeamEvent,
  failInTransaction,
  findOutboxCommandsForRun,
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
