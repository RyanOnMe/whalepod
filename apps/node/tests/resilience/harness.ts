/**
 * Q6 故障门共享 harness（P1-16；apps/node resilience specs）。
 *
 * 提供两类真人路径探针：
 * - ScriptedRuntimeDriver：纯内存 fake Runtime，测试脚本化注入 cancel 服从性、
 *   退出码/信号与 stdout 帧；terminate/forceKill 记录调用并按脚本派发退出
 *   （vitest forks 池里真实子进程 exit 事件可靠，但 fake 让计时确定性可控）。
 * - RealProcessDriver：真实 node 子进程（detached 进程组，cmdline 带
 *   --run-id/--nonce，与生产 DshRuntimeDriver 同形）——强杀/孤儿用 liveness
 *   探针（process.kill(pid,0)）断言，不做接口背后的暗手。
 *
 * ManualTimers：手动推进的 setTimeout/clearTimeout，供 RunManager 取消升级
 * （15s 确认窗口 / 5s SIGTERM 宽限）的确定性驱动。
 */
import { spawn } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import { mkdtemp, mkdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { NodeDownstream, ProjectedRunEvent, RuntimeCommand } from '@project311/protocol'
import { CommandStore } from '../../src/spool/command-store.js'
import { EventStore } from '../../src/spool/event-store.js'
import { SecretStore } from '../../src/secret/store.js'
import { WorkspaceRegistry } from '../../src/workspace/registry.js'
import { RuntimeSupervisor } from '../../src/supervisor/runtime-supervisor.js'
import { RunManager } from '../../src/run/run-manager.js'
import type { RuntimeDriver, RuntimeHandle, RuntimeStartSpec } from '../../src/runtime-driver.js'

// ---------- ManualTimers ----------

export class ManualTimers {
  private seq = 0
  private readonly tasks = new Map<number, { at: number; fn: () => void }>()
  private nowMs = 0

  readonly setTimeout = (fn: () => void, ms: number): ReturnType<typeof setTimeout> => {
    this.seq += 1
    this.tasks.set(this.seq, { at: this.nowMs + ms, fn })
    return this.seq as unknown as ReturnType<typeof setTimeout>
  }

  readonly clearTimeout = (id: ReturnType<typeof setTimeout>): void => {
    this.tasks.delete(id as unknown as number)
  }

  /** 推进时钟并触发所有到期回调（按到期顺序）。 */
  advance(ms: number): void {
    this.nowMs += ms
    const due = [...this.tasks.entries()]
      .filter(([, task]) => task.at <= this.nowMs)
      .sort((a, b) => a[1].at - b[1].at)
    for (const [id, task] of due) {
      this.tasks.delete(id)
      task.fn()
    }
  }

  pendingCount(): number {
    return this.tasks.size
  }
}

// ---------- ScriptedRuntimeDriver ----------

export interface ScriptedRuntime {
  readonly runId: string
  readonly nonce: string
  readonly stdin: RuntimeCommand[]
  /** 注入一条 stdout 协议帧（测试脚本化 Runtime 行为）。 */
  emitStdout: (line: string) => void
  /** 驱动退出：按指定 code/signal 派发 onExit 并 resolve exitPromise。 */
  exitWith: (code: number | null, signal: string | null) => void
}

export interface ScriptedRuntimeBehavior {
  /** terminate（SIGTERM）是否真的终止进程（false = 忽略信号，等 SIGKILL）。 */
  diesOnTerminate: boolean
  /** forceKill（SIGKILL）是否终止进程（测试里应恒 true，除非模拟极端场景）。 */
  diesOnForceKill: boolean
  /** 自派发退出前的延迟 ms（0 = 同步派发）。 */
  exitDelayMs: number
}

const DEFAULT_BEHAVIOR: ScriptedRuntimeBehavior = {
  diesOnTerminate: true,
  diesOnForceKill: true,
  exitDelayMs: 0,
}

export function makeScriptedDriver(behavior: Partial<ScriptedRuntimeBehavior> = {}): {
  driver: RuntimeDriver
  runtimes: ScriptedRuntime[]
  signals: Array<{ runId: string; kind: 'terminate' | 'forceKill' }>
} {
  const resolved = { ...DEFAULT_BEHAVIOR, ...behavior }
  const runtimes: ScriptedRuntime[] = []
  const signals: Array<{ runId: string; kind: 'terminate' | 'forceKill' }> = []
  // pid → 退出派发器（spawn 时注册；terminate/forceKill 按句柄 pid 定位）。
  const exits = new Map<
    number,
    {
      runId: string
      onExit: (code: number | null, signal: string | null) => void
      resolveExit: () => void
    }
  >()

  const driver: RuntimeDriver = {
    async spawn(spec, ctx): Promise<RuntimeHandle> {
      const runtime: ScriptedRuntime = {
        runId: spec.runId,
        nonce: spec.nonce,
        stdin: [],
        emitStdout: (line) => ctx.onStdout(line),
        exitWith: (code, signal) => {
          // 测试直接驱动退出（崩溃注入）。
          for (const exit of exits.values()) {
            if (exit.runId !== spec.runId) continue
            exit.onExit(code, signal)
            exit.resolveExit()
            break
          }
        },
      }
      runtimes.push(runtime)
      return {
        pid: 3_000_000 + runtimes.length,
        exitPromise: new Promise<void>((resolve) => {
          exits.set(3_000_000 + runtimes.length, {
            runId: spec.runId,
            onExit: (code, signal) => ctx.onExit(code, signal),
            resolveExit: resolve,
          })
        }),
        send: (command) => {
          runtime.stdin.push(command)
        },
      }
    },
    async terminate(handle) {
      const exit = exits.get(handle.pid)
      signals.push({ runId: exit?.runId ?? '', kind: 'terminate' })
      if (resolved.diesOnTerminate && exit !== undefined) {
        const dispatch = () => {
          exit.onExit(null, 'SIGTERM')
          exit.resolveExit()
        }
        if (resolved.exitDelayMs === 0) dispatch()
        else setTimeout(dispatch, resolved.exitDelayMs).unref?.()
      }
    },
    async forceKill(handle) {
      const exit = exits.get(handle.pid)
      signals.push({ runId: exit?.runId ?? '', kind: 'forceKill' })
      if (resolved.diesOnForceKill && exit !== undefined) {
        exit.onExit(null, 'SIGKILL')
        exit.resolveExit()
      }
    },
  }
  return { driver, runtimes, signals }
}

// ---------- RunManager harness（scripted） ----------

export interface ResilienceHarness {
  manager: RunManager
  supervisor: RuntimeSupervisor
  eventStore: EventStore
  commandStore: CommandStore
  runtimes: ScriptedRuntime[]
  signals: Array<{ runId: string; kind: 'terminate' | 'forceKill' }>
  sent: string[]
  timers: ManualTimers
  workspaceId: string
  logs: Array<{ level: string; component?: string; msg: string; [key: string]: unknown }>
  sentFrames: () => Array<{ type: string; payload: Record<string, unknown> }>
  runEvents: () => ProjectedRunEvent[]
  /** 收尾：停掉在管 Runtime、关 spool/状态库并删除临时目录。 */
  cleanup: () => Promise<void>
  /** 切换在线状态（离线时上行帧被 session 层丢弃——生产语义）。 */
  setOnline: (online: boolean) => void
}

export const RUN_ID = '11111111-1111-4111-8111-111111111111'
export const COMMAND_ID = '22222222-2222-4222-8222-222222222222'

export function runStartFrame(
  workspaceId: string,
  overrides: Record<string, unknown> = {},
): NodeDownstream {
  return {
    protocolVersion: 1,
    messageId: 'm-1',
    sentAt: new Date().toISOString(),
    type: 'run.start',
    payload: {
      commandId: COMMAND_ID,
      runId: RUN_ID,
      taskId: '33333333-3333-4333-8333-333333333333',
      ownerUserId: '44444444-4444-4444-8444-444444444444',
      agent: {
        id: '55555555-5555-4555-8555-555555555555',
        profileRevisionId: '66666666-6666-4666-8666-666666666666',
        persona: 'test persona',
        provider: 'dsh',
        model: 'test-model',
        credentialSlot: 'api_key',
      },
      workspaceId,
      expectedProfileDigest: 'a'.repeat(64),
      expectedPluginPackDigest: 'b'.repeat(64),
      prompt: 'do the thing',
      ...overrides,
    },
  } as NodeDownstream
}

export function cancelFrame(
  commandId = 'c9c9c9c9-c9c9-4999-8999-c9c9c9c9c9c9',
  cause: 'user' | 'admin' = 'user',
): NodeDownstream {
  return {
    protocolVersion: 1,
    messageId: 'c-frame',
    sentAt: new Date().toISOString(),
    type: 'run.cancel',
    payload: { commandId, runId: RUN_ID, cause },
  } as NodeDownstream
}

export function runtimeReadyLine(runId: string, sessionId = 'session-1'): string {
  return JSON.stringify({
    protocolVersion: 1,
    messageId: '30000000-0000-4000-8000-000000000001',
    sentAt: new Date().toISOString(),
    type: 'runtime.ready',
    payload: { runId, dshSessionId: sessionId },
  })
}

export function runCancelledLine(runId: string): string {
  return JSON.stringify({
    protocolVersion: 1,
    messageId: '30000000-0000-4000-8000-000000000002',
    sentAt: new Date().toISOString(),
    type: 'run.cancelled',
    payload: { runId },
  })
}

export async function makeResilienceHarness(
  options: {
    behavior?: Partial<ScriptedRuntimeBehavior>
    cancelConfirmMs?: number
    cancelTermGraceMs?: number
    timers?: ManualTimers
    online?: boolean
    /** 替换 driver（真人路径强杀探针：真实 node 子进程）。 */
    driverOverride?: RuntimeDriver
  } = {},
): Promise<ResilienceHarness> {
  const root = await mkdtemp(join(tmpdir(), 'p311-resilience-'))
  const workspaceDir = join(root, 'ws')
  await mkdir(workspaceDir, { recursive: true })
  mkdirSync(join(root, 'runtime-home'), { recursive: true })

  let online = options.online ?? true
  const timers = options.timers ?? new ManualTimers()
  const scripted = makeScriptedDriver(options.behavior)
  const driver = options.driverOverride ?? scripted.driver
  // driverOverride（真实进程探针）时 runtimes/signals 为空表——用例改用
  // liveness 探针与 supervisor 日志判定。
  const runtimes = scripted.runtimes
  const signals = scripted.signals
  const registry = new WorkspaceRegistry(join(root, 'registry.db'), 'test-hmac-key')
  const workspace = await registry.register(workspaceDir, { name: 'ws-1' })
  const secrets = new SecretStore(join(root, 'secrets.json'), {
    PROJECT311_DSH_SECRET_DSH_API_KEY: 'sk-test-123',
  })
  const eventStore = new EventStore(join(root, 'events.db'))
  const commandStore = new CommandStore(join(root, 'commands.db'))
  const sent: string[] = []
  const logs: ResilienceHarness['logs'] = []

  const harness: ResilienceHarness = {
    runtimes,
    signals,
    eventStore,
    commandStore,
    sent,
    timers,
    workspaceId: workspace.id,
    logs,
    supervisor: undefined as unknown as RuntimeSupervisor,
    manager: undefined as unknown as RunManager,
    sentFrames: () =>
      sent.map((raw) => JSON.parse(raw) as { type: string; payload: Record<string, unknown> }),
    runEvents: () =>
      sent
        .map((raw) => JSON.parse(raw) as { type: string; payload: unknown })
        .filter((frame) => frame.type === 'run.event')
        .map((frame) => frame.payload as ProjectedRunEvent),
  }

  const supervisor = new RuntimeSupervisor({
    driver,
    registry,
    secrets,
    stateDbPath: join(root, 'supervisor.db'),
    capacity: 2,
    runtimeTimeoutMs: 60_000,
    onStdoutLine: (runId, line) => harness.manager.handleStdoutLine(runId, line),
  })
  const manager = new RunManager({
    supervisor,
    registry,
    commandStore,
    eventStore,
    send: (frame) => {
      if (online) sent.push(frame)
    },
    runtimeHomeFor: (runId) => join(root, 'runtime-home', runId),
    homeDir: '/Users/testhome',
    stateDir: root,
    packsRoot: join(root, 'plugin-packs'),
    deviceId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
    dshDistributionVersion: '0.1.0-rc.8',
    ...(options.cancelConfirmMs !== undefined ? { cancelConfirmMs: options.cancelConfirmMs } : {}),
    ...(options.cancelTermGraceMs !== undefined
      ? { cancelTermGraceMs: options.cancelTermGraceMs }
      : {}),
    ...(options.timers !== undefined
      ? { timers: { setTimeout: timers.setTimeout, clearTimeout: timers.clearTimeout } }
      : {}),
    log: (level, msg, context) => {
      logs.push({ level, component: 'node.run', msg, ...context })
    },
  })
  harness.supervisor = supervisor
  harness.manager = manager
  harness.setOnline = (value: boolean) => {
    online = value
  }
  harness.cleanup = async () => {
    await supervisor.stopAll()
    supervisor.close()
    commandStore.close()
    eventStore.close()
    await rm(root, { recursive: true, force: true })
  }
  return harness
}

// ---------- RealProcessDriver（真人路径强杀探针） ----------

const LONG_SCRIPT = 'setInterval(() => {}, 1000)'
const SIGTERM_IMMUNE_SCRIPT = "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)"

export interface RealDriverOptions {
  /** 进程对 SIGTERM 免疫（等 SIGKILL 升级路径用）。 */
  sigtermImmune?: boolean
}

export function makeRealProcessDriver(options: RealDriverOptions = {}): {
  driver: RuntimeDriver
  pids: number[]
} {
  const pids: number[] = []
  const driver: RuntimeDriver = {
    async spawn(spec: RuntimeStartSpec, ctx): Promise<RuntimeHandle> {
      const child = spawn(
        process.execPath,
        [
          '-e',
          options.sigtermImmune === true ? SIGTERM_IMMUNE_SCRIPT : LONG_SCRIPT,
          '--',
          '--run-id',
          spec.runId,
          '--nonce',
          spec.nonce,
        ],
        { cwd: ctx.cwd, env: ctx.env, stdio: 'ignore', detached: true },
      )
      pids.push(child.pid ?? -1)
      // 契约同生产 DshRuntimeDriver：退出事实必须回调 ctx.onExit（supervisor
      // finalize → exit 事件 → RunManager 归因全靠它）。
      child.once('exit', (code, signal) => ctx.onExit(code, signal))
      return {
        pid: child.pid ?? -1,
        exitPromise: new Promise<void>((resolve) => child.once('exit', () => resolve())),
      }
    },
    async terminate(handle) {
      try {
        process.kill(-handle.pid, 'SIGTERM')
      } catch {
        // 已退出：ESRCH 视为成功。
      }
    },
    async forceKill(handle) {
      try {
        process.kill(-handle.pid, 'SIGKILL')
      } catch {
        // 已退出：ESRCH 视为成功。
      }
    },
  }
  return { driver, pids }
}

export async function alive(pid: number): Promise<boolean> {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

/** 轮询等待进程死亡（deadline 内每 25ms 探一次）。 */
export async function awaitDead(pid: number, deadlineMs = 5_000): Promise<boolean> {
  const deadline = Date.now() + deadlineMs
  for (;;) {
    if (!(await alive(pid))) return true
    if (Date.now() > deadline) return false
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
}
