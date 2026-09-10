/**
 * 展示层格式化与状态文案（状态同时用文字+色块，见 prototype DESIGN.md §8：
 * 不能只靠颜色传达状态）。
 */
import type { AssignmentStatus, DeviceView, Role, RunStatus, TaskStatus } from './api/types.js'

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

/** 设备在线状态文案（#142；Hub 侧 deriveDeviceStatus 的 online/offline/revoked）。 */
export const DEVICE_STATUS_LABEL: Readonly<Record<DeviceView['status'], string>> = {
  online: '在线',
  offline: '离线',
  revoked: '已撤销',
}

/**
 * 角色文案（#152）：全站唯一一套中文角色名——成员页徽标、邀请角色下拉、页头身份行
 * 同用这一张表。此前徽标写 `Owner`、下拉写「Member（普通成员）」，同一页两种说法。
 */
export const ROLE_LABEL: Readonly<Record<Role, string>> = {
  owner: '所有者',
  admin: '管理员',
  member: '成员',
}

/**
 * 设备平台文案（#152）：Hub 收到的 `platform` 是 Node 上报的 `process.platform`
 * 内部标识（协议枚举 darwin/linux/win32），不是给用户看的名字。未知取值原样保留
 * 并显式标注「未知平台」——既不丢信息，也不假装认识。
 */
export const PLATFORM_LABEL: Readonly<Record<string, string>> = {
  darwin: 'macOS',
  linux: 'Linux',
  win32: 'Windows',
}

export function formatPlatform(platform: string | null): string {
  if (platform === null || platform === '') return '未知平台'
  return PLATFORM_LABEL[platform] ?? `${platform}（未知平台）`
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

const MINUTE_MS = 60_000
const HOUR_MS = 60 * MINUTE_MS
const DAY_MS = 24 * HOUR_MS

/**
 * 相对时间文案（#152）：刚刚 / N 分钟前 / N 小时前 / 昨天 HH:mm / 更早给日期。
 * 所有用户可见时间走这里（shared/RelativeTime），`title` 另留绝对时间可核对。
 *
 * 判定次序与理由：
 * - 未来时刻（超过 60 秒）没有「多久以前」的说法：原样走绝对时间——配对码与邀请
 *   有效期是**截止时刻**，编一个「N 分钟后」只会把真实期限说糊；
 * - 60 秒内（含轻微时钟偏差造成的负差）一律「刚刚」，不出现「0 分钟前」；
 * - 跨天以**本地日历日**为准：昨天 22:30 在今天 00:30 看是「昨天 22:30」，
 *   而不是「2 小时前」——日历日与小时数的说法冲突时前者更贴近人话；
 * - 更早给日期：同年 `9月11日`，跨年 `2025年9月11日`（去年的事必须看得见年份）；
 * - null 给占位符，非法串原样返回（都不伪装成时间）。
 * `now` 可注入，边界因此可测。
 */
export function formatRelativeTime(iso: string | null, now: Date = new Date()): string {
  if (iso === null) return '—'
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return iso
  const diffMs = now.getTime() - date.getTime()
  if (diffMs < -MINUTE_MS) return formatIso(iso)
  if (diffMs < MINUTE_MS) return '刚刚'
  const dayDiff = calendarDayDiff(date, now)
  if (dayDiff === 0) {
    if (diffMs < HOUR_MS) return `${Math.floor(diffMs / MINUTE_MS)} 分钟前`
    return `${Math.floor(diffMs / HOUR_MS)} 小时前`
  }
  if (dayDiff === 1) return `昨天 ${clockOf(date)}`
  if (date.getFullYear() === now.getFullYear()) {
    return `${date.getMonth() + 1}月${date.getDate()}日`
  }
  return `${date.getFullYear()}年${date.getMonth() + 1}月${date.getDate()}日`
}

/** 两个时刻相隔几个本地日历日（跨夏令时也取整到整天）。 */
function calendarDayDiff(then: Date, now: Date): number {
  const startOfDay = (value: Date): number =>
    new Date(value.getFullYear(), value.getMonth(), value.getDate()).getTime()
  return Math.round((startOfDay(now) - startOfDay(then)) / DAY_MS)
}

/** 本地 HH:mm（昨天一档用；不带秒，够用且短）。 */
function clockOf(date: Date): string {
  const hours = String(date.getHours()).padStart(2, '0')
  const minutes = String(date.getMinutes()).padStart(2, '0')
  return `${hours}:${minutes}`
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

/**
 * 剩余毫秒 → mm:ss 倒计时（#142 配对码有效期）。向上取整：只剩 0.4 秒时显示
 * 00:01、归零才显示 00:00——既不提前宣布过期，也不给出负数倒计时。
 */
export function formatCountdown(ms: number): string {
  const totalSeconds = Math.ceil(Math.max(0, ms) / 1000)
  const minutes = Math.floor(totalSeconds / 60)
  const seconds = totalSeconds % 60
  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`
}

/**
 * 短 id（8 字符）。#152 起**不再用于呈现人名**：成员名录（features/team/
 * memberDirectory）解析不出人时给「未知成员」，不拿半截 UUID 冒充姓名。
 * 仍用于 git sha / digest 等非人名场景。
 */
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
