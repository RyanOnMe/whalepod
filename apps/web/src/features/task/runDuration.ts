/**
 * 运行时长（#248；#243 第 4 条「时间感」）。纯函数，供 RunTimeline 渲染与单测共用。
 *
 * 口径对照 ChatGPT Work 台的「用时 21分9秒」：时长是预期管理（长任务心里有数），
 * 不是装饰。三种事实三种话：
 *   终态  —— 固定总时长（finishedAt − startedAt），与 now 无关；
 *   活跃  —— 已耗时（now − startedAt），组件层挂 30s 自跳；
 *   未开始（无 startedAt）—— null：没有时间事实就不给值，不假装。
 */
import { ACTIVE_RUN, TERMINAL_RUN } from './run-states.js'
import type { TaskRoomRun } from '../../shared/api/types.js'

/** 毫秒 → 人话时长。四档：秒 / 分秒 / 小时分 / 天小时（零与负值钳到 0秒）。 */
export function formatDuration(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000))
  if (totalSeconds < 60) return `${totalSeconds}秒`
  const totalMinutes = Math.floor(totalSeconds / 60)
  if (totalMinutes < 60) return `${totalMinutes}分${totalSeconds % 60}秒`
  const totalHours = Math.floor(totalMinutes / 60)
  if (totalHours < 24) return `${totalHours}小时${totalMinutes % 60}分`
  return `${Math.floor(totalHours / 24)}天${totalHours % 24}小时`
}

/**
 * 运行卡的时长文案；没有时间事实返回 null（调用方不画时长行）。
 * 终态但缺 finishedAt（数据不完整）也返回 null——宁缺毋造。
 */
export function runDurationText(run: TaskRoomRun, now: number): string | null {
  if (run.startedAt === null) return null
  const started = Date.parse(run.startedAt)
  if (TERMINAL_RUN.has(run.status)) {
    if (run.finishedAt === null) return null
    return formatDuration(Date.parse(run.finishedAt) - started)
  }
  if (ACTIVE_RUN.has(run.status)) return formatDuration(now - started)
  return null
}
