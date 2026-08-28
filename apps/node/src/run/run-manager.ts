/**
 * RunManager —— P1-13 的 Node 侧运行会话编排（02 Task 13；03 §6/§7/§8/§9）。
 *
 * 职责链：Hub 下行命令 → 本地 spool 先落 → ack → Runtime 子进程 → stdout 帧 →
 * 单一 projector → run_event 草稿原子落 spool（appendAlloc）→ 上行 Hub；
 * Hub run.event_ack → spool 删除；断线重连/ run.resend_from → 全量补发。
 *
 * 不变式：
 * - 先落后做：run.start 先入 command spool 再 spawn（崩溃恢复有据）；投影事件
 *   先入 event spool 再上行（R1：Hub 未 ack 不丢；ack 才删除）。
 * - 至少一次 + Hub (runId, seq) 幂等 = 恰好一次应用（R6 的设计依据）。
 * - live delta 不进 spool（03 §8：非持久通道，可丢）。
 * - Runtime stdout 非法帧 → 当前 Run 失败（§11 fail-closed），绝不容忍协议外输出。
 */
import type {
  NodeDownstream,
  ProjectedRunEvent,
  RuntimeCommand,
  RuntimeOutput,
} from '@project311/protocol'
import { parseRuntimeFrame } from '@project311/protocol'
import { commandAckFrame, runEventFrame, runLiveDeltaFrame } from '../gateway/hub-socket.js'
import { RunProjector, type ProjectionContext } from '../projection/projector.js'
import type { CommandStore } from '../spool/command-store.js'
import type { EventStore } from '../spool/event-store.js'
import { newRuntimeNonce, RuntimeSupervisor, SupervisorError } from '../supervisor/runtime-supervisor.js'
import type { RuntimeStartSpec } from '../runtime-driver.js'
import type { WorkspaceRegistry } from '../workspace/registry.js'

/** 上行帧出口：session 层注入；socket 非 OPEN 时由注入方丢弃（spool 仍持有）。 */
export type UplinkSend = (frame: string) => void

export interface RunManagerDeps {
  readonly supervisor: RuntimeSupervisor
  readonly registry: WorkspaceRegistry
  readonly commandStore: CommandStore
  readonly eventStore: EventStore
  readonly send: UplinkSend
  /** 每 run 的 DSH_HOME（stateDir 下派生；调用方负责 mkdir）。 */
  readonly runtimeHomeFor: (runId: string) => string
  readonly homeDir: string
  readonly now?: () => Date
  readonly log?: (level: 'info' | 'warn' | 'error', msg: string, context?: Record<string, unknown>) => void
}

type RunStartPayload = Extract<NodeDownstream, { type: 'run.start' }>['payload']

export class RunManager {
  private readonly projectors = new Map<string, RunProjector>()
  private readonly liveSeq = new Map<string, number>()
  private readonly now: () => Date

  constructor(private readonly deps: RunManagerDeps) {
    this.now = deps.now ?? (() => new Date())
  }

  /** 下行帧入口（session 在 token_revoked 之后委托）。返回 promise 供测试 await。 */
  async handleFrame(frame: NodeDownstream): Promise<void> {
    switch (frame.type) {
      case 'run.start':
        return this.handleRunStart(frame.payload)
      case 'run.cancel':
        return this.handleRunCancel(frame.payload)
      case 'approval.decide':
        return this.handleApprovalDecide(frame.payload)
      case 'run.event_ack':
        this.deps.eventStore.ackUntil(frame.payload.runId, frame.payload.throughSeq)
        return
      case 'run.resend_from':
        this.drainRun(frame.payload.runId)
        return
      default:
        // run.status_request（P1-16 快照语义）/ node.token_revoked（session 已处理）。
        return
    }
  }

  /** 重连后全量补发（R1：Hub 重启后从各自未 ack 处续发；Hub 幂等去重）。 */
  onReconnect(): void {
    for (const runId of this.deps.eventStore.runIdsWithPending()) this.drainRun(runId)
  }

  /** 心跳事实：activeRunIds + lastEventSeqByRun（03 §6.2）。 */
  heartbeatFacts(): { activeRunIds: string[]; lastEventSeqByRun: Record<string, number> } {
    return {
      activeRunIds: this.deps.supervisor.activeRunIds(),
      lastEventSeqByRun: this.deps.eventStore.seqWatermarkByRun(),
    }
  }

  // ---------- run.start ----------

  private async handleRunStart(payload: RunStartPayload): Promise<void> {
    const { commandId, runId } = payload
    const outcome = this.deps.commandStore.record({
      commandId,
      runId,
      type: 'run.start',
      payload,
    })
    if (outcome === 'duplicate') {
      if (this.deps.supervisor.isActive(runId)) {
        // R7：Hub 重发（ack 丢失）→ 按 commandId 回旧 ack，绝不起第二 Runtime。
        this.ack(commandId, true)
        return
      }
      // 崩溃恢复：command 已落但未 spawn（或 runtime 已不在）——继续正常处理。
      this.log('info', 'duplicate run.start without active runtime; reprocessing', { runId })
    }

    try {
      // redaction 上下文要 canonical workspace 根（registry.resolve 已 realpath +
      // 身份校验）；supervisor.start 内部会再 resolve 一次（同一事实源）。
      const workspacePath = await this.deps.registry.resolve(payload.workspaceId)
      const projector = new RunProjector(this.projectionContext(runId, workspacePath))
      const spec: RuntimeStartSpec = {
        runId,
        nonce: newRuntimeNonce(),
        workspaceId: payload.workspaceId,
        prompt: payload.prompt,
        agent: {
          id: payload.agent.id,
          profileRevisionId: payload.agent.profileRevisionId,
          persona: payload.agent.persona,
          provider: payload.agent.provider,
          model: payload.agent.model,
          credentialSlot: payload.agent.credentialSlot,
          ...(payload.agent.maxTokens !== undefined
            ? { maxTokens: payload.agent.maxTokens }
            : {}),
        },
        expectedProfileDigest: payload.expectedProfileDigest,
        expectedPluginPackDigest: payload.expectedPluginPackDigest,
      }
      await this.deps.supervisor.start(spec, { workspaceId: payload.workspaceId })
      this.projectors.set(runId, projector)
      this.liveSeq.set(runId, 0)
      this.deps.commandStore.markAcked(commandId)
      this.ack(commandId, true)

      // spawn 成功即下发 initialize + prompt（02 Task 13 的启动次序）。
      const initialize: RuntimeCommand = {
        protocolVersion: 1,
        messageId: crypto.randomUUID(),
        sentAt: this.now().toISOString(),
        type: 'runtime.initialize',
        payload: {
          runId,
          workspacePath,
          dshHomePath: this.deps.runtimeHomeFor(runId),
          profileDigest: payload.expectedProfileDigest,
          pluginPackDigest: payload.expectedPluginPackDigest,
          provider: payload.agent.provider,
          model: payload.agent.model,
          ...(payload.agent.maxTokens !== undefined ? { maxTokens: payload.agent.maxTokens } : {}),
          persona: payload.agent.persona,
        },
      }
      this.deps.supervisor.dispatchToRuntime(runId, initialize)
      this.deps.supervisor.dispatchToRuntime(runId, {
        protocolVersion: 1,
        messageId: crypto.randomUUID(),
        sentAt: this.now().toISOString(),
        type: 'run.prompt',
        payload: { runId, text: payload.prompt },
      })
    } catch (error) {
      this.projectors.delete(runId)
      const code =
        error instanceof SupervisorError ? error.code : ('INTERNAL_ERROR' as const)
      const message = error instanceof Error ? error.message : String(error)
      this.deps.commandStore.markAcked(commandId)
      this.ack(commandId, false, { code, message })
    }
  }

  // ---------- run.cancel / approval.decide ----------

  private async handleRunCancel(
    payload: Extract<NodeDownstream, { type: 'run.cancel' }>['payload'],
  ): Promise<void> {
    const outcome = this.deps.commandStore.record({
      commandId: payload.commandId,
      runId: payload.runId,
      type: 'run.cancel',
      payload,
    })
    if (outcome === 'duplicate') {
      this.ack(payload.commandId, true)
      return
    }
    // wire 的 admin 取消映射 Runtime 的 parent（03 §7.1 枚举）；终态 run.cancelled
    // 由 Runtime 经 stdout 上报（桥内 turn/end aborted → run.cancelled）。
    this.deps.supervisor.dispatchToRuntime(payload.runId, {
      protocolVersion: 1,
      messageId: crypto.randomUUID(),
      sentAt: this.now().toISOString(),
      type: 'run.cancel',
      payload: { runId: payload.runId, cause: payload.cause === 'admin' ? 'parent' : 'user' },
    })
    this.deps.commandStore.markAcked(payload.commandId)
    this.ack(payload.commandId, true)
  }

  private async handleApprovalDecide(
    payload: Extract<NodeDownstream, { type: 'approval.decide' }>['payload'],
  ): Promise<void> {
    // 一次性转发：决定经 stdin 进 Runtime 生效（P1-14 的 HTTP 闭环在前）；决定
    // 生效后本地回显 approval.decided 让 Hub 收卡（§8 关联：runId+callId）。
    this.deps.supervisor.dispatchToRuntime(payload.runId, {
      protocolVersion: 1,
      messageId: crypto.randomUUID(),
      sentAt: this.now().toISOString(),
      type: 'approval.decide',
      payload: { runId: payload.runId, callId: payload.callId, decision: payload.decision },
    })
    const projector = this.projectors.get(payload.runId)
    if (projector !== undefined) {
      const result = projector.projectApprovalDecided(payload.callId, payload.decision)
      this.spoolAndDrain(payload.runId, result.events)
    }
    this.ack(payload.commandId, true)
  }

  // ---------- stdout 路由（supervisor deps.onStdoutLine 的接线点） ----------

  /** 供 cli/session 注入 supervisor：stdout 行 → 解析 → 投影 → spool → drain。 */
  readonly handleStdoutLine = (runId: string, line: string): void => {
    const projector = this.projectors.get(runId)
    if (projector === undefined) {
      this.log('warn', 'stdout line for unknown run dropped', { runId })
      return
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(line)
    } catch {
      this.protocolViolation(runId, 'runtime output line is not JSON')
      return
    }
    let frame: RuntimeOutput
    try {
      frame = parseRuntimeFrame(parsed, 'output')
    } catch {
      this.protocolViolation(runId, 'runtime output failed wire schema')
      return
    }
    if (frame.payload.runId !== runId) {
      // 帧 runId 与来源进程不符：串扰防护（一个子进程只服务一个 Run）。
      this.protocolViolation(runId, 'runtime output runId mismatch')
      return
    }
    const result = projector.projectRuntimeOutput(frame)
    this.spoolAndDrain(runId, result.events)
    for (const text of result.liveTexts) {
      const deltaSeq = (this.liveSeq.get(runId) ?? 0) + 1
      this.liveSeq.set(runId, deltaSeq)
      this.deps.send(runLiveDeltaFrame(runId, deltaSeq, text))
    }
    // Run 终态帧已投影：回收 projector（spool 里的事件由 ack 流程清尾）。
    if (
      frame.type === 'run.completed' ||
      frame.type === 'run.cancelled' ||
      frame.type === 'runtime.fatal'
    ) {
      this.projectors.delete(runId)
      this.liveSeq.delete(runId)
    }
  }

  /** §11：Runtime 协议违例 → 当前 Run 失败（合成 run.failed，走正常投影链）。 */
  private protocolViolation(runId: string, why: string): void {
    this.log('error', 'runtime protocol violation; failing run', { runId, why })
    const projector = this.projectors.get(runId)
    if (projector !== undefined) {
      const result = projector.projectRuntimeOutput({
        protocolVersion: 1,
        messageId: crypto.randomUUID(),
        sentAt: this.now().toISOString(),
        type: 'runtime.fatal',
        payload: { runId, code: 'INTERNAL_ERROR', summary: `runtime protocol violation: ${why}` },
      })
      this.spoolAndDrain(runId, result.events)
      this.projectors.delete(runId)
      this.liveSeq.delete(runId)
    }
    void this.deps.supervisor.cancel(runId)
  }

  // ---------- spool 与上行 ----------

  /** 事件原子落 spool（seq 嵌入 payload）后立刻尝试 drain。 */
  private spoolAndDrain(
    runId: string,
    drafts: readonly { audience: 'owner' | 'project'; occurredAt: string; event: ProjectedRunEvent['event'] }[],
  ): void {
    for (const draft of drafts) {
      this.deps.eventStore.appendAlloc(runId, (seq) =>
        JSON.stringify({
          runId,
          seq,
          occurredAt: draft.occurredAt,
          audience: draft.audience,
          event: draft.event,
        } satisfies ProjectedRunEvent),
      )
    }
    if (drafts.length > 0) this.drainRun(runId)
  }

  /** 把该 run 全部未 ack 事件按 seq 升序发出（at-least-once；Hub 幂等）。 */
  private drainRun(runId: string): void {
    for (const pending of this.deps.eventStore.pending(runId)) {
      this.deps.send(runEventFrame(JSON.parse(pending.payload) as ProjectedRunEvent))
    }
  }

  private ack(
    commandId: string,
    accepted: boolean,
    error?: { code: string; message: string },
  ): void {
    this.deps.send(commandAckFrame(commandId, accepted, error))
  }

  private projectionContext(runId: string, workspacePath: string): ProjectionContext {
    return { runId, workspaceRoot: workspacePath, homeDir: this.deps.homeDir }
  }

  private log(level: 'info' | 'warn' | 'error', msg: string, context?: Record<string, unknown>): void {
    this.deps.log?.(level, msg, context)
  }
}
