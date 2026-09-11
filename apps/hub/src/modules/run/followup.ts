/**
 * Hub 侧「往活跃 Run 里继续说话」的命令层（#186 / ADR-0009 决策 3、5）。
 *
 * 这是切片③b 的核心：把线程消息变成**可审计的驱动事实**。
 *   - 受理成功 → 消息 `accepted`；被拒 → 消息 `rejected` **并落理由**（migration 0004）。
 *   - 驱动通道是既有的 `run.followup` 下行帧（切片② 已铺到 Node），Hub 这半边此前**没有发送方**。
 *
 * 受理规则按 ADR-0009 决策 5（只认**状态**，不猜 Node 内部）：
 *   - `queued` / `dispatching` / `running` → 受理（前两者由 Hub 侧排队，run.start 的 ack 会先到）；
 *   - `waiting_approval` → 受理但排队（进程还在；**不声称模型一定读到**——accepted 的机制保证
 *     只到「Node 写进 stdin」，审批落地后是否真被读到由 `session.event` 呈现）；
 *   - `cancel_requested` / 各终态 → **不受理**，当场落一条带理由的 `rejected` 消息
 *     （`RUN_CANCELLING` / `RUN_TERMINAL`），不排队等一个必然被终态打断的结果。
 *
 * 授权按现行不变量（只有 Task 责任人能驱动执行，`orchestrator.ts:130-132` 同款）：
 * 授权名单 `task_instruction_grant` 属切片④，本片**不放宽**任何权限。
 */
import { and, eq } from 'drizzle-orm'
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

/**
 * 受理集合（ADR-0009 决策 5）：**只按状态判定**，不猜 Node 内部。
 *
 * `queued` / `dispatching` / `running` / `waiting_approval` 全部受理——前两者是「运行已建立、
 * 首轮还在路上」，`run.start` 的 ack 一定会来，而同一个 outbox 天然保序，追问排在它后面即可
 *（03 §6.3「该窗口由 Hub 侧排队」）。`cancel_requested` 与各终态一律**当场拒绝**：取消已经在
 * 路上，排队必然被终态打断，不如立刻如实告诉人。
 */
const FOLLOWUP_ACCEPTING_STATUSES = new Set([
  'queued',
  'dispatching',
  'running',
  'waiting_approval',
])

/**
 * Hub 侧拒绝理由的标签（写进 `task_message.instruction_error_code`）。
 *
 * 与 Node 回执里的 **wire ErrorCode 不是同一套词表**：wire 码描述「Node 怎么回应了这条命令」，
 * 这里描述「这条指令为什么没被受理」。两者同列存放（都是「指令的命运」），故此处用 ADR-0009
 * 决策 3/5 命名的理由标签（`RUN_TERMINAL` / `RUN_CANCELLING`），而 Node 的 ack 码**原样透传**。
 * 不改 protocol 的 ErrorCode 目录——那是线上契约，不该为 Hub 内部记账扩容。
 */
const REFUSAL_RUN_TERMINAL = 'RUN_TERMINAL'
const REFUSAL_RUN_CANCELLING = 'RUN_CANCELLING'

/** 终态：Run 已经答完了，追问只能改走新回合。 */
const TERMINAL_RUN_STATUSES = new Set(['completed', 'failed', 'cancelled', 'lost'])

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
    // 先取 Run（不加锁，只为拿到 taskId），再按 **Task → Run** 的顺序加锁。
    const [probe] = await tx
      .select({ id: schema.runs.id, taskId: schema.runs.taskId })
      .from(schema.runs)
      .where(eq(schema.runs.id, runId))
    if (probe === undefined) throw new RunCommandError('NOT_FOUND', 'run not found')

    // 锁顺序必须是 Task → Run：`task/commands.ts`（lockTask → 锁 Run 行）就是这一序，
    // 反过来会在「Task 取消 × 追问」并发时造成 40P01 死锁。
    const [task] = await tx
      .select()
      .from(schema.tasks)
      .where(eq(schema.tasks.id, probe.taskId))
      .for('update')
    if (task === undefined) throw new RunCommandError('NOT_FOUND', 'task not found')

    // 受理判定与入队在同一把锁下（否则两个并发追问可能都判到 running 并各自入队，
    // 而其中一个本该在状态已变后被拒——ADR-0009 决策 5 的「按状态受理」要求判定串行）。
    const [run] = await tx.select().from(schema.runs).where(eq(schema.runs.id, runId)).for('update')
    if (run === undefined) throw new RunCommandError('NOT_FOUND', 'run not found')
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
      // 理由区分「已经答完」与「正在取消」——前者引导用户改走新回合，后者只需等取消落地。
      const terminal = TERMINAL_RUN_STATUSES.has(run.status)
      const message = await insertMessage(tx, {
        ...common,
        instructionState: 'rejected',
        instructionErrorCode: terminal ? REFUSAL_RUN_TERMINAL : REFUSAL_RUN_CANCELLING,
        instructionErrorMessage: terminal
          ? `run reached ${run.status}; send the followup as a new run instead`
          : `run is ${run.status}; the cancellation in flight will end it before a followup could be read`,
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
            // Node 今天的拒绝路径都带码；无码时用 INTERNAL_ERROR 如实表示「不知道为什么」，
            // 而不是借 run.start 的 RUNTIME_START_FAILED（那是 Run 启动失败，与指令无关）。
            code: ack.error?.code ?? 'INTERNAL_ERROR',
            message: ack.error?.message ?? 'node rejected the followup without a reason code',
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

/**
 * Run 进终态时，把该 Run 上仍 `pending` 的追问一律落 `rejected(RUN_TERMINAL)`（ADR-0009 决策 3）。
 *
 * 为什么必须有：`accepted` 的机制保证只到「Node 写进 stdin」，Node 可能**永远不会**回 ack
 *（进程已死、outbox 无重试上限、连接丢失）。没有这条清扫，「waiting_approval 追问 → 用户取消
 * → lost」这类路径会让消息**永久停在 pending**——正是本片要消灭的「零痕迹」的同族口子。
 * 由 `setRunStatus` 在写终态时同事务调用（只从 pending 收敛，故多挂点也安全）。
 */
export async function settlePendingInstructionsForRun(
  tx: Tx,
  runId: string,
  reason: { code: string; message: string },
): Promise<number> {
  const settled = await tx
    .update(schema.taskMessages)
    .set({
      instructionState: 'rejected',
      instructionErrorCode: reason.code,
      instructionErrorMessage: reason.message,
    })
    .where(
      and(
        eq(schema.taskMessages.runId, runId),
        eq(schema.taskMessages.instructionState, 'pending'),
      ),
    )
    .returning({ id: schema.taskMessages.id })
  return settled.length
}
