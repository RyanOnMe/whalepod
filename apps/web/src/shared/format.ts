/**
 * 展示层格式化与状态文案（状态同时用文字+色块，见 prototype DESIGN.md §8：
 * 不能只靠颜色传达状态）。
 */
import type { AssignmentStatus, RunStatus, TaskStatus } from './api/types.js'

export const TASK_STATUS_LABEL: Readonly<Record<TaskStatus, string>> = {
  open: '未开始',
  in_progress: '进行中',
  in_review: '验收中',
  done: '已完成',
  cancelled: '已取消',
}

export const ASSIGNMENT_STATUS_LABEL: Readonly<Record<AssignmentStatus, string>> = {
  pending: '待接受',
  accepted: '已接受',
  rejected: '已拒绝',
}

export const RUN_STATUS_LABEL: Readonly<Record<RunStatus, string>> = {
  queued: '排队中',
  dispatching: '派发中',
  running: '运行中',
  waiting_approval: '等待审批',
  cancel_requested: '取消中',
  completed: '已完成',
  failed: '失败',
  cancelled: '已取消',
  lost: '丢失',
}

/** ISO 时间 → 本地可读字符串；null 显示占位符。非法串原样返回（不伪装）。 */
export function formatIso(iso: string | null): string {
  if (iso === null) return '—'
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return iso
  return date.toLocaleString('zh-CN', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  })
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

/** 成员列表接口缺失前的临时身份呈现：短 id，不伪造显示名（03 §9）。 */
export function shortId(id: string): string {
  return id.slice(0, 8)
}

/** 40 hex git sha 的短形态（review commit 等）：前 8 字符，完整值经 title/复制给出。 */
export function shortSha(value: string): string {
  return value.slice(0, 8)
}

/**
 * SRI / SHA-256 hex 等长 digest 的短摘要：前 12 字符 + 省略号（02 Task 17 Step 7
 * 的 integrity 短摘要）；完整值必须经 title 或复制入口给出，不伪造截断值。
 */
export function shortDigest(value: string): string {
  return `${value.slice(0, 12)}…`
}
