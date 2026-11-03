/**
 * RunOrchestrator（P1-10；02-第一阶段实施计划.md Task 10 Step 3/5/6）。
 *
 * 深模块：Run 创建/取消/上行事件 ingest/租约 reconcile 的唯一入口。
 * 不变量：
 * - create 在单个事务内完成守卫校验、Run/TeamEvent/Outbox 写入与幂等回执；
 *   活跃唯一由 run_one_active_per_task 部分唯一索引兜底（预检 + 23505 映射）。
 * - 所有状态迁移走 domain transitionRun/transitionTask，非法边抛 DomainError。
 * - Node command.ack 只表示命令已持久到 Node spool：queued → dispatching；
 *   只有 runtime.ready 才转 running。
 * - 终态禁复活：终态 Run 上的迟到事件持久留证但不迁移状态。
 * - #52/ADR-0007：合法帧上的语义冲突（表外边/引用缺失）不外溢为通道故障——
 *   事件留证 + 非终态 Run 收敛 failed(INVALID_RUN_TRANSITION) + 连接保留。
 */
import { randomUUID } from 'node:crypto'
import { snapshotRunInputs } from './input-manifest.js'
import { snapshotHandoffInput } from './handoff-input.js'
import { buildExecutionContext } from './execution-context.js'
import { resolveSpecBinding } from './spec-binding.js'
import { persistHandoffDraftEvent } from '../handoff/drafts.js'
import { uuidv7 } from '../shared/uuid.js'
import { and, eq, inArray } from 'drizzle-orm'
import { asUserId, authorize, DomainError, transitionRun, transitionTask } from '@whalepod/domain'
import type { RunEvent as DomainRunEvent } from '@whalepod/domain'
import type { Database, RunRow, Tx } from '@whalepod/db'
import {
  ackInTransaction,
  appendRunEvent,
  appendTeamEvent,
  countPendingApprovals,
  failInTransaction,
  findCommandReceipt,
  getApproval,
  getOutboxCommand,
  getRun,
  getWorkByKeyForUpdate,
  insertApprovalIfAbsent,
  insertRun,
  insertMessage,
  Outbox,
  schema,
  setApprovalStatus,
  setRunStatus,
  setTaskStatus,
  resolveInstructionRight,
  TERMINAL_RUN_STATUSES,
  transactCommandWithOrigin,
  unwrapPgError,
} from '@whalepod/db'
import type { ClaimedCommand } from '@whalepod/db'
import type {
  ContextStateAck,
  ContextStatePull,
  ErrorCode,
  NodeDownstream,
  ProjectedRunEvent,
  RunContextReceipt,
  RunSnapshot,
  RunWorkInputReceipt,
} from '@whalepod/protocol'
import { parseNodeFrame, RunCancelSchema, RunStartSchema } from '@whalepod/protocol'
import { cancelPendingApprovalsInTransaction, cancelRunInTransaction } from './cancel.js'
import { decideApprovalInTransaction } from './decide.js'
import type { ApprovalDecisionInput } from './decide.js'
import { expireApprovals } from './approval-expiry.js'
import type { DeviceActivity } from './reconciler.js'
import { ACTIVE_RUN_STATUSES, reconcileLeases } from './reconciler.js'
import type { ActorContext, CreateRunInput } from './commands.js'
import { assertCreateRunInput } from './commands.js'
import type { AuthenticatedDevice } from './device-gateway.js'
import { isRunSemanticConflict, RunCommandError } from './errors.js'
import { settleFollowupAck, settleTriggerInstruction } from './followup.js'
import { applyRunStatus } from './run-status.js'
import { recordWorkInputDeliveries, snapshotWorkInputs } from '../work/run-inputs.js'
import {
  assertWorkInputCapability,
  verifyRunMachineDispatch,
  verifyRunWorkInputs,
} from '../work/run-dispatch.js'
import type { ContextEntryObserver, RecordedContextEntry } from '../context/observer.js'
import {
  assertProjectContextCapability,
  createRunProjectContext,
  verifyRunProjectContext,
} from '../context/run-snapshot.js'
import { recordRunContextReceipt } from '../context/receipts.js'
import {
  enqueueRunContextState,
  enqueueRunContextStatesForDevice,
  handleRunContextStatePull,
  recordRunContextStateAck,
  refreshRunContextState,
  type RunContextStateDeps,
} from '../context/state.js'
import { recordRunWorkInputReceipt } from '../work/receipts.js'
import type { ApprovalView, RunView } from './queries.js'
import { toApprovalView, toRunView } from './queries.js'

// 终态集合来自 packages/db 的单一事实源（#187 评审 N3；此前三处各写一份）。
function isTerminal(status: RunRow['status']): boolean {
  return TERMINAL_RUN_STATUSES.has(status)
}

export interface RunOrchestratorDeps {
  database: Database
  outbox: Outbox
  now?: () => Date
  /**
   * #52：越边降级与违例收敛的结构化告警通道（组合根接 app.log.warn，
   * component 分层字段由调用点给出）。缺省 = 静默（测试深模块驱动）。
   */
  warn?: (message: string, context: Record<string, unknown>) => void
  /**
   * ADR-0025 §9：事务提交后的 `context.entry_recorded` 观测回调（组合根接
   * app.log.info）。缺省 = 静默；观测只在提交后写，回滚不留痕。
   */
  log?: ContextEntryObserver
  /**
   * ADR-0027 §8：快照创建/派发阻断/回执接受或拒绝的结构化观测（component=hub.context，
   * 字段只含不透明 id、状态、计数）。事务内只收集，提交后写。
   */
  contextLog?: (action: string, fields: Record<string, unknown>) => void
  /**
   * PC-05b-2：回执接收 ack 的直发通道（设备在线才发，丢了由 Node 重放回执）。
   * 缺省 = 不发（深模块单测）；组合根接 nodeConnections.send。
   */
  send?: (deviceId: string, frame: NodeDownstream) => void
}

export class RunOrchestrator {
  private readonly database: Database
  private readonly outbox: Outbox
  private readonly nowFn: () => Date
  private readonly warnFn: (message: string, context: Record<string, unknown>) => void
  private readonly logFn: ContextEntryObserver
  private readonly contextLogFn: (action: string, fields: Record<string, unknown>) => void
  private readonly sendFn: (deviceId: string, frame: NodeDownstream) => void
  private readonly contextStateDeps: RunContextStateDeps
  /** deviceId → 最近心跳；reconciler 据此判断「Node 在线但已没有该 Run」。 */
  readonly deviceActivity = new Map<string, DeviceActivity>()

  /** #88：已发收敛取消的终态 Run（本进程内去重；重启重发由 Node 侧幂等吸收）。 */
  private readonly terminalReleaseNotified = new Set<string>()

  constructor(deps: RunOrchestratorDeps) {
    this.database = deps.database
    this.outbox = deps.outbox
    this.nowFn = deps.now ?? (() => new Date())
    this.warnFn = deps.warn ?? (() => {})
    this.logFn = deps.log ?? (() => {})
    this.contextLogFn = deps.contextLog ?? (() => {})
    this.sendFn = deps.send ?? (() => {})
    this.contextStateDeps = {
      database: this.database,
      outbox: this.outbox,
      now: this.nowFn,
      log: (message, context) => this.warnFn(message, context),
    }
  }

  /** Node 重连/hello：下发该设备所有活跃 Run 的完整上下文状态（不只增量）。 */
  async onDeviceHello(deviceId: string): Promise<void> {
    try {
      await enqueueRunContextStatesForDevice(this.contextStateDeps, deviceId)
    } catch (error) {
      this.warnFn('context state sync on hello failed', {
        component: 'hub.context',
        deviceId,
        errorName: error instanceof Error ? error.name : 'unknown',
      })
    }
  }

  private contextLog(action: string, fields: Record<string, unknown>): void {
    this.contextLogFn(action, fields)
  }

  /** 事务提交后统一写 `context.entry_recorded`（事务内只收集，不落日志）。 */
  private flushContextEvents(recorded: readonly RecordedContextEntry[]): void {
    for (const event of recorded) this.logFn(event)
  }

  /**
   * 幂等键重放返回首次结果；并发同 key 由 command_receipt 唯一约束串行化。
   * 同 key 并发时败者可能先撞活跃唯一（它在 Task 锁释放后才做预检，读不到
   * 回执早查的结果）：此时回读回执，返回胜者结果而非报 RUN_ALREADY_ACTIVE。
   */
  async create(
    ctx: ActorContext,
    taskId: string,
    input: CreateRunInput,
    trigger?: { origin: 'human' | 'auto_assignment' },
  ): Promise<RunView> {
    // UUID route spelling must not change the persisted input identity.
    taskId = taskId.toLowerCase()
    assertCreateRunInput(input)
    // 机器 Run 只能经派工端口创建；普通建 Run 入口不得携带 origin='mandate'。
    if (input.origin === 'mandate') {
      throw new RunCommandError('FORBIDDEN', 'machine runs must be created by the dispatch port')
    }
    const now = this.nowFn()
    const key = `run.create:${input.idempotencyKey}`
    let createdSnapshot: { readonly snapshotId: string; readonly entryCount: number } | undefined
    try {
      const outcome = await transactCommandWithOrigin(this.database, key, async (tx) => {
        const run = await this.createInTransaction(tx, ctx, taskId, input, now, (snapshot) => {
          createdSnapshot = snapshot
        })
        if (trigger !== undefined) {
          // 初始指令、Run 锚点、run.start 与回执同事务提交。派发者看见命令时消息必已存在，
          // ack 不会漏结算，也不会把初始 prompt 当成尚未派发的追问再次执行。
          const message = await insertMessage(tx, {
            id: uuidv7(),
            taskId,
            authorUserId: ctx.userId,
            body: input.prompt,
            kind: 'instruction',
            origin: trigger.origin,
            targetAgentId: run.agentId,
            runId: run.id,
            instructionState: 'pending',
            createdAt: now,
          })
          await tx
            .update(schema.runs)
            .set({ triggerMessageId: message.id })
            .where(eq(schema.runs.id, run.id))
        }
        return run
      })
      // 回放要按回执自身的 Task/工作复核，不能只看本次请求带没带 ids：被授权成员
      // 省略 workInputItemIds 或用另一个自己是责任人的 Task 路径都能命中同一全局 key。
      if (!outcome.executed) {
        await this.assertReplayAllowed(taskId, ctx.userId, outcome.value)
      }
      if (outcome.executed && createdSnapshot !== undefined) {
        this.contextLog('context.snapshot_created', {
          component: 'hub.context',
          taskId,
          snapshotId: createdSnapshot.snapshotId,
          entryCount: createdSnapshot.entryCount,
        })
      }
      return outcome.value
    } catch (error) {
      const pg = unwrapPgError(error)
      const activeConflict =
        (pg?.code === '23505' && (pg.constraintName ?? '').includes('run_one_active_per_task')) ||
        (error instanceof RunCommandError && error.code === 'RUN_ALREADY_ACTIVE')
      if (activeConflict) {
        const prior = await findCommandReceipt(this.database.db, key)
        if (prior !== undefined) {
          await this.assertReplayAllowed(taskId, ctx.userId, prior.result)
          return prior.result as RunView
        }
        throw new RunCommandError('RUN_ALREADY_ACTIVE', 'task already has an active run')
      }
      throw error
    }
  }

  /**
   * 幂等回放/并发回读的复核：回执必须属于请求路径的 Task；带回工作输入的 Run
   * 只允许当前 Task 责任人读回，且按回执里的 taskId 判定，不信任请求字段。
   */
  private async assertReplayAllowed(
    requestedTaskId: string,
    userId: string,
    result: unknown,
  ): Promise<void> {
    const cached = result as Partial<RunView>
    const cachedTaskId = cached.taskId
    if (cachedTaskId === undefined || cachedTaskId !== requestedTaskId) {
      throw new RunCommandError('NOT_FOUND', 'run not found for this task')
    }
    if (cached.workKey != null) {
      const right = await resolveInstructionRight(this.database.db, cachedTaskId, userId)
      if (right !== 'assignee') {
        throw new RunCommandError('FORBIDDEN', 'work inputs are assignee-only')
      }
    }
  }

  /**
   * Compose a Run with another server command in its existing transaction.
   * The caller owns the resource/idempotency lock; all Run guards, snapshots,
   * Task transition and outbox writes still use the same creation core.
   * Never open a second create() transaction while holding the Task lock.
   */
  async createWithinTransaction(
    tx: Tx,
    ctx: ActorContext,
    taskId: string,
    input: CreateRunInput,
  ): Promise<RunView> {
    assertCreateRunInput(input)
    return this.createInTransaction(tx, ctx, taskId.toLowerCase(), input, this.nowFn())
  }

  private async createInTransaction(
    tx: Tx,
    ctx: ActorContext,
    taskId: string,
    input: CreateRunInput,
    now: Date,
    onSnapshot?: (snapshot: { readonly snapshotId: string; readonly entryCount: number }) => void,
  ): Promise<RunView> {
    // 锁 Task 行串行化并发创建；索引是兜底，锁让守卫读到稳定事实。
    const [task] = await tx
      .select()
      .from(schema.tasks)
      .where(eq(schema.tasks.id, taskId))
      .for('update')
    if (task === undefined) throw new RunCommandError('NOT_FOUND', 'task not found')
    // 执行主体（ADR-0009 决策 4；#198）：责任人 ∪ 被授权成员。判定收敛在仓储的唯一入口里，
    // 别在这里再写一遍条件——三处各写一份正是这轮要消灭的东西。
    const right = await resolveInstructionRight(tx, taskId, ctx.userId)
    if (right === 'none') {
      throw new RunCommandError(
        'FORBIDDEN',
        'only the task assignee or a granted member can start a run',
      )
    }
    // ADR-0028（RD-02a-2a）：工作输入来自责任人私有收件箱。被授权成员能说话、
    // 能被派工，但不能把责任人收件箱里的材料带进 Run。
    if (input.workInputItemIds !== undefined && right !== 'assignee') {
      throw new RunCommandError('FORBIDDEN', 'work inputs are assignee-only')
    }
    if (task.assignmentStatus !== 'accepted') {
      throw new DomainError('ASSIGNMENT_NOT_ACCEPTED', 'assignment must be accepted first')
    }
    if (task.status === 'done' || task.status === 'cancelled') {
      throw new DomainError('TASK_TERMINAL', 'cannot start a run on a terminal task')
    }

    const [agent] = await tx.select().from(schema.agents).where(eq(schema.agents.id, input.agentId))
    if (agent === undefined || agent.archivedAt !== null) {
      throw new RunCommandError('NOT_FOUND', 'agent not found')
    }
    const revisionId = input.profileRevisionId ?? agent.currentRevisionId
    if (revisionId === null || revisionId === undefined) {
      throw new RunCommandError('NOT_FOUND', 'agent has no profile revision')
    }
    const [revision] = await tx
      .select()
      .from(schema.agentProfileRevisions)
      .where(eq(schema.agentProfileRevisions.id, revisionId))
    if (revision === undefined || revision.agentId !== agent.id) {
      throw new RunCommandError('NOT_FOUND', 'profile revision not found')
    }
    const [pack] = await tx
      .select()
      .from(schema.pluginPacks)
      .where(eq(schema.pluginPacks.id, revision.pluginPackId))
    if (pack === undefined) throw new RunCommandError('NOT_FOUND', 'plugin pack not found')

    // 审批档位解析（#241；ADR-0009 决策 7）：Task 覆盖（NULL=继承，不物化）??
    // Revision 默认 → 本次 Run 的固化档位。所以「Revision 更新后 Task 跟不跟」有唯一
    // 答案：未覆盖的跟（每次建 Run 重新解析），已覆盖的不跟（Task 值优先）。
    // 口径（ADR-0010 决策 5）：不做「自动触发降级」，触发方式不影响档位。
    const approvalPolicy = task.approvalPolicy ?? revision.approvalPolicy
    if (
      input.expectedApprovalPolicy !== undefined &&
      input.expectedApprovalPolicy !== approvalPolicy
    ) {
      throw new RunCommandError('CONFLICT', '审批档位已变化，请重新确认后发送')
    }
    // ADR-0028 §6（RD-03a）：机器 Run 必须有完整 provenance，且不能以 full_access 执行。
    const origin = input.origin ?? 'human'
    if (origin !== 'mandate' && input.toolPolicy !== undefined) {
      throw new RunCommandError('VALIDATION_FAILED', 'tool policy is only for machine runs')
    }
    if (origin === 'mandate') {
      if (
        input.workKey === undefined ||
        input.mandateId === undefined ||
        input.dispatchIntentId === undefined ||
        input.onBehalfOfUserId === undefined
      ) {
        throw new RunCommandError('VALIDATION_FAILED', 'machine run provenance is incomplete')
      }
      if (
        input.toolPolicy === undefined ||
        input.toolPolicy.workKey !== input.workKey ||
        input.toolPolicy.mode !== 'draft'
      ) {
        throw new RunCommandError('VALIDATION_FAILED', 'machine run tool policy is incomplete')
      }
      if (input.onBehalfOfUserId !== task.assigneeUserId) {
        throw new RunCommandError('FORBIDDEN', 'machine run must be on behalf of the assignee')
      }
      if (approvalPolicy === 'full_access') {
        throw new RunCommandError('FORBIDDEN', 'full_access cannot be used for a machine run')
      }
    }

    const [device] = await tx
      .select()
      .from(schema.devices)
      .where(eq(schema.devices.id, input.deviceId))
    // Device 必须属于 owner（§2.6）；存在性+归属合一，避免可枚举。
    // 设备/工作区属于**运行归属人**（= Task 责任人），不是"当前开口的人"：
    // 被授权成员只是能说话，执行永远在责任人的设备与凭据上（#198 红线）。
    if (device === undefined || device.ownerUserId !== task.assigneeUserId) {
      throw new RunCommandError('FORBIDDEN', 'device does not belong to the actor')
    }
    if (device.revokedAt !== null) {
      throw new RunCommandError('DEVICE_REVOKED', 'device token has been revoked')
    }
    const [workspace] = await tx
      .select()
      .from(schema.workspaces)
      .where(eq(schema.workspaces.id, input.workspaceId))
    if (
      workspace === undefined ||
      workspace.ownerUserId !== task.assigneeUserId ||
      workspace.deviceId !== device.id
    ) {
      throw new RunCommandError('FORBIDDEN', 'workspace does not belong to the actor and device')
    }
    if (!workspace.available) {
      throw new RunCommandError('WORKSPACE_UNAVAILABLE', 'workspace is not available')
    }

    let rerunSource: RunRow | undefined
    if (input.rerunOfRunId !== undefined) {
      const prior = await getRun(tx, input.rerunOfRunId)
      if (prior === undefined || prior.taskId !== taskId) {
        throw new RunCommandError('NOT_FOUND', 'rerun source run not found')
      }
      if (!isTerminal(prior.status)) {
        throw new RunCommandError('CONFLICT', 'rerun source run must be terminal')
      }
      rerunSource = prior
    }

    // ADR-0009 切片⑤（resume 续跑）四重守卫——「同 Workspace」是机器判据，不是口头约束：
    // ① 同 Task（与 rerun 同口径，NOT_FOUND 同形防枚举）；
    // ② 来源终态（活着的 Run 走追问路径，不该出现在这里）；
    // ③ dshSessionId 非空（没到过 running 就没有会话可续）；
    // ④ Device 与 Workspace 与本次输入**全等**——ResumeAgentOptions 不收 cwd，续跑的
    //    工作目录来自持久化 header（旧值）；换 workspace 会「工具在新目录跑、会话按旧
    //    cwd 续」的静默错位，换 device 连日志都没有（日志在来源设备的 DSH_HOME）。
    //    拒绝换目标，不静默降级成摘要 fallback（那是后续独立组件）。
    let resumeSource: RunRow | undefined
    if (input.resumeFromRunId !== undefined) {
      const prior = await getRun(tx, input.resumeFromRunId)
      if (prior === undefined || prior.taskId !== taskId) {
        throw new RunCommandError('NOT_FOUND', 'resume source run not found')
      }
      if (!isTerminal(prior.status)) {
        throw new RunCommandError('CONFLICT', 'resume source run must be terminal')
      }
      // ADR-0027 §6（PC-05b-3）：非空项目上下文 Run 的 session 在终态清理中被删除
      //（resume probe 未固定，fail-safe blocked）；不得创建新 Run。blocked 是显式
      // 状态，优先于“没有会话”的泛化拒绝。
      if (prior.resumeContext === 'blocked') {
        throw new RunCommandError(
          'CONFLICT',
          'resume source run session was cleaned up (resumeContext=blocked)',
        )
      }
      if (prior.dshSessionId === null) {
        throw new RunCommandError(
          'CONFLICT',
          'resume source run has no session to continue (never reached running)',
        )
      }
      if (prior.deviceId !== device.id || prior.workspaceId !== workspace.id) {
        throw new RunCommandError(
          'CONFLICT',
          'resume must keep the same device and workspace as the source run',
        )
      }
      resumeSource = prior
    }

    const active = await tx
      .select({ id: schema.runs.id })
      .from(schema.runs)
      .where(
        and(eq(schema.runs.taskId, taskId), inArray(schema.runs.status, [...ACTIVE_RUN_STATUSES])),
      )
    if (active.length > 0) {
      throw new RunCommandError('RUN_ALREADY_ACTIVE', 'task already has an active run')
    }

    // 评审 M4：purpose 是**客户端可声明**的免绑定标记，不设门槛就等于给「约定流程」
    // 开了后门（任何有指令权的人传 agreement_draft 即可绕过 AGREEMENT_REQUIRED 跑业务
    // 工作）。辅助 Run 只允许责任人发起（ADR-0017 §1 的整理约定场景）。
    if (
      input.purpose !== undefined &&
      input.purpose !== 'business' &&
      task.assigneeUserId !== ctx.userId
    ) {
      throw new RunCommandError('FORBIDDEN', 'helper run purposes are assignee-only')
    }
    // 任务约定绑定（#378；ADR-0017 §2）：与输入清单同一事务内固化，全入口单点收口。
    const specRevision = await resolveSpecBinding(tx, task, input)
    const specRevisionId = specRevision?.id ?? null
    // #379（ADR-0017 §3）：Task 启用约定流程的业务 Run 携带收尾整理快照——Runtime
    // 据此在正常完成后生成交接草稿；辅助 Run 不生成（purpose 非 business）。
    const handoffRunSpec =
      task.agreementEnabled && (input.purpose ?? 'business') === 'business'
        ? {
            agreement:
              specRevision === null || specRevision.revisionNumber === null
                ? null
                : {
                    revisionNumber: specRevision.revisionNumber,
                    goal: specRevision.content.goal,
                    constraints: specRevision.content.constraints,
                    acceptance: specRevision.content.acceptance,
                    openQuestions: specRevision.content.openQuestions,
                  },
          }
        : undefined

    const artifactInputManifest = await snapshotRunInputs(
      tx,
      task.id,
      input.artifactInputIds,
      resumeSource ?? rerunSource,
    )
    // 跨 Task 交接输入（#380；ADR-0017 §5）：显式 receipt 或重跑/续跑继承来源快照；
    // 与上面的同 Task 清单**互不合并**——两条独立的固定输入面。
    const handoffInput = await snapshotHandoffInput(
      tx,
      task,
      input.handoffReceiptId,
      resumeSource ?? rerunSource,
    )
    // ADR-0028（RD-02a-2a）：工作输入与 Run 同事务冻结；清单创建后不可改。
    const workInputs = await snapshotWorkInputs(tx, task, input.workInputItemIds)
    // ADR-0028 §6（RD-03a）：机器 Run 即使没有收件箱条目也必须绑定 workKey；
    // 显式 workKey 必须是本 Task 的 active 工作，且与冻结清单一致。
    let explicitWorkKey: string | undefined
    if (input.workKey !== undefined) {
      const work = await getWorkByKeyForUpdate(tx, input.workKey)
      if (
        work === undefined ||
        work.taskId !== taskId ||
        work.state !== 'active' ||
        work.humanOwnerUserId !== task.assigneeUserId
      ) {
        throw new RunCommandError('CONFLICT', 'work is not active for this task assignee')
      }
      explicitWorkKey = work.workKey
      if (workInputs !== undefined && workInputs.work.workKey !== explicitWorkKey) {
        throw new RunCommandError('CONFLICT', 'work inputs do not belong to the intent work')
      }
    }
    if (origin === 'mandate' && explicitWorkKey === undefined) {
      throw new RunCommandError('VALIDATION_FAILED', 'machine run must carry a workKey')
    }
    const runWorkKey = workInputs?.work.workKey ?? explicitWorkKey
    const runId = randomUUID()
    const commandId = randomUUID()

    // 判权**复读**（复核 #204 观察 7 → #205 复核 S2 纠正了口径）：
    //
    // 事实订正：我原先在这里写「撤销授权不阻塞这里的 Task 行锁」——**这是反的**。
    // `revokeInstructionRight` 第一步也是 `lockTask` 的 `for('update')`，与建 Run 抢**同一把 Task
    // 行锁**，所以**生产可达路径上撤销与建 Run 本来就已串行**（复核 PROBE C：撤销在门后阻塞满 3s
    // 超时，orchestrator 照常建出 Run）。窗口本来就是关着的，功劳在 Task 锁，不在这次复读。
    //
    // 那这次复读还防什么？防**带外删除**——绕过 `revokeInstructionRight`（不经 Task 锁）直接删授权行
    // 的路径（运维脚本、将来的批量接口）。READ COMMITTED 下它能读到期间提交的删除（复核 PROBE B 复现）。
    // 便宜、无害、方向正确，故保留。
    await RunOrchestrator.assertInstructionRightStillValid(tx, taskId, ctx.userId)
    await insertRun(tx, {
      id: runId,
      taskId,
      ownerUserId: task.assigneeUserId,
      agentId: agent.id,
      profileRevisionId: revision.id,
      deviceId: device.id,
      workspaceId: workspace.id,
      artifactInputManifest,
      ...(runWorkKey === undefined ? {} : { workKey: runWorkKey }),
      ...(workInputs === undefined
        ? {}
        : {
            workInputManifest: workInputs.manifest,
            workInputManifestDigest: workInputs.manifestDigest,
          }),
      origin,
      ...(origin === 'mandate'
        ? {
            mandateId: input.mandateId!,
            dispatchIntentId: input.dispatchIntentId!,
            onBehalfOfUserId: input.onBehalfOfUserId!,
          }
        : {}),
      ...(handoffInput !== null ? { handoffInput } : {}),
      ...(input.reviewInput !== undefined ? { reviewInput: input.reviewInput } : {}),
      ...(specRevisionId !== null ? { specRevisionId } : {}),
      ...(input.purpose !== undefined ? { purpose: input.purpose } : {}),
      profileDigest: revision.profileDigest,
      pluginPackDigest: pack.packDigest,
      dshDistributionVersion: input.dshDistributionVersion,
      approvalPolicy,
      createdAt: now, // #119：领域时钟出生时间，reconcile 新生儿宽限的对表基准
      ...(input.rerunOfRunId !== undefined ? { rerunOfRunId: input.rerunOfRunId } : {}),
      ...(input.resumeFromRunId !== undefined ? { resumeFromRunId: input.resumeFromRunId } : {}),
    })
    if (workInputs !== undefined) {
      await recordWorkInputDeliveries(tx, workInputs, runId, now)
    }
    // ADR-0027（PC-05a）：项目上下文快照与 Run/Outbox 同事务冻结。选择只读当前
    // 有效 Decision/Observation；Inference 永不进入执行依据。空快照仍落行，
    // 但 `run.start` 不携带 projectContext（旧 Node 可继续执行）。
    const projectContext = await createRunProjectContext(tx, {
      runId,
      projectId: task.projectId,
      taskId: task.id,
      now,
    })
    assertProjectContextCapability(
      device,
      projectContext.start === undefined ? 0 : projectContext.start.manifest.length,
    )
    if (projectContext.start !== undefined) {
      // ADR-0027 §6（PC-05b）：创建事务内派生首版状态（全 frozen）并把完整状态
      // 入队；Node 早于 run.start 收到也只会持久化，等下载完成后再应用。
      const derivedState = await refreshRunContextState(tx, projectContext.snapshotId, now)
      await enqueueRunContextState(tx, this.contextStateDeps, derivedState.state)
    }
    assertWorkInputCapability(device, workInputs?.items.length ?? 0)
    const runStartPayload = RunStartSchema.shape.payload.parse({
      commandId,
      runId,
      taskId,
      ownerUserId: task.assigneeUserId,
      agent: {
        id: agent.id,
        profileRevisionId: revision.id,
        persona: revision.persona,
        provider: revision.provider,
        model: revision.model,
        credentialSlot: revision.credentialSlot,
        ...(revision.maxTokens !== null ? { maxTokens: revision.maxTokens } : {}),
      },
      workspaceId: workspace.id,
      expectedProfileDigest: revision.profileDigest,
      expectedPluginPackDigest: pack.packDigest,
      prompt: input.prompt,
      executionContext: buildExecutionContext(
        specRevision,
        handoffInput,
        input.reviewInput ?? null,
      ),
      // 切片⑧：解析后的档位成对固化（run.start 与 runs 行同值，Node 只透传）。
      approvalPolicy,
      // ADR-0028 §7（RD-03c1）：机器 Run 的固定草稿面（人类 Run 缺省）。
      ...(input.toolPolicy !== undefined ? { toolPolicy: input.toolPolicy } : {}),
      // #379：收尾交接草稿的触发与约定快照（缺省 = 不生成）。
      ...(handoffRunSpec !== undefined ? { handoff: handoffRunSpec } : {}),
      // ADR-0027 §3：本 Run 冻结的项目上下文清单（正文走 Node 受控下载）。
      ...(projectContext.start !== undefined ? { projectContext: projectContext.start } : {}),
      // ADR-0028 §3：本 Run 冻结的工作输入清单（正文走 Node 受控下载）。
      ...(workInputs !== undefined
        ? {
            workInput: { manifestDigest: workInputs.manifestDigest, manifest: workInputs.manifest },
          }
        : {}),
      // 切片⑤：成对下发——resumeOfRunId 让 Node 把 dshHomePath 指向来源 Run 的
      // home（per-run 隔离下新 home 没有旧日志）；resumeSessionId 直达装载身份。
      ...(resumeSource !== undefined
        ? { resumeOfRunId: resumeSource.id, resumeSessionId: resumeSource.dshSessionId! }
        : {}),
    })
    onSnapshot?.({
      snapshotId: projectContext.snapshotId,
      entryCount: projectContext.start?.manifest.length ?? 0,
    })
    // 首个 Run 把 Task 推进到 in_progress（§3.1）；in_progress 上重复 run_started 无边。
    if (task.status === 'open' || task.status === 'in_review') {
      const next = transitionTask({ status: task.status }, { type: 'run_started' })
      await setTaskStatus(tx, taskId, next.status)
    }
    await appendTeamEvent(tx, {
      type: 'run.changed',
      payload: { runId, taskId, status: 'queued' },
    })
    await this.outbox.enqueue(tx, {
      id: commandId,
      deviceId: device.id,
      type: 'run.start',
      payload: runStartPayload,
      notBefore: now,
    })
    const row = await getRun(tx, runId)
    if (row === undefined) throw new Error('run insert lost in its own transaction')
    return toRunView(row)
  }

  /**
   * ADR-0027 §3：`run.start` 真正下发前的复核。快照只在创建后、派发前这段窗口内
   * 可能被新的约定/交接版本或条目纠正追上；任一失败走既有派发失败路径
   * `failed(CONTEXT_UNAVAILABLE)`，不自动换最新版本，也不静默丢条目。
   *
   * 返回 false = 本命令不得发出（worker 会作废该 outbox 行）。没有快照的历史
   * Run 直接放行。
   */
  async beforeDispatch(command: ClaimedCommand): Promise<boolean> {
    if (command.type !== 'run.start') return true
    const payload = command.payload as { runId?: unknown }
    if (typeof payload.runId !== 'string') return true
    // 已成功写入过 Node 的命令是同一冻结快照的重复投递（R7 ack 丢失/重连重发）；
    // 期间来源变化只能影响「尚未发出的新快照」，不能把已在执行的 Run 判失败。
    if (command.sentAt !== null) return true
    const now = this.nowFn()
    const recorded: RecordedContextEntry[] = []
    const dispatch: { outcome: 'send' | 'block' | 'skip' } = { outcome: 'skip' }
    let blockReason: string | undefined
    await this.database.transaction(async (tx) => {
      const [run] = await tx
        .select()
        .from(schema.runs)
        .where(eq(schema.runs.id, payload.runId as string))
        .for('update')
      if (run === undefined || run.status !== 'queued' || run.deviceId !== command.deviceId) {
        return
      }
      // RD-03a：机器 Run 在真正发往 Node 前复核 Mandate/意图/Task；撤权后即使
      // 取消事务尚未到达，也走既有 queued 取消路径，绝不把 run.start 发出去。
      const machineVerification = await verifyRunMachineDispatch(tx, run, now)
      if (!machineVerification.ok) {
        blockReason = machineVerification.reason
        await cancelRunInTransaction(tx, { outbox: this.outbox, now }, run, 'admin')
        dispatch.outcome = 'block'
        return
      }
      // RD-03c1：升级前排队、未被本版本固化 toolPolicy 的机器 Run 一律不下发。
      // 旧行没有固定草稿面，继续跑会退回 ask-all 并把自主 Run 卡在审批上；按
      // 「机器 Run 必须有 policy」fail closed，走既有 queued 取消路径。
      const startPayload = command.payload as { toolPolicy?: unknown }
      if (run.origin === 'mandate' && startPayload.toolPolicy === undefined) {
        blockReason = 'machine_tool_policy_missing'
        await cancelRunInTransaction(tx, { outbox: this.outbox, now }, run, 'admin')
        dispatch.outcome = 'block'
        return
      }
      const projectVerification = await verifyRunProjectContext(tx, run)
      const verification = projectVerification.ok
        ? await verifyRunWorkInputs(tx, run)
        : projectVerification
      if (verification.ok) {
        dispatch.outcome = 'send'
        return
      }
      blockReason = verification.reason
      transitionRun({ status: run.status }, { type: 'failed' })
      const failureSummary = `Run 输入在派发前复核失败（${verification.reason}）`
      // 评审 B2：创建 Run 与真正下发之间是异步窗口，指令消息此时仍是 pending。
      // 先于状态迁移结算，理由才是精确的 CONTEXT_UNAVAILABLE；`setRunStatus` 的
      // 终态兜底只接管仍 pending 的追问（RUN_TERMINAL），不该盖掉这里的根因。
      await settleTriggerInstruction(tx, run, {
        accepted: false,
        error: { code: 'CONTEXT_UNAVAILABLE', message: failureSummary },
      })
      await applyRunStatus(
        tx,
        this.outbox,
        run.id,
        'failed',
        {
          failureCode: 'CONTEXT_UNAVAILABLE',
          failureSummary,
          finishedAt: now,
        },
        recorded,
      )
      await appendTeamEvent(tx, {
        type: 'run.changed',
        payload: { runId: run.id, taskId: run.taskId, status: 'failed' },
      })
      await failInTransaction(tx, command.id, now)
      dispatch.outcome = 'block'
    })
    this.flushContextEvents(recorded)
    if (dispatch.outcome === 'block') {
      this.contextLog('context.dispatch_blocked', {
        component: 'hub.context',
        runId: payload.runId,
        reason: blockReason,
      })
    }
    return dispatch.outcome === 'send'
  }

  /**
   * 取消（§3.2）：queued 直接在事务内作废待投 run.start 并转 cancelled；
   * dispatching/running/waiting_approval 转 cancel_requested 并入队 run.cancel；
   * cancel_requested/cancelled 幂等返回；其余终态抛 INVALID_RUN_TRANSITION。
   * run 侧写入复用 cancelRunInTransaction（与 Task 取消共享同一事务时同源）。
   */
  async cancel(ctx: ActorContext, runId: string): Promise<RunView> {
    const now = this.nowFn()
    const recorded: RecordedContextEntry[] = []
    const view = await this.database.transaction(async (tx) => {
      const [run] = await tx
        .select()
        .from(schema.runs)
        .where(eq(schema.runs.id, runId))
        .for('update')
      if (run === undefined) throw new RunCommandError('NOT_FOUND', 'run not found')
      if (!authorize(ctx, 'cancel_run', { ownerUserId: asUserId(run.ownerUserId) })) {
        throw new RunCommandError('FORBIDDEN', 'only the run owner or a team admin can cancel')
      }
      await cancelRunInTransaction(
        tx,
        { outbox: this.outbox, now, recorded },
        run,
        ctx.userId === run.ownerUserId ? 'user' : 'admin',
      )
      const row = await getRun(tx, runId)
      if (row === undefined) throw new Error('run vanished in its own transaction')
      return toRunView(row)
    })
    this.flushContextEvents(recorded)
    return view
  }

  /**
   * Approval 一次性决定（03 §4「POST /approvals/:approvalId/decisions」；P1-14）。
   * owner-only、first-wins、过期即拒——语义见 decide.ts；此处负责行锁、
   * NotFound 判定与事务边界。
   */
  async decideApproval(
    ctx: ActorContext,
    approvalId: string,
    decision: ApprovalDecisionInput,
  ): Promise<ApprovalView> {
    const now = this.nowFn()
    return this.database.transaction(async (tx) => {
      const [approval] = await tx
        .select()
        .from(schema.approvals)
        .where(eq(schema.approvals.id, approvalId))
        .for('update')
      if (approval === undefined) throw new RunCommandError('NOT_FOUND', 'approval not found')
      const [run] = await tx
        .select()
        .from(schema.runs)
        .where(eq(schema.runs.id, approval.runId))
        .for('update')
      if (run === undefined) throw new RunCommandError('NOT_FOUND', 'run not found')
      const row = await decideApprovalInTransaction(
        tx,
        { outbox: this.outbox, now },
        approval,
        run,
        ctx,
        decision,
      )
      return toApprovalView(row)
    })
  }

  /**
   * Approval 过期清扫（G5-05）：组合根周期驱动；语义见 approval-expiry.ts。
   * 返回本轮写入 expired 的行数。
   */
  async expireApprovals(now: Date): Promise<number> {
    return expireApprovals({ database: this.database, outbox: this.outbox, now: this.nowFn }, now)
  }

  /**
   * Node 上行帧入口（fail-closed：未知 type/畸形载荷抛 ProtocolError）。
   * 任何已认证帧都刷新设备租约（lastSeenAt）；hello/inventory/live_delta 由
   * device/realtime 模块负责（P1-09/13），这里只租约刷新，不做 run 侧动作。
   */
  async ingestNodeEvent(device: AuthenticatedDevice, rawFrame: unknown): Promise<void> {
    const frame = parseNodeFrame(rawFrame, 'upstream')
    const now = this.nowFn()
    await this.database.db
      .update(schema.devices)
      .set({ lastSeenAt: now })
      .where(eq(schema.devices.id, device.deviceId))
    switch (frame.type) {
      case 'command.ack':
        await this.handleCommandAck(device, frame.payload, now)
        return
      case 'run.event':
        await this.handleRunEvent(device, frame.payload, now)
        return
      case 'run.snapshot':
        await this.handleRunSnapshot(device, frame.payload, now)
        return
      case 'run.context_receipt':
        await this.handleRunContextReceipt(device, frame.payload, now)
        return
      case 'run.work_input_receipt':
        await this.handleRunWorkInputReceipt(device, frame.payload, now)
        return
      case 'context.state_pull':
        await this.handleContextStatePull(device, frame.payload, now)
        return
      case 'context.state_ack':
        await this.handleContextStateAck(device, frame.payload, now)
        return
      case 'node.heartbeat':
        if (frame.payload.deviceId !== device.deviceId) {
          throw new RunCommandError('FORBIDDEN', 'heartbeat device does not match the connection')
        }
        this.deviceActivity.set(device.deviceId, {
          at: now,
          activeRunIds: new Set(frame.payload.activeRunIds),
        })
        // #88：心跳仍把 Hub 已终态的 Run 列为 active（Node 侧 Runtime 滞留——
        // 如断连期被判 lost、本地还在等审批）→ 入队 admin run.cancel 让 Node
        // 走既有取消升级链收敛进程。不动账本状态（终态禁复活），每 Run 本进程
        // 内只发一次（心跳 10s 一拍，不得刷出重发风暴；Hub 重启重发无害——
        // Node 侧幂等：本地已终态只回 ack）。
        await this.convergeTerminalActiveRuns(device, frame.payload.activeRunIds, now)
        return
      default:
        return
    }
  }

  /**
   * 落库前的判权复核（见 `createInTransaction` 里的说明）。抽成独立函数是为了**能被判据直接调用**：
   * 复核 #205 实测「删掉复读整段 → 24/24 全绿」，即它此前零覆盖。
   */
  static async assertInstructionRightStillValid(
    tx: Tx,
    taskId: string,
    userId: string,
  ): Promise<void> {
    const right = await resolveInstructionRight(tx, taskId, userId)
    if (right === 'none') {
      throw new RunCommandError(
        'FORBIDDEN',
        'instruction rights were revoked before the run could be created',
      )
    }
  }

  /** 派发确认（02 Step 5）：ack 落库与状态迁移同事务；重复 ack 幂等。 */
  private async handleCommandAck(
    device: AuthenticatedDevice,
    ack: {
      commandId: string
      accepted: boolean
      error?: { code: ErrorCode; message: string } | undefined
    },
    now: Date,
  ): Promise<void> {
    const recorded: RecordedContextEntry[] = []
    await this.database.transaction(async (tx) => {
      const command = await getOutboxCommand(tx, ack.commandId)
      if (command === undefined) return // 重启前的残留 ack：无行可动
      if (command.deviceId !== device.deviceId) {
        throw new RunCommandError('FORBIDDEN', 'ack device does not match the command destination')
      }
      const acked = await ackInTransaction(tx, ack.commandId, now)
      if (!acked) return // 重复 ack（R7 重发后的旧 ack 重放）
      if (command.type === 'run.followup') {
        // #186：追问的受理回执此前落到 outbox 就断了（`!== 'run.start'` 直接 return），
        // 线程消息永远停在 pending——正是 ADR-0009 决策 3 禁止的「已受理、零痕迹」的镜像。
        // 结算按消息行上的状态收敛（只从 pending 走一次），理由同事务落库。
        await settleFollowupAck(tx, command, ack)
        return
      }
      if (command.type !== 'run.start') return
      const runId = (command.payload as { runId?: unknown }).runId
      if (typeof runId !== 'string') return
      const [run] = await tx
        .select()
        .from(schema.runs)
        .where(eq(schema.runs.id, runId))
        .for('update')
      if (run === undefined) return
      // #196：由执行区指令起的 Run，其 run.start ack 就是**那条指令**的命运（决策 3「受理即落账」）。
      // 与 followup 的区别只是锚点不同：这里是 runs.trigger_message_id，那边是 outbox.message_id。
      await settleTriggerInstruction(tx, run, ack)
      // 迟到 ack 仍结算消息；已推进的 Run 不重复迁移，终态不复活。
      if (run.status !== 'queued') return
      if (ack.accepted) {
        this.applyRunTransition(run, { type: 'dispatch_acked' })
        await setRunStatus(tx, run.id, 'dispatching')
        await appendTeamEvent(tx, {
          type: 'run.changed',
          payload: { runId: run.id, taskId: run.taskId, status: 'dispatching' },
        })
      } else {
        this.applyRunTransition(run, { type: 'failed' })
        await applyRunStatus(
          tx,
          this.outbox,
          run.id,
          'failed',
          {
            failureCode: ack.error?.code ?? 'RUNTIME_START_FAILED',
            failureSummary: ack.error?.message ?? 'node rejected run.start',
            finishedAt: now,
          },
          recorded,
        )
        await appendTeamEvent(tx, {
          type: 'run.changed',
          payload: { runId: run.id, taskId: run.taskId, status: 'failed' },
        })
      }
    })
    this.flushContextEvents(recorded)
  }

  /**
   * ADR-0027 §4：`run.context_receipt` 接受谓词全部成立才落库；终态后迟到记
   * `receipt_late`，不复活 Run。回执是受信 Node 的自报证据，不防恶意 Node。
   */
  private async handleRunContextReceipt(
    device: AuthenticatedDevice,
    receipt: RunContextReceipt,
    now: Date,
  ): Promise<void> {
    let outcome: Awaited<ReturnType<typeof recordRunContextReceipt>> | undefined
    // 消费行写入失败只记 consumption_gap；告警在事务提交后统一写，避免回滚留下
    // 指向不存在 receipt 的日志。
    const gaps: { message: string; context: Record<string, unknown> }[] = []
    await this.database.transaction(async (tx) => {
      const [run] = await tx
        .select()
        .from(schema.runs)
        .where(eq(schema.runs.id, receipt.runId))
        .for('update')
      if (run === undefined) return
      if (run.deviceId !== device.deviceId) {
        throw new RunCommandError('FORBIDDEN', 'run does not belong to this device')
      }
      outcome = await recordRunContextReceipt(tx, run, receipt, now, (message, context) => {
        gaps.push({ message, context })
      })
    })
    for (const gap of gaps) this.warnFn(gap.message, gap.context)
    if (outcome === undefined) return
    // PC-05b-2：无论 accepted/duplicate/late/rejected 都回 ack；Node 只有收到
    // ack 才删除本地回执发件箱，否则断线重连后会继续重放。发送失败（Node 恰好
    // 断开）不是协议违例：快照与消费事实已提交，Node 重放同一 seq 会得到幂等
    // duplicate ack。
    const ackResult =
      outcome.status === 'accepted'
        ? 'accepted'
        : outcome.status === 'duplicate'
          ? 'duplicate'
          : outcome.status === 'late'
            ? 'late'
            : 'rejected'
    try {
      this.sendFn(device.deviceId, {
        protocolVersion: 1,
        messageId: randomUUID(),
        sentAt: now.toISOString(),
        type: 'run.context_receipt_ack',
        payload: {
          runId: receipt.runId,
          snapshotId: receipt.snapshotId,
          receiptSeq: receipt.receiptSeq,
          highestSeq:
            outcome.status === 'accepted' || outcome.status === 'duplicate'
              ? outcome.highestSeq
              : 0,
          result: ackResult,
          ...(outcome.status === 'rejected' ? { reason: outcome.reason } : {}),
        },
      })
    } catch (error) {
      this.contextLog('context.receipt_ack_send_failed', {
        component: 'hub.context',
        runId: receipt.runId,
        snapshotId: receipt.snapshotId,
        receiptSeq: receipt.receiptSeq,
        result: ackResult,
        errorName: error instanceof Error ? error.name : typeof error,
      })
    }
    if (outcome.status === 'accepted') {
      this.contextLog('context.receipt_recorded', {
        component: 'hub.context',
        runId: receipt.runId,
        snapshotId: outcome.snapshotId,
        receiptSeq: receipt.receiptSeq,
        delivered: outcome.delivered,
        read: outcome.read,
      })
      return
    }
    if (outcome.status === 'duplicate') {
      this.contextLog('context.receipt_duplicate', {
        component: 'hub.context',
        runId: receipt.runId,
        snapshotId: outcome.snapshotId,
        receiptSeq: receipt.receiptSeq,
        highestSeq: outcome.highestSeq,
      })
      return
    }
    if (outcome.status === 'late') {
      this.contextLog('context.receipt_late', {
        component: 'hub.context',
        runId: receipt.runId,
        snapshotId: receipt.snapshotId,
        receiptSeq: receipt.receiptSeq,
      })
      return
    }
    this.contextLog('context.receipt_invalid', {
      component: 'hub.context',
      runId: receipt.runId,
      snapshotId: receipt.snapshotId,
      receiptSeq: receipt.receiptSeq,
      reason: outcome.reason,
    })
  }

  /** ADR-0027 §6（PC-05b）：Node 摘要不一致时拉取完整状态；归属不符即忽略。 */
  private async handleContextStatePull(
    device: AuthenticatedDevice,
    pull: ContextStatePull,
    now: Date,
  ): Promise<void> {
    const enqueued = await handleRunContextStatePull(this.contextStateDeps, device.deviceId, pull)
    this.contextLog('context.state_pull', {
      component: 'hub.context',
      runId: pull.runId,
      snapshotId: pull.snapshotId,
      knownStateVersion: pull.knownStateVersion,
      enqueued,
      at: now.toISOString(),
    })
  }

  /** ADR-0027 §6（PC-05b）：Node 应用完整状态后的回执；未知/越权版本只丢弃。 */
  private async handleContextStateAck(
    device: AuthenticatedDevice,
    ack: ContextStateAck,
    now: Date,
  ): Promise<void> {
    const accepted = await recordRunContextStateAck(this.contextStateDeps, device.deviceId, ack)
    this.contextLog(accepted ? 'context.state_acked' : 'context.state_ack_invalid', {
      component: 'hub.context',
      runId: ack.runId,
      snapshotId: ack.snapshotId,
      stateVersion: ack.stateVersion,
      failed: ack.failedEntryIds.length,
      at: now.toISOString(),
    })
  }

  /**
   * ADR-0028 §3（RD-02a-2b）：工作输入回执独立于项目上下文——Run 终态后仍接受；
   * 窗口内 consumed，窗口后只记迟到对账。这里只做事务边界与设备归属，状态机在
   * work/receipts.ts。
   */
  private async handleRunWorkInputReceipt(
    device: AuthenticatedDevice,
    receipt: RunWorkInputReceipt,
    now: Date,
  ): Promise<void> {
    let outcome: Awaited<ReturnType<typeof recordRunWorkInputReceipt>> | undefined
    try {
      await this.database.transaction(async (tx) => {
        const [run] = await tx
          .select()
          .from(schema.runs)
          .where(eq(schema.runs.id, receipt.runId))
          .for('update')
        if (run === undefined) return
        if (run.deviceId !== device.deviceId) {
          throw new RunCommandError('FORBIDDEN', 'run does not belong to this device')
        }
        outcome = await recordRunWorkInputReceipt(tx, run, receipt, now)
      })
    } catch (error) {
      // 回执是独立对账通道：单条语义冲突只丢弃该回执并留观测，不得升级成
      // 设备连接 4003（那会连带影响同设备上所有活跃 Run）。
      if (error instanceof RunCommandError && error.code === 'CONFLICT') {
        this.contextLog('work.input_receipt_invalid', {
          component: 'hub.work_input',
          runId: receipt.runId,
          receiptSeq: receipt.receiptSeq,
          reason: error.message,
        })
        return
      }
      throw error
    }
    if (outcome === undefined) return
    this.contextLog('work.input_receipt', {
      component: 'hub.work_input',
      runId: receipt.runId,
      receiptSeq: receipt.receiptSeq,
      consumed: outcome.consumed,
      duplicate: outcome.duplicate,
      duplicateConsumption: outcome.duplicateConsumption,
      late: outcome.late,
      idempotent: outcome.idempotent,
    })
  }

  /**
   * Projected Run Event（§6.4）：(runId, seq) 幂等去重后落 run_event，
   * 并按事件类型推进状态机。重复 seq 整帧跳过（不重迁移、不产生第二行）。
   */
  private async handleRunEvent(
    device: AuthenticatedDevice,
    payload: ProjectedRunEvent,
    now: Date,
  ): Promise<void> {
    const recorded: RecordedContextEntry[] = []
    await this.database.transaction(async (tx) => {
      const [run] = await tx
        .select()
        .from(schema.runs)
        .where(eq(schema.runs.id, payload.runId))
        .for('update')
      if (run === undefined) return
      if (run.deviceId !== device.deviceId) {
        throw new RunCommandError('FORBIDDEN', 'run does not belong to this device')
      }
      const { appended } = await appendRunEvent(tx, {
        id: randomUUID(),
        runId: run.id,
        seq: payload.seq,
        type: payload.event.type,
        audience: payload.audience,
        payload: payload.event,
        occurredAt: new Date(payload.occurredAt),
      })
      if (!appended) return
      await appendTeamEvent(tx, {
        type: 'run.event',
        payload: {
          runId: run.id,
          seq: payload.seq,
          audience: payload.audience,
          // P1-13 受众过滤的事实源：Browser 扇出按它决定 owner 帧的可见性。
          ownerUserId: run.ownerUserId,
          event: payload.event,
        },
      })
      // #379（ADR-0017 §3）：交接草稿事实先落（幂等、不碰 Run 状态）——放在终态
      // 早返**之前**：迟到/重放的上行仍要能补上草稿，但绝不复活终态。
      // 受众纪律（评审 m1）：handoff.draft 按协议**只允许 owner 受众**；非 owner 行
      // 直接拒绝（fail-closed）——拒绝在同一事务内回滚，run_event 留痕与团队扇出都不
      // 发生；否则伪造的 project 行会把私有草稿内容推给全团队。
      if (payload.event.type === 'handoff.draft' && payload.audience !== 'owner') {
        throw new RunCommandError(
          'VALIDATION_FAILED',
          'handoff.draft frames must use the owner audience',
        )
      }
      if (payload.event.type === 'handoff.draft') {
        await persistHandoffDraftEvent(tx, run, payload.event, now)
      }
      // 终态禁复活（§3.2/R5）：迟到事件已持久留证，状态不动。
      if (isTerminal(run.status)) return
      // 双受众单行迁移（P1-13 链路实测）：同一事实的 owner/project 两行各自
      // append 成功，若都推状态机，第二行必撞 INVALID_RUN_TRANSITION——状态
      // 迁移只由 owner（全量）行驱动，project（收缩）行是纯镜像。
      if (payload.audience !== 'owner') return
      // ADR-0012「事件即受理证据」：ack 是背书不是许可。ack 可能丢失（传输/崩溃窗），
      // 而 Node 一旦受理就会把 Runtime 起起来并上行事件——此时若还停在 queued，按表边
      // 处理会把 Run 误判 failed(INVALID_RUN_TRANSITION)（A0-8 取证实测：丢一次 ack
      // 即复现，R7 连跑不稳）。先把"受理"按事件所证补上，再走正常事件迁移。
      // 不伪造 ack：outbox 行的 acked_at 只由真实 command.ack 写。
      if (run.status === 'queued') {
        // applyRunTransition 是**纯校验器**（返回目标态、不改行）：这里必须把内存行一起推进
        // ——紧接着的 applyProjectedEvent 读的就是这个对象（首版漏了这步，判据立刻抓到）。
        const dispatched = this.applyRunTransition(run, { type: 'dispatch_acked' })
        await setRunStatus(tx, run.id, dispatched.status)
        run.status = dispatched.status
        await appendTeamEvent(tx, {
          type: 'run.changed',
          payload: { runId: run.id, taskId: run.taskId, status: dispatched.status },
        })
      }
      try {
        await this.applyProjectedEvent(tx, run, payload.event, now, recorded)
      } catch (error) {
        // #52/ADR-0007：表外边/引用缺失——语义冲突在本事务内降级：已 append 的
        // 事件行随降级提交一起留证（现状：抛错回滚，连证都留不下），Run 收敛
        // failed，帧按正常应用 ack 掉（水位推进、spool 可 GC）——毒帧循环从
        // 源头拆除，连接保留。
        if (isRunSemanticConflict(error)) {
          await this.convergeSemanticConflict(tx, run, error, now, recorded)
          return
        }
        throw error
      }
    })
    this.flushContextEvents(recorded)
  }

  /**
   * 语义冲突的 Run 级收敛（ADR-0007 决策 2）：failed(INVALID_RUN_TRANSITION)、
   * pending Approval 随终态折叠（cause=run_terminal_fold）、run.changed 广播、
   * 结构化 warn（违例的可观测面）。不走 transitionRun——收敛本身必须无条件
   * 成立（否则又造出新的不可收敛态）。
   */
  private async convergeSemanticConflict(
    tx: Tx,
    run: RunRow,
    error: unknown,
    now: Date,
    recorded: RecordedContextEntry[],
  ): Promise<void> {
    const reason = error instanceof Error ? error.message : String(error)
    this.warnFn('run transition violation converged to failed', {
      component: 'hub.run.orchestrator.transition-violation',
      runId: run.id,
      deviceId: run.deviceId,
      taskId: run.taskId,
      fromStatus: run.status,
      reason,
    })
    await applyRunStatus(
      tx,
      this.outbox,
      run.id,
      'failed',
      {
        failureCode: 'INVALID_RUN_TRANSITION',
        failureSummary: `transition violation: ${reason}`.slice(0, 1000),
        finishedAt: now,
      },
      recorded,
    )
    await cancelPendingApprovalsInTransaction(tx, run, now, 'run_terminal_fold')
    await appendTeamEvent(tx, {
      type: 'run.changed',
      payload: { runId: run.id, taskId: run.taskId, status: 'failed' },
    })
  }

  private async applyProjectedEvent(
    tx: Tx,
    run: RunRow,
    event: ProjectedRunEvent['event'],
    now: Date,
    recorded: RecordedContextEntry[],
  ): Promise<void> {
    const runChanged = async (status: RunRow['status']) => {
      await appendTeamEvent(tx, {
        type: 'run.changed',
        payload: { runId: run.id, taskId: run.taskId, status },
      })
    }
    switch (event.type) {
      case 'runtime.ready': {
        this.applyRunTransition(run, { type: 'runtime_ready' })
        // 走收口：进入 running 时顺带放行排队中的追问（ADR-0009 决策 5）。
        await applyRunStatus(tx, this.outbox, run.id, 'running', {
          dshSessionId: event.dshSessionId,
          startedAt: run.startedAt ?? now,
        })
        await runChanged('running')
        return
      }
      case 'run.completed': {
        this.applyRunTransition(run, { type: 'completed' })
        await applyRunStatus(tx, this.outbox, run.id, 'completed', { finishedAt: now }, recorded)
        // #52/ADR-0007：Runtime 终态裁决折叠悬置审批（waiting_approval 来的
        // 裁决在此落账；running 来的折叠是恒等空转，一并防御既有不变量）。
        await cancelPendingApprovalsInTransaction(tx, run, now, 'run_terminal_fold')
        await runChanged('completed')
        return
      }
      case 'run.failed': {
        this.applyRunTransition(run, { type: 'failed' })
        await applyRunStatus(
          tx,
          this.outbox,
          run.id,
          'failed',
          {
            failureCode: event.code,
            failureSummary: event.summary,
            finishedAt: now,
          },
          recorded,
        )
        await cancelPendingApprovalsInTransaction(tx, run, now, 'run_terminal_fold')
        await runChanged('failed')
        return
      }
      case 'run.cancelled': {
        this.applyRunTransition(run, { type: 'cancel_confirmed' })
        await applyRunStatus(tx, this.outbox, run.id, 'cancelled', { finishedAt: now }, recorded)
        await runChanged('cancelled')
        return
      }
      case 'approval.requested': {
        // 只有 owner 行会到这里（project 行在调用上游已被挡）；R6 重放的重复
        // owner 行则由 insertApprovalIfAbsent 幂等跳过（事件均已持久留证）。
        const { inserted } = await insertApprovalIfAbsent(tx, {
          id: event.approval.approvalId,
          runId: run.id,
          callId: event.approval.callId,
          toolName: event.approval.toolName,
          reason: event.approval.reason,
          preview: event.approval.preview,
          expiresAt: new Date(event.approval.expiresAt),
        })
        if (!inserted) return
        await appendTeamEvent(tx, {
          type: 'approval.changed',
          // taskId 供 Browser 端按 Task Room 粒度失效查询（03 §5 投影 payload）。
          payload: {
            approvalId: event.approval.approvalId,
            runId: run.id,
            taskId: run.taskId,
            status: 'pending',
          },
        })
        this.applyRunTransition(run, { type: 'approval_opened' })
        await setRunStatus(tx, run.id, 'waiting_approval')
        await runChanged('waiting_approval')
        return
      }
      case 'approval.decided': {
        const approval = await getApproval(tx, event.approvalId)
        if (approval === undefined || approval.runId !== run.id) {
          throw new RunCommandError('NOT_FOUND', 'approval not found')
        }
        if (approval.status === 'pending') {
          // §2.6：decided_by 必须等于 Run owner（决定是 owner 在 Node 侧生效后上报的）。
          await setApprovalStatus(tx, approval.id, event.status, run.ownerUserId, now)
          await appendTeamEvent(tx, {
            type: 'approval.changed',
            payload: {
              approvalId: approval.id,
              runId: run.id,
              taskId: run.taskId,
              status: event.status,
            },
          })
        }
        if (run.status === 'waiting_approval') {
          const remainingPending = await countPendingApprovals(tx, run.id)
          const next = this.applyRunTransition(run, {
            type: 'approval_closed',
            remainingPending,
          })
          if (next.status !== run.status) {
            // 当前 approval_closed 只到 running；仍传 collector，未来新增终态边时
            // 不会静默丢失 entry_recorded（评审 C6）。
            await applyRunStatus(tx, this.outbox, run.id, next.status, {}, recorded)
            await runChanged(next.status)
          }
        }
        return
      }
      default:
        // run.phase / assistant.message / tool.* / artifact.candidate / subagent.*：
        // 只持久投影。artifact.candidate 的 Artifact 行在 Node 上传时已落库
        // （P1-15：store+row 原子），这里不重复创建、也不产生状态迁移。
        return
    }
  }

  /**
   * Node 上报的 Run 投影（status_request 的应答）：只用于收敛非终态 Run；
   * Hub 已终态时一律忽略（禁复活）。非法边视为陈旧投影，跳过不报错。
   */
  private async handleRunSnapshot(
    device: AuthenticatedDevice,
    snapshot: RunSnapshot,
    now: Date,
  ): Promise<void> {
    const recorded: RecordedContextEntry[] = []
    await this.database.transaction(async (tx) => {
      const [run] = await tx
        .select()
        .from(schema.runs)
        .where(eq(schema.runs.id, snapshot.runId))
        .for('update')
      if (run === undefined) return
      if (run.deviceId !== device.deviceId) {
        throw new RunCommandError('FORBIDDEN', 'run does not belong to this device')
      }
      if (isTerminal(run.status)) return
      const event = this.snapshotToEvent(run, snapshot)
      if (event === undefined) return
      try {
        const next = this.applyRunTransition(run, event)
        await this.persistTransition(tx, run, next.status, snapshot, now, recorded)
      } catch (error) {
        if (error instanceof DomainError && error.code === 'INVALID_RUN_TRANSITION') return
        throw error
      }
    })
    this.flushContextEvents(recorded)
  }

  /**
   * #88：心跳 activeRunIds 里的 Hub 终态 Run → 入队 admin run.cancel（收敛取消）。
   * 只入队、不迁移状态（终态禁复活：账本行是真相，Node 侧滞留 Runtime 是要
   * 回收的副作用）。幂等由 terminalReleaseNotified（进程内）+ Node 免打扰
   * 守卫（本地已终态只回 ack）双层保证；run 不属于该设备或不存在时跳过。
   */
  private async convergeTerminalActiveRuns(
    device: AuthenticatedDevice,
    activeRunIds: readonly string[],
    now: Date,
  ): Promise<void> {
    const candidates = activeRunIds.filter((id) => !this.terminalReleaseNotified.has(id))
    if (candidates.length === 0) return
    await this.database.transaction(async (tx) => {
      for (const runId of candidates) {
        const [run] = await tx
          .select()
          .from(schema.runs)
          .where(eq(schema.runs.id, runId))
          .for('update')
        if (run === undefined) continue
        if (!isTerminal(run.status)) continue // 活跃 Run 每拍如实上报是常态，不记账
        if (run.deviceId !== device.deviceId) continue // 心跳声明他人设备的 Run：不动作
        this.terminalReleaseNotified.add(runId)
        const commandId = randomUUID()
        const payload = RunCancelSchema.shape.payload.parse({
          commandId,
          runId: run.id,
          cause: 'admin',
        })
        await this.outbox.enqueue(tx, {
          id: commandId,
          deviceId: run.deviceId,
          type: 'run.cancel',
          payload,
          notBefore: now,
        })
        this.warnFn('terminal run still active on node; enqueuing convergence cancel', {
          component: 'hub.orchestrator',
          runId: run.id,
          status: run.status,
          deviceId: device.deviceId,
        })
      }
    })
  }

  private snapshotToEvent(run: RunRow, snapshot: RunSnapshot): DomainRunEvent | undefined {
    switch (snapshot.status) {
      case 'running':
        return run.status === 'dispatching' ? { type: 'runtime_ready' } : undefined
      case 'completed':
        return { type: 'completed' }
      case 'failed':
        return { type: 'failed' }
      case 'cancelled':
        return { type: 'cancel_confirmed' }
      case 'lost':
        return { type: 'lease_expired' }
      default:
        return undefined
    }
  }

  private async persistTransition(
    tx: Tx,
    run: RunRow,
    status: RunRow['status'],
    snapshot: RunSnapshot,
    now: Date,
    recorded: RecordedContextEntry[],
  ): Promise<void> {
    const terminal = isTerminal(status)
    await applyRunStatus(
      tx,
      this.outbox,
      run.id,
      status,
      {
        ...(snapshot.dshSessionId !== null ? { dshSessionId: snapshot.dshSessionId } : {}),
        ...(status === 'running' ? { startedAt: run.startedAt ?? now } : {}),
        ...(terminal ? { finishedAt: now } : {}),
        ...(snapshot.failureCode !== null ? { failureCode: snapshot.failureCode } : {}),
        ...(snapshot.failureSummary !== null ? { failureSummary: snapshot.failureSummary } : {}),
      },
      recorded,
    )
    // ADR-0007：快照也能把 waiting_approval 收敛到终态（新边）——同一事务折叠
    // 悬置审批，守住「终态 Run 不挂 pending Approval」的账本不变式。
    if (terminal) {
      await cancelPendingApprovalsInTransaction(tx, run, now, 'run_terminal_fold')
    }
    await appendTeamEvent(tx, {
      type: 'run.changed',
      payload: { runId: run.id, taskId: run.taskId, status },
    })
  }

  /**
   * 状态迁移唯一入口：domain transitionRun 抛出即表外边。调用方分通道处置——
   * run.event 通道在同一事务捕获并 Run 级收敛留证（convergeSemanticConflict），
   * snapshot 通道视为陈旧投影静默跳过；HTTP/取消等写路径照旧上抛 409。
   */
  private applyRunTransition(run: RunRow, event: DomainRunEvent): { status: RunRow['status'] } {
    return transitionRun({ status: run.status }, event)
  }

  /** 启动恢复扫描（02 Step 6；R8）：语义见 reconciler.ts。 */
  async reconcileLeases(now: Date): Promise<number> {
    return reconcileLeases(
      {
        database: this.database,
        outbox: this.outbox,
        activity: this.deviceActivity,
        now: this.nowFn,
        log: this.logFn,
      },
      now,
    )
  }
}
