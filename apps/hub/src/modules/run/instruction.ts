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
 * 授权：本片沿用既有守卫（`orchestrator.create` 里"只有 Task 责任人能起 Run"）——
 * **泛化到 `task_instruction_grant` 是切片④ 的事**，别在这里先造半套。
 */
import { and, desc, eq, inArray } from 'drizzle-orm'
import type { Database, TaskMessageRow, Tx } from '@whalepod/db'
import {
  insertMessage,
  schema,
  settleInstruction,
  TERMINAL_RUN_STATUSES,
  transactCommand,
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

  // 先看有没有活跃 Run：有 → 复用追问路径（③c-1 的排队/下发语义原样生效）。
  const active = await activeRunForTask(deps.database.db, taskId)
  if (active !== undefined) {
    const message = await sendRunFollowup(deps.database, deps.outbox, actor, active.id, {
      text: input.text,
      idempotencyKey: input.idempotencyKey,
    })
    // 追问的受理/排队由 ③c-1 决定：状态 pending 且没有命令 = 排队（Node 还没到 running）。
    const queued = await isQueued(deps, message.id)
    return { kind: queued ? 'queued' : 'followup', message, runId: active.id }
  }

  // 没有活跃 Run → 建 Run。目标解析失败一律**明确拒绝**（不猜，也不落一条注定失败的指令）。
  const target = await resolveRunTarget(deps.database.db, {
    taskId,
    assigneeUserId: actor.userId,
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

  const run = await deps.orchestrator.create(actor, taskId, {
    idempotencyKey: input.idempotencyKey,
    agentId,
    deviceId: target.deviceId,
    workspaceId: target.workspaceId,
    dshDistributionVersion: dshVersion,
    prompt: input.text,
  })

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

/**
 * 仅用于**幂等重放**：把上一次同 idempotencyKey 的指令读回来（`transactCommand` 已保证
 * 建 Run 侧幂等；这里让「同一 key 重发」返回同一结果而不是再建一条消息）。
 */
export async function replayInstruction(
  deps: SendInstructionDeps,
  taskId: string,
  idempotencyKey: string,
): Promise<SendInstructionOutcome | undefined> {
  const receipt = await transactCommand(deps.database, idempotencyKey, async (tx) => {
    const rows = await tx
      .select()
      .from(schema.taskMessages)
      .where(eq(schema.taskMessages.taskId, taskId))
      .orderBy(desc(schema.taskMessages.createdAt))
      .limit(1)
    return rows[0]
  })
  if (receipt === undefined) return undefined
  const settled = receipt as TaskMessageRow
  if (settled.runId === null) return undefined
  const queued = await isQueued(deps, settled.id)
  return {
    kind: queued ? 'queued' : 'followup',
    message: toCommentView(settled),
    runId: settled.runId,
  }
}

/** 暴露给路由：把「指令没被受理」的拒绝写进消息（设备拒绝 run.start 时的兜底路径之外用不到）。 */
export async function rejectInstruction(
  tx: Tx,
  messageId: string,
  error: { code: string; message: string },
): Promise<void> {
  await settleInstruction(tx, messageId, { state: 'rejected', error })
}
