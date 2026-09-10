/**
 * RuntimeDriver（P1-12；02 Task 12 Files: runtime-driver.ts）。
 *
 * 驱动「一个 DSH Runtime 子进程」的生命周期；supervisor 只依赖本接口，
 * 测试注入可替换实现（进程隔离与恢复判据不绑定具体 Runtime）。
 * 生产实现 DshRuntimeDriver：`node <runtimeEntry> --run-id <id> --nonce <nonce>`，
 * cmdline 参数是 Node 重启后孤儿探测的三重匹配判据之一（Step 6）。
 */
import { spawn } from 'node:child_process'
import { RuntimeCommandSchema, type RuntimeCommand } from '@whalepod/protocol'

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
  /**
   * 取消：对进程组发 SIGTERM（driver 实现负责升级策略）。
   * forceKill（P1-16，可选）：SIGKILL 进程组——取消升级链路的最后一跳；
   * 未实现的 driver 退化为 terminate。
   */
  terminate(handle: RuntimeHandle): Promise<void>
  forceKill?(handle: RuntimeHandle): Promise<void>
}

export interface DshRuntimeDriverOptions {
  /** DSH Runtime 入口脚本绝对路径（部署时定位；P1-11 的 runtime-bridge 产物）。 */
  readonly runtimeEntry: string
  /**
   * node 自身参数（加载器等，置于入口前）。生产空数组跑 dist 产物；
   * 验收链路用 ['--import', 'tsx'] 直跑 TS 源（与 Q3 stdio 探针同形态）。
   */
  readonly nodeArgs?: readonly string[]
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
        ...(this.options.nodeArgs ?? []),
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
    // #107：对已死子进程 stdin 的写失败有两条腿，都必须归因且不掀宿主——
    // ① 猝死 + 管道积压 ⟹ 流级 EPIPE error 事件（无监听 = uncaughtException，
    //    CI Q2 实录杀宿主）；② 干净退出被本端感知后 ⟹ 流已销毁，write 只经
    //    回调报 ERR_STREAM_DESTROYED，不再发 error 事件。两腿归并一次留证
    //    （Run 收敛由 onExit → exit-classifier 的 RUNTIME_LOST 路径承担；
    //    评审 F1 销账：本注释曾引用全仓不存在的 runtime_crashed 幽灵词）。
    let stdinFailureAttributed = false
    const attributeStdinFailure = (error: unknown): void => {
      if (stdinFailureAttributed) return
      stdinFailureAttributed = true
      ctx.onStderr(
        `[runtime-driver] stdin 写失败（Runtime 已退出？）：${error instanceof Error ? error.message : String(error)}\n`,
      )
    }
    child.stdin?.on('error', attributeStdinFailure)
    const exitPromise = new Promise<void>((resolve) => {
      child.once('exit', (code, signal) => {
        ctx.onExit(code, signal)
        resolve()
      })
    })
    const send = (command: RuntimeCommand): void => {
      // 写出前过 schema：非法命令帧绝不进入 Runtime（§11 fail-closed 对称侧）。
      const line = `${JSON.stringify(RuntimeCommandSchema.parse(command))}\n`
      // #107 腿②（已销毁流的回调报错）+ 同步形态（ERR_STREAM_DESTROYED 同步抛出）
      // 同源兜底。doc 承诺的「stdin 已关闭时静默丢弃」含归因留证——竞态常态，
      // 但不是无迹可寻。
      try {
        child.stdin?.write(line, (error?: Error | null) => {
          if (error != null) attributeStdinFailure(error)
        })
      } catch (error) {
        attributeStdinFailure(error)
      }
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

  /** P1-16：SIGKILL 进程组——SIGTERM 宽限到期后的最后一跳（G7-02）。 */
  async forceKill(handle: RuntimeHandle): Promise<void> {
    try {
      if (process.platform !== 'win32') {
        process.kill(-handle.pid, 'SIGKILL')
      } else {
        process.kill(handle.pid, 'SIGKILL')
      }
    } catch {
      // 已退出：ESRCH 视为成功。
    }
  }
}
