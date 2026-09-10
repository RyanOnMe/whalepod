/**
 * RunManager —— P1-13 的 Node 侧运行会话编排（02 Task 13；03 §6/§7/§8/§9），
 * P1-16 扩展取消升级 / 退出归因 / Run 投影上报（G7-01..03、R9）。
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
 * - P1-16：Run 终态禁止复活；Runtime 消失/退出只归因、绝不自动重启或重放
 *   可能有副作用的工具（G7-03/R9）。
 *
 * 取消升级（03 §3.2、02 Task 16 Step 3；G7-02）：
 *   run.cancel → stdin 派发，等待 Runtime 上报 run.cancelled；cancelConfirmMs
 *   （生产 15s）未确认 → SIGTERM 进程组；cancelTermGraceMs（生产 5s）仍不退 →
 *   SIGKILL。强杀后由退出归因合成 run.cancelled(forced=true)。每个阶段写
 *   node.supervisor 结构化日志（真人路径可观测，不做接口背后的暗手）。
 */
import type {
  NodeDownstream,
  ProjectedRunEvent,
  RuntimeArtifactInput,
  RunSnapshot,
  RuntimeCommand,
  RuntimeOutput,
} from '@whalepod/protocol'
import { parseRuntimeFrame } from '@whalepod/protocol'
import {
  commandAckFrame,
  runEventFrame,
  runLiveDeltaFrame,
  runSnapshotFrame,
} from '../gateway/hub-socket.js'
import { PluginPreflightError, type PreflightOutcome } from '../plugin/plugin-preflight.js'
import { RunProjector, type ProjectionContext } from '../projection/projector.js'
import type { CommandStore } from '../spool/command-store.js'
import type { EventStore } from '../spool/event-store.js'
import {
  classifyRuntimeExit,
  describeRuntimeExit,
  type RuntimeTerminalReport,
} from '../supervisor/exit-classifier.js'
import { RuntimeEnvError } from '../supervisor/environment.js'
import {
  newRuntimeNonce,
  RuntimeSupervisor,
  SupervisorError,
} from '../supervisor/runtime-supervisor.js'
import type { RuntimeStartSpec } from '../runtime-driver.js'
import type { WorkspaceRegistry } from '../workspace/registry.js'

/** 上行帧出口：session 层注入；socket 非 OPEN 时由注入方丢弃（spool 仍持有）。 */
export type UplinkSend = (frame: string) => void

export interface RunManagerTimers {
  readonly setTimeout: typeof setTimeout
  readonly clearTimeout: typeof clearTimeout
}

export interface RunManagerDeps {
  readonly supervisor: RuntimeSupervisor
  readonly registry: WorkspaceRegistry
  readonly commandStore: CommandStore
  readonly eventStore: EventStore
  readonly send: UplinkSend
  /** 每 run 的 DSH_HOME（stateDir 下派生；调用方负责 mkdir）。 */
  readonly runtimeHomeFor: (runId: string) => string
  readonly homeDir: string
  /**
   * Node 状态目录（`--state-dir`）与插件 packs 根：脱敏上下文替换项（P1-17，
   * 红线——绝对路径不进团队投影）。Runtime boot 错误（pack overlay 路径缺失等）
   * 会把 stateDir 下的绝对路径带进 runtime.fatal summary，投影前必须归约。
   */
  readonly stateDir: string
  readonly packsRoot: string
  /**
   * P1-17：Plugin Pack preflight（runtime.initialize 之前执行，02 Task 17
   * Step 5）。core-empty pack 返回 {}（无 overlay）；非空 pack 本地命中或经
   * Hub descriptor 安装后返回 overlay yml 路径。失败抛 PluginPreflightError：
   * run 以对应 failure_code 拒绝（ack accepted=false），绝不启动 Runtime。
   */
  readonly pluginPackPreflight?: (packDigest: string) => Promise<PreflightOutcome>
  /**
   * P1-15：Artifact 采集器（artifact.candidate 帧 → realpath/hash/上传 →
   * candidate 事件投影）。缺省（部分单测）时候选被丢弃并留结构化告警。
   */
  readonly artifactCollector?: RunArtifactCollector
  /**
   * P1-15：Reviewer 输入准备（run.start 时拉取任务已发布 Artifact 清单并下载
   * 受控副本）。返回 entries+dir 随 runtime.initialize 下发（成对字段）；
   * 失败折算 run.start 拒绝（ack accepted=false 透传错误码）。
   */
  readonly prepareArtifactInputs?: (runId: string, taskId: string) => Promise<RunArtifactInputs>
  /**
   * P1-15：Run 终态后的输入副本清理（best-effort）。#62：由 finalizeRun 终态
   * 单一收敛点触发（帧投影/协议违例/退出归因/supervisor lost 全覆盖），
   * run.start 拒绝路径单独补清（Run 从未在管，不进 finalizeRun）。
   */
  readonly cleanupArtifactInputs?: (runId: string) => Promise<void>
  /** P1-16：run.snapshot 的设备身份与 DSH 发行版版本（§2.6/§6.2）。 */
  readonly deviceId: string
  readonly dshDistributionVersion: string
  /** P1-16：取消确认窗口（默认 15s，§3.2）与 SIGTERM 宽限（默认 5s）。 */
  readonly cancelConfirmMs?: number
  readonly cancelTermGraceMs?: number
  /** 计时器注入点（测试手动时钟）；缺省全局定时器。 */
  readonly timers?: RunManagerTimers
  readonly now?: () => Date
  readonly log?: (
    level: 'info' | 'warn' | 'error',
    msg: string,
    context?: Record<string, unknown>,
  ) => void
}

/** 采集器结构面（实现见 artifact/collect.ts；测试用 fake 同形注入）。 */
export interface RunArtifactCollector {
  collect(
    runId: string,
    candidate: { relativePath: string; title: string; mediaType: string },
    workspacePath: string,
  ): Promise<{
    artifactId: string
    sha256: string
    byteSize: number
    sourceRelativePath: string
  }>
}

/** Reviewer 输入准备结构面（实现见 artifact/inputs.ts）。 */
export interface RunArtifactInputs {
  readonly dir: string
  readonly entries: readonly RuntimeArtifactInput[]
}

type RunStartPayload = Extract<NodeDownstream, { type: 'run.start' }>['payload']
/** run.start 载荷 + spool 层接收时间（snapshot createdAt 事实源；spool 回读时补）。 */
type RunFacts = RunStartPayload & { receivedAt?: string }

/** 取消升级状态（per run；Runtime 确认或退出即收敛）。 */
interface CancelEscalation {
  readonly commandId: string
  phase: 'requested' | 'sigterm' | 'sigkill' | 'confirmed'
  timer?: ReturnType<typeof setTimeout> | undefined
}

/** 本 Node 进程内记录的 Run 终态事实（snapshot 上报的事实源）。 */
interface FinalFacts {
  readonly status: Extract<RunSnapshot['status'], 'completed' | 'failed' | 'cancelled' | 'lost'>
  readonly failureCode: RunSnapshot['failureCode']
  readonly failureSummary: RunSnapshot['failureSummary']
  readonly finishedAt: string
}

const DEFAULT_CANCEL_CONFIRM_MS = 15_000 as const
const DEFAULT_CANCEL_TERM_GRACE_MS = 5_000 as const

export class RunManager {
  private readonly projectors = new Map<string, RunProjector>()
  private readonly liveSeq = new Map<string, number>()
  /** runId → canonical workspace 根（采集器校验用；P1-15）。 */
  private readonly workspacePaths = new Map<string, string>()
  private readonly now: () => Date
  private readonly logFn: RunManagerDeps['log']
  private readonly confirmMs: number
  private readonly termGraceMs: number
  private readonly timers: RunManagerTimers
  /** runId → run.start 载荷（snapshot 的字段事实源；重启后从 spool 回读）。 */
  private readonly runFacts = new Map<string, RunFacts>()
  /** runId → runtime.ready 事实（dshSessionId/startedAt）。 */
  private readonly readyFacts = new Map<string, { dshSessionId: string; startedAt: string }>()
  /** runId → 本进程内已记录的终态事实。 */
  private readonly finalFacts = new Map<string, FinalFacts>()
  /** runId → 取消升级状态。 */
  private readonly cancels = new Map<string, CancelEscalation>()
  /**
   * #88：runId → 终态释放的升级计时器（runtime.shutdown → 宽限 → SIGTERM →
   * 再宽限 → SIGKILL）。Runtime 退出（handleRuntimeExit）即清除——绝不向已退
   * 进程发信号；supervisor 硬超时（生产 6h）降为最后兜底而非主回收路径。
   */
  private readonly releases = new Map<string, { timer?: ReturnType<typeof setTimeout> }>()
  /** 断连期间攒下的 lost 快照（onReconnect flush；R9）。 */
  private readonly pendingLostSnapshots = new Map<string, RunSnapshot>()

  constructor(private readonly deps: RunManagerDeps) {
    this.now = deps.now ?? (() => new Date())
    this.logFn = deps.log
    this.confirmMs = deps.cancelConfirmMs ?? DEFAULT_CANCEL_CONFIRM_MS
    this.termGraceMs = deps.cancelTermGraceMs ?? DEFAULT_CANCEL_TERM_GRACE_MS
    this.timers = deps.timers ?? { setTimeout, clearTimeout }
    // P1-16：Supervisor 的裸事实在这里归因（exit-classifier），Run 终态只收敛一次。
    deps.supervisor.onRuntimeExit((event) =>
      this.handleRuntimeExit(event.runId, event.code, event.signal),
    )
    deps.supervisor.onLost((runId, reason) => this.handleSupervisorLost(runId, reason))
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
      case 'run.status_request':
        // P1-16：Hub 收敛探针的应答（§6.2 run.snapshot）；Run 事实缺失则诚实沉默。
        this.answerStatusRequest(frame.payload.runId)
        return
      default:
        // node.token_revoked（session 已处理）。
        return
    }
  }

  /** 重连后全量补发（R1：Hub 重启后从各自未 ack 处续发；Hub 幂等去重）。 */
  onReconnect(): void {
    // R9：先补发攒下的 lost 快照（终态事实优先于历史事件重放）。
    for (const snapshot of this.pendingLostSnapshots.values()) {
      this.deps.send(runSnapshotFrame(snapshot))
    }
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
      if (this.deps.commandStore.isAcked(commandId)) {
        // P1-16（G7-03/R9）：命令已完整处理过一次且 Runtime 已不在——绝不自动
        // 重启、不重放工具。回放旧 ack + 上报 lost(RUNTIME_LOST)，等显式重跑。
        this.log('warn', 'duplicate run.start for finished runtime; reporting lost', { runId })
        this.ack(commandId, true)
        this.reportLostSnapshot(
          runId,
          'runtime is gone after a previous run.start attempt; explicit rerun required',
        )
        return
      }
      // 崩溃恢复：command 已落但未 spawn（本进程从未完成处理）——继续正常处理。
      this.log('info', 'duplicate run.start without active runtime; reprocessing', { runId })
    }

    try {
      // redaction 上下文要 canonical workspace 根（registry.resolve 已 realpath +
      // 身份校验）；supervisor.start 内部会再 resolve 一次（同一事实源）。
      const workspacePath = await this.deps.registry.resolve(payload.workspaceId)
      // P1-17 preflight：workspace 就绪后、spawn 之前。失败即 run 拒绝，
      // 绝不带着未校验/未安装的 pack 启动 Runtime。
      let pluginPackOverlayPath: string | undefined
      if (this.deps.pluginPackPreflight !== undefined) {
        const preflight = await this.deps.pluginPackPreflight(payload.expectedPluginPackDigest)
        pluginPackOverlayPath = preflight.overlayPath
      }
      // P1-15：Reviewer 输入准备（清单拉取 + 受控下载副本）。失败 → run 拒绝，
      // 错误码透传（如 ARTIFACT_HASH_MISMATCH）；Builder Run（空清单）直接通过。
      let artifactInputs: RunArtifactInputs | undefined
      if (this.deps.prepareArtifactInputs !== undefined) {
        artifactInputs = await this.deps.prepareArtifactInputs(runId, payload.taskId)
      }
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
          ...(payload.agent.maxTokens !== undefined ? { maxTokens: payload.agent.maxTokens } : {}),
        },
        expectedProfileDigest: payload.expectedProfileDigest,
        expectedPluginPackDigest: payload.expectedPluginPackDigest,
      }
      await this.deps.supervisor.start(spec, { workspaceId: payload.workspaceId })
      this.projectors.set(runId, projector)
      this.liveSeq.set(runId, 0)
      this.workspacePaths.set(runId, workspacePath)
      this.runFacts.set(runId, payload)
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
          ...(pluginPackOverlayPath !== undefined ? { pluginPackOverlayPath } : {}),
          ...(artifactInputs !== undefined && artifactInputs.entries.length > 0
            ? {
                artifactInputs: [...artifactInputs.entries],
                artifactInputsDir: artifactInputs.dir,
              }
            : {}),
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
      this.workspacePaths.delete(runId)
      const code =
        error instanceof SupervisorError
          ? error.code
          : error instanceof PluginPreflightError
            ? error.code
            : error instanceof RuntimeEnvError
              ? error.code // 凭据/工作区环境失败：透传具体 wire 码，不降级 INTERNAL_ERROR
              : error instanceof Error &&
                  typeof (error as unknown as { code?: unknown }).code === 'string'
                ? (error as unknown as { code: string }).code // P1-15：输入准备失败码（如 ARTIFACT_HASH_MISMATCH）透传
                : ('INTERNAL_ERROR' as const)
      const message = error instanceof Error ? error.message : String(error)
      this.deps.commandStore.markAcked(commandId)
      this.ack(commandId, false, { code, message })
      // run.start 拒绝路径不进 finalizeRun（Run 从未在管）：输入准备可能已下载
      // 副本（spawn 前失败），同样要清理（#62：不留半成品目录）。
      this.cleanupInputs(runId)
    }
  }

  // ---------- run.cancel（P1-16 取消升级链路） ----------

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
      // R7：重复 run.cancel 只回放 ack——绝不重启升级计时器（重发不是新取消意图）。
      this.ack(payload.commandId, true)
      return
    }
    const runId = payload.runId
    if (this.finalFacts.has(runId)) {
      // #88：本地已终态（shutdown 释放已发或 Runtime 已退）→ 迟到的收敛取消
      // 只回 ack，绝不再向 Runtime 下发任何帧（免打扰守卫，先于 isActive 判定）。
      this.log('info', 'run.cancel for locally terminal run; ack only', { runId })
      this.deps.commandStore.markAcked(payload.commandId)
      this.ack(payload.commandId, true)
      return
    }
    if (!this.deps.supervisor.isActive(runId)) {
      // Runtime 已不在（崩溃/已终态）：无需升级；退出归因/Hub 侧已收敛。
      this.log('warn', 'run.cancel for inactive runtime; nothing to escalate', { runId })
      this.deps.commandStore.markAcked(payload.commandId)
      this.ack(payload.commandId, true)
      return
    }
    // wire 的 admin 取消映射 Runtime 的 parent（03 §7.1 枚举）；终态 run.cancelled
    // 由 Runtime 经 stdout 上报（桥内 turn/end aborted → run.cancelled）。
    this.deps.supervisor.dispatchToRuntime(runId, {
      protocolVersion: 1,
      messageId: crypto.randomUUID(),
      sentAt: this.now().toISOString(),
      type: 'run.cancel',
      payload: { runId, cause: payload.cause === 'admin' ? 'parent' : 'user' },
    })
    this.deps.commandStore.markAcked(payload.commandId)
    this.ack(payload.commandId, true)
    this.beginCancelEscalation(runId, payload.commandId)
  }

  /** 取消升级第 0 跳：确认窗口（§3.2：cancel_requested 15s 未确认 → 强制收尾）。 */
  private beginCancelEscalation(runId: string, commandId: string): void {
    const escalation: CancelEscalation = { commandId, phase: 'requested' }
    escalation.timer = this.timers.setTimeout(() => {
      this.escalateToSigterm(runId)
    }, this.confirmMs)
    this.cancels.set(runId, escalation)
    this.log('info', 'cancel requested; awaiting runtime confirmation', {
      component: 'node.supervisor',
      runId,
      confirmMs: this.confirmMs,
    })
  }

  private escalateToSigterm(runId: string): void {
    const escalation = this.cancels.get(runId)
    if (escalation === undefined || escalation.phase !== 'requested') return
    escalation.phase = 'sigterm'
    // 先挂宽限计时器再发信号：若 SIGTERM 即刻生效，退出归因会清掉它（短路）。
    escalation.timer = this.timers.setTimeout(() => {
      this.escalateToSigkill(runId)
    }, this.termGraceMs)
    this.log('warn', 'cancel unconfirmed; escalating to sigterm', {
      component: 'node.supervisor',
      runId,
      graceMs: this.termGraceMs,
    })
    this.deps.supervisor.terminate(runId)
  }

  private escalateToSigkill(runId: string): void {
    const escalation = this.cancels.get(runId)
    if (escalation === undefined || escalation.phase !== 'sigterm') return
    escalation.phase = 'sigkill'
    escalation.timer = undefined
    this.log('warn', 'sigterm grace expired; escalating to sigkill', {
      component: 'node.supervisor',
      runId,
    })
    this.deps.supervisor.forceKill(runId)
  }

  /**
   * Runtime 确认（run.cancelled 帧）：取消升级链收敛（确认窗口/SIGTERM 宽限
   * 计时器清除，不再升级）。「确认后仍不退出」的进程收尾由 finalizeRun →
   * releaseRuntime 统一承担（#88：shutdown → 宽限 → SIGTERM → SIGKILL，
   * 与 completed/failed 终态同一收敛点），本函数不再单设 reap 链。
   */
  private confirmCancel(runId: string): void {
    const escalation = this.cancels.get(runId)
    if (escalation === undefined || escalation.phase === 'confirmed') return
    if (escalation.timer !== undefined) this.timers.clearTimeout(escalation.timer)
    escalation.phase = 'confirmed'
    escalation.timer = undefined
    this.cancels.delete(runId)
  }

  // ---------- 退出归因（P1-16：Supervisor 裸事实 → Run 终态） ----------

  private handleRuntimeExit(runId: string, code: number | null, signal: string | null): void {
    // #88：Runtime 退出收敛释放升级链——已排程的 SIGTERM/SIGKILL 一律撤销，
    // 绝不向已退进程发信号。
    const release = this.releases.get(runId)
    if (release !== undefined) {
      if (release.timer !== undefined) this.timers.clearTimeout(release.timer)
      this.releases.delete(runId)
    }
    const reported = this.finalFacts.has(runId)
      ? (this.finalFacts.get(runId)!.status as RuntimeTerminalReport)
      : 'none'
    const outcome = classifyRuntimeExit({ reported, cancelInFlight: this.cancels.has(runId) })
    switch (outcome) {
      case 'ignore':
        return
      case 'cancelled_forced': {
        // G7-02：Runtime 未确认取消即死亡 → cancelled(forced=true)。
        this.log('warn', 'runtime died with cancel in flight; forced cancel', {
          component: 'node.supervisor',
          runId,
          code,
          signal,
        })
        const projector = this.projectors.get(runId)
        if (projector !== undefined) {
          this.spoolAndDrain(runId, projector.projectCancelledLocal(true).events)
        }
        this.finalizeRun(runId, 'cancelled')
        return
      }
      case 'runtime_lost': {
        // G7-03：无终态事实的退出 = RUNTIME_LOST。绝不自动重启。
        const summary = describeRuntimeExit(code, signal)
        this.log('error', 'runtime lost; failing run without restart', {
          component: 'node.supervisor',
          runId,
          code,
          signal,
        })
        const projector = this.projectors.get(runId)
        if (projector !== undefined) {
          this.spoolAndDrain(runId, projector.projectRuntimeLost(summary).events)
        }
        this.finalizeRun(runId, 'failed', 'RUNTIME_LOST', summary)
        return
      }
    }
  }

  private handleSupervisorLost(
    runId: string,
    reason: 'runtime_timeout' | 'orphaned_after_node_restart',
  ): void {
    if (reason === 'orphaned_after_node_restart') {
      // R9：Node 重启后孤儿已按三重匹配处理。上报 lost(RUNTIME_LOST)（Hub 落
      // lost 终态），交人工显式重跑——绝不自动复活或重放。
      this.log('error', 'orphaned runtime after node restart; reporting lost', {
        component: 'node.supervisor',
        runId,
      })
      this.finalizeRun(runId, 'lost', 'RUNTIME_LOST', 'runtime orphaned after node restart')
      this.reportLostSnapshot(runId, 'runtime orphaned after node restart')
      return
    }
    // runtime_timeout：wall-clock 超限被回收（G7-03 的归因面：Run 失败，不重启）。
    if (this.finalFacts.has(runId)) return
    const summary = 'runtime exceeded its wall-clock limit (runtime_timeout)'
    this.log('error', 'runtime timeout; failing run without restart', {
      component: 'node.supervisor',
      runId,
    })
    const projector = this.projectors.get(runId)
    if (projector !== undefined) {
      this.spoolAndDrain(runId, projector.projectRuntimeLost(summary).events)
    }
    this.finalizeRun(runId, 'failed', 'RUNTIME_LOST', summary)
  }

  // ---------- run.status_request 应答与 lost 快照上报 ----------

  private answerStatusRequest(runId: string): void {
    const snapshot = this.buildSnapshot(runId)
    if (snapshot === undefined) {
      this.log('warn', 'status_request for unknown run; no snapshot to report', { runId })
      return
    }
    this.deps.send(runSnapshotFrame(snapshot))
  }

  /**
   * R9：lost(RUNTIME_LOST) 快照（快照不落 spool，at-least-once 语义）——立即尝试
   * 上行，并留底到 onReconnect 重发；离线时 session 层丢弃，重连后由 flush 补达。
   * Hub 侧终态幂等（重复快照被忽略）。
   */
  private reportLostSnapshot(runId: string, summary: string): void {
    if (this.finalFacts.get(runId) === undefined) {
      this.finalizeRun(runId, 'lost', 'RUNTIME_LOST', summary)
    }
    const snapshot = this.buildSnapshot(runId)
    if (snapshot === undefined) {
      this.log('warn', 'lost snapshot skipped: no run facts available', { runId })
      return
    }
    this.pendingLostSnapshots.set(runId, snapshot)
    this.deps.send(runSnapshotFrame(snapshot))
  }

  /** 组装 §6.2 RunSnapshot：字段只来自 run.start 载荷与本地观测到的事实。 */
  private buildSnapshot(runId: string): RunSnapshot | undefined {
    const facts = this.runFacts.get(runId) ?? this.readRunFactsFromSpool(runId)
    if (facts === undefined) return undefined
    if (this.runFacts.get(runId) === undefined) this.runFacts.set(runId, facts)
    const ready = this.readyFacts.get(runId)
    const final = this.finalFacts.get(runId)
    const active = this.deps.supervisor.isActive(runId)
    const status: RunSnapshot['status'] =
      final !== undefined
        ? final.status
        : active
          ? ready !== undefined
            ? 'running'
            : 'dispatching'
          : 'lost'
    return {
      runId,
      taskId: facts.taskId,
      ownerUserId: facts.ownerUserId,
      agentId: facts.agent.id,
      profileRevisionId: facts.agent.profileRevisionId,
      deviceId: this.deps.deviceId,
      workspaceId: facts.workspaceId,
      dshSessionId: ready?.dshSessionId ?? null,
      status,
      failureCode: final?.failureCode ?? null,
      failureSummary: final?.failureSummary ?? null,
      // Node 不持有 rerunOfRunId（Hub 固化字段）；上报 null，Hub 不回读该列。
      rerunOfRunId: null,
      profileDigest: facts.expectedProfileDigest,
      pluginPackDigest: facts.expectedPluginPackDigest,
      dshDistributionVersion: this.deps.dshDistributionVersion,
      createdAt: facts.receivedAt ?? new Date().toISOString(),
      startedAt: ready?.startedAt ?? null,
      finishedAt: final?.finishedAt ?? null,
    }
  }

  /** Node 重启后内存为空：从 command spool 回读 run.start 载荷。 */
  private readRunFactsFromSpool(runId: string): RunFacts | undefined {
    const spooled = this.deps.commandStore.latestForRun(runId, 'run.start')
    if (spooled === undefined) return undefined
    const payload = spooled.payload as RunStartPayload
    if (payload.runId !== runId) return undefined
    // receivedAt 是 spool 层字段；补回快照 createdAt 用。
    return { ...payload, receivedAt: spooled.receivedAt }
  }

  // ---------- approval.decide ----------

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
    // P1-16：runtime.ready 事实入账（snapshot 的 dshSessionId/startedAt）。
    if (frame.type === 'runtime.ready') {
      this.readyFacts.set(runId, {
        dshSessionId: frame.payload.dshSessionId,
        startedAt: this.now().toISOString(),
      })
    }
    // P1-16：Runtime 自身确认取消 → 升级链路收敛（投影 forced=false 照旧）。
    if (frame.type === 'run.cancelled') {
      this.confirmCancel(runId)
    }
    // P1-15：artifact.candidate 不进投影直译——先采集（realpath/hash/上传）
    // 取得 artifactId/sha256/byteSize，成功后再投影双受众 candidate 事件。
    if (frame.type === 'artifact.candidate') {
      const workspacePath = this.workspacePaths.get(runId)
      if (workspacePath === undefined) {
        this.log('warn', 'artifact candidate without workspace context dropped', { runId })
        return
      }
      if (this.deps.artifactCollector === undefined) {
        this.log('warn', 'artifact candidate dropped: no collector wired', { runId })
        return
      }
      void this.collectArtifact(runId, frame.payload, workspacePath).catch(() => {})
      return
    }
    const result = projector.projectRuntimeOutput(frame)
    this.spoolAndDrain(runId, result.events)
    for (const text of result.liveTexts) {
      const deltaSeq = (this.liveSeq.get(runId) ?? 0) + 1
      this.liveSeq.set(runId, deltaSeq)
      this.deps.send(runLiveDeltaFrame(runId, deltaSeq, text))
    }
    // Run 终态帧已投影：登记终态事实并回收 projector（G7-03 归因以事实为准；
    // finalizeRun 内做 projectors/liveSeq 回收、取消升级计时器收敛与输入副本
    // 清理（#62：所有终态路径统一在 finalizeRun 收敛，这里不再单发））。
    if (
      frame.type === 'run.completed' ||
      frame.type === 'run.cancelled' ||
      frame.type === 'runtime.fatal'
    ) {
      if (frame.type === 'run.completed') {
        this.finalizeRun(runId, 'completed')
      } else if (frame.type === 'run.cancelled') {
        this.finalizeRun(runId, 'cancelled')
      } else {
        this.finalizeRun(runId, 'failed', frame.payload.code, frame.payload.summary)
      }
      this.workspacePaths.delete(runId)
    }
  }

  /** P1-15：采集链路（collector 抛错=候选被拒/上传失败：只留结构化痕迹，Run 不受影响）。 */
  private async collectArtifact(
    runId: string,
    candidate: { relativePath: string; title: string; mediaType: string },
    workspacePath: string,
  ): Promise<void> {
    const collector = this.deps.artifactCollector
    if (collector === undefined) return
    try {
      const collected = await collector.collect(runId, candidate, workspacePath)
      const projector = this.projectors.get(runId)
      if (projector === undefined) {
        // Run 已终态：Hub 行已在（上传原子落库），仅迟到投影丢失，不补发。
        this.log('warn', 'artifact collected after run terminal; event skipped', {
          runId,
          artifactId: collected.artifactId,
        })
        return
      }
      const result = projector.projectArtifactCandidate({
        artifactId: collected.artifactId,
        runId,
        title: candidate.title,
        mediaType: candidate.mediaType,
        byteSize: collected.byteSize,
        sha256: collected.sha256,
        sourceRelativePath: collected.sourceRelativePath,
      })
      this.spoolAndDrain(runId, result.events)
    } catch (error) {
      const code = (error as { code?: unknown }).code
      this.log('error', 'artifact candidate collection failed', {
        runId,
        component: 'node.artifact',
        code: typeof code === 'string' ? code : 'INTERNAL_ERROR',
        reason: error instanceof Error ? error.message : String(error),
      })
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
      this.finalizeRun(runId, 'failed', 'INTERNAL_ERROR', `runtime protocol violation: ${why}`)
      this.workspacePaths.delete(runId)
    }
    void this.deps.supervisor.cancel(runId)
  }

  // ---------- 终态登记（P1-16：单一收敛点，终态只记一次） ----------

  private finalizeRun(
    runId: string,
    status: Extract<RunSnapshot['status'], 'completed' | 'failed' | 'cancelled' | 'lost'>,
    failureCode: RunSnapshot['failureCode'] = null,
    failureSummary: RunSnapshot['failureSummary'] = null,
  ): void {
    if (this.finalFacts.has(runId)) return // 终态禁改写（03 §3.2）
    this.finalFacts.set(runId, {
      status,
      failureCode,
      failureSummary,
      finishedAt: this.now().toISOString(),
    })
    const escalation = this.cancels.get(runId)
    if (escalation !== undefined && escalation.phase !== 'confirmed') {
      if (escalation.timer !== undefined) this.timers.clearTimeout(escalation.timer)
      this.cancels.delete(runId)
    }
    this.projectors.delete(runId)
    this.liveSeq.delete(runId)
    // P1-15/#62：输入副本清理收敛在终态单一收敛点——所有终态路径（终态帧投影、
    // 协议违例、退出归因 cancelled_forced/runtime_lost、supervisor lost
    // orphan/runtime_timeout、lost 快照）都经 finalizeRun，无一漏网。
    this.cleanupInputs(runId)
    // #88：Runtime 主动回收同样收敛在此——终态即下发 runtime.shutdown（协议帧，
    // bridge/bin 收敛后 EOF 退出），容量立即释放；宽限内不退则信号升级
    // （SIGTERM→SIGKILL），supervisor 硬超时（生产 6h）降为最后兜底。
    this.releaseRuntime(runId)
  }

  /**
   * #88 终态回收（02 语义：runtime.shutdown 收敛帧 + 宽限升级）。
   * Runtime 已不在管（退出归因/lost 路径先走一步）时 no-op——没有可收的对象。
   * 升级节奏与取消确认收敛同口径（cancelTermGraceMs）；退出事件到达即清除
   * 计时器（handleRuntimeExit），绝不杀已退进程。
   */
  private releaseRuntime(runId: string): void {
    if (!this.deps.supervisor.isActive(runId)) return
    this.deps.supervisor.dispatchToRuntime(runId, {
      protocolVersion: 1,
      messageId: crypto.randomUUID(),
      sentAt: this.now().toISOString(),
      type: 'runtime.shutdown',
      payload: { runId },
    })
    this.log('info', 'run terminal; runtime.shutdown dispatched, release pending', {
      component: 'node.supervisor',
      runId,
      graceMs: this.termGraceMs,
    })
    const entry: { timer?: ReturnType<typeof setTimeout> } = {}
    entry.timer = this.timers.setTimeout(() => {
      if (!this.deps.supervisor.isActive(runId)) {
        this.releases.delete(runId)
        return
      }
      this.log('warn', 'runtime lingered past shutdown grace; escalating to sigterm', {
        component: 'node.supervisor',
        runId,
        graceMs: this.termGraceMs,
      })
      this.deps.supervisor.terminate(runId)
      entry.timer = this.timers.setTimeout(() => {
        if (this.deps.supervisor.isActive(runId)) {
          this.log('warn', 'sigterm grace expired after shutdown; escalating to sigkill', {
            component: 'node.supervisor',
            runId,
          })
          this.deps.supervisor.forceKill(runId)
        }
        this.releases.delete(runId)
      }, this.termGraceMs)
    }, this.termGraceMs)
    this.releases.set(runId, entry)
  }

  /** P1-15：输入副本清理（best-effort，失败只吞掉——不阻塞终态登记）。 */
  private cleanupInputs(runId: string): void {
    void this.deps.cleanupArtifactInputs?.(runId).catch(() => {})
  }

  // ---------- spool 与上行 ----------

  /** 事件原子落 spool（seq 嵌入 payload）后立刻尝试 drain。 */
  private spoolAndDrain(
    runId: string,
    drafts: readonly {
      audience: 'owner' | 'project'
      occurredAt: string
      event: ProjectedRunEvent['event']
    }[],
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
    return {
      runId,
      workspaceRoot: workspacePath,
      homeDir: this.deps.homeDir,
      stateDir: this.deps.stateDir,
      packsRoot: this.deps.packsRoot,
    }
  }

  private log(
    level: 'info' | 'warn' | 'error',
    msg: string,
    context?: Record<string, unknown>,
  ): void {
    this.logFn?.(level, msg, context)
  }
}
