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
import { and, asc, eq, inArray } from 'drizzle-orm'
import type { Actor } from '@whalepod/domain'
import type { Database, Outbox, RunRow, TaskMessageRow, Tx } from '@whalepod/db'
import {
  appendTeamEvent,
  INSTRUCTION_REFUSAL,
  insertMessage,
  schema,
  settleInstruction,
  TERMINAL_RUN_STATUSES,
  transactCommand,
} from '@whalepod/db'
import { DomainError } from '@whalepod/domain'
import { RunCommandError } from './errors.js'
import { toCommentView } from '../task/queries.js'
import type { CommentView } from '../task/queries.js'
import { uuidv7 } from '../shared/uuid.js'

/**
 * 受理集合（ADR-0009 决策 5）：**只按状态判定**，不猜 Node 内部。分两档：
 *
 * - **可下发**（`running`）：Node 的 `runtime.ready` 已到，写 stdin 有意义；
 * - **只排队**（`queued` / `dispatching` / `waiting_approval`）：**落 `pending`、不下发命令**。
 *   前两者是「运行已建立、首轮还在路上」，此时 Node 收到 followup 会以
 *   `INVALID_RUN_TRANSITION` 拒绝（真守卫在 `apps/node/src/run/run-manager.ts:481-484`，见 #189）；
 *   `waiting_approval` 尤其不得把追问塞进审批阻塞的执行路径。等 Run 进入 `running` 时按序补发
 *   （`dispatchPendingInstructions`）。
 *
 * `cancel_requested` 与各终态一律**当场拒绝**：取消已经在路上、Run 已答完，排队必然被打断。
 */
const FOLLOWUP_DISPATCHABLE_STATUSES = new Set(['running'])
const FOLLOWUP_QUEUEING_STATUSES = new Set(['queued', 'dispatching', 'waiting_approval'])

/**
 * 不受理时的理由映射（显式穷尽，评审 O2）：`run_status` 现有 9 值 = 活跃 5 + 终态 4，
 * 这里覆盖**全部**非受理分支；未来新增状态会落到最后一条 `INTERNAL_ERROR`（诚实报「未知」），
 * 而不是被推断成「正在取消」。
 */
function refusalFor(status: RunRow['status']): {
  code: string
  message: (status: RunRow['status']) => string
} {
  if (TERMINAL_RUN_STATUSES.has(status)) {
    return {
      code: REFUSAL_RUN_TERMINAL,
      message: (value) => `run reached ${value}; send the followup as a new run instead`,
    }
  }
  switch (status) {
    case 'cancel_requested':
      return {
        code: REFUSAL_RUN_CANCELLING,
        message: (value) =>
          `run is ${value}; the cancellation in flight will end it before a followup could be read`,
      }
    default:
      return {
        code: 'INTERNAL_ERROR',
        message: (value) =>
          `run is ${value}, which this Hub cannot accept or queue an instruction for`,
      }
  }
}

/**
 * Hub 侧拒绝理由的标签（写进 `task_message.instruction_error_code`）。
 *
 * 与 Node 回执里的 **wire ErrorCode 不是同一套词表**：wire 码描述「Node 怎么回应了这条命令」，
 * 这里描述「这条指令为什么没被受理」。两者同列存放（都是「指令的命运」），故此处用 ADR-0009
 * 决策 3/5 命名的理由标签（`RUN_TERMINAL` / `RUN_CANCELLING`），而 Node 的 ack 码**原样透传**。
 * 不改 protocol 的 ErrorCode 目录——那是线上契约，不该为 Hub 内部记账扩容。
 */
// 标签与终态集合都取 packages/db 的单一事实源（#187 评审 N3/N4）。
const REFUSAL_RUN_TERMINAL = INSTRUCTION_REFUSAL.RUN_TERMINAL
const REFUSAL_RUN_CANCELLING = INSTRUCTION_REFUSAL.RUN_CANCELLING

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

    const dispatchNow = FOLLOWUP_DISPATCHABLE_STATUSES.has(run.status)
    if (!dispatchNow && !FOLLOWUP_QUEUEING_STATUSES.has(run.status)) {
      // 不受理也要留痕：线程里出现这条消息，带明确状态与理由（不静默丢弃）。
      // 理由区分「已经答完」与「正在取消」——前者引导用户改走新回合，后者只需等取消落地。
      // 显式映射，不靠「非终态 ⇒ 正在取消」推断（评审 O2）：将来 `run_status` 加第 10 个值时，
      // 它会落到 INTERNAL_ERROR 这条**诚实**的分支，而不是被静默标成「正在取消」。
      const refusal = refusalFor(run.status)
      const message = await insertMessage(tx, {
        ...common,
        instructionState: 'rejected',
        instructionErrorCode: refusal.code,
        instructionErrorMessage: refusal.message(run.status),
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

    // 受理：先落 pending 消息。**只有 running 才同时入队命令**（决策 5）：排队窗口里下发
    // 必然被 Node 拒（#189 实测），等 Run 进 running 再按序补发。
    const message = await insertMessage(tx, { ...common, instructionState: 'pending' })
    if (!dispatchNow) {
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
 * Run 进入 `running` 时，把它上面**仍 `pending` 且尚未入队**的追问按 `(created_at, id)` 顺序补发
 *（ADR-0009 决策 5：「未 running 的一切窗口都排队，不丢……等 Run 进入 `running` 后按序下发」）。
 *
 * 幂等：以 `dispatch_outbox.message_id` 作为「已入队」的唯一判据——重复进入 `running`（或
 * running 状态的重复事件）不会二次下发同一句话。顺序取自 `(created_at, id)`，与线程展示一致。
 *
 * 调用点：**唯一**收口 `./run-status.ts` 的 `applyRunStatus`（Hub 里能写 `running` 的 5 条路径
 * 全部经它）。别再往各入口各挂一次——那正是本片首版漏掉真人路径（`decide.ts`）的原因。
 */
export async function dispatchPendingInstructions(
  tx: Tx,
  outbox: Outbox,
  run: { id: string; deviceId: string; status: RunRow['status'] },
): Promise<number> {
  // 不信任调用方（评审 S1/③）：Node 只会在 Run 处于 running 时受理 followup，其他状态下发必被拒
  //（#189）。这里**抛错而不是静默返回 0**——静默降级正是 B1 的同族（漏发却看不出来），
  // 而生产路径（`applyRunStatus`）传的是迁移后的行，永远满足这个前置条件，抛错不会误伤。
  if (run.status !== 'running') {
    throw new DomainError(
      'INVALID_RUN_TRANSITION',
      `cannot dispatch queued instructions for a run in ${run.status}`,
    )
  }
  const pending = await tx
    .select()
    .from(schema.taskMessages)
    .where(
      and(
        eq(schema.taskMessages.runId, run.id),
        eq(schema.taskMessages.instructionState, 'pending'),
      ),
    )
    .orderBy(asc(schema.taskMessages.createdAt), asc(schema.taskMessages.id))
  if (pending.length === 0) return 0

  // 「已入队」的唯一判据是 outbox 行上的 message_id（migration 0004 就是为这条链加的）。
  // 用刚查出的 pending id 收窄（评审 S3）：`dispatch_outbox` 只有 pending 的部分索引、
  // 且全仓没有 GC，全表扫 followup 会随历史线性变慢。
  const queued = await tx
    .select({ messageId: schema.dispatchOutbox.messageId })
    .from(schema.dispatchOutbox)
    .where(
      and(
        eq(schema.dispatchOutbox.type, 'run.followup'),
        inArray(
          schema.dispatchOutbox.messageId,
          pending.map((message) => message.id),
        ),
      ),
    )
  const queuedIds = new Set(
    queued.map((row) => row.messageId).filter((id): id is string => id !== null),
  )

  let dispatched = 0
  for (const message of pending) {
    if (queuedIds.has(message.id)) continue // 已入队过：不重复下发
    const commandId = uuidv7()
    await outbox.enqueue(tx, {
      id: commandId,
      deviceId: run.deviceId,
      type: 'run.followup',
      payload: { commandId, runId: run.id, text: message.body },
      messageId: message.id,
    })
    dispatched += 1
  }
  return dispatched
}

/**
 * 由指令起的 Run：`run.start` 的 ack 就是**那条指令**的命运（P1-196；ADR-0009 决策 3）。
 *
 * 锚点是 `runs.trigger_message_id`（migration 0005）——wire 帧载荷不可能夹带消息 id，所以
 * commandId → 指令的映射只能落在 Hub 自己的 runs 行上（与追问走 `outbox.message_id` 同理）。
 *
 * 结算仍只从 `pending` 收敛一次（`settleInstruction` 的既有语义）：重复 ack 幂等，且不会把
 * 已经落定的指令改写成别的命运。
 */
export async function settleTriggerInstruction(
  tx: Tx,
  run: RunRow,
  ack: { accepted: boolean; error?: { code: string; message: string } | undefined },
): Promise<void> {
  if (run.triggerMessageId === null) return
  await settleInstruction(
    tx,
    run.triggerMessageId,
    ack.accepted
      ? { state: 'accepted', runId: run.id }
      : {
          state: 'rejected',
          // 拒绝理由**落库**（不能只写事件）：team_event 只有 24 小时窗口，而「我的指令为什么
          // 没被受理」是长期问题（migration 0004 立的规矩）。
          error: {
            code: ack.error?.code ?? 'INTERNAL_ERROR',
            message: ack.error?.message ?? 'device refused run.start without a reason',
          },
        },
  )
}
