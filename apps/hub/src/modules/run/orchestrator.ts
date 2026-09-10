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
import { and, eq, inArray } from 'drizzle-orm'
import { asUserId, authorize, DomainError, transitionRun, transitionTask } from '@whalepod/domain'
import type { RunEvent as DomainRunEvent } from '@whalepod/domain'
import type { Database, RunRow, Tx } from '@whalepod/db'
import {
  ackInTransaction,
  appendRunEvent,
  appendTeamEvent,
  countPendingApprovals,
  findCommandReceipt,
  getApproval,
  getOutboxCommand,
  getRun,
  insertApprovalIfAbsent,
  insertRun,
  Outbox,
  schema,
  setApprovalStatus,
  setRunStatus,
  setTaskStatus,
  transactCommand,
  unwrapPgError,
} from '@whalepod/db'
import type { ErrorCode, ProjectedRunEvent, RunSnapshot } from '@whalepod/protocol'
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
import type { ApprovalView, RunView } from './queries.js'
import { toApprovalView, toRunView } from './queries.js'

const TERMINAL_RUN_STATUSES = ['completed', 'failed', 'cancelled', 'lost'] as const

function isTerminal(status: RunRow['status']): boolean {
  return (TERMINAL_RUN_STATUSES as readonly string[]).includes(status)
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
}

export class RunOrchestrator {
  private readonly database: Database
  private readonly outbox: Outbox
  private readonly nowFn: () => Date
  private readonly warnFn: (message: string, context: Record<string, unknown>) => void
  /** deviceId → 最近心跳；reconciler 据此判断「Node 在线但已没有该 Run」。 */
  readonly deviceActivity = new Map<string, DeviceActivity>()

  /** #88：已发收敛取消的终态 Run（本进程内去重；重启重发由 Node 侧幂等吸收）。 */
  private readonly terminalReleaseNotified = new Set<string>()

  constructor(deps: RunOrchestratorDeps) {
    this.database = deps.database
    this.outbox = deps.outbox
    this.nowFn = deps.now ?? (() => new Date())
    this.warnFn = deps.warn ?? (() => {})
  }

  /**
   * 幂等键重放返回首次结果；并发同 key 由 command_receipt 唯一约束串行化。
   * 同 key 并发时败者可能先撞活跃唯一（它在 Task 锁释放后才做预检，读不到
   * 回执早查的结果）：此时回读回执，返回胜者结果而非报 RUN_ALREADY_ACTIVE。
   */
  async create(ctx: ActorContext, taskId: string, input: CreateRunInput): Promise<RunView> {
    assertCreateRunInput(input)
    const now = this.nowFn()
    const key = `run.create:${input.idempotencyKey}`
    try {
      return await transactCommand(this.database, key, (tx) =>
        this.createInTransaction(tx, ctx, taskId, input, now),
      )
    } catch (error) {
      const pg = unwrapPgError(error)
      const activeConflict =
        (pg?.code === '23505' && (pg.constraintName ?? '').includes('run_one_active_per_task')) ||
        (error instanceof RunCommandError && error.code === 'RUN_ALREADY_ACTIVE')
      if (activeConflict) {
        const prior = await findCommandReceipt(this.database.db, key)
        if (prior !== undefined) return prior.result as RunView
        throw new RunCommandError('RUN_ALREADY_ACTIVE', 'task already has an active run')
      }
      throw error
    }
  }

  private async createInTransaction(
    tx: Tx,
    ctx: ActorContext,
    taskId: string,
    input: CreateRunInput,
    now: Date,
  ): Promise<RunView> {
    // 锁 Task 行串行化并发创建；索引是兜底，锁让守卫读到稳定事实。
    const [task] = await tx
      .select()
      .from(schema.tasks)
      .where(eq(schema.tasks.id, taskId))
      .for('update')
    if (task === undefined) throw new RunCommandError('NOT_FOUND', 'task not found')
    if (task.assigneeUserId !== ctx.userId) {
      throw new RunCommandError('FORBIDDEN', 'only the task assignee can start a run')
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

    const [device] = await tx
      .select()
      .from(schema.devices)
      .where(eq(schema.devices.id, input.deviceId))
    // Device 必须属于 owner（§2.6）；存在性+归属合一，避免可枚举。
    if (device === undefined || device.ownerUserId !== ctx.userId) {
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
      workspace.ownerUserId !== ctx.userId ||
      workspace.deviceId !== device.id
    ) {
      throw new RunCommandError('FORBIDDEN', 'workspace does not belong to the actor and device')
    }
    if (!workspace.available) {
      throw new RunCommandError('WORKSPACE_UNAVAILABLE', 'workspace is not available')
    }

    if (input.rerunOfRunId !== undefined) {
      const prior = await getRun(tx, input.rerunOfRunId)
      if (prior === undefined || prior.taskId !== taskId) {
        throw new RunCommandError('NOT_FOUND', 'rerun source run not found')
      }
      if (!isTerminal(prior.status)) {
        throw new RunCommandError('CONFLICT', 'rerun source run must be terminal')
      }
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

    const runId = randomUUID()
    const commandId = randomUUID()
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
    })

    await insertRun(tx, {
      id: runId,
      taskId,
      ownerUserId: task.assigneeUserId,
      agentId: agent.id,
      profileRevisionId: revision.id,
      deviceId: device.id,
      workspaceId: workspace.id,
      profileDigest: revision.profileDigest,
      pluginPackDigest: pack.packDigest,
      dshDistributionVersion: input.dshDistributionVersion,
      createdAt: now, // #119：领域时钟出生时间，reconcile 新生儿宽限的对表基准
      ...(input.rerunOfRunId !== undefined ? { rerunOfRunId: input.rerunOfRunId } : {}),
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
   * 取消（§3.2）：queued 直接在事务内作废待投 run.start 并转 cancelled；
   * dispatching/running/waiting_approval 转 cancel_requested 并入队 run.cancel；
   * cancel_requested/cancelled 幂等返回；其余终态抛 INVALID_RUN_TRANSITION。
   * run 侧写入复用 cancelRunInTransaction（与 Task 取消共享同一事务时同源）。
   */
  async cancel(ctx: ActorContext, runId: string): Promise<RunView> {
    const now = this.nowFn()
    return this.database.transaction(async (tx) => {
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
        { outbox: this.outbox, now },
        run,
        ctx.userId === run.ownerUserId ? 'user' : 'admin',
      )
      const row = await getRun(tx, runId)
      if (row === undefined) throw new Error('run vanished in its own transaction')
      return toRunView(row)
    })
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
    await this.database.transaction(async (tx) => {
      const command = await getOutboxCommand(tx, ack.commandId)
      if (command === undefined) return // 重启前的残留 ack：无行可动
      if (command.deviceId !== device.deviceId) {
        throw new RunCommandError('FORBIDDEN', 'ack device does not match the command destination')
      }
      const acked = await ackInTransaction(tx, ack.commandId, now)
      if (!acked) return // 重复 ack（R7 重发后的旧 ack 重放）
      if (command.type !== 'run.start') return
      const runId = (command.payload as { runId?: unknown }).runId
      if (typeof runId !== 'string') return
      const [run] = await tx
        .select()
        .from(schema.runs)
        .where(eq(schema.runs.id, runId))
        .for('update')
      if (run === undefined || run.status !== 'queued') return // 已迁移过：不重复迁移
      if (ack.accepted) {
        this.applyRunTransition(run, { type: 'dispatch_acked' })
        await setRunStatus(tx, run.id, 'dispatching')
        await appendTeamEvent(tx, {
          type: 'run.changed',
          payload: { runId: run.id, taskId: run.taskId, status: 'dispatching' },
        })
      } else {
        this.applyRunTransition(run, { type: 'failed' })
        await setRunStatus(tx, run.id, 'failed', {
          failureCode: ack.error?.code ?? 'RUNTIME_START_FAILED',
          failureSummary: ack.error?.message ?? 'node rejected run.start',
          finishedAt: now,
        })
        await appendTeamEvent(tx, {
          type: 'run.changed',
          payload: { runId: run.id, taskId: run.taskId, status: 'failed' },
        })
      }
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
      // 终态禁复活（§3.2/R5）：迟到事件已持久留证，状态不动。
      if (isTerminal(run.status)) return
      // 双受众单行迁移（P1-13 链路实测）：同一事实的 owner/project 两行各自
      // append 成功，若都推状态机，第二行必撞 INVALID_RUN_TRANSITION——状态
      // 迁移只由 owner（全量）行驱动，project（收缩）行是纯镜像。
      if (payload.audience !== 'owner') return
      try {
        await this.applyProjectedEvent(tx, run, payload.event, now)
      } catch (error) {
        // #52/ADR-0007：表外边/引用缺失——语义冲突在本事务内降级：已 append 的
        // 事件行随降级提交一起留证（现状：抛错回滚，连证都留不下），Run 收敛
        // failed，帧按正常应用 ack 掉（水位推进、spool 可 GC）——毒帧循环从
        // 源头拆除，连接保留。
        if (isRunSemanticConflict(error)) {
          await this.convergeSemanticConflict(tx, run, error, now)
          return
        }
        throw error
      }
    })
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
    await setRunStatus(tx, run.id, 'failed', {
      failureCode: 'INVALID_RUN_TRANSITION',
      failureSummary: `transition violation: ${reason}`.slice(0, 1000),
      finishedAt: now,
    })
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
        await setRunStatus(tx, run.id, 'running', {
          dshSessionId: event.dshSessionId,
          startedAt: run.startedAt ?? now,
        })
        await runChanged('running')
        return
      }
      case 'run.completed': {
        this.applyRunTransition(run, { type: 'completed' })
        await setRunStatus(tx, run.id, 'completed', { finishedAt: now })
        // #52/ADR-0007：Runtime 终态裁决折叠悬置审批（waiting_approval 来的
        // 裁决在此落账；running 来的折叠是恒等空转，一并防御既有不变量）。
        await cancelPendingApprovalsInTransaction(tx, run, now, 'run_terminal_fold')
        await runChanged('completed')
        return
      }
      case 'run.failed': {
        this.applyRunTransition(run, { type: 'failed' })
        await setRunStatus(tx, run.id, 'failed', {
          failureCode: event.code,
          failureSummary: event.summary,
          finishedAt: now,
        })
        await cancelPendingApprovalsInTransaction(tx, run, now, 'run_terminal_fold')
        await runChanged('failed')
        return
      }
      case 'run.cancelled': {
        this.applyRunTransition(run, { type: 'cancel_confirmed' })
        await setRunStatus(tx, run.id, 'cancelled', { finishedAt: now })
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
            await setRunStatus(tx, run.id, next.status)
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
        await this.persistTransition(tx, run, next.status, snapshot, now)
      } catch (error) {
        if (error instanceof DomainError && error.code === 'INVALID_RUN_TRANSITION') return
        throw error
      }
    })
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
  ): Promise<void> {
    const terminal = isTerminal(status)
    await setRunStatus(tx, run.id, status, {
      ...(snapshot.dshSessionId !== null ? { dshSessionId: snapshot.dshSessionId } : {}),
      ...(status === 'running' ? { startedAt: run.startedAt ?? now } : {}),
      ...(terminal ? { finishedAt: now } : {}),
      ...(snapshot.failureCode !== null ? { failureCode: snapshot.failureCode } : {}),
      ...(snapshot.failureSummary !== null ? { failureSummary: snapshot.failureSummary } : {}),
    })
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
      },
      now,
    )
  }
}
