/**
 * Q3 契约探针 harness：无密钥 replay 运行时（02-第一阶段实施计划.md Task 11 Step 1）。
 *
 * `startReplayRuntime` 以 `@deepseek-ai/dsh-llm-replay` overlay（config/replay.yml）
 * 启动真 RuntimeBridge —— 探针走与生产相同的 boot/bridge 路径，仅 LLM 出口被
 * replay adapter 替换（fixture: tests/dsh-contract/fixtures/<scenario>/）。
 * 任何探针都不访问外部模型或密钥。
 */
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomUUID } from 'node:crypto'
import {
  RuntimeBridge,
  dispatchRuntimeCommand,
  type RuntimeBridgeOptions,
  type RuntimeSpec,
} from '../../../src/index.js'
import type { RuntimeCommand, RuntimeOutput } from '@whalepod/protocol'

export type ReplayScenario =
  | 'basic'
  | 'tool-approval'
  | 'cancel'
  | 'unmodified-plugin'
  // #176 切片① resume 探针：第一阶段（resume）与续跑阶段（resume-continue）各一份脚本。
  // 第二阶段脚本里的 assistant 文本带 `{{fromRequest:<pattern>}}` 占位符，只有**上下文里
  // 真有第一阶段那句话**才解析得出（pattern 匹配不到即硬失败）——这就是"接上了"的机器判据。
  | 'resume'
  | 'resume-continue'

const CONFIG_DIR = fileURLToPath(new URL('../../../config/', import.meta.url))
const FIXTURES_DIR = fileURLToPath(new URL('../fixtures/', import.meta.url))

/**
 * 探针用 RuntimeSpec（02 Step 1 的 runtimeSpec()）：replay provider，占位 digest。
 *
 * #177 R5：**被 overrides 覆盖的目录不再预先创建**。此前无条件 mkdtemp 再被 overrides
 * 覆盖，会给"复用既有 workspace / DSH_HOME"的探针（resume 多轮续跑）每次白造 2 个
 * 没人认领的孤儿临时目录（评审实测每次运行净留 14 个）。现在只有真正会被用到的目录
 * 才创建，且都在 spec 里、由 harness 的 tempDirs 负责回收。
 */
export function runtimeSpec(overrides: Partial<RuntimeSpec> = {}): RuntimeSpec {
  const workspacePath = overrides.workspacePath ?? mkdtempSync(join(tmpdir(), 'whalepod-probe-ws-'))
  // 注意（#177 R5 评审提醒）：**自带 workspacePath 的调用方不会拿到 out/report.md 脚手架**。
  // 这是有意为之——复用既有 workspace 的探针（resume 多轮）不该被注入新文件；新调用方若要
  // 走 publish_artifact 探针，得自己准备候选文件。
  if (overrides.workspacePath === undefined) {
    // P1-15：桥内 publish_artifact 校验已接线（realpath/边界/size）——探针里
    // publish_artifact('out/report.md') 的候选必须是工作区内真实存在的文件，
    // 否则工具以失败结果回给模型、replay 循环重试直到超时。
    mkdirSync(join(workspacePath, 'out'), { recursive: true })
    writeFileSync(join(workspacePath, 'out', 'report.md'), '# probe report\n')
  }
  return {
    runId: randomUUID(),
    workspacePath,
    dshHomePath: overrides.dshHomePath ?? mkdtempSync(join(tmpdir(), 'whalepod-probe-home-')),
    // profile/plugin-pack digest 由 P1-17 真实接线；探针阶段为 wire 占位（schema 要求 64 hex）。
    profileDigest: '0'.repeat(64),
    pluginPackDigest: '0'.repeat(64),
    provider: 'replay',
    model: 'replay-model',
    persona: 'You are a contract-probe agent for whalepod.',
    ...overrides,
  }
}

export function commandFrame<T extends RuntimeCommand['type']>(
  type: T,
  payload: Extract<RuntimeCommand, { type: T }>['payload'],
): RuntimeCommand {
  return {
    protocolVersion: 1,
    messageId: randomUUID(),
    sentAt: new Date().toISOString(),
    type,
    payload,
  } as RuntimeCommand
}

export function initializeCommand(spec: RuntimeSpec): RuntimeCommand {
  // RuntimeSpec 的 artifactInputs 是 readonly（spec 是只读事实），wire 载荷要可变数组。
  // 先解构摘掉这个键、再按需放回副本：否则 TS 会把两处 spread 的该属性并成
  // 「readonly 数组 或 可变数组」而仍不兼容（#178 纳入 tests typecheck 后暴露）。
  const { artifactInputs, ...rest } = spec
  return commandFrame('runtime.initialize', {
    ...rest,
    ...(artifactInputs !== undefined ? { artifactInputs: [...artifactInputs] } : {}),
  })
}

export interface ProbeRuntime {
  /** 与 Node 相同的命令入口（runtime.initialize 为首帧）。 */
  send(command: RuntimeCommand): Promise<void>
  /** 按读指针取下一帧 output（02 Step 1 的 runtime.next()）。 */
  next(): Promise<RuntimeOutput>
  /**
   * 等到一帧匹配 type（与可选 predicate）的 output；已到帧幂等命中，
   * 未到的帧挂起等待。其间的帧全部留在 outputs 里供断言。
   */
  until<T extends RuntimeOutput['type']>(
    type: T,
    predicate?: (frame: Extract<RuntimeOutput, { type: T }>) => boolean,
  ): Promise<Extract<RuntimeOutput, { type: T }>>
  /** 到目前收到的全部 output 帧。 */
  readonly outputs: readonly RuntimeOutput[]
  /** bridge 结构化日志（stderr 通道）记录。 */
  readonly logs: readonly Record<string, unknown>[]
  readonly spec: RuntimeSpec
  dispose(): Promise<void>
}

const FRAME_TIMEOUT_MS = 90_000

/**
 * 帧等待者。`T` 就是调用方谓词的窄化结果：`predicate` 负责判定、`resolve` 只接 `T`
 * ——两者由同一个类型参数绑定，这样 `emit` 里传 `output`、`waitForFrame` 里传 `frame`
 * 都不需要 cast（#178 评审 O1：原先唯一的 `as T` 虽安全，但绑不住契约）。
 */
interface FrameWaiter {
  predicate: (frame: RuntimeOutput) => boolean
  resolve: (frame: RuntimeOutput) => void
  timer: NodeJS.Timeout
}

/**
 * 启动 replay 探针运行时：备好隔离 DSH_HOME/Workspace 与 replay fixture 环境，
 * 返回命令/帧驱动面。`send(initializeCommand(spec))` 触发真正的 boot。
 */
export interface ReplayRuntimeOptions {
  /**
   * **探针专用**（#176 切片①）：把本 Run 改成对既有会话的 persisted load
   * （`RuntimeBridgeOptions.probeResumeSessionId`）。用于 resume 探针的第二阶段。
   */
  probeResumeSessionId?: string
  /**
   * 保留临时目录（默认删除）。resume 探针需要跨阶段复用同一个 DSH_HOME 与
   * Workspace——会话日志就躺在 DSH_HOME 里，删了就没得续。
   */
  keepTempDirs?: boolean
}

export async function startReplayRuntime(
  scenario: ReplayScenario,
  spec: RuntimeSpec = runtimeSpec(),
  probeOptions: ReplayRuntimeOptions = {},
): Promise<ProbeRuntime> {
  const fixtureDir = join(FIXTURES_DIR, scenario)
  process.env.DSH_SNAPSHOT_FILE = join(fixtureDir, 'session.jsonl')
  const overrideFile = join(fixtureDir, 'replay.override.json')
  if (existsSync(overrideFile)) {
    process.env.DSH_SNAPSHOT_OVERRIDE = overrideFile
  } else {
    delete process.env.DSH_SNAPSHOT_OVERRIDE
  }

  const outputs: RuntimeOutput[] = []
  const logs: Record<string, unknown>[] = []
  const waiters: FrameWaiter[] = []
  let cursor = 0
  let disposed = false

  const emit: RuntimeBridgeOptions['emit'] = (output) => {
    outputs.push(output)
    for (let i = waiters.length - 1; i >= 0; i--) {
      const waiter = waiters[i]
      if (waiter && waiter.predicate(output)) {
        clearTimeout(waiter.timer)
        waiters.splice(i, 1)
        waiter.resolve(output)
      }
    }
  }

  const options: RuntimeBridgeOptions = {
    emit,
    log: (record) => {
      logs.push(record)
    },
    extraPatchFiles: [join(CONFIG_DIR, 'replay.yml')],
    ...(probeOptions.probeResumeSessionId === undefined
      ? {}
      : { probeResumeSessionId: probeOptions.probeResumeSessionId }),
  }

  const slot: { current: RuntimeBridge | undefined } = { current: undefined }
  const tempDirs = [spec.workspacePath, spec.dshHomePath]

  /**
   * 等一帧满足谓词的 output。`T` 的收窄**只发生在这一处**：谓词是类型守卫，settle 在
   * 守卫通过的同一分支里被调用，因此不需要任何 `as`（#178 评审 O1）。
   * 跨条目的存储用 `FrameWaiter`（吃 RuntimeOutput），避免异构数组的方差问题。
   */
  const waitForFrame = <T extends RuntimeOutput>(
    predicate: (frame: RuntimeOutput) => frame is T,
    label: string,
  ): Promise<T> => {
    let settle: (frame: T) => void = () => {}
    const pending = new Promise<T>((resolve, reject) => {
      settle = (frame) => resolve(frame)
      const timer = setTimeout(() => {
        const index = waiters.findIndex((waiter) => waiter.timer === timer)
        if (index >= 0) waiters.splice(index, 1)
        reject(
          new Error(
            `probe harness: timed out waiting for ${label}; received: ${
              outputs.map((frame) => frame.type).join(',') || '(none)'
            }`,
          ),
        )
      }, FRAME_TIMEOUT_MS)
      waiters.push({
        predicate: predicate as (frame: RuntimeOutput) => boolean,
        resolve: (frame: RuntimeOutput) => {
          if (predicate(frame)) settle(frame)
        },
        timer,
      })
    })
    return pending
  }

  return {
    async send(command) {
      if (disposed) throw new Error('probe harness: send after dispose')
      await dispatchRuntimeCommand(slot, command, options)
    },
    async next() {
      const index = cursor
      cursor += 1
      const existing = outputs[index]
      if (existing) return existing
      return waitForFrame(
        (frame): frame is RuntimeOutput =>
          outputs[outputs.length - 1] === frame && outputs.length > index,
        `frame #${index + 1}`,
      ).then(() => {
        const frame = outputs[index]
        if (!frame) throw new Error(`probe harness: frame #${index + 1} disappeared`)
        return frame
      })
    },
    until(type, predicate) {
      const matches = (
        frame: RuntimeOutput,
      ): frame is Extract<RuntimeOutput, { type: typeof type }> =>
        frame.type === type &&
        (predicate === undefined ||
          predicate(frame as Extract<RuntimeOutput, { type: typeof type }>))
      const existing = outputs.find(matches)
      if (existing) return Promise.resolve(existing)
      return waitForFrame(matches, `output type ${type}`)
    },
    get outputs() {
      return outputs
    },
    get logs() {
      return logs
    },
    spec,
    async dispose() {
      disposed = true
      for (const waiter of waiters.splice(0)) clearTimeout(waiter.timer)
      await slot.current?.dispose()
      slot.current = undefined
      if (probeOptions.keepTempDirs !== true) {
        for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true })
      }
    },
  }
}
