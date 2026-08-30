/**
 * Runtime 退出分类器（P1-16；02-第一阶段实施计划.md Task 16 Step 4）。
 *
 * RuntimeSupervisor 只上报「进程退出了」这一裸事实；把退出归因到 Run 终态的
 * 语义集中在这里（纯函数，单测覆盖每条分支）：
 *
 * - reported ≠ none：Run 已有终态事实（completed/cancelled/failed 上报过），
 *   退出只是进程的尾声——ignore。绝不产生第二份失败投影。
 * - cancelInFlight：run.cancel 已派发但 Runtime 未确认（03 §3.2：15s 未确认
 *   Supervisor 终止）→ cancelled_forced，Run 以 cancelled(forced=true) 收敛。
 * - 其余（非零退出、被信号杀死、干净退出但没有终态帧）→ runtime_lost：
 *   Run 以 failed(RUNTIME_LOST) 收敛（G7-03），不自动重启、不重放副作用工具。
 *
 * 归因纪律：这里不猜「退出是不是因为崩溃」，只区分「有没有更具体的事实」。
 * summary 由 describeRuntimeExit 用退出码/信号如实描述，不带路径与凭据。
 */

/** Run 在本 Node 进程内已上报的终态事实（RunManager 维护）。 */
export type RuntimeTerminalReport = 'completed' | 'cancelled' | 'failed' | 'none'

export type RuntimeExitOutcome = 'ignore' | 'cancelled_forced' | 'runtime_lost'

export interface RuntimeExitSignals {
  readonly reported: RuntimeTerminalReport
  readonly cancelInFlight: boolean
}

export function classifyRuntimeExit(input: RuntimeExitSignals): RuntimeExitOutcome {
  if (input.reported !== 'none') return 'ignore'
  if (input.cancelInFlight) return 'cancelled_forced'
  return 'runtime_lost'
}

/** 退出摘要（进 run.failed summary；只含 code/signal，不含路径/凭据/参数）。 */
export function describeRuntimeExit(code: number | null, signal: string | null): string {
  if (signal !== null) return `runtime exited unexpectedly (signal=${signal})`
  return `runtime exited unexpectedly (code=${code ?? 'unknown'})`
}
