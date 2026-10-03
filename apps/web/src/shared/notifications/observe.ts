/**
 * 终态 Run → 通知的判定（P1-UX-13 / #259）。
 *
 * 与 event-router 的分工：路由器管「帧 → 失效哪些缓存」（纯逻辑、零依赖），这里管
 * 「帧 → 未读水位 / 系统通知」。两者都在 RealtimeBridge 的 onFrame 上跑，但互不阻塞
 * ——通知抛错绝不影响 cursor 提交（否则一次通知故障会让实时链路反复重放）。
 *
 * 两条判定轴：
 *   - 是不是同一件事：`known` 去重（持久，见 store.ts）——重放窗口里的事件不重复记账；
 *   - 是不是当场发生：帧 occurredAt vs 本次挂载时刻——历史重放只进徽标，**不弹系统通知**
 *     （打开页面时被 24 小时前的旧事弹一脸，是最典型的通知骚扰）。
 */
import type { ClientFrame } from '@whalepod/protocol'
import { isTerminalRunStatus, recordTerminalRun } from './store.js'
import type { TerminalRunStatus } from './store.js'

/**
 * 「当场发生」的容差：帧时间早于本次挂载前 60s 视为重放。
 * 留容差是因为服务端时钟与浏览器时钟不可能严格一致，且连接建立、重放、
 * 首帧之间本来就有秒级延迟。
 */
export const LIVE_TOLERANCE_MS = 60_000

export interface RunCompletionNotice {
  readonly taskId: string
  readonly status: TerminalRunStatus
  /** 任务名（调用方从缓存查，零请求）；null = 拿不到，展示层用占位。 */
  readonly taskTitle: string | null
}

export interface RunCompletionDeps {
  /** 本次页面挂载时刻（ms）：重放与当场的分界。 */
  readonly mountedAt: number
  /** 用户是否正开着该任务房间（开着就不进未读——人就在现场）。 */
  readonly isViewingTask: (taskId: string) => boolean
  readonly taskTitleFor: (taskId: string) => string | null
  /** 系统通知投递（开关/权限门在实现侧）。 */
  readonly notify: (notice: RunCompletionNotice) => void
}

export function observeRunCompletion(frame: ClientFrame, deps: RunCompletionDeps): void {
  if (frame.kind !== 'persistent' || frame.event.type !== 'run.changed') return
  const payload = frame.event.payload
  const runId = payloadField(payload, 'runId')
  const taskId = payloadField(payload, 'taskId')
  const status = payloadField(payload, 'status')
  // 载荷由 Hub 投影保证（run.changed 带 runId/taskId/status），但读侧不信任写路径：
  // 形状不对就当没有这条通知，不抛、不画。
  if (typeof runId !== 'string' || typeof taskId !== 'string') return
  if (!isTerminalRunStatus(status)) return

  const viewing = deps.isViewingTask(taskId)
  if (!recordTerminalRun({ runId, taskId, status }, !viewing)) return

  const occurredAt = Date.parse(frame.occurredAt)
  const live = Number.isFinite(occurredAt) && occurredAt >= deps.mountedAt - LIVE_TOLERANCE_MS
  if (!live) return
  deps.notify({ taskId, status, taskTitle: deps.taskTitleFor(taskId) })
}

function payloadField(payload: unknown, key: string): unknown {
  if (typeof payload !== 'object' || payload === null) return undefined
  return (payload as Record<string, unknown>)[key]
}
