/**
 * Hub 侧「往活跃 Run 里继续说话」的命令层（#186 / ADR-0009 决策 3、5）。
 *
 * 这是切片③b 的核心：把线程消息变成**可审计的驱动事实**。
 *   - 受理成功 → 消息 `accepted`；被拒 → 消息 `rejected` **并落理由**（migration 0004）。
 *   - 驱动通道是既有的 `run.followup` 下行帧（切片② 已铺到 Node），Hub 这半边此前**没有发送方**。
 *
 * 受理规则按 ADR-0009 决策 5（只认**状态**，不猜 Node 内部）：
 *   - `running` → 受理，Node 立刻写 Runtime stdin；
 *   - `waiting_approval` → **受理但排队**（Node 侧进程还在，帧进 stdin 队列，等审批落地后模型才读到）；
 *   - 其余状态（`queued` / `dispatching` / `cancel_requested` / 各终态）→ **不受理**，
 *     立即以 `INVALID_RUN_TRANSITION` 落一条 `rejected` 消息——不排在队列里等一个可能永远不来的状态。
 *
 * 授权按现行不变量（只有 Task 责任人能驱动执行，`orchestrator.ts:130-132` 同款）：
 * 授权名单 `task_instruction_grant` 属切片④，本片**不放宽**任何权限。
 */
import { eq } from 'drizzle-orm'
import type { Actor } from '@whalepod/domain'
import type { Database, Outbox, TaskMessageRow, Tx } from '@whalepod/db'
import {
  appendTeamEvent,
  insertMessage,
  schema,
  settleInstruction,
  transactCommand,
} from '@whalepod/db'
import { RunCommandError } from './errors.js'
import { toCommentView } from '../task/queries.js'
import type { CommentView } from '../task/queries.js'
import { uuidv7 } from '../shared/uuid.js'

/** `waiting_approval` 也算受理：进程在，帧会排队，审批落地后模型读得到（决策 5）。 */
const FOLLOWUP_ACCEPTING_STATUSES = new Set(['running', 'waiting_approval'])

export interface SendFollowupInput {
  text: string
  idempotencyKey: string
}

/**
 * 往 Run 里发一条追问。返回线程消息视图（含受理状态）——调用方据此回 201/202。
 *
 * 幂等：同 `idempotencyKey` 重放直接返回首次结果（`transactCommand` 回执），不会二次入队
 * ——否则 Hub 重试会把同一句话注入两次。
 */
export async function sendRunFollowup(
  database: Database,
  outbox: Outbox,
  actor: Actor,
  runId: string,
  input: SendFollowupInput,
): Promise<CommentView> {
  if (input.text.trim().length === 0) {
    throw new RunCommandError('VALIDATION_FAILED', 'followup text must not be empty')
  }
  if (input.idempotencyKey.trim().length === 0) {
    throw new RunCommandError('VALIDATION_FAILED', 'idempotency key is required')
  }

  return transactCommand(database, `run.followup:${input.idempotencyKey}`, async (tx) => {
    // 锁 Run 行：受理判定与入队必须在同一把锁下（否则两个并发追问可能都判到 running 并各自入队，
    // 而其中一个本该在状态已变后被拒——ADR-0009 决策 5 的「按状态受理」要求判定串行）。
    const [run] = await tx.select().from(schema.runs).where(eq(schema.runs.id, runId)).for('update')
    if (run === undefined) throw new RunCommandError('NOT_FOUND', 'run not found')

    const [task] = await tx
      .select()
      .from(schema.tasks)
      .where(eq(schema.tasks.id, run.taskId))
      .for('update')
    if (task === undefined) throw new RunCommandError('NOT_FOUND', 'task not found')
    // 执行主体不变量（ADR-0009 决策 4）：只有 Task 责任人能往 Run 里说话。切片④ 才引入授权名单。
    if (task.assigneeUserId !== actor.userId) {
      throw new RunCommandError('FORBIDDEN', 'only the task assignee can follow up on a run')
    }

    const messageId = uuidv7()
    const common = {
      id: messageId,
      taskId: run.taskId,
      authorUserId: actor.userId,
      body: input.text,
      kind: 'followup' as const,
      origin: 'human' as const,
      targetAgentId: run.agentId,
      runId: run.id,
    }

    if (!FOLLOWUP_ACCEPTING_STATUSES.has(run.status)) {
      // 不受理也要留痕：线程里出现这条消息，带明确状态与理由（不静默丢弃）。
      const message = await insertMessage(tx, {
        ...common,
        instructionState: 'rejected',
        instructionErrorCode: 'INVALID_RUN_TRANSITION',
        instructionErrorMessage: `run is ${run.status}; followup is only accepted while running or waiting for approval`,
      })
      await appendTeamEvent(tx, {
        type: 'comment.created',
        payload: {
          commentId: message.id,
          taskId: message.taskId,
          authorUserId: message.authorUserId,
        },
      })
      return toCommentView(message)
    }

    // 受理：先落 pending 消息，再入队命令；ack 回来时按 commandId 找回来收敛（migration 0004）。
    const message = await insertMessage(tx, { ...common, instructionState: 'pending' })
    const commandId = uuidv7()
    await outbox.enqueue(tx, {
      id: commandId,
      deviceId: run.deviceId,
      type: 'run.followup',
      // 载荷必须**恰好**是 wire 帧的载荷：node-wire 的 `run.followup` 是
      // `{commandId, runId, text}`，commandId 是 Node 回 ack 的依据（切片② §6.3）。
      // 少一个字段 worker 的 NodeDownstreamSchema 校验就会把行判为 permanent fail
      // （#186 实测：漏 commandId 时命令静默躺在表里，一条都没派发出去）。
      // 不得夹带 Hub 内部字段——commandId → 消息的映射走 outbox 行的 message_id 列。
      payload: { commandId, runId: run.id, text: input.text },
      messageId: message.id,
    })
    await appendTeamEvent(tx, {
      type: 'comment.created',
      payload: {
        commentId: message.id,
        taskId: message.taskId,
        authorUserId: message.authorUserId,
      },
    })
    return toCommentView(message)
  })
}

/**
 * Node 对 `run.followup` 的受理回执（orchestrator 的 ack 分支调用，已在事务内）。
 *
 * 语义强度按机制写：`accepted=true` 只表示 **Node 已把帧写进在管 Runtime 进程的 stdin**
 *（`docs/adr/0009` 决策 3 与切片② 的 §6.3），不保证模型读到；进展由 `session.event` 呈现。
 */
export async function settleFollowupAck(
  tx: Tx,
  command: { messageId: string | null },
  ack: { accepted: boolean; error?: { code: string; message: string } | undefined },
): Promise<void> {
  if (command.messageId === null) return
  const settled = await settleInstruction(
    tx,
    command.messageId,
    ack.accepted
      ? { state: 'accepted' }
      : {
          state: 'rejected',
          error: {
            code: ack.error?.code ?? 'RUNTIME_START_FAILED',
            message: ack.error?.message ?? 'node rejected run.followup',
          },
        },
  )
  // undefined = 不是 pending（重复 ack 重放 / 行不存在）：既成事实不二次改写，也不发事件。
  if (settled === undefined) return
  await appendTeamEvent(tx, {
    type: 'comment.created',
    payload: { commentId: settled.id, taskId: settled.taskId, authorUserId: settled.authorUserId },
  })
}
