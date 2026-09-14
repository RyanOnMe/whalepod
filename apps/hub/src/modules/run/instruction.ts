/**
 * 执行区的指令动作（P1-196 切片③c-2b；ADR-0010 决策 2 的执行区入口）。
 *
 * 一句话语义（ADR-0009 决策 5 的"接着说永远成立"）：
 *   * 该 Task **已有活跃 Run** → 这条指令**降级为追问**（排队或下发由 ③c-1 的状态语义决定）；
 *   * **没有活跃 Run** → **建 Run**：解析执行目标（设备/工作区三段式）、把指令与 Run 双向锚定。
 *
 * 为什么不做成"两套 API"：对人来说只有"让 Agent 干这个"一个动作，分叉是 Hub 的内部事实。
 * 复用的是既有的两条路径（`sendRunFollowup` / `orchestrator.create`），所以 followup 的排队语义、
 * Run 的活跃唯一约束（`run_one_active_per_task`）、机器身份校验都不需要第二份实现。
 *
 * 授权（切片④ #198 已落地）：责任人 ∪ 被授权成员（`resolveInstructionRight` 唯一判定入口）。
 * 被授权成员只是"能开口"——设备/凭据仍是责任人的，Run 归属也仍是责任人。
 */
import { and, desc, eq, inArray } from 'drizzle-orm'
import type { Database, TaskMessageRow, Tx } from '@whalepod/db'
import {
  findCommandReceipt,
  insertMessage,
  resolveInstructionRight,
  schema,
  settleInstruction,
  TERMINAL_RUN_STATUSES,
} from '@whalepod/db'
import type { ActorContext } from './commands.js'
import { toCommentView } from '../task/queries.js'
import type { CommentView } from '../task/queries.js'
import { RunCommandError } from './errors.js'
import { uuidv7 } from '../shared/uuid.js'
import { sendRunFollowup } from './followup.js'
import { resolveRunTarget } from './instruction-target.js'
import type { Outbox } from '@whalepod/db'
import type { RunOrchestrator } from './orchestrator.js'

export interface SendInstructionDeps {
  database: Database
  outbox: Outbox
  orchestrator: RunOrchestrator
  /** 目标设备的 DSH 发行版版本（在建 Run 时固化；组合根注入，见 commands.ts 的说明）。 */
  dshDistributionVersionFor: (deviceId: string) => Promise<string | undefined>
  now?: () => Date
}

export interface SendInstructionInput {
  text: string
  idempotencyKey: string
  /** 执行目标显式覆盖（缺省时走三段式自动解析）。 */
  deviceId?: string
  workspaceId?: string
  /** 用哪个 Agent（缺省：该 Task 上一个 Run 用过的 Agent）。 */
  agentId?: string
}

export type SendInstructionOutcome =
  | { kind: 'started_run'; message: CommentView; runId: string }
  | { kind: 'followup'; message: CommentView; runId: string }
  | { kind: 'queued'; message: CommentView; runId: string }
  /** 已被 Hub 当场拒绝（终态 / 正在取消）：`message.instructionState='rejected'` 且带理由。 */
  | { kind: 'rejected'; message: CommentView; runId: string }

/** 该 Task 当前的活跃 Run（非终态，按创建时间取最近一条）。 */
async function activeRunForTask(
  handle: Tx | Database['db'],
  taskId: string,
): Promise<{ id: string; status: string } | undefined> {
  const rows = await handle
    .select({ id: schema.runs.id, status: schema.runs.status })
    .from(schema.runs)
    .where(
      and(
        eq(schema.runs.taskId, taskId),
        // 终态集合来自单一事实源（③b 收口时集中到 packages/db）。
        inArray(schema.runs.status, [
          'queued',
          'dispatching',
          'running',
          'waiting_approval',
          'cancel_requested',
        ]),
      ),
    )
    .orderBy(desc(schema.runs.createdAt))
    .limit(1)
  const row = rows[0]
  if (row === undefined) return undefined
  // 双保险：显式集合与共享终态集必须一致（若将来加状态忘了改上面那行，这里会立刻发现）。
  if (TERMINAL_RUN_STATUSES.has(row.status as never)) return undefined
  return row
}

/**
 * 发一条执行区指令。返回值告诉调用方走的是哪条分支（`started_run` / `followup` / `queued`），
 * 便于路由把结果如实告诉人（UI 据此提示"已起新回合"/"已排进当前回合"）。
 */
export async function sendInstruction(
  deps: SendInstructionDeps,
  actor: ActorContext,
  taskId: string,
  input: SendInstructionInput,
): Promise<SendInstructionOutcome> {
  const now = deps.now?.() ?? new Date()

  // **先判权，再谈幂等**（评审 #204 阻断 1）：回执回放此前排在判权之前，于是「撤销授权后拿旧 key
  // 重放」能拿回原 Run（撤销立刻失效被推翻），未授权的人猜到 key 还能读回别人指令的正文。
  // 回执只服务「本人已成功的重试」，所以权限必须最先判定。
  const right = await resolveInstructionRight(deps.database.db, taskId, actor.userId)
  if (right === 'none') {
    throw new RunCommandError(
      'FORBIDDEN',
      'only the task assignee or a granted member can send instructions',
    )
  }

  // **幂等优先**（评审 B1）：`orchestrator.create` 用 `run.create:<key>` 回执保证同一把 key 只建一个
  // Run，但"写指令消息 + 回填锚点"没有幂等——同 key 重发会插出第二条指令、覆盖 `trigger_message_id`，
  // 让第一条永远等不到 ack。所以在**任何副作用之前**先按同一把 key 查回执：命中说明上一次调用已经
  // 落过账，按锚点把那条指令读回来原样返回（消息 id、Run id 都不变）。
  const priorReceipt = await findCommandReceipt(
    deps.database.db,
    `run.create:${input.idempotencyKey}`,
  )
  if (priorReceipt !== undefined) {
    const priorRunId = (priorReceipt.result as { id?: unknown }).id
    if (typeof priorRunId === 'string') {
      const replayed = await replayByRun(deps, priorRunId, taskId)
      if (replayed !== undefined) return replayed
    }
  }

  // 先看有没有活跃 Run：有 → 复用追问路径（③c-1 的排队/下发语义原样生效）。
  const active = await activeRunForTask(deps.database.db, taskId)
  if (active !== undefined) {
    const message = await sendRunFollowup(deps.database, deps.outbox, actor, active.id, {
      text: input.text,
      idempotencyKey: input.idempotencyKey,
    })
    // 追问的受理/排队由 ③c-1 决定：状态 pending 且没有命令 = 排队（Node 还没到 running）。
    // outcome 要与消息的真实命运一致（评审应改 5）：被拒的消息没有 outbox 行，但绝不是"排队中"，
    // 否则 UI 会把 `outcome:'queued'` 与 `instructionState:'rejected'` 同时显示，误导人。
    if (message.instructionState === 'rejected') {
      return { kind: 'rejected', message, runId: active.id }
    }
    const queued = await isQueued(deps, message.id)
    return { kind: queued ? 'queued' : 'followup', message, runId: active.id }
  }

  // 目标解析用**责任人**的设备/工作区：被授权成员只是"能开口"，执行永远在责任人的机器与凭据上。
  const [task] = await deps.database.db
    .select({ assigneeUserId: schema.tasks.assigneeUserId })
    .from(schema.tasks)
    .where(eq(schema.tasks.id, taskId))
    .limit(1)
  if (task === undefined) throw new RunCommandError('NOT_FOUND', 'task not found')

  // 没有活跃 Run → 建 Run。目标解析失败一律**明确拒绝**（不猜，也不落一条注定失败的指令）。
  const target = await resolveRunTarget(deps.database.db, {
    taskId,
    assigneeUserId: task.assigneeUserId,
    ...(input.deviceId !== undefined ? { deviceId: input.deviceId } : {}),
    ...(input.workspaceId !== undefined ? { workspaceId: input.workspaceId } : {}),
  })
  if (target === undefined) {
    throw new RunCommandError(
      'DEVICE_OFFLINE',
      'no runnable device/workspace for this task; pick one explicitly or bring a device online',
    )
  }
  // 用哪个 Agent：显式给就用它；否则沿用**上一个 Run 用过的**（"接着说"的直觉）。
  // 没有上一轮可继承时**不猜**——这个 Task 还没跑过，Agent 是产品选择（原型里是 @Agent 的那个），
  // 让调用方明确指定；错误信息写清怎么修。
  const agentId = input.agentId ?? (await agentFromLastRun(deps, taskId))
  if (agentId === undefined) {
    throw new RunCommandError(
      'VALIDATION_FAILED',
      'this task has no prior run to inherit an agent from; pass agentId explicitly',
    )
  }
  const dshVersion = await deps.dshDistributionVersionFor(target.deviceId)
  if (dshVersion === undefined) {
    throw new RunCommandError('DEVICE_OFFLINE', 'the target device has not reported node.hello yet')
  }

  let run: Awaited<ReturnType<typeof deps.orchestrator.create>>
  try {
    run = await deps.orchestrator.create(actor, taskId, {
      idempotencyKey: input.idempotencyKey,
      agentId,
      deviceId: target.deviceId,
      workspaceId: target.workspaceId,
      dshDistributionVersion: dshVersion,
      prompt: input.text,
    })
  } catch (error) {
    // 并发窗口（评审应改 1）：上面那次"有没有活跃 Run"是无锁读，两条指令同时到会一成一败。
    // ADR-0010 的语义是**有活跃 Run 就接着说**，所以这里不该把用户的话丢掉、回 409——
    // 退化成追问，与"先看到活跃 Run"的分支同路。
    if (error instanceof RunCommandError && error.code === 'RUN_ALREADY_ACTIVE') {
      const raced = await activeRunForTask(deps.database.db, taskId)
      if (raced !== undefined) {
        const message = await sendRunFollowup(deps.database, deps.outbox, actor, raced.id, {
          text: input.text,
          idempotencyKey: input.idempotencyKey,
        })
        return {
          kind:
            message.instructionState === 'rejected'
              ? 'rejected'
              : (await isQueued(deps, message.id))
                ? 'queued'
                : 'followup',
          message,
          runId: raced.id,
        }
      }
    }
    throw error
  }

  // **幂等**（评审 B1）：`orchestrator.create` 按 idempotencyKey 回放同一个 Run，但消息写入没有
  // 幂等——同 key 重发会插出第二条指令，并把 `trigger_message_id` 覆盖掉，让第一条永远等不到 ack。
  // 判据就是锚点本身：这个 Run 已经有触发消息 = 上一次同 key 的调用已经落过账，直接读回来返回。
  const [existingRun] = await deps.database.db
    .select({ triggerMessageId: schema.runs.triggerMessageId })
    .from(schema.runs)
    .where(eq(schema.runs.id, run.id))
  if (existingRun?.triggerMessageId != null) {
    const [prior] = await deps.database.db
      .select()
      .from(schema.taskMessages)
      .where(eq(schema.taskMessages.id, existingRun.triggerMessageId))
    if (prior !== undefined) {
      return {
        kind: 'started_run',
        message: toCommentView(prior),
        runId: run.id,
      }
    }
  }

  // 双向锚定（migration 0005）：Run 记触发它的消息，消息记 run_id；指令停在 pending，
  // 由该 Run 的 run.start ack 结算（accepted / rejected + 理由）。
  const message = await deps.database.transaction(async (tx) => {
    const created = await insertMessage(tx, {
      id: uuidv7(),
      taskId,
      authorUserId: actor.userId,
      body: input.text,
      kind: 'instruction',
      origin: 'human',
      targetAgentId: agentId,
      runId: run.id,
      instructionState: 'pending',
      createdAt: now,
    })
    await tx
      .update(schema.runs)
      .set({ triggerMessageId: created.id })
      .where(eq(schema.runs.id, run.id))
    return created
  })

  return { kind: 'started_run', message: toCommentView(message as TaskMessageRow), runId: run.id }
}

/** 该 Task 上一个 Run 用过的 Agent（指令没显式指定时的默认）。 */
async function agentFromLastRun(
  deps: SendInstructionDeps,
  taskId: string,
): Promise<string | undefined> {
  const rows = await deps.database.db
    .select({ agentId: schema.runs.agentId })
    .from(schema.runs)
    .where(eq(schema.runs.taskId, taskId))
    .orderBy(desc(schema.runs.createdAt))
    .limit(1)
  return rows[0]?.agentId
}

/** 这条消息是否还排着队（pending 且没有对应的 outbox 命令）。 */
async function isQueued(deps: SendInstructionDeps, messageId: string): Promise<boolean> {
  const rows = await deps.database.db
    .select({ id: schema.dispatchOutbox.id })
    .from(schema.dispatchOutbox)
    .where(eq(schema.dispatchOutbox.messageId, messageId))
    .limit(1)
  return rows.length === 0
}

/** 暴露给路由：把「指令没被受理」的拒绝写进消息（设备拒绝 run.start 时的兜底路径之外用不到）。 */
export async function rejectInstruction(
  tx: Tx,
  messageId: string,
  error: { code: string; message: string },
): Promise<void> {
  await settleInstruction(tx, messageId, { state: 'rejected', error })
}

/** 按 Run 的触发锚点把指令读回来（幂等重放用）：没有锚点/消息则返回 undefined。 */
async function replayByRun(
  deps: SendInstructionDeps,
  runId: string,
  taskId: string,
): Promise<SendInstructionOutcome | undefined> {
  const [run] = await deps.database.db
    .select({ triggerMessageId: schema.runs.triggerMessageId, taskId: schema.runs.taskId })
    .from(schema.runs)
    .where(eq(schema.runs.id, runId))
  if (run?.triggerMessageId == null) return undefined
  const [message] = await deps.database.db
    .select()
    .from(schema.taskMessages)
    .where(eq(schema.taskMessages.id, run.triggerMessageId))
  if (message === undefined) return undefined
  // 纵深防御（评审 #204 阻断 1）：回执里的 Run 必须属于**本次请求的 Task**，
  // 否则就是跨 Task 回放（即使 key 撞上了也不该把别人的指令读回去）。
  if (run.taskId !== taskId) return undefined
  return { kind: 'started_run', message: toCommentView(message), runId }
}
