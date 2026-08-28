/**
 * RuntimeSupervisor（P1-12；02 Task 12 Step 5/6、G3-05、R5/R8）。
 *
 * 每 Run 一个独立 Runtime 子进程（detached 进程组）：
 * - start：容量检查（默认 2，超出 NODE_CAPACITY_REACHED）→ workspace preflight
 *   （WORKSPACE_UNAVAILABLE）→ 环境白名单构建（MODEL_CREDENTIAL_UNAVAILABLE）→
 *   spawn → 事务落 active_runtime（pid/启动时间/pgid/nonce）；
 * - stderr 只保留末尾 8KiB；
 * - 超时回收：超过 runtimeTimeoutMs 的 Runtime 被终止并上报 runtime_timeout；
 * - recoverOrphans：Node 重启后三重匹配（pid/启动时间/cmdline nonce）才终止进程组，
 *   任何不匹配绝不发信号；处理后上报 RUNTIME_LOST（orphaned_after_node_restart）。
 */
import { DatabaseSync } from 'node:sqlite'
import { randomUUID } from 'node:crypto'
import type { RuntimeDriver, RuntimeHandle, RuntimeStartSpec } from '../runtime-driver.js'
import type { RuntimeCommand } from '@project311/protocol'
import type { SecretStore } from '../secret/store.js'
import type { WorkspaceRegistry } from '../workspace/registry.js'
import { buildRuntimeEnvironment, RuntimeEnvError } from './environment.js'
import { StderrTail } from './stderr-tail.js'
import { killProcessGroup, probeOrphan, processStartTime } from './process.js'

export class SupervisorError extends Error {
  constructor(
    readonly code: 'NODE_CAPACITY_REACHED' | 'WORKSPACE_UNAVAILABLE',
    message: string,
  ) {
    super(message)
    this.name = 'SupervisorError'
  }
}

export interface RuntimeLostEvent {
  readonly runId: string
  readonly reason: 'runtime_timeout' | 'orphaned_after_node_restart'
}

export interface ActiveRuntimeRecord {
  readonly runId: string
  readonly pid: number
  readonly runtimeNonce: string
  readonly startedAt: string
}

interface SupervisorDeps {
  readonly driver: RuntimeDriver
  readonly registry: WorkspaceRegistry
  readonly secrets: SecretStore
  readonly stateDbPath: string
  readonly capacity: number
  readonly runtimeTimeoutMs: number
  /** Node 自身环境（scrub 的输入源）；测试注入用。 */
  readonly processEnv?: NodeJS.ProcessEnv
  /** P1-13：stdout 行路由（会话层投影/落 spool）；缺省丢弃。 */
  readonly onStdoutLine?: (runId: string, line: string) => void
  /**
   * 额外透传给 Runtime 的环境变量名白名单（默认 []；仅验收/replay 链路用，
   * 见 environment.ts 注释）。生产 cli 不设置。
   */
  readonly runtimeEnvPassthrough?: readonly string[]
}

interface ActiveRow {
  run_id: string
  pid: number
  process_start_time: string
  pgid: number
  runtime_nonce: string
  workspace_id: string
  started_at: string
  stderr_tail: string | null
}

export class RuntimeSupervisor {
  private readonly db: DatabaseSync
  private readonly handles = new Map<string, { handle: RuntimeHandle; timer?: NodeJS.Timeout }>()
  private readonly lostHandlers: Array<
    (runId: string, reason: RuntimeLostEvent['reason']) => void
  > = []

  constructor(private readonly deps: SupervisorDeps) {
    this.db = new DatabaseSync(deps.stateDbPath)
    this.db.exec('pragma journal_mode = WAL')
    this.db.exec('pragma synchronous = FULL')
    this.db.exec(`
      create table if not exists active_runtime (
        run_id text primary key,
        pid integer not null,
        process_start_time text not null,
        pgid integer not null,
        runtime_nonce text not null,
        workspace_id text not null,
        started_at text not null,
        stderr_tail text
      )
    `)
  }

  onLost(handler: (runId: string, reason: RuntimeLostEvent['reason']) => void): void {
    this.lostHandlers.push(handler)
  }

  private emitLost(runId: string, reason: RuntimeLostEvent['reason']): void {
    for (const handler of this.lostHandlers) handler(runId, reason)
  }

  async start(spec: RuntimeStartSpec, ctx: { workspaceId: string }): Promise<{ pid: number }> {
    if (this.handles.size >= this.deps.capacity) {
      throw new SupervisorError('NODE_CAPACITY_REACHED', 'runtime capacity reached')
    }
    let workspacePath: string
    try {
      workspacePath = await this.deps.registry.resolve(ctx.workspaceId)
    } catch {
      throw new SupervisorError('WORKSPACE_UNAVAILABLE', 'workspace preflight failed')
    }
    // 环境白名单 + 凭据解析（缺失即抛，spawn 前失败）。
    const env = buildRuntimeEnvironment(spec, {
      workspacePath,
      secrets: this.deps.secrets,
      processEnv: this.deps.processEnv ?? process.env,
      extraPassthrough: this.deps.runtimeEnvPassthrough ?? [],
    })

    const tails = new Map<string, StderrTail>()
    const handle = await this.deps.driver.spawn(spec, {
      cwd: workspacePath,
      env,
      onStdout: (line) => {
        // P1-13：会话层投影管线（projector → spool → Hub）经 deps 注入。
        this.deps.onStdoutLine?.(spec.runId, line)
      },
      onStderr: (chunk) => {
        const tail = tails.get(spec.runId) ?? new StderrTail()
        tail.push(chunk)
        tails.set(spec.runId, tail)
      },
      onExit: (code, signal) => {
        this.finalize(spec.runId, code, signal, tails.get(spec.runId))
      },
    })

    const processStart = (await processStartTime(handle.pid)) ?? ''
    const pgid = process.platform !== 'win32' ? handle.pid : handle.pid
    this.db
      .prepare(
        'insert into active_runtime (run_id, pid, process_start_time, pgid, runtime_nonce, workspace_id, started_at, stderr_tail) values (?, ?, ?, ?, ?, ?, ?, ?)',
      )
      .run(
        spec.runId,
        handle.pid,
        processStart,
        pgid,
        spec.nonce,
        ctx.workspaceId,
        new Date().toISOString(),
        null,
      )
    const timer = setTimeout(() => {
      void this.reclaimTimeout(spec.runId)
    }, this.deps.runtimeTimeoutMs)
    this.handles.set(spec.runId, { handle, timer })
    return { pid: handle.pid }
  }

  private finalize(
    runId: string,
    _code: number | null,
    _signal: string | null,
    tail?: StderrTail,
  ): void {
    const entry = this.handles.get(runId)
    if (entry?.timer !== undefined) clearTimeout(entry.timer)
    this.handles.delete(runId)
    // 活跃表只反映存活 Runtime；终态经 lost 事件上报（stderr tail 随 P1-13 投影带出）。
    this.db.prepare('delete from active_runtime where run_id = ?').run(runId)
  }

  /** 超时回收：wall-clock 超限 → 终止 + 上报 runtime_timeout。 */
  private async reclaimTimeout(runId: string): Promise<void> {
    const entry = this.handles.get(runId)
    if (entry === undefined) return
    await this.deps.driver.terminate(entry.handle)
    await entry.handle.exitPromise
    // finalize 可能已由 onExit 先行移除 handle；上报与句柄表解耦。
    this.emitLost(runId, 'runtime_timeout')
  }

  async cancel(runId: string): Promise<void> {
    const entry = this.handles.get(runId)
    if (entry !== undefined) {
      await this.deps.driver.terminate(entry.handle)
      await entry.handle.exitPromise
    }
  }

  /** 该 run 的 Runtime 当前是否在管（P1-13 重复 run.start 的 R7 判定）。 */
  isActive(runId: string): boolean {
    return this.handles.has(runId)
  }

  /** 在管 Runtime 的 runId 列表（心跳 activeRunIds 上报用）。 */
  activeRunIds(): string[] {
    return [...this.handles.keys()]
  }

  /**
   * P1-13：向在管 Runtime 的 stdin 派发命令帧（initialize/prompt/cancel/
   * approval.decide）。run 不在管或 driver 未实现 stdin 时返回 false。
   */
  dispatchToRuntime(runId: string, command: RuntimeCommand): boolean {
    const entry = this.handles.get(runId)
    if (entry?.handle.send === undefined) return false
    entry.handle.send(command)
    return true
  }

  async activeRuns(): Promise<ActiveRuntimeRecord[]> {
    const rows = this.db
      .prepare(
        'select run_id, pid, runtime_nonce, started_at from active_runtime order by started_at asc',
      )
      .all() as unknown as Array<{
      run_id: string
      pid: number
      runtime_nonce: string
      started_at: string
    }>
    return rows.map((row) => ({
      runId: row.run_id,
      pid: row.pid,
      runtimeNonce: row.runtime_nonce,
      startedAt: row.started_at,
    }))
  }

  /**
   * Node 重启恢复：逐条记录三重匹配探测——
   * matched → 终止进程组 + 上报 orphaned_after_node_restart；
   * dead / mismatch → 绝不发信号；记录一律移除（交人工重跑，不自动复活 Run）。
   */
  async recoverOrphans(): Promise<void> {
    const rows = this.db.prepare('select * from active_runtime').all() as unknown as ActiveRow[]
    for (const row of rows) {
      const verdict = await probeOrphan({
        pid: row.pid,
        processStartTime: row.process_start_time,
        runId: row.run_id,
        runtimeNonce: row.runtime_nonce,
      })
      console.error('RECOVER_VERDICT', row.run_id, verdict, row.runtime_nonce)
      if (verdict === 'matched') {
        await killProcessGroup(row.pid, 'SIGTERM')
        await killProcessGroup(row.pid, 'SIGKILL')
      }
      this.db.prepare('delete from active_runtime where run_id = ?').run(row.run_id)
      this.emitLost(row.run_id, 'orphaned_after_node_restart')
    }
  }

  /** 优雅停机：终止本实例管理的全部 Runtime（不影响恢复流程语义）。 */
  async stopAll(): Promise<void> {
    for (const [runId, entry] of [...this.handles.entries()]) {
      if (entry.timer !== undefined) clearTimeout(entry.timer)
      await this.deps.driver.terminate(entry.handle)
      this.handles.delete(runId)
    }
  }

  close(): void {
    this.db.close()
  }
}

/** runtime nonce 工厂（组合根生成并持久化到 spool intent）。 */
export function newRuntimeNonce(): string {
  return randomUUID()
}
