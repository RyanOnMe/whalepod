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
 */
import { randomUUID } from 'node:crypto'
import { and, eq, inArray } from 'drizzle-orm'
import { asUserId, authorize, DomainError, transitionRun, transitionTask } from '@project311/domain'
import type { RunEvent as DomainRunEvent } from '@project311/domain'
import type { Database, RunRow, Tx } from '@project311/db'
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
} from '@project311/db'
import type { ErrorCode, ProjectedRunEvent, RunSnapshot } from '@project311/protocol'
import { parseNodeFrame, RunStartSchema } from '@project311/protocol'
import { cancelRunInTransaction } from './cancel.js'
import type { DeviceActivity } from './reconciler.js'
import { ACTIVE_RUN_STATUSES, reconcileLeases } from './reconciler.js'
import type { ActorContext, CreateRunInput } from './commands.js'
import { assertCreateRunInput } from './commands.js'
import type { AuthenticatedDevice } from './device-gateway.js'
import { RunCommandError } from './errors.js'
import type { RunView } from './queries.js'
import { toRunView } from './queries.js'

const TERMINAL_RUN_STATUSES = ['completed', 'failed', 'cancelled', 'lost'] as const

function isTerminal(status: RunRow['status']): boolean {
  return (TERMINAL_RUN_STATUSES as readonly string[]).includes(status)
}

export interface RunOrchestratorDeps {
  database: Database
  outbox: Outbox
  now?: () => Date
}

export class RunOrchestrator {
  private readonly database: Database
  private readonly outbox: Outbox
  private readonly nowFn: () => Date
  /** deviceId → 最近心跳；reconciler 据此判断「Node 在线但已没有该 Run」。 */
  readonly deviceActivity = new Map<string, DeviceActivity>()

  constructor(deps: RunOrchestratorDeps) {
    this.database = deps.database
    this.outbox = deps.outbox
    this.nowFn = deps.now ?? (() => new Date())
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
      await this.applyProjectedEvent(tx, run, payload.event, now)
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
          payload: { approvalId: event.approval.approvalId, runId: run.id, status: 'pending' },
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
            payload: { approvalId: approval.id, runId: run.id, status: event.status },
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
        // 本任务只持久投影；Artifact 落库是 P1-15 的事。
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
    await appendTeamEvent(tx, {
      type: 'run.changed',
      payload: { runId: run.id, taskId: run.taskId, status },
    })
  }

  /** 状态迁移唯一入口：domain transitionRun 抛出即非法边，调用方不吞（snapshot 除外）。 */
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
