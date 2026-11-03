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
import { existsSync, readdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import type {
  ContextStateSyncWire,
  ErrorCode,
  NodeDownstream,
  ProjectedRunEvent,
  RunContextReceipt,
  RunContextStateWire,
  RunStartProjectContext,
  RunStartWorkInput,
  RunWorkInputReceipt,
  RuntimeArtifactInput,
  RuntimeContextReceiptPayload,
  RuntimeWorkInputReceiptPayload,
  RunSnapshot,
  RuntimeCommand,
  RuntimeOutput,
} from '@whalepod/protocol'
import { parseRuntimeFrame } from '@whalepod/protocol'
import {
  commandAckFrame,
  contextStateAckFrame,
  contextStatePullFrame,
  runContextReceiptFrame,
  runEventFrame,
  runLiveDeltaFrame,
  runSnapshotFrame,
  runWorkInputReceiptFrame,
} from '../gateway/hub-socket.js'
import {
  applyContextStateSync,
  applyRunContextState,
  drainContextCleanupQueue,
  initializePreparedContextState,
  type ContextStateApplierDeps,
} from '../context/state.js'
import type { ContextStateStore } from '../context/state-store.js'
import { MemoryContextStateStore } from '../context/state-store.js'
import type { RunContextReceiptDraft, RunContextReceiptOutbox } from '../context/receipt-outbox.js'
import { MemoryContextReceiptOutbox } from '../context/receipt-outbox.js'
import type {
  RunRuntimeFacts,
  RunTerminalCleanupStore,
  TerminalCleanupTask,
} from './terminal-cleanup.js'
import { MemoryRunTerminalCleanupStore } from './terminal-cleanup.js'
import type { PreparedProjectContext } from '../context/project-context.js'
import type { PreparedWorkInputs } from '../work/work-input.js'
import type { WorkInputReceiptStore } from '../work/receipt-store.js'
import { MemoryWorkInputReceiptStore } from '../work/receipt-store.js'
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
  type RuntimeLostEvent,
} from '../supervisor/runtime-supervisor.js'
import type { RuntimeStartSpec } from '../runtime-driver.js'
import type { WorkspaceRegistry } from '../workspace/registry.js'

/** 上行帧出口：session 层注入；返回是否真正写出（false 时持久队列继续保留）。 */
export type UplinkSend = (frame: string) => boolean

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
  /**
   * ADR-0027 §3：按 run.start 快照清单下载项目上下文副本（digest/byteSize 校验）。
   * 失败折算 run.start 拒绝；清单存在但本 Node 未装配时同样 fail-closed。
   */
  readonly prepareProjectContext?: (
    runId: string,
    manifest: RunStartProjectContext,
  ) => Promise<PreparedProjectContext>
  /**
   * ADR-0028 §3：按 run.start 清单下载工作输入副本（digest/byteSize 校验）。
   * 清单存在但本 Node 未装配时 fail-closed。
   */
  readonly prepareWorkInputs?: (
    runId: string,
    input: RunStartWorkInput,
  ) => Promise<PreparedWorkInputs>
  /** ADR-0028 §6：Run 终态/启动拒绝后的 runtime-work-inputs 副本清理。 */
  readonly cleanupWorkInputs?: (runId: string) => Promise<void>
  /** ADR-0028 §3：工作输入回执的持久累计/待发队列（生产 SQLite）。 */
  readonly workInputReceiptStore?: WorkInputReceiptStore
  /** ADR-0027 §6（PC-05b）：上下文状态与清理重试队列（生产 SQLite；缺省内存）。 */
  readonly contextStateStore?: ContextStateStore
  /** ADR-0027 §4（PC-05b-2）：回执持久发件箱（生产 SQLite；缺省内存）。 */
  readonly contextReceiptOutbox?: RunContextReceiptOutbox
  /**
   * ADR-0027 §6（PC-05b-3）：终态清理持久队列与 Run home 事实
   * （生产 SQLite；缺省内存）。
   */
  readonly terminalCleanupStore?: RunTerminalCleanupStore
  /** runtime-context/<runId> 的绝对路径（生产由组合根注入；缺省只清 spill/session）。 */
  readonly runtimeContextDirFor?: (runId: string) => string
  /** 同一 DSH home 是否仍有其它活跃 Runtime（resume 共享 home 的清理守卫）。 */
  readonly isRuntimeHomeInUse?: (homePath: string, exceptRunId: string) => boolean
  /** 终态清理失败后的重试间隔（默认 1 小时；测试可缩短）。 */
  readonly terminalCleanupRetryMs?: number
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
  /** runId → 已下载的项目上下文副本与快照清单（本地回执的事实源）。 */
  private readonly projectContexts = new Map<string, PreparedProjectContext>()
  /** runId → 本快照已交付/已读集合与 header 事实（Node 侧累计并集）。 */
  private readonly contextReceiptState = new Map<
    string,
    {
      snapshotId: string
      delivered: Set<string>
      read: Set<string>
      headerDigest: string
      nonceMatched: boolean
    }
  >()
  private readonly contextReceiptOutbox: RunContextReceiptOutbox
  private readonly terminalCleanupStore: RunTerminalCleanupStore
  private readonly terminalCleanupRetryMs: number
  /** 队列写失败的终态 facts：同进程下一轮 tick 先补登记（不丢到重启）。 */
  private readonly unscheduledCleanupFacts = new Map<
    string,
    { facts: RunRuntimeFacts; terminalAt: string }
  >()
  /** 本连接内已发送、尚未 ack 的回执；重连时清空以便全量重放。 */
  private readonly sentContextReceipts = new Set<string>()
  private readonly contextStateStore: ContextStateStore
  private readonly contextStateDeps: ContextStateApplierDeps
  /**
   * 单 Run 状态帧串行化：`handleFrame` 是 fire-and-forget，Hub 的完整状态、水位
   * 帧与 run.start 初始化可能并发；并发 tmp+rename 会让旧状态覆盖新状态。
   */
  private readonly contextStateOps = new Map<string, Promise<unknown>>()
  /** runId → 已下载的工作输入副本与清单（本地回执的事实源）。 */
  private readonly workInputs = new Map<string, PreparedWorkInputs>()
  private readonly workInputReceiptStore: WorkInputReceiptStore
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
    this.contextReceiptOutbox = deps.contextReceiptOutbox ?? new MemoryContextReceiptOutbox()
    this.terminalCleanupStore = deps.terminalCleanupStore ?? new MemoryRunTerminalCleanupStore()
    this.terminalCleanupRetryMs = deps.terminalCleanupRetryMs ?? 60 * 60 * 1000
    this.contextStateStore = deps.contextStateStore ?? new MemoryContextStateStore()
    this.contextStateDeps = {
      runtimeHomeFor: deps.runtimeHomeFor,
      store: this.contextStateStore,
      now: this.now,
      log: (level, msg, context) => this.log(level, msg, context),
    }
    this.workInputReceiptStore = deps.workInputReceiptStore ?? new MemoryWorkInputReceiptStore()
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
      case 'run.followup':
        return this.handleRunFollowup(frame.payload)
      case 'approval.decide':
        return this.handleApprovalDecide(frame.payload)
      case 'run.context_state':
        return this.handleRunContextState(frame.payload)
      case 'context.state_sync':
        return this.handleContextStateSync(frame.payload)
      case 'run.context_receipt_ack':
        this.handleContextReceiptAck(frame.payload)
        return
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

  /** 单 Run 串行队列；前序失败不阻塞后续帧（清理/新状态仍要尝试）。 */
  private enqueueContextStateOp<T>(runId: string, op: () => Promise<T>): Promise<T> {
    const previous = this.contextStateOps.get(runId) ?? Promise.resolve()
    const next = previous.catch(() => undefined).then(op)
    this.contextStateOps.set(runId, next)
    void next
      .catch(() => undefined)
      .finally(() => {
        if (this.contextStateOps.get(runId) === next) this.contextStateOps.delete(runId)
      })
    return next
  }

  /** 重连后全量补发（R1：Hub 重启后从各自未 ack 处续发；Hub 幂等去重）。 */
  onReconnect(): void {
    // R9：先补发攒下的 lost 快照（终态事实优先于历史事件重放）。
    for (const snapshot of this.pendingLostSnapshots.values()) {
      this.deps.send(runSnapshotFrame(snapshot))
    }
    for (const runId of this.deps.eventStore.runIdsWithPending()) this.drainRun(runId)
    // 断线期间未写出的工作输入回执：重连后补发（Hub 按 receiptSeq 幂等）。
    this.drainWorkInputReceipts()
    // ADR-0027 §4（PC-05b-2）：未收到 Hub ack 的上下文回执按序重放。
    // 新连接没有「本连接已发」记忆，必须全量重放，由 Hub 按 seq 幂等吸收。
    this.sentContextReceipts.clear()
    this.drainContextReceiptOutbox()
    // ADR-0027 §6（PC-05b）：到期未完成的撤权副本删除先重试一轮。
    // 每个 Run 走自己的串行队列，避免与状态帧并发写 state.json。
    this.scheduleContextCleanupDrain()
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
      // ADR-0027 §6（PC-05b-3）：在任何下载/初始化之前先落 Run home 事实。
      // 进程若在 prepare 之后、spawn 之前崩溃，启动清扫仍能对账清理 runtime-context。
      const dshHomePath = this.deps.runtimeHomeFor(payload.resumeOfRunId ?? runId)
      this.terminalCleanupStore.putFacts(
        {
          runId,
          homePath: dshHomePath,
          entryCount: payload.projectContext?.manifest.length ?? 0,
          ownsHome: payload.resumeOfRunId === undefined,
          sessionReady: false,
          dshSessionId: null,
        },
        this.now().toISOString(),
      )
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
      // ADR-0027 §3：项目上下文快照下载 + 逐条 digest/byteSize 核对。清单存在但
      // 本 Node 未装配时 fail-closed（绝不「只存快照 ID」继续执行）。
      let projectContext: PreparedProjectContext | undefined
      if (payload.projectContext !== undefined) {
        if (this.deps.prepareProjectContext === undefined) {
          const error = new Error('project context delivery is not configured on this node')
          ;(error as Error & { code?: string }).code = 'CONTEXT_UNAVAILABLE'
          throw error
        }
        projectContext = await this.deps.prepareProjectContext(runId, payload.projectContext)
        this.projectContexts.set(runId, projectContext)
        // ADR-0027 §6（PC-05b）：先落本地状态（优先复用重连前已持久化的状态），
        // Runtime 启动后第一次读取就有可校验的 state.json。与后续状态帧共用
        // 单 Run 串行队列，避免初始化覆盖已到达的撤权状态。
        await this.enqueueContextStateOp(runId, () =>
          initializePreparedContextState(this.contextStateDeps, projectContext!),
        )
        const storedContextState = this.contextStateStore.get(runId)
        this.contextReceiptState.set(runId, {
          snapshotId: projectContext.snapshotId,
          delivered: new Set(storedContextState?.delivered ?? []),
          read: new Set(storedContextState?.read ?? []),
          headerDigest: projectContext.headerDigest,
          nonceMatched: true,
        })
      }
      // ADR-0028 §3：工作输入正文下载 + digest/byteSize 核对。清单存在但未装配
      // 同样 fail-closed（绝不让 Runtime 在缺正文的情况下继续）。
      let workInputs: PreparedWorkInputs | undefined
      if (payload.workInput !== undefined) {
        if (this.deps.prepareWorkInputs === undefined) {
          const error = new Error('work input delivery is not configured on this node')
          ;(error as Error & { code?: string }).code = 'CONTEXT_UNAVAILABLE'
          throw error
        }
        workInputs = await this.deps.prepareWorkInputs(runId, payload.workInput)
        this.workInputs.set(runId, workInputs)
      }
      const projector = new RunProjector(this.projectionContext(runId, workspacePath))
      const spec: RuntimeStartSpec = {
        runId,
        nonce: newRuntimeNonce(),
        workspaceId: payload.workspaceId,
        dshHomePath,
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
          // 切片⑤（resume）：续跑 Run 的 DSH_HOME 必须指向**来源 Run** 的 home——
          // runtimeHomeFor 按 runId 隔离，新 runId 的 home 里没有旧日志，resume
          // 的 persisted load 会找不到存储。resumeSessionId 直达装载身份。
          dshHomePath,
          ...(payload.resumeSessionId !== undefined
            ? { resumeSessionId: payload.resumeSessionId }
            : {}),
          profileDigest: payload.expectedProfileDigest,
          pluginPackDigest: payload.expectedPluginPackDigest,
          ...(pluginPackOverlayPath !== undefined ? { pluginPackOverlayPath } : {}),
          ...(artifactInputs !== undefined && artifactInputs.entries.length > 0
            ? {
                artifactInputs: [...artifactInputs.entries],
                artifactInputsDir: artifactInputs.dir,
              }
            : {}),
          ...(projectContext !== undefined
            ? {
                projectContext: {
                  snapshotId: projectContext.snapshotId,
                  digest: projectContext.snapshotDigest,
                  headerText: projectContext.headerText,
                  headerDigest: projectContext.headerDigest,
                  entries: [...projectContext.entries],
                  entriesDir: projectContext.dir,
                },
              }
            : {}),
          ...(workInputs !== undefined
            ? {
                workInputs: {
                  workKey: workInputs.workKey,
                  manifestDigest: workInputs.manifestDigest,
                  entries: [...workInputs.entries],
                  entriesDir: workInputs.dir,
                },
              }
            : {}),
          provider: payload.agent.provider,
          model: payload.agent.model,
          ...(payload.agent.maxTokens !== undefined ? { maxTokens: payload.agent.maxTokens } : {}),
          persona: payload.agent.persona,
          // 切片⑧（#241）：Hub 解析固化的档位原样透传（缺省不携带 = 旧 Runtime 的
          // approval_required 语义）。
          ...(payload.approvalPolicy !== undefined
            ? { approvalPolicy: payload.approvalPolicy }
            : {}),
          // #379：收尾交接草稿的触发与约定快照原样透传（缺省 = 不生成）。
          ...(payload.handoff !== undefined ? { handoff: payload.handoff } : {}),
          ...(payload.executionContext !== undefined
            ? { executionContext: payload.executionContext }
            : {}),
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
      // 副本（spawn 前失败），同样要清理（#62：不留半成品目录）。Runtime 未启动时
      // 立即清；spawn 后下发失败则由 cleanupAbortedRun 改登记持久队列等退出确认。
      this.cleanupInputs(runId)
      this.cleanupAbortedRun(runId)
    }
  }

  // ---------- run.followup（#180 / ADR-0009 决策 3：执行中继续说话） ----------

  /**
   * Run 执行期间的一次追问：**不新开 Run、不换 session**，直接把 text 写进 Runtime
   * stdin 的本地 `run.followup` 帧（runtime-wire 既有），由 Runtime 排队成一次
   * follow-up turn。
   *
   * 受理语义（与协议注释同口径）：`ack accepted=true` 只表示「**已受理并下发到
   * Runtime stdin**」，不表示模型已读到——进展仍由既有 `session.event` / `run.*`
   * 上行帧呈现。Hub 侧据此把指令落 `instruction_state=accepted`（切片③）。
   *
   * 拒绝路径一律走 §10 现有码（不新造码），且**都不下发**：
   * - 本地已终态（finalFacts）→ INVALID_RUN_TRANSITION（终态禁止复活；免打扰守卫先于一切）
   * - 本 Node 没有这个 Run 的任何事实 → NOT_FOUND
   * - 还没到 runtime.ready（Run 不处于 running）→ INVALID_RUN_TRANSITION
   * - Runtime 已不在 → RUNTIME_LOST
   */
  private async handleRunFollowup(
    payload: Extract<NodeDownstream, { type: 'run.followup' }>['payload'],
  ): Promise<void> {
    const { commandId, runId } = payload
    const outcome = this.deps.commandStore.record({
      commandId,
      runId,
      type: 'run.followup',
      payload,
    })
    if (outcome === 'duplicate') {
      /**
       * 重复投递必须**回放当初那次处理的真实结果**，不能一律回 accepted（#181 阻断 B1）。
       *
       * 反例（评审用探针复现过）：首次投递因「未 ready」被拒 → ack 上行时连接已断、
       * ack 被丢弃 → Hub outbox 未落 acked_at → 退避后按**同一 commandId** 重投；
       * 此时 Run 已 ready。若这里回 accepted=true，那句话从未进过 Runtime stdin，
       * 而 Hub 会因为这条 ack 把 outbox 行标记完成、**永不重投**——「已受理、零痕迹、
       * 未执行」，正是 ADR-0009 决策 3 禁止的形态。
       *
       * 三种情况：
       * - 首次已受理（outcome=accepted）→ 回放 accepted=true：那句话确实在 Runtime 队列里。
       * - 首次被拒（outcome=rejected）→ 回放**同一个拒绝码与理由**，不重新判定
       *  （重新判定会因状态已变化而给出与当初不一致的答案）。
       * - 没有处理结果（崩溃在 record 与处理之间）→ 落到下面重新处理一次：这正是 spool 的
       *   本意（未处理完的 command 重来时应当被真正处理）。
       */
      const previous = this.deps.commandStore.outcomeOf(commandId)
      if (previous !== undefined) {
        // 回放是 B1 的关键事件（不该静默）：观测面要能看见「这次 ack 是回放、回放的是什么」。
        this.log('info', 'run.followup duplicate replayed first outcome', {
          component: 'node.run_manager',
          runId,
          commandId,
          replayed: previous.outcome,
          ...(previous.error !== undefined ? { replayedCode: previous.error.code } : {}),
        })
        if (previous.outcome === 'accepted') {
          this.ack(commandId, true)
          return
        }
        this.ack(
          commandId,
          false,
          previous.error ?? { code: 'INTERNAL_ERROR', message: 'replayed rejection' },
        )
        return
      }
    }
    /**
     * 记录首次处理结果。**落库失败绝不吞掉 ack**（#181 评审 N1）：ack 描述的是刚刚
     * 真实发生的事（已下发 / 已拒绝），与本地台账是否写成无关；反过来，若不 ack，
     * Hub 会按同一 commandId 重投，而 `outcomeOf` 仍是 undefined（落库失败），于是
     * 重新处理一次 → 同一句追问**二次注入**。所以落库异常降级为 error 级留痕，
     * ack 照发；代价是「ack 也丢失」时可能二次注入（极窄，登记在验收文档）。
     */
    const persistOutcome = (
      result: 'accepted' | 'rejected',
      error?: { code: string; message: string },
    ): void => {
      try {
        this.deps.commandStore.recordOutcome(commandId, result, error)
      } catch (cause) {
        this.log('error', 'run.followup outcome persist failed; ack still sent', {
          component: 'node.run_manager',
          runId,
          commandId,
          outcome: result,
          error: cause instanceof Error ? cause.message : String(cause),
        })
      }
    }
    const reject = (code: ErrorCode, message: string): void => {
      // 记录首次结果（与 ack 同一时刻的事实）：Hub 重投时据此回放同一个拒绝。
      persistOutcome('rejected', { code, message })
      this.log('warn', 'run.followup rejected', { component: 'node.run_manager', runId, code })
      this.ack(commandId, false, { code, message })
    }
    if (this.finalFacts.has(runId)) {
      reject('INVALID_RUN_TRANSITION', 'run is terminal; followup rejected')
      return
    }
    if (!this.runFacts.has(runId) && !this.readyFacts.has(runId)) {
      reject('NOT_FOUND', 'run is unknown on this node')
      return
    }
    if (!this.readyFacts.has(runId)) {
      // Run 存在但还没 running（queued / dispatching）：本 Node 不排队，交回 Hub 决定
      //（ADR-0009 决策 5：未 running 的窗口由 Hub 侧排队，进 running 后按序下发）。
      reject('INVALID_RUN_TRANSITION', 'run has not reached running; followup rejected')
      return
    }
    // 用 dispatchToRuntime 的返回值而不是先 isActive() 再派发：它把「handle 是否还在」
    // 的判断与写入放在同一次调用里，省掉一次可被穿插的检查。
    //
    // 但它**只保证「handle 在管且调用过 write」**，不保证字节真的到达 Runtime：driver
    // 的 send 把 stdin 写失败统一吞成 stderr 归因（#107 有意设计）。所以已知窗口是
    // 「进程已死、exit 事件尚未投递」——那一瞬 handle 还在、这里返回 true，而追问被
    // 无声吞掉（进程边界窗口，非本函数的竞态）。要让 accepted 更强就得让发送路径能
    // 报投递失败（send 返回结果 / supervisor 暴露可写性），那是 driver 层的改动，
    // 不在切片② 范围内；本片按机制能保证的强度措辞，并把它登记在验收文档。
    const dispatched = this.deps.supervisor.dispatchToRuntime(runId, {
      protocolVersion: 1,
      messageId: crypto.randomUUID(),
      sentAt: this.now().toISOString(),
      type: 'run.followup',
      payload: { runId, text: payload.text },
    })
    if (!dispatched) {
      reject('RUNTIME_LOST', 'runtime is not active; followup rejected')
      return
    }
    persistOutcome('accepted')
    this.ack(commandId, true)
    this.log('info', 'run.followup dispatched to runtime', {
      component: 'node.run_manager',
      runId,
    })
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
    // 终态帧先到、进程后退出：退出确认后才执行 session/spill 清理（PC-05b-3）。
    if (this.finalFacts.has(runId)) this.runTerminalCleanupTick()
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

  private handleSupervisorLost(runId: string, reason: RuntimeLostEvent['reason']): void {
    // 穷尽性由 switch + never 兜住（评审 A-P1）：写成 if 链时，将来给
    // RuntimeLostEvent 加第 4 个 reason 会**静默**落进 runtime_timeout 分支——
    // 那正是本码要消灭的「用户分不清是什么搞的」。
    switch (reason) {
      case 'version_changed_after_node_restart': {
        // #356：该 Run 存活期间本机 DSH 版本被换过（升级/回滚流程：停 Node → 换版 →
        // 起 Node）。孤儿已由三重匹配处理，但归因不是「进程丢了」而是「版本换了」——
        // 旧版本下跑起来的 Runtime 不恢复、绝不自动复活，用户据专用码知道要显式重跑。
        const summary =
          'local DSH distribution version changed since the last node startup; runtime not restored'
        this.log('error', 'runtime orphaned after dsh version change; reporting lost', {
          component: 'node.supervisor',
          runId,
        })
        this.finalizeRun(runId, 'lost', 'RUNTIME_VERSION_CHANGED', summary)
        this.reportLostSnapshot(runId, summary, 'RUNTIME_VERSION_CHANGED')
        return
      }
      case 'orphaned_after_node_restart': {
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
      case 'runtime_timeout': {
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
        return
      }
      default: {
        const exhaustive: never = reason
        throw new Error(`unhandled runtime lost reason: ${String(exhaustive)}`)
      }
    }
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
  private reportLostSnapshot(
    runId: string,
    summary: string,
    code: ErrorCode = 'RUNTIME_LOST',
  ): void {
    if (this.finalFacts.get(runId) === undefined) {
      this.finalizeRun(runId, 'lost', code, summary)
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
  /** 重启后 lost 快照要带上持久化的 session id，Hub 才能沿血缘标 blocked。 */
  private persistedSessionId(runId: string): string | null {
    try {
      return this.terminalCleanupStore.getFacts(runId)?.dshSessionId ?? null
    } catch {
      return null
    }
  }

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
      dshSessionId: ready?.dshSessionId ?? this.persistedSessionId(runId),
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
    // ADR-0027 §4：项目上下文两级回执不投影成产品事件；Node 累计并集后转专用上行帧。
    if (frame.type === 'runtime.context_receipt') {
      this.handleContextReceipt(runId, frame.payload)
      return
    }
    // ADR-0028 §3：工作输入回执走独立通道（不是产品事件）。
    if (frame.type === 'runtime.work_input_receipt') {
      this.handleWorkInputReceipt(runId, frame.payload)
      return
    }
    // P1-16：runtime.ready 事实入账（snapshot 的 dshSessionId/startedAt）。
    if (frame.type === 'runtime.ready') {
      // #288：ready 回声的 profileDigest 必须等于 run.start 固化的 Revision digest。
      // 对照点在收到方（Node）——不符即身份漂移，按协议违例同路收敛（fail run +
      // 终止 runtime），绝不让身份不明的 Run 继续执行。
      // 没有固化事实就没有可对照的右侧：这在本进程内不可达（runFacts 与 projector
      // 同点写入、从不删除），但它是这条对照唯一的 fail-open 分支——按违例收敛，
      // 不静默放过（将来把两者解耦时不会悄悄失效）。
      const facts = this.runFacts.get(runId)
      if (facts === undefined) {
        this.protocolViolation(runId, 'runtime.ready without pinned run facts')
        return
      }
      if (frame.payload.profileDigest !== facts.expectedProfileDigest) {
        this.profileIdentityViolation(
          runId,
          frame.payload.profileDigest,
          facts.expectedProfileDigest,
        )
        return
      }
      this.readyFacts.set(runId, {
        dshSessionId: frame.payload.dshSessionId,
        startedAt: this.now().toISOString(),
      })
      // 终态清理据此判断本 Run 是否已把 session 写进（可能是共享的）home。
      try {
        this.terminalCleanupStore.markSessionReady(
          runId,
          frame.payload.dshSessionId,
          this.now().toISOString(),
        )
      } catch (error) {
        this.log('warn', 'terminal cleanup markSessionReady failed', {
          component: 'node.context',
          action: 'node.context.terminal_cleanup',
          event: 'facts_write_failed',
          runId,
          errorName: error instanceof Error ? (error.name ?? 'Error') : typeof error,
        })
      }
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

  /**
   * #288：Runtime 回报的 profileDigest 与固化的 Revision digest 不符——身份对照
   * 失败，与协议违例同路收敛（合成 run.failed(PROFILE_MISMATCH) + 终止 runtime）。
   * 两个 digest 都是 sha256 十六进制，可直接进消息（不是本地路径或敏感语料）。
   */
  private profileIdentityViolation(runId: string, reported: string, expected: string): void {
    const summary = `runtime reported profile digest ${reported}; pinned revision digest is ${expected}`
    this.log('error', 'runtime profile identity mismatch; failing run', { runId })
    const projector = this.projectors.get(runId)
    if (projector !== undefined) {
      const result = projector.projectRuntimeOutput({
        protocolVersion: 1,
        messageId: crypto.randomUUID(),
        sentAt: this.now().toISOString(),
        type: 'runtime.fatal',
        payload: { runId, code: 'PROFILE_MISMATCH', summary },
      })
      this.spoolAndDrain(runId, result.events)
      this.finalizeRun(runId, 'failed', 'PROFILE_MISMATCH', summary)
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
    // P1-15/#62：artifact/work inputs 仍走既有终态收敛；项目上下文与 session/spill
    // 改由持久清理队列承担——必须等 Runtime 子进程退出确认后再删（PC-05b-3）。
    this.cleanupInputs(runId)
    this.scheduleTerminalCleanup(runId)
    // #88：Runtime 主动回收同样收敛在此——终态即下发 runtime.shutdown（协议帧，
    // bridge/bin 收敛后 EOF 退出），容量立即释放；宽限内不退则信号升级
    // （SIGTERM→SIGKILL），supervisor 硬超时（生产 6h）降为最后兜底。
    this.releaseRuntime(runId)
    // 退出归因路径（cancelled_forced/runtime_lost/supervisor lost）到达时进程
    // 已不在管；terminal frame 路径等 handleRuntimeExit 再清。
    if (!this.deps.supervisor.isActive(runId)) this.runTerminalCleanupTick()
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

  /** ADR-0027 §6（PC-05b）：应用完整状态并回报 ack（清理失败项一并上报）。 */
  private async handleRunContextState(state: RunContextStateWire): Promise<void> {
    return this.enqueueContextStateOp(state.runId, () => this.applyRunContextStateFrame(state))
  }

  private async applyRunContextStateFrame(state: RunContextStateWire): Promise<void> {
    const prepared = this.projectContexts.get(state.runId)
    let result: Awaited<ReturnType<typeof applyRunContextState>>
    try {
      result = await applyRunContextState(this.contextStateDeps, prepared, state)
    } catch (error) {
      // 帧处理是 fire-and-forget 入口：本地 IO 失败必须收口并 ack false，不能
      // 变成未处理拒绝拖垮 Node 进程。
      this.log('warn', 'project context state apply failed', {
        component: 'node.context',
        runId: state.runId,
        errorName: error instanceof Error ? error.name : 'unknown',
      })
      this.ack(state.commandId, false)
      return
    }
    // Outbox 命令必须 ack；状态被忽略/摘要不符时 ack false，避免无意义重发。
    this.ack(state.commandId, result.applied)
    if (!result.applied) {
      this.log('warn', 'project context state ignored', {
        component: 'node.context',
        runId: state.runId,
        snapshotId: state.snapshotId,
        stateVersion: state.stateVersion,
      })
      return
    }
    if (prepared !== undefined && prepared.snapshotId === state.snapshotId) {
      this.deps.send(
        contextStateAckFrame({
          runId: state.runId,
          snapshotId: state.snapshotId,
          stateVersion: state.stateVersion,
          stateDigest: state.stateDigest,
          appliedAt: this.now().toISOString(),
          failedEntryIds: [...new Set([...result.failedEntryIds, ...result.pendingEntryIds])],
        }),
      )
    }
    this.log('info', 'project context state applied', {
      component: 'node.context',
      runId: state.runId,
      snapshotId: state.snapshotId,
      stateVersion: state.stateVersion,
      deleted: result.deleted,
      quarantined: result.quarantined,
      failed: result.failedEntryIds.length,
      pending: result.pendingEntryIds.length,
      paused: result.paused,
    })
  }

  /** ADR-0027 §6（PC-05b）：摘要不一致/本地缺失 → 拉完整状态；一致才刷新水位。 */
  private async handleContextStateSync(sync: ContextStateSyncWire): Promise<void> {
    return this.enqueueContextStateOp(sync.runId, () => this.applyContextStateSyncFrame(sync))
  }

  private async applyContextStateSyncFrame(sync: ContextStateSyncWire): Promise<void> {
    const prepared = this.projectContexts.get(sync.runId)
    let result: Awaited<ReturnType<typeof applyContextStateSync>>
    try {
      result = await applyContextStateSync(this.contextStateDeps, prepared, sync)
    } catch (error) {
      this.log('warn', 'project context state sync failed', {
        component: 'node.context',
        runId: sync.runId,
        errorName: error instanceof Error ? error.name : 'unknown',
      })
      this.ack(sync.commandId, false)
      return
    }
    this.ack(sync.commandId, true)
    if (result.pull) {
      const stored = this.contextStateStore.get(sync.runId)
      this.deps.send(
        contextStatePullFrame({
          runId: sync.runId,
          snapshotId: sync.snapshotId,
          knownStateVersion: stored?.stateVersion ?? 0,
        }),
      )
      this.log('warn', 'project context state sync mismatch; pulling full state', {
        component: 'node.context',
        runId: sync.runId,
        snapshotId: sync.snapshotId,
        stateVersion: sync.stateVersion,
        reason: result.reason,
      })
      return
    }
    await this.drainRunContextCleanup(sync.runId)
  }

  /** 重连时给每个已准备上下文副本的 Run 排一次清理重试。 */
  private scheduleContextCleanupDrain(): void {
    for (const runId of this.projectContexts.keys()) {
      void this.enqueueContextStateOp(runId, () => this.drainRunContextCleanup(runId))
    }
  }

  /** 单 Run 到期清理重试；调用方必须已持有该 Run 的串行队列。 */
  private async drainRunContextCleanup(runId: string): Promise<void> {
    try {
      const result = await drainContextCleanupQueue(
        this.contextStateDeps,
        (id) => this.projectContexts.get(id),
        runId,
      )
      for (const resumedRunId of result.resumedRuns) {
        const prepared = this.projectContexts.get(resumedRunId)
        const stored = this.contextStateStore.get(resumedRunId)
        if (prepared === undefined || stored === undefined || stored.stateVersion < 1) continue
        this.deps.send(
          contextStateAckFrame({
            runId: resumedRunId,
            snapshotId: stored.snapshotId,
            stateVersion: stored.stateVersion,
            stateDigest: stored.stateDigest,
            appliedAt: this.now().toISOString(),
            failedEntryIds: [],
          }),
        )
      }
      if (result.retried > 0 || result.failed > 0) {
        this.log('info', 'project context cleanup retry', {
          component: 'node.context',
          runId,
          retried: result.retried,
          failed: result.failed,
          resumed: result.resumedRuns.length,
        })
      }
    } catch (error) {
      this.log('warn', 'project context cleanup retry failed', {
        component: 'node.context',
        runId,
        errorName: error instanceof Error ? error.name : 'unknown',
      })
    }
  }

  /**
   * ADR-0027 §4：把 Runtime 的 delivered/read 回执累计成 Node→Hub 的
   * `run.context_receipt`。`entriesDelivered` 是累计并集；`entriesRead/readEvents`
   * 是本批新增读取（Hub 侧累计取并集）。未知 entryId 不进入回执，避免伪造清单外条目。
   */
  private handleContextReceipt(runId: string, payload: RuntimeContextReceiptPayload): void {
    const prepared = this.projectContexts.get(runId)
    const state = this.contextReceiptState.get(runId)
    if (prepared === undefined || state === undefined) {
      this.log('warn', 'project context receipt without a prepared snapshot dropped', {
        component: 'node.context',
        runId,
      })
      return
    }
    if (payload.snapshotId !== prepared.snapshotId) {
      this.log('warn', 'project context receipt snapshot mismatch dropped', {
        component: 'node.context',
        runId,
      })
      return
    }
    const known = new Set(prepared.entries.map((entry) => entry.entryId))
    let draft: RunContextReceiptDraft
    if (payload.kind === 'delivered') {
      for (const entryId of payload.entriesDelivered) {
        if (known.has(entryId)) state.delivered.add(entryId)
      }
      state.headerDigest = payload.headerDigest
      state.nonceMatched = payload.nonceMatched && payload.headerDigest === prepared.headerDigest
      draft = {
        runId,
        snapshotId: prepared.snapshotId,
        headerDigest: state.headerDigest,
        nonceMatched: state.nonceMatched,
        entriesDelivered: [...state.delivered].sort(),
        entriesRead: [],
        readEvents: [],
        missing: prepared.entries
          .map((entry) => entry.entryId)
          .filter((entryId) => !state.delivered.has(entryId)),
        digestVerified: true,
        at: payload.at,
      }
    } else {
      if (!known.has(payload.entryId)) {
        this.log('warn', 'project context read receipt for an unknown entry dropped', {
          component: 'node.context',
          runId,
        })
        return
      }
      state.read.add(payload.entryId)
      draft = {
        runId,
        snapshotId: prepared.snapshotId,
        headerDigest: state.headerDigest,
        nonceMatched: state.nonceMatched,
        entriesDelivered: [...state.delivered].sort(),
        entriesRead: [payload.entryId],
        readEvents: [
          {
            entryId: payload.entryId,
            digestVerified: payload.digestVerified,
            byteSize: payload.byteSize,
            at: payload.at,
          },
        ],
        missing: prepared.entries
          .map((entry) => entry.entryId)
          .filter((entryId) => !state.delivered.has(entryId)),
        digestVerified: payload.digestVerified,
        at: payload.at,
      }
    }
    // 先原子「分配 seq + 入队」再写本地已交付/已读标记：任何一步失败都不会
    // 出现「seq 已消费但没有待发回执」的空洞。持久化失败只记结构化错误，绝不
    // 让 stdout 监听器冒泡异常拖死整个 Node 进程。
    let receipt: RunContextReceipt
    try {
      receipt = this.contextReceiptOutbox.enqueueNext(draft, this.now().toISOString())
    } catch (error) {
      this.log('error', 'project context receipt persist failed', {
        component: 'node.context',
        action: 'node.context.receipt_outbox',
        event: 'persist_failed',
        runId,
        snapshotId: prepared.snapshotId,
        errorName: error instanceof Error ? error.name : typeof error,
      })
      return
    }
    try {
      if (payload.kind === 'delivered') {
        this.contextStateStore.markDelivered(runId, prepared.snapshotId, [...state.delivered])
      } else {
        // 已读集合必须跨重启保留：撤权时只删 readAt=0 的副本。
        this.contextStateStore.markRead(runId, prepared.snapshotId, payload.entryId)
      }
    } catch (error) {
      // 回执已持久化；本地标记滞后只影响撤权清理的保守方向，不回滚已发生事实。
      this.log('warn', 'project context receipt local state mark failed', {
        component: 'node.context',
        action: 'node.context.receipt_outbox',
        event: 'local_state_failed',
        runId,
        snapshotId: prepared.snapshotId,
        receiptSeq: receipt.receiptSeq,
        errorName: error instanceof Error ? error.name : typeof error,
      })
    }
    this.drainContextReceiptOutbox(runId)
    this.log('info', 'project context receipt queued', {
      component: 'node.context',
      action: 'node.context.receipt_outbox',
      event: 'queued',
      runId,
      snapshotId: prepared.snapshotId,
      receiptSeq: receipt.receiptSeq,
      delivered: receipt.entriesDelivered.length,
      read: receipt.entriesRead.length,
      pending: this.contextReceiptOutbox.pending(runId).length,
    })
  }

  /** 按 seq 升序重放未 ack 的上下文回执；发送成功也保留到 Hub ack。 */
  private drainContextReceiptOutbox(runId?: string): void {
    for (const item of this.contextReceiptOutbox.pending(runId)) {
      const key = this.contextReceiptKey(item.receipt)
      if (this.sentContextReceipts.has(key)) continue
      if (this.deps.send(runContextReceiptFrame(item.receipt))) {
        this.sentContextReceipts.add(key)
      }
    }
  }

  private contextReceiptKey(
    receipt: Pick<RunContextReceipt, 'runId' | 'snapshotId' | 'receiptSeq'>,
  ): string {
    return `${receipt.runId}|${receipt.snapshotId}|${receipt.receiptSeq}`
  }

  /** Hub 接收回执后删除本地待发项；未知/过期 seq 幂等忽略。 */
  private handleContextReceiptAck(
    payload: Extract<NodeDownstream, { type: 'run.context_receipt_ack' }>['payload'],
  ): void {
    // 只删被 ack 的精确 seq。Hub 允许 seq 空洞，highestSeq 不能证明更低的
    // 未 ack 项已经落库——按区间删会丢掉 Hub 从未收到的读取事实。
    this.contextReceiptOutbox.ack(payload.runId, payload.snapshotId, payload.receiptSeq)
    this.sentContextReceipts.delete(
      this.contextReceiptKey({
        runId: payload.runId,
        snapshotId: payload.snapshotId,
        receiptSeq: payload.receiptSeq,
      }),
    )
    this.log('info', 'project context receipt acknowledged', {
      component: 'node.context',
      action: 'node.context.receipt_outbox',
      event: 'acknowledged',
      runId: payload.runId,
      snapshotId: payload.snapshotId,
      receiptSeq: payload.receiptSeq,
      highestSeq: payload.highestSeq,
      result: payload.result,
      pending: this.contextReceiptOutbox.pending(payload.runId).length,
    })
  }

  /**
   * ADR-0028 §3：把 Runtime 的工作输入 delivered/read 回执累计成专用上行帧。
   * 持久 store 先入队再发送；发送失败（断线）保留，重连后重放。
   */
  private handleWorkInputReceipt(runId: string, payload: RuntimeWorkInputReceiptPayload): void {
    const prepared = this.workInputs.get(runId)
    if (prepared === undefined) {
      this.log('warn', 'work input receipt without prepared inputs dropped', {
        component: 'node.work_input',
        runId,
      })
      return
    }
    if (
      payload.workKey !== prepared.workKey ||
      payload.manifestDigest !== prepared.manifestDigest
    ) {
      this.log('warn', 'work input receipt manifest mismatch dropped', {
        component: 'node.work_input',
        runId,
      })
      return
    }
    const known = new Set(prepared.entries.map((entry) => entry.inboxItemId))
    if (payload.kind === 'read' && !known.has(payload.inboxItemId)) {
      this.log('warn', 'work input read receipt for an unknown item dropped', {
        component: 'node.work_input',
        runId,
      })
      return
    }
    // 状态累计、序号与 outbox 必须同一本地事务：进程在两步之间崩溃会留下
    // 「读取已发生、回执从未入队」的永久缺口。
    const receipt = this.workInputReceiptStore.transaction(() => {
      if (payload.kind === 'delivered') {
        this.workInputReceiptStore.addDelivered(
          runId,
          prepared.manifestDigest,
          payload.entriesDelivered.filter((id) => known.has(id)),
        )
      } else {
        this.workInputReceiptStore.addRead(runId, prepared.manifestDigest, payload.inboxItemId)
      }
      const snapshot = this.workInputReceiptStore.snapshot(runId, prepared.manifestDigest)
      const built: RunWorkInputReceipt = {
        runId,
        workKey: prepared.workKey,
        manifestDigest: prepared.manifestDigest,
        receiptSeq: this.workInputReceiptStore.nextSeq(runId, prepared.manifestDigest),
        entriesDelivered: [...snapshot.delivered].sort(),
        entriesRead: [...snapshot.read].sort(),
        readEvents:
          payload.kind === 'read'
            ? [
                {
                  inboxItemId: payload.inboxItemId,
                  digestVerified: payload.digestVerified,
                  byteSize: payload.byteSize,
                  at: payload.at,
                },
              ]
            : [],
        missing: prepared.entries
          .map((entry) => entry.inboxItemId)
          .filter((id) => !snapshot.delivered.includes(id)),
        digestVerified: payload.kind === 'read' ? payload.digestVerified : true,
        at: payload.at,
      }
      this.workInputReceiptStore.enqueue(built)
      return built
    })
    const sent = this.deps.send(runWorkInputReceiptFrame(receipt))
    if (sent) {
      this.workInputReceiptStore.removePending(
        receipt.runId,
        receipt.manifestDigest,
        receipt.receiptSeq,
      )
    }
    this.log(
      sent ? 'info' : 'warn',
      sent ? 'work input receipt forwarded' : 'work input receipt queued for reconnect',
      {
        component: 'node.work_input',
        runId,
        receiptSeq: receipt.receiptSeq,
        delivered: receipt.entriesDelivered.length,
        read: receipt.readEvents.length,
      },
    )
  }

  /** 重连后补发断线期间未成功写出的工作输入回执。 */
  private drainWorkInputReceipts(): void {
    for (const receipt of this.workInputReceiptStore.pending()) {
      if (this.deps.send(runWorkInputReceiptFrame(receipt))) {
        this.workInputReceiptStore.removePending(
          receipt.runId,
          receipt.manifestDigest,
          receipt.receiptSeq,
        )
      }
    }
  }

  /** P1-15：输入副本清理（best-effort，失败只吞掉——不阻塞终态登记）。 */
  private cleanupInputs(runId: string): void {
    void this.deps.cleanupArtifactInputs?.(runId).catch(() => {})
    void this.deps.cleanupWorkInputs?.(runId).catch(() => {})
    this.projectContexts.delete(runId)
    this.contextReceiptState.delete(runId)
    this.workInputs.delete(runId)
  }

  /**
   * 清理事实的兜底来源：本进程未写过 facts（升级接管、旧 Node 遗留）时从
   * command spool 的 run.start 重建。缺了它，升级在途的非空上下文 Run 会被
   * 当成 full 保留 session，Hub 却已经写了 blocked。
   */
  private fallbackCleanupFacts(runId: string): RunRuntimeFacts {
    const spooled = this.readRunFactsFromSpool(runId)
    const resumeOfRunId = spooled?.resumeOfRunId
    return {
      runId,
      homePath: this.deps.runtimeHomeFor(resumeOfRunId ?? runId),
      entryCount: spooled?.projectContext?.manifest.length ?? 0,
      ownsHome: resumeOfRunId === undefined,
      sessionReady: this.readyFacts.has(runId),
      dshSessionId: null,
    }
  }

  /** 持久事实优先；runtime.ready 以本进程内存为准（store 写失败时 fail-safe 补上）。 */
  private cleanupFactsFor(runId: string): RunRuntimeFacts {
    let stored: RunRuntimeFacts | undefined
    try {
      stored = this.terminalCleanupStore.getFacts(runId)
    } catch (error) {
      this.log('warn', 'run terminal cleanup facts read failed', {
        component: 'node.context',
        action: 'node.context.terminal_cleanup',
        event: 'facts_read_failed',
        runId,
        errorName: error instanceof Error ? (error.name ?? 'Error') : typeof error,
      })
    }
    if (stored === undefined) return this.fallbackCleanupFacts(runId)
    const ready = this.readyFacts.get(runId)
    return {
      ...stored,
      sessionReady: stored.sessionReady || ready !== undefined,
      dshSessionId: stored.dshSessionId ?? ready?.dshSessionId ?? null,
    }
  }

  /**
   * 有 facts 但无任务（prepare 后崩溃、schedule 写失败）的启动对账：
   * 无活跃 Runtime 的 Run 补登记为立即到期，然后由正常 tick 清理。
   */
  private reconcileCleanupFacts(includeSharedHome: boolean): void {
    let factsRows: readonly RunRuntimeFacts[]
    try {
      factsRows = this.terminalCleanupStore.factsNotScheduled()
    } catch (error) {
      this.log('warn', 'terminal cleanup facts reconcile failed', {
        component: 'node.context',
        action: 'node.context.terminal_cleanup',
        event: 'facts_read_failed',
        errorName: error instanceof Error ? (error.name ?? 'Error') : typeof error,
      })
      return
    }
    const at = this.now().toISOString()
    for (const facts of factsRows) {
      if (!includeSharedHome && !facts.ownsHome) continue
      if (this.deps.supervisor.isActive(facts.runId)) continue
      try {
        this.terminalCleanupStore.schedule({
          ...facts,
          runTerminalAt: at,
          dueAt: at,
        })
      } catch (error) {
        this.log('warn', 'terminal cleanup facts reconcile schedule failed', {
          component: 'node.context',
          action: 'node.context.terminal_cleanup',
          event: 'schedule_failed',
          runId: facts.runId,
          errorName: error instanceof Error ? (error.name ?? 'Error') : typeof error,
        })
      }
    }
  }

  /** 同进程补登记上次 schedule 失败的终态 facts。 */
  private retryUnscheduledCleanupTasks(includeSharedHome: boolean): void {
    for (const [runId, entry] of this.unscheduledCleanupFacts) {
      if (!includeSharedHome && !entry.facts.ownsHome) continue
      try {
        this.terminalCleanupStore.schedule({
          ...entry.facts,
          runTerminalAt: entry.terminalAt,
          dueAt: entry.terminalAt,
        })
        this.unscheduledCleanupFacts.delete(runId)
      } catch {
        // 仍失败：保留到下一轮（绝不丢内存里的待重试事实）。
      }
    }
  }

  /** run.start 拒绝路径：Runtime 未启动时立即清受管副本；已启动则等退出确认。 */
  private cleanupAbortedRun(runId: string): void {
    // spawn 成功后的下发失败（stdin 已关闭等）仍会进 catch：此时 session 可能
    // 正在写，直接删会破坏 ADR-0027 §6 的“退出后才清理”时序。
    if (this.deps.supervisor.isActive(runId)) {
      this.scheduleTerminalCleanup(runId)
      return
    }
    let facts: RunRuntimeFacts
    try {
      facts = this.cleanupFactsFor(runId)
    } catch (error) {
      this.log('warn', 'rejected run cleanup facts unavailable', {
        component: 'node.context',
        action: 'node.context.terminal_cleanup',
        event: 'facts_read_failed',
        runId,
        errorName: error instanceof Error ? (error.name ?? 'Error') : typeof error,
      })
      return
    }
    try {
      // resume Run 在 spawn 前失败：来源 Run 的 session 不属于本 Run。
      // cleanupRunCopies 对“非 owner 且未 ready”只清自己的 runtime-context。
      this.cleanupRunCopies(facts)
    } catch (error) {
      const now = this.now()
      const at = now.toISOString()
      const errorName = error instanceof Error ? (error.name ?? 'Error') : typeof error
      // 拒绝路径同样不能把失败副本丢在地上：登记持久任务并按正常重试节奏再试。
      try {
        this.terminalCleanupStore.schedule({
          runId: facts.runId,
          homePath: facts.homePath,
          entryCount: facts.entryCount,
          ownsHome: facts.ownsHome,
          sessionReady: facts.sessionReady,
          runTerminalAt: at,
          dueAt: at,
        })
        this.terminalCleanupStore.markFailure(
          facts.runId,
          errorName,
          new Date(now.getTime() + this.terminalCleanupRetryMs).toISOString(),
          at,
        )
      } catch (storeError) {
        this.log('warn', 'rejected run cleanup task write failed', {
          component: 'node.context',
          action: 'node.context.terminal_cleanup',
          event: 'schedule_failed',
          runId,
          errorName: storeError instanceof Error ? (storeError.name ?? 'Error') : typeof storeError,
        })
      }
      this.log('warn', 'rejected run cleanup failed', {
        component: 'node.context',
        action: 'node.context.terminal_cleanup',
        event: 'cleanup_pending',
        runId,
        errorName,
      })
    }
  }

  /**
   * ADR-0027 §6（PC-05b-3）：终态登记清理任务。此函数只落事实，不删文件；
   * Runtime 退出确认后由 {@link runTerminalCleanupTick} 执行。
   */
  private scheduleTerminalCleanup(runId: string): void {
    const at = this.finalFacts.get(runId)?.finishedAt ?? this.now().toISOString()
    let facts: RunRuntimeFacts
    try {
      facts = this.cleanupFactsFor(runId)
    } catch (error) {
      this.log('warn', 'run terminal cleanup facts unavailable', {
        component: 'node.context',
        action: 'node.context.terminal_cleanup',
        event: 'facts_read_failed',
        runId,
        errorName: error instanceof Error ? (error.name ?? 'Error') : typeof error,
      })
      return
    }
    try {
      this.terminalCleanupStore.schedule({
        runId,
        homePath: facts.homePath,
        entryCount: facts.entryCount,
        ownsHome: facts.ownsHome,
        sessionReady: facts.sessionReady,
        runTerminalAt: at,
        dueAt: at,
      })
      this.unscheduledCleanupFacts.delete(runId)
    } catch (error) {
      // 队列写失败不能阻断终态收敛/runtime.shutdown；内存保留事实，下一轮 tick
      // 先补登记（进程崩溃则靠启动的 factsNotScheduled 对账）。
      this.unscheduledCleanupFacts.set(runId, { facts, terminalAt: at })
      this.log('warn', 'run terminal cleanup schedule failed', {
        component: 'node.context',
        action: 'node.context.terminal_cleanup',
        event: 'schedule_failed',
        runId,
        errorName: error instanceof Error ? (error.name ?? 'Error') : typeof error,
      })
    }
  }

  /**
   * Node 启动后的先清扫：recoverOrphans 已处理完孤儿，此时 active_runtime 只剩
   * 本进程真正在管的 Runtime——未完成任务可安全重试（忽略 due_at）。
   */
  startTerminalCleanup(includeSharedHome = true): number {
    this.reconcileCleanupFacts(includeSharedHome)
    return this.runTerminalCleanupTick(true, includeSharedHome)
  }

  /**
   * 执行到期的终态清理；返回本轮成功完成的数量。单个 Run 失败只记
   * `cleanup_pending` 并保留队列，不拖垮整轮。
   */
  runTerminalCleanupTick(all = false, includeSharedHome = true): number {
    const now = this.now()
    this.retryUnscheduledCleanupTasks(includeSharedHome)
    let tasks: readonly TerminalCleanupTask[]
    try {
      tasks = all ? this.terminalCleanupStore.notDone() : this.terminalCleanupStore.due(now)
      if (!includeSharedHome) tasks = tasks.filter((task) => task.ownsHome)
    } catch (error) {
      // 队列读失败不能从 exit handler/小时定时器逃逸；本轮放弃，下一轮再试。
      this.log('warn', 'run terminal cleanup queue read failed', {
        component: 'node.context',
        action: 'node.context.terminal_cleanup',
        event: 'queue_read_failed',
        errorName: error instanceof Error ? (error.name ?? 'Error') : typeof error,
      })
      return 0
    }
    let completed = 0
    for (const task of tasks) {
      const retryAt = new Date(now.getTime() + this.terminalCleanupRetryMs).toISOString()
      try {
        // 本 Run 自己的 Runtime 还活着（终态帧已到、shutdown 宽限中）时绝不删：
        // isHomeInUse 按“其它 Run”口径排除了自己，不能拿它当退出确认。
        if (this.deps.supervisor.isActive(task.runId)) {
          this.terminalCleanupStore.markDeferred(task.runId, retryAt, now.toISOString())
          this.log('info', 'run terminal cleanup deferred; own runtime still active', {
            component: 'node.context',
            action: 'node.context.terminal_cleanup',
            event: 'deferred',
            runId: task.runId,
            attempts: task.attempts,
          })
          continue
        }
        // home 占用探测读 supervisor 状态库：数据库忙/损坏同样走 cleanup_pending，
        // 绝不让每小时定时器因一次探查异常把 Node 进程带崩。
        if (this.deps.isRuntimeHomeInUse?.(task.homePath, task.runId) === true) {
          // resume Run 共享来源 Run 的 home：等最后一个使用者终态/退出，绝不早删。
          this.terminalCleanupStore.markDeferred(task.runId, retryAt, now.toISOString())
          this.log('info', 'run terminal cleanup deferred; home still in use', {
            component: 'node.context',
            action: 'node.context.terminal_cleanup',
            event: 'deferred',
            runId: task.runId,
            attempts: task.attempts,
          })
          continue
        }
        this.cleanupRunCopies(task)
        this.terminalCleanupStore.markDone(task.runId, now.toISOString())
        completed += 1
        this.log('info', 'run terminal cleanup completed', {
          component: 'node.context',
          action: 'node.context.terminal_cleanup',
          event: 'done',
          runId: task.runId,
          mode: task.entryCount > 0 ? 'blocked' : 'full',
          attempts: task.attempts,
        })
      } catch (error) {
        const lastError = error instanceof Error ? (error.name ?? 'Error') : typeof error
        try {
          this.terminalCleanupStore.markFailure(task.runId, lastError, retryAt, now.toISOString())
        } catch (markError) {
          this.log('warn', 'run terminal cleanup markFailure failed', {
            component: 'node.context',
            action: 'node.context.terminal_cleanup',
            event: 'cleanup_pending_write_failed',
            runId: task.runId,
            errorName: markError instanceof Error ? (markError.name ?? 'Error') : typeof markError,
          })
        }
        this.log('warn', 'run terminal cleanup pending', {
          component: 'node.context',
          action: 'node.context.terminal_cleanup',
          event: 'cleanup_pending',
          runId: task.runId,
          attempts: task.attempts + 1,
          errorName: lastError,
        })
      }
    }
    return completed
  }

  /**
   * 清理一个 Run 的受管副本：
   * - 所有 Run：runtime-context/<runId>；
   * - resume Run 在 spawn 前失败（未写过共享 home）：到此为止；
   * - 其余：删 <home>/spill；
   * - 非空项目上下文（blocked）：删除 home 下全部内容（session + 非 session），
   *   但保留 home 目录本身（ADR-0009 resume 用的是来源 home，不整体删）；
   * - 空快照/无上下文（full）：保留 session 与非 session 文件，只额外清掉
   *   quarantine（正文暂存区，终态必须删除）。
   */
  private cleanupRunCopies(task: {
    runId: string
    homePath: string
    entryCount: number
    ownsHome: boolean
    sessionReady: boolean
  }): void {
    if (this.deps.runtimeContextDirFor !== undefined) {
      rmSync(this.deps.runtimeContextDirFor(task.runId), { recursive: true, force: true })
    }
    if (!task.ownsHome && !task.sessionReady) return
    rmSync(join(task.homePath, 'spill'), { recursive: true, force: true })
    if (task.entryCount > 0) {
      if (existsSync(task.homePath)) {
        for (const name of readdirSync(task.homePath)) {
          rmSync(join(task.homePath, name), { recursive: true, force: true })
        }
      }
      return
    }
    rmSync(join(task.homePath, 'quarantine'), { recursive: true, force: true })
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
