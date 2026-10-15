import { and, eq, isNull } from 'drizzle-orm'
import {
  appendTeamEvent,
  getEnabledMember,
  getTeam,
  resolveInstructionRight,
  schema,
  settleInstruction,
  type Tx,
} from '@whalepod/db'

/** 补发时按当前事实判断；成员停用也不能继续驱动。仅查询状态，不扩大任何权限。 */
export async function instructionAuthorAllowed(
  tx: Tx,
  taskId: string,
  userId: string,
): Promise<boolean> {
  // 与停用成员的User写锁串行化：本次补发提交前启用状态不被改写。
  const [account] = await tx
    .select({ disabledAt: schema.userAccounts.disabledAt })
    .from(schema.userAccounts)
    .where(eq(schema.userAccounts.id, userId))
    .for('share')
  if (account === undefined || account.disabledAt !== null) return false
  const team = await getTeam(tx)
  if (team === undefined || (await getEnabledMember(tx, team.id, userId)) === undefined)
    return false
  return (await resolveInstructionRight(tx, taskId, userId)) !== 'none'
}

export async function rejectUndeliveredInstruction(tx: Tx, message: { id: string }): Promise<void> {
  const settled = await settleInstruction(tx, message.id, {
    state: 'rejected',
    error: { code: 'FORBIDDEN', message: '发送者已失去指令权限；尚未开始派发的追问已拒绝。' },
  })
  if (settled !== undefined)
    await appendTeamEvent(tx, {
      type: 'comment.created',
      payload: {
        commentId: settled.id,
        taskId: settled.taskId,
        authorUserId: settled.authorUserId,
      },
    })
}

/** 调用方已持Task→活跃Run锁。Outbox→消息与followup ack同序；第一次claim是无法保证撤回的边界。 */
export async function rejectUnattemptedFollowups(
  tx: Tx,
  taskId: string,
  userId: string,
): Promise<void> {
  const messages = await tx
    .select({ id: schema.taskMessages.id })
    .from(schema.taskMessages)
    .where(
      and(
        eq(schema.taskMessages.taskId, taskId),
        eq(schema.taskMessages.authorUserId, userId),
        eq(schema.taskMessages.kind, 'followup'),
        eq(schema.taskMessages.instructionState, 'pending'),
      ),
    )
  for (const message of messages) {
    const commands = await tx
      .select()
      .from(schema.dispatchOutbox)
      .where(
        and(
          eq(schema.dispatchOutbox.messageId, message.id),
          eq(schema.dispatchOutbox.type, 'run.followup'),
        ),
      )
      .for('update')
    if (
      commands.some((row) => row.attemptCount > 0 || row.ackedAt !== null || row.failedAt !== null)
    )
      continue
    for (const command of commands)
      await tx
        .update(schema.dispatchOutbox)
        .set({ failedAt: new Date() })
        .where(
          and(
            eq(schema.dispatchOutbox.id, command.id),
            eq(schema.dispatchOutbox.attemptCount, 0),
            isNull(schema.dispatchOutbox.ackedAt),
            isNull(schema.dispatchOutbox.failedAt),
          ),
        )
    await rejectUndeliveredInstruction(tx, message)
  }
}
