/**
 * RuntimeDriver（P1-12；02 Task 12 Files: runtime-driver.ts）。
 *
 * 驱动「一个 DSH Runtime 子进程」的生命周期；supervisor 只依赖本接口，
 * 测试注入可替换实现（进程隔离与恢复判据不绑定具体 Runtime）。
 * 生产实现 DshRuntimeDriver：`node <runtimeEntry> --run-id <id> --nonce <nonce>`，
 * cmdline 参数是 Node 重启后孤儿探测的三重匹配判据之一（Step 6）。
 */
import { spawn } from 'node:child_process'
import { RuntimeCommandSchema, type RuntimeCommand } from '@project311/protocol'

export interface RuntimeStartSpec {
  readonly runId: string
  /** 随机 nonce：Node 重启后用 cmdline 匹配防误杀无关进程。 */
  readonly nonce: string
  readonly workspaceId: string
  readonly prompt: string
  readonly agent: {
    readonly id: string
    readonly profileRevisionId: string
    readonly persona: string
    readonly provider: string
    readonly model: string
    readonly credentialSlot: string
    readonly maxTokens?: number
  }
  readonly expectedProfileDigest: string
  readonly expectedPluginPackDigest: string
}

export interface RuntimeSpawnContext {
  readonly cwd: string
  readonly env: NodeJS.ProcessEnv
}

export interface RuntimeHandle {
  readonly pid: number
  /** 进程退出 promise（测试与 supervisor 等待用）。 */
  readonly exitPromise?: Promise<void>
  /**
   * P1-13：向 Runtime stdin 写一帧命令（NDJSON）。帧写出前过
   * RuntimeCommandSchema（fail-closed 双向纪律）；子进程 stdin 已关闭时静默
   * 丢弃（与迟到 decide 同构——竞态常态，不是错误）。
   */
  readonly send?: (command: RuntimeCommand) => void
}

export interface RuntimeDriver {
  spawn(
    spec: RuntimeStartSpec,
    ctx: RuntimeSpawnContext & {
      onStdout: (line: string) => void
      onStderr: (chunk: string) => void
      onExit: (code: number | null, signal: string | null) => void
    },
  ): Promise<RuntimeHandle>
  /** 取消：对进程组发 SIGTERM（driver 实现负责升级策略）。 */
  terminate(handle: RuntimeHandle): Promise<void>
}

export interface DshRuntimeDriverOptions {
  /** DSH Runtime 入口脚本绝对路径（部署时定位；P1-11 的 runtime-bridge 产物）。 */
  readonly runtimeEntry: string
}

export class DshRuntimeDriver implements RuntimeDriver {
  constructor(private readonly options: DshRuntimeDriverOptions) {}

  async spawn(
    spec: RuntimeStartSpec,
    ctx: RuntimeSpawnContext & {
      onStdout: (line: string) => void
      onStderr: (chunk: string) => void
      onExit: (code: number | null, signal: string | null) => void
    },
  ): Promise<RuntimeHandle> {
    // detached：独立进程组，supervisor 可对整组发信号（02 Task 12 Step 5）。
    const child = spawn(
      process.execPath,
      [
        this.options.runtimeEntry,
        // `--` 之后的参数归 Runtime 的 process.argv，避免被 node CLI 解析（bad option 退出 9）。
        '--',
        '--run-id',
        spec.runId,
        '--nonce',
        spec.nonce,
        '--prompt-stdin',
      ],
      {
        cwd: ctx.cwd,
        env: ctx.env,
        stdio: ['pipe', 'pipe', 'pipe'],
        detached: process.platform !== 'win32',
      },
    )
    child.stdout?.setEncoding('utf8')
    child.stdout?.on('data', (chunk: string) => {
      for (const line of chunk.split('\n')) {
        if (line.trim() !== '') ctx.onStdout(line)
      }
    })
    child.stderr?.setEncoding('utf8')
    child.stderr?.on('data', (chunk: string) => ctx.onStderr(chunk))
    const exitPromise = new Promise<void>((resolve) => {
      child.once('exit', (code, signal) => {
        ctx.onExit(code, signal)
        resolve()
      })
    })
    const send = (command: RuntimeCommand): void => {
      // 写出前过 schema：非法命令帧绝不进入 Runtime（§11 fail-closed 对称侧）。
      const line = `${JSON.stringify(RuntimeCommandSchema.parse(command))}\n`
      child.stdin?.write(line, () => {})
    }
    return { pid: child.pid ?? -1, exitPromise, send }
  }

  async terminate(handle: RuntimeHandle): Promise<void> {
    // 进程组整体 SIGTERM；升级策略（SIGKILL）由 supervisor 超时控制。
    try {
      if (process.platform !== 'win32') {
        process.kill(-handle.pid, 'SIGTERM')
      } else {
        process.kill(handle.pid, 'SIGTERM')
      }
    } catch {
      // 已退出：ESRCH 视为成功。
    }
  }
}
