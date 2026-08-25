/**
 * RuntimeBridge —— Node ↔ DSH Runtime 子进程协议的桥（02 Task 11，03 §7）。
 *
 * `RuntimeBridge.start(spec)` 处理 `runtime.initialize`：以 dsh-base 为基座
 * （其 cordis.patch.yml  bundle 层）+ project311.patch.yml（本包 config/ 下）boot
 * 一棵 Cordis 树，创建本 Run 的 Agent，随后发 `runtime.ready`。其余 wire 命令
 * 经 `handleCommand` 映射到 DSH 公开 interface（07 §2 结论：只用公开面，
 * 不 fork loop）。`dispose()` 按 cancel → flush → dispose 次序收敛后拆树。
 */
import { randomUUID } from 'node:crypto'
import { realpathSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import type { Context } from '@deepseek-ai/cordis'
import { boot, loadOverlayPatches } from '@deepseek-ai/dsh-app-boot'
import type { TurnEndReason } from '@deepseek-ai/dsh-session'
import {
  ProtocolError,
  type ErrorCode,
  type RuntimeCommand,
  type RuntimeOutput,
} from '@project311/protocol'
import type { ArtifactPort } from './artifact-tool.js'
import { ApprovalPort } from './approval-port.js'
import { nullLog, type LogSink } from './log.js'
import { dshSessionIdOf, runtimeSpecFromInitialize, type RuntimeSpec } from './runtime-spec.js'
import { SessionOwner, type SessionOwnerEvents } from './session-owner.js'

/** bridge 的 output 出口与结构化日志口（生产由 apps/runtime 接到 stdout/stderr）。 */
export interface RuntimeBridgeOptions {
  /** 每帧 RuntimeOutput 的出口；帧在 protocol-port 写线前过 schema。 */
  emit(output: RuntimeOutput): void
  /** 结构化日志 sink（stderr 通道；缺省丢弃）。 */
  log?: LogSink
  /**
   * 追加的 Loader patch 层（在 dsh-base 与 project311.patch.yml 之后应用）。
   * 契约探针用它挂 replay overlay（config/replay.yml）；生产传 P1-17 批准的
   * Runtime Plugin Pack 层。
   */
  extraPatchFiles?: readonly string[]
}

const CONFIG_DIR = fileURLToPath(new URL('../config/', import.meta.url))
const require = createRequire(import.meta.url)
const BIN_NAME = 'project311-runtime'

/**
 * in-box 插件名的解析锚点：@deepseek-ai/dsh CLI 包的真实路径（realpath 后进
 * pnpm 虚拟 store，bare plugin specifier 经父目录遍历命中其依赖与 hoist 面，
 * 与 dsh-app-boot `boot()` 的 bareModuleBaseUrl 契约一致——宿主拥有完整插件集）。
 */
function dshAnchorUrl(): string {
  return pathToFileURL(realpathSync(require.resolve('@deepseek-ai/dsh/package.json'))).href
}

function dshBasePatchPath(): string {
  return require.resolve('@deepseek-ai/dsh-base/cordis.patch.yml')
}

/** 组合 Runtime 的 patch 栈：dsh-base 基座 → project311 bundle → 额外层。 */
async function bootDshTree(extraPatchFiles: readonly string[]): Promise<Context> {
  const patches = [
    ...loadOverlayPatches(BIN_NAME, dshBasePatchPath()),
    ...loadOverlayPatches(BIN_NAME, join(CONFIG_DIR, 'project311.patch.yml')),
    ...extraPatchFiles.flatMap((file) => loadOverlayPatches(BIN_NAME, file)),
  ]
  return boot(BIN_NAME, join(CONFIG_DIR, 'cordis.yml'), patches, undefined, dshAnchorUrl())
}

function frameOf<T extends RuntimeOutput['type']>(
  type: T,
  payload: Extract<RuntimeOutput, { type: T }>['payload'],
): RuntimeOutput {
  return {
    protocolVersion: 1,
    messageId: randomUUID(),
    sentAt: new Date().toISOString(),
    type,
    payload,
  } as RuntimeOutput
}

/** turn/end error 的 LlmFailure → wire ErrorCode（03 §10 目录内映射，不新造码）。 */
function mapTurnError(error: unknown): { code: ErrorCode; summary: string } {
  const record = (typeof error === 'object' && error !== null ? error : {}) as Record<
    string,
    unknown
  >
  const code = typeof record['code'] === 'string' ? record['code'] : 'UNKNOWN'
  const message = typeof record['message'] === 'string' ? record['message'] : 'turn failed'
  const mapped: ErrorCode = /credential|unauthorized|forbidden|api[-_]?key|^401$|^403$/i.test(code)
    ? 'MODEL_CREDENTIAL_UNAVAILABLE'
    : 'INTERNAL_ERROR'
  return { code: mapped, summary: `${code}: ${message}`.slice(0, 1000) }
}

export class RuntimeBridge {
  private disposed = false

  private constructor(
    private readonly ctx: Context,
    private readonly owner: SessionOwner,
    private readonly approval: ApprovalPort,
    private readonly spec: RuntimeSpec,
    private readonly log: LogSink,
  ) {}

  /**
   * 处理 `runtime.initialize`：boot DSH 树并创建本 Run 的 Agent，
   * 成功发 `runtime.ready`；失败抛出（由调用方转成 `runtime.fatal`）。
   */
  static async start(spec: RuntimeSpec, options: RuntimeBridgeOptions): Promise<RuntimeBridge> {
    const log = options.log ?? nullLog
    const runId = spec.runId
    const dshSessionId = dshSessionIdOf(spec)
    const emit = (output: RuntimeOutput): void => options.emit(output)

    // DSH_HOME 是本进程级契约（dsh-home-paths 经 $DSH_HOME 解析）；一个 Runtime
    // 子进程只服务一个 Run，initialize 到达后再 boot，home 即在 spec 里。
    process.env.DSH_HOME = spec.dshHomePath
    const ctx = await bootDshTree(options.extraPatchFiles ?? [])
    log({ level: 'info', component: 'runtime.bridge', msg: 'runtime booted', runId })

    const approval = new ApprovalPort(
      (fact) => emit(frameOf('approval.requested', { runId, ...fact })),
      log,
    )
    const artifact: ArtifactPort = {
      publish: (candidate) => emit(frameOf('artifact.candidate', { runId, ...candidate })),
    }
    const events: SessionOwnerEvents = {
      sessionEvent: (event) => emit(frameOf('session.event', { runId, dshSessionId, event })),
      agentStatus: (status) => emit(frameOf('agent.status', { runId, status })),
      turnSettled: (reason, finalMessageId) => {
        switch (reason.kind) {
          case 'completed':
            emit(
              frameOf('run.completed', {
                runId,
                dshSessionId,
                ...(finalMessageId !== undefined ? { finalMessageId } : {}),
              }),
            )
            return
          case 'aborted':
            emit(frameOf('run.cancelled', { runId }))
            return
          case 'error': {
            const failure = mapTurnError(reason.error)
            emit(frameOf('runtime.fatal', { runId, code: failure.code, summary: failure.summary }))
            return
          }
          default:
            // blocked / max-tokens / interrupted：P1-11 不产生的边界终态，fail loud。
            emit(
              frameOf('runtime.fatal', {
                runId,
                code: 'INTERNAL_ERROR',
                summary: `turn ended with unhandled reason kind: ${reason.kind}`,
              }),
            )
        }
      },
    }
    const owner = await SessionOwner.create(ctx, spec, { artifact, approval }, events, log)
    emit(frameOf('runtime.ready', { runId, dshSessionId }))
    return new RuntimeBridge(ctx, owner, approval, spec, log)
  }

  /** 处理 initialize 之后的 wire 命令（03 §7.1 → DSH 公开 interface）。 */
  async handleCommand(command: RuntimeCommand): Promise<void> {
    if (command.type === 'runtime.shutdown') {
      await this.dispose()
      return
    }
    if (this.disposed) {
      throw new ProtocolError('VALIDATION_FAILED', `command ${command.type} after runtime shutdown`)
    }
    switch (command.type) {
      case 'run.prompt':
      case 'run.followup':
        this.owner.followup(command.payload.text)
        return
      case 'run.cancel':
        this.owner.cancel(command.payload.cause)
        return
      case 'approval.decide':
        this.approval.decide(command.payload.callId, command.payload.decision)
        return
      case 'runtime.initialize':
        throw new ProtocolError('VALIDATION_FAILED', 'duplicate runtime.initialize')
    }
  }

  /**
   * 收敛本次 Run 并拆树：审批全部撤回 → owner dispose（cancel→flush→agent
   * dispose）→ Cordis 根 fiber dispose。幂等；阶段错误聚合后在收敛完成时抛出。
   */
  async dispose(): Promise<void> {
    if (this.disposed) return
    this.disposed = true
    this.approval.cancelAll()
    let firstError: unknown
    const stage = async (name: string, run: () => Promise<unknown>) => {
      try {
        await run()
      } catch (error) {
        firstError ??= error
        this.log({
          level: 'error',
          component: 'runtime.bridge',
          msg: `dispose stage failed: ${name}`,
          error: error instanceof Error ? error.message : String(error),
        })
      }
    }
    await stage('session owner', () => this.owner.dispose())
    await stage('cordis tree', () => this.ctx.fiber.dispose())
    this.log({
      level: 'info',
      component: 'runtime.bridge',
      msg: 'runtime disposed',
      runId: this.spec.runId,
    })
    if (firstError !== undefined) throw firstError
  }
}

export interface RuntimeBridgeSlot {
  current: RuntimeBridge | undefined
}

/**
 * wire 命令的统一分发面（bin 与探针 harness 共用，六原语 #1 同一条路径）：
 * 首帧必须 runtime.initialize；重复 initialize 与未初始化命令 fail-closed。
 */
export async function dispatchRuntimeCommand(
  slot: RuntimeBridgeSlot,
  command: RuntimeCommand,
  options: RuntimeBridgeOptions,
): Promise<void> {
  if (command.type === 'runtime.initialize') {
    if (slot.current !== undefined) {
      throw new ProtocolError('VALIDATION_FAILED', 'duplicate runtime.initialize')
    }
    slot.current = await RuntimeBridge.start(runtimeSpecFromInitialize(command), options)
    return
  }
  const bridge = slot.current
  if (bridge === undefined) {
    throw new ProtocolError(
      'VALIDATION_FAILED',
      `command ${command.type} before runtime.initialize`,
    )
  }
  await bridge.handleCommand(command)
}
