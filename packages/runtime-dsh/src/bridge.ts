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
import {
  ProtocolError,
  type ErrorCode,
  type RuntimeCommand,
  type RuntimeOutput,
} from '@project311/protocol'
import type { ArtifactPort } from './artifact-tool.js'
import { createWorkspaceArtifactValidator } from './artifact-validation.js'
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
   * 契约探针用它挂 replay overlay（config/replay.yml）。生产不使用本接缝挂
   * Plugin Pack：P1-17 起经审核的 Runtime Plugin Pack 层按 Run 随
   * runtime.initialize 的 `pluginPackOverlayPath`（RuntimeSpec）到达并最后
   * 入栈（见 start/bootDshTree），env/构造参数通道仅留给探针。
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

/**
 * Pack overlay（栈尾 Run 级层）行契约的机器强制（P1-17，PR #54 review M11）。
 *
 * vendor 语义（@deepseek-ai/dsh-app-boot 0.1.0-rc.8 `applyEntryPatches`，
 * lib/index.js 已核实）：patch 行解构出 `{ id, insert, name, ...overrides }`——
 * 带 id 的非 insert 行对既有条目 per-key 覆盖（`target[key] = value`，后层
 * 胜，可改写 config/disabled 等；`name` 只是匹配闸，不是可改字段）；带 id 的
 * insert 行向既有 group 条目追加子条目；不带 id 的 insert 行整表追加且同 id
 * 不去重（两条都会挂载）；id 未命中仅 warn 跳过。pack overlay 在栈尾，一旦
 * 携带 id 定位行即可改写核心条目，一旦 insert 撞既有 id 即可双挂——「overlay
 * 只含 insert 行」「pack 插件 id 与核心/探针 id 空间不相交」由此从约定变为
 * 启动门，fail-closed：
 *
 * - a.（assertPackOverlayInsertOnly）每行必须恰为 `{ insert: [...] }`：
 *   带 id（id 定位 override / group 定位 insert）、缺 insert、insert 之外还
 *   带其他键（vendor insert 分支会静默丢弃，放行会让非契约行混过审计）或
 *   insert 非数组的行一律拒绝；
 * - b.（assertPackInsertIdsFresh）insert 子条目的 id 不得与既有层 patch 行
 *   出现过的 id 重复（dsh-base 核心 / project311 bundle / 探针
 *   extraPatchFiles；group 子树按 vendor buildMap 同形递归收集），pack 内部
 *   重复 id 同拒。config/cordis.yml 是空表（见其头注），栈内条目全部来自
 *   这些层的 insert 行，故该集合即 pack 入栈前已占用的 id 空间。
 *
 * 违例抛 Error——与 loadOverlayPatches/boot 失败同路：start 抛出，bin 转
 * runtime.fatal(RUNTIME_START_FAILED)；消息带 overlay 路径、行号与冲突 id
 * 供归因。校验只作用于 pack overlay 这一层，探针 extraPatchFiles 通道的
 * 既有行为不受约束。
 */

/** 递归收集 entry 列表里的 id（vendor applyEntryPatches buildMap 同形：group 条目下钻 config 数组）。 */
function collectEntryIds(entries: readonly unknown[], into: Set<string>): void {
  for (const entry of entries) {
    if (typeof entry !== 'object' || entry === null) continue
    const record = entry as Record<string, unknown>
    if (typeof record['id'] === 'string') into.add(record['id'])
    if (record['group'] && Array.isArray(record['config'])) {
      collectEntryIds(record['config'], into)
    }
  }
}

/** 收集一层 patch 行出现过的全部 id：id 定位行的 id + insert 子条目的 id。 */
function collectPatchLayerIds(patches: readonly unknown[], into: Set<string>): void {
  for (const patch of patches) {
    if (typeof patch !== 'object' || patch === null) continue
    const record = patch as Record<string, unknown>
    if (typeof record['id'] === 'string') into.add(record['id'])
    if (Array.isArray(record['insert'])) collectEntryIds(record['insert'], into)
  }
}

/** 校验 a：pack overlay 只允许 `{ insert: [...] }` 形态的行（见函数组头注）。 */
function assertPackOverlayInsertOnly(overlayPath: string, patches: readonly unknown[]): void {
  patches.forEach((patch, index) => {
    const where = `pack overlay ${overlayPath} row ${index + 1}`
    const reject = (reason: string): never => {
      throw new Error(`${BIN_NAME}: ${where}: ${reason}; pack overlays may only carry insert rows`)
    }
    if (typeof patch !== 'object' || patch === null || Array.isArray(patch)) {
      reject('patch row is not a mapping')
    }
    const record = patch as Record<string, unknown>
    if ('id' in record) {
      reject(
        `id-targeted row (id: ${String(JSON.stringify(record['id']))}) may rewrite an existing boot entry`,
      )
    }
    if (!('insert' in record)) reject('patch row carries no insert list')
    const extraKeys = Object.keys(record).filter((key) => key !== 'insert')
    if (extraKeys.length > 0) {
      reject(
        `unexpected key(s) ${extraKeys.map((key) => JSON.stringify(key)).join(', ')} beside insert`,
      )
    }
    if (!Array.isArray(record['insert'])) reject('insert is not an array')
  })
}

/** 校验 b：pack insert 的 id 不得撞 boot 栈既有层已占用的 id，pack 内部亦不得重复（见函数组头注）。 */
function assertPackInsertIdsFresh(
  overlayPath: string,
  patches: readonly unknown[],
  earlierLayers: readonly (readonly unknown[])[],
): void {
  const taken = new Set<string>()
  for (const layer of earlierLayers) collectPatchLayerIds(layer, taken)
  patches.forEach((patch, index) => {
    if (typeof patch !== 'object' || patch === null) return
    const record = patch as Record<string, unknown>
    if (!Array.isArray(record['insert'])) return // 校验 a 已保证 insert 形态
    for (const entry of record['insert']) {
      if (typeof entry !== 'object' || entry === null) continue
      const id = (entry as Record<string, unknown>)['id']
      if (typeof id !== 'string') continue
      if (taken.has(id)) {
        throw new Error(
          `${BIN_NAME}: pack overlay ${overlayPath} row ${index + 1}: insert id ${JSON.stringify(
            id,
          )} collides with an existing boot-stack layer id (insert rows are not deduped — both entries would mount); pack plugin ids must not collide with the core/probe id space`,
        )
      }
      taken.add(id)
    }
  })
}

/** 加载 pack overlay 并在入栈前过 a/b 两道校验（任一违例即拒绝启动）。 */
function loadPackOverlay(
  overlayPath: string,
  earlierLayers: readonly (readonly unknown[])[],
): ReturnType<typeof loadOverlayPatches> {
  const patches = loadOverlayPatches(BIN_NAME, overlayPath)
  assertPackOverlayInsertOnly(overlayPath, patches)
  assertPackInsertIdsFresh(overlayPath, patches, earlierLayers)
  return patches
}

/**
 * 组合 Runtime 的 patch 栈：dsh-base 基座 → project311 bundle → 额外层
 * （探针 replay）→ 本 Run 的 Plugin Pack overlay。
 *
 * Pack overlay 置于栈尾（P1-17）：它是唯一随 wire 到达的 Run 级层，栈位在
 * 静态层之后意味着同 id patch「后到者胜」的确定性归它所有——生产运维只能改
 * 进程静态层，approved pack 的行不被它们意外改写。栈尾位同时意味着 vendor
 * 的 per-key 覆盖/不去重语义一旦被滥用只会指向核心条目：pack overlay 不携带
 * id 定位行、不撞既有 id 这两条由 loadPackOverlay 在入栈前 fail-closed 机器
 * 强制（PR #54 review M11，此前只是约定），违例拒绝启动。探针
 * extraPatchFiles 通道不受该行契约约束（replay 层既有行为不变）；overlay
 * 路径不存在时 loadOverlayPatches fail-closed 抛出，与校验违例同样由 start
 * 经 bin 转 runtime.fatal(RUNTIME_START_FAILED)。
 */
async function bootDshTree(
  extraPatchFiles: readonly string[],
  pluginPackOverlayPath: string | undefined,
): Promise<Context> {
  const dshBasePatches = loadOverlayPatches(BIN_NAME, dshBasePatchPath())
  const bundlePatches = loadOverlayPatches(BIN_NAME, join(CONFIG_DIR, 'project311.patch.yml'))
  const probePatches = extraPatchFiles.flatMap((file) => loadOverlayPatches(BIN_NAME, file))
  const earlierLayers = [dshBasePatches, bundlePatches, probePatches]
  const packOverlayPatches =
    pluginPackOverlayPath === undefined ? [] : loadPackOverlay(pluginPackOverlayPath, earlierLayers)
  return boot(
    BIN_NAME,
    join(CONFIG_DIR, 'cordis.yml'),
    [...dshBasePatches, ...bundlePatches, ...probePatches, ...packOverlayPatches],
    undefined,
    dshAnchorUrl(),
  )
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
    // P1-17：spec.pluginPackOverlayPath 是经审核 Plugin Pack 的 Cordis overlay
    // （本地 wire 绝对路径，红线同 workspacePath——只走本地命令帧，不进日志；
    // 这里的结构化日志只带 runId）。
    const ctx = await bootDshTree(options.extraPatchFiles ?? [], spec.pluginPackOverlayPath)
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
    const owner = await SessionOwner.create(
      ctx,
      spec,
      {
        artifact,
        approval,
        // P1-15：publish_artifact 在桥内先过工作区校验（realpath/边界/size），
        // 越界/超限的候选以失败工具结果回给模型，绝不发 artifact.candidate 帧。
        artifactValidator: createWorkspaceArtifactValidator({ workspacePath: spec.workspacePath }),
      },
      events,
      log,
    )
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
