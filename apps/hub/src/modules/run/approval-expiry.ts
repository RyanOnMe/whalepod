/**
 * Approval 过期清扫（03 §3.3 pending → expired；04 G5-05「等价拒绝」）。
 *
 * 挂起的 Approval 到达 expires_at 仍无决定时：
 * - 行写入 expired（decided_by 记 Run owner——03 §2.6「必须等于 Run owner」
 *   的平凡满足；语义上是一次无人做出的决定）；
 * - 等价拒绝：向 Node 派发 approval.decide(rejected)，让 DSH 侧挂起的审批
 *   请求以拒绝收口，Agent 得以继续生成解释（与 G5-04 拒绝路径同果）；
 * - 最后一条 pending 结束后 Run 从 waiting_approval 回 running。
 *
 * 由组合根（server.ts）随租约 reconcile 同周期驱动；幂等：已决行不再入选，
 * 重复清扫不产生第二命令/事件。
 */
import { randomUUID } from 'node:crypto'
import { and, eq, lte } from 'drizzle-orm'
import { decideApproval, transitionRun } from '@whalepod/domain'
import type { Database, Outbox, Tx } from '@whalepod/db'
import {
  appendTeamEvent,
  countPendingApprovals,
  schema,
  setApprovalStatus,
  setRunStatus,
} from '@whalepod/db'
import { ApprovalDecideSchema } from '@whalepod/protocol'

export interface ExpirySweepDeps {
  readonly database: Database
  readonly outbox: Outbox
  readonly now: () => Date
}

export async function expireApprovals(deps: ExpirySweepDeps, now: Date): Promise<number> {
  const due = await deps.database.db
    .select({ approval: schema.approvals, run: schema.runs })
    .from(schema.approvals)
    .innerJoin(schema.runs, eq(schema.approvals.runId, schema.runs.id))
    .where(and(eq(schema.approvals.status, 'pending'), lte(schema.approvals.expiresAt, now)))
  let acted = 0
  for (const row of due) {
    try {
      if (await expireOne(deps, row.approval.id, now)) acted += 1
    } catch {
      // 单行失败不阻塞其余；下一轮清扫重试。
    }
  }
  return acted
}

async function expireOne(deps: ExpirySweepDeps, approvalId: string, now: Date): Promise<boolean> {
  return deps.database.transaction(async (tx: Tx) => {
    const [approval] = await tx
      .select()
      .from(schema.approvals)
      .where(eq(schema.approvals.id, approvalId))
      .for('update')
    if (approval === undefined || approval.status !== 'pending') return false
    if (approval.expiresAt.getTime() > now.getTime()) return false // 并发下已被决定
    const [run] = await tx
      .select()
      .from(schema.runs)
      .where(eq(schema.runs.id, approval.runId))
      .for('update')
    if (run === undefined) return false

    // 领域门（03 §3.3）：expire 决策允许落在过期点及之后。
    decideApproval(
      { status: approval.status, expiresAt: approval.expiresAt.getTime() },
      { type: 'expire', at: now.getTime() },
    )
    const row = await setApprovalStatus(tx, approval.id, 'expired', run.ownerUserId, now)
    if (row === undefined) throw new Error('approval expiry lost in its own transaction')
    await appendTeamEvent(tx, {
      type: 'approval.changed',
      payload: {
        approvalId: approval.id,
        runId: run.id,
        taskId: run.taskId,
        status: 'expired',
      },
    })

    // 等价拒绝：仅当 Run 仍在等待审批时才需要解除 Runtime 的挂起请求。
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
          decision: 'rejected',
        }),
        notBefore: now,
      })
      const remainingPending = await countPendingApprovals(tx, run.id)
      const next = transitionRun(
        { status: run.status },
        { type: 'approval_closed', remainingPending },
      )
      if (next.status !== run.status) {
        await setRunStatus(tx, run.id, next.status)
        await appendTeamEvent(tx, {
          type: 'run.changed',
          payload: { runId: run.id, taskId: run.taskId, status: next.status },
        })
      }
    }
    return true
  })
}
