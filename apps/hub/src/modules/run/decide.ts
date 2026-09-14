/**
 * Approval 一次性决策的事务内写入（03 §3.3/§4；P1-14）。
 *
 * 抽出为独立函数（与 cancelRunInTransaction 同哲学）：HTTP 路由
 * （POST /approvals/:approvalId/decisions）与未来其他入口共享同一份
 * first-wins 语义，调用方负责行锁（for update）与 NotFound 判定。
 *
 * 不变量：
 * - owner-only：authorize(ctx, 'decide_approval', { ownerUserId })，团队
 *   Owner/Admin 角色不豁免（G5-02；decide_approval 是 publish_artifact 同款
 *   的「只属于资源 owner」动作）。
 * - first-wins：第一条有效决定获胜；重复相同决定幂等返回第一次结果（不重发
 *   命令、不重复事件）；冲突决定抛 APPROVAL_ALREADY_DECIDED。
 * - 过期即拒：pending 但 now >= expires_at 的 allow/reject 抛 APPROVAL_EXPIRED，
 *   行保持 pending（终态由过期清扫写入，G5-05）。
 * - 决定生效即派发 approval.decide 命令（Run 处于 waiting_approval 时），
 *   Node 转发 stdin 解除 DSH 挂起的审批请求；Run 回 running（最后一条
 *   pending 结束，03 §3.2 特殊规则）。
 */
import { randomUUID } from 'node:crypto'
import { asUserId, authorize, decideApproval, transitionRun } from '@whalepod/domain'
import type { ApprovalRow, Outbox, RunRow, Tx } from '@whalepod/db'
import { appendTeamEvent, countPendingApprovals, setApprovalStatus } from '@whalepod/db'
import { ApprovalDecideSchema } from '@whalepod/protocol'
import { applyRunStatus } from './run-status.js'
import type { ActorContext } from './commands.js'
import { RunCommandError } from './errors.js'

export interface DecideApprovalDeps {
  readonly outbox: Outbox
  readonly now: Date
}

export type ApprovalDecisionInput = 'allowed_once' | 'rejected'

/**
 * 在调用方事务内应用决定并返回已决行。approval/run 必须已由调用方
 * `for update` 锁定（并发同决由此串行化，G5-06 first-wins 的机制基础）。
 */
export async function decideApprovalInTransaction(
  tx: Tx,
  deps: DecideApprovalDeps,
  approval: ApprovalRow,
  run: RunRow,
  actor: ActorContext,
  decision: ApprovalDecisionInput,
): Promise<ApprovalRow> {
  if (!authorize(actor, 'decide_approval', { ownerUserId: asUserId(run.ownerUserId) })) {
    throw new RunCommandError('FORBIDDEN', 'only the run owner can decide an approval')
  }

  const outcome = decision === 'allowed_once' ? 'allowed_once' : 'rejected'
  if (approval.status !== 'pending') {
    if (approval.status === outcome) return approval // 重复相同决定：返回第一次结果
    throw new RunCommandError(
      'APPROVAL_ALREADY_DECIDED',
      `approval already ${approval.status}; cannot apply ${decision}`,
    )
  }

  // 领域门（03 §3.3）：过期后的 allow/reject 拒绝且行保持 pending；
  // 正常路径返回的 decidedAt 与本函数写入一致。
  decideApproval(
    { status: approval.status, expiresAt: approval.expiresAt.getTime() },
    { type: decision === 'allowed_once' ? 'allow_once' : 'reject', at: deps.now.getTime() },
  )

  const row = await setApprovalStatus(tx, approval.id, outcome, run.ownerUserId, deps.now)
  if (row === undefined) throw new Error('approval update lost in its own transaction')
  await appendTeamEvent(tx, {
    type: 'approval.changed',
    payload: {
      approvalId: approval.id,
      runId: run.id,
      taskId: run.taskId,
      status: outcome,
    },
  })

  // Run 处于 waiting_approval 才有挂起的 DSH 审批请求可解除；其余状态
  // （理论上不应有 pending）只闭环行，不向已不在等待的 Runtime 派发命令。
  if (run.status === 'waiting_approval') {
    const commandId = randomUUID()
    await deps.outbox.enqueue(tx, {
      id: commandId,
      deviceId: run.deviceId,
      type: 'approval.decide',
      payload: ApprovalDecideSchema.shape.payload.parse({
        commandId,
        runId: run.id,
        approvalId: approval.id,
        callId: approval.callId,
        decision,
      }),
      notBefore: deps.now,
    })
    const remainingPending = await countPendingApprovals(tx, run.id)
    const next = transitionRun(
      { status: run.status },
      { type: 'approval_closed', remainingPending },
    )
    if (next.status !== run.status) {
      // 收口（评审 B1）：HTTP 审批决策是**真人主路径**，同一事务里把 waiting_approval → running，
      // 审批期间排队的追问必须在这里放行（Node 回显的 approval.decided 到达时已经不是该状态）。
      await applyRunStatus(tx, deps.outbox, run.id, next.status)
      await appendTeamEvent(tx, {
        type: 'run.changed',
        payload: { runId: run.id, taskId: run.taskId, status: next.status },
      })
    }
  }
  return row
}
