/**
 * #152 展示层文案的机器判据（unit project：纯函数，不需要 DOM）。
 *
 * 起因是实测截图审查：用户屏上同时出现 `状态: pending`、`平台 darwin`、`Owner`
 * 与一律 `2026/09/11 00:06` 的时间。这一份文件把「内部词汇不得作为可见文案」
 * 与相对时间的边界钉成可跑的检查——标签表与格式化函数是纯函数，边界因此可测。
 *
 * 时间用例全部用注入的 `now`（本地日历日构造），不依赖运行时的当天日期与时区。
 */
import { describe, expect, it } from 'vitest'
import {
  ASSIGNMENT_STATUS_LABEL,
  DEVICE_STATUS_LABEL,
  PLATFORM_LABEL,
  ROLE_LABEL,
  RUN_STATUS_LABEL,
  TASK_STATUS_LABEL,
  formatIso,
  formatPlatform,
  formatRelativeTime,
} from '../src/shared/format.js'

/** 固定「现在」：本地 2026-09-11 14:00（TZ 无关——期望值也由本地日历日构造）。 */
const NOW = new Date(2026, 8, 11, 14, 0, 0)

/** 相对 NOW 偏移若干毫秒的 ISO 串。 */
function ago(ms: number): string {
  return new Date(NOW.getTime() - ms).toISOString()
}

const SECOND = 1000
const MINUTE = 60 * SECOND
const HOUR = 60 * MINUTE

describe('#152 状态与角色标签表', () => {
  it('分配状态：内部枚举值不出现在文案里（`pending` → 待接受）', () => {
    expect(ASSIGNMENT_STATUS_LABEL.pending).toBe('待接受')
    expect(ASSIGNMENT_STATUS_LABEL.accepted).toBe('已接受')
    expect(ASSIGNMENT_STATUS_LABEL.rejected).toBe('已拒绝')
  })

  it('角色：中文角色名一套到底（owner/admin/member），不含英文旧文案', () => {
    expect(ROLE_LABEL.owner).toBe('所有者')
    expect(ROLE_LABEL.admin).toBe('管理员')
    expect(ROLE_LABEL.member).toBe('成员')
    for (const label of Object.values(ROLE_LABEL)) {
      expect(label).not.toMatch(/[A-Za-z]/)
    }
  })

  it('所有状态标签表都不含 ASCII 字母（裸枚举泄漏的回归闸门）', () => {
    const tables = [
      TASK_STATUS_LABEL,
      ASSIGNMENT_STATUS_LABEL,
      RUN_STATUS_LABEL,
      DEVICE_STATUS_LABEL,
    ]
    for (const table of tables) {
      for (const [enumValue, label] of Object.entries(table)) {
        expect(label, `${enumValue} 的文案`).not.toMatch(/[A-Za-z]/)
      }
    }
  })
})

describe('#152 平台映射', () => {
  it('内部标识 → 人话：darwin/linux/win32', () => {
    expect(formatPlatform('darwin')).toBe('macOS')
    expect(formatPlatform('linux')).toBe('Linux')
    expect(formatPlatform('win32')).toBe('Windows')
    expect(PLATFORM_LABEL.darwin).toBe('macOS')
  })

  it('未知取值原样保留但标「未知平台」——不假装认识，也不吞掉信息', () => {
    expect(formatPlatform('freebsd')).toBe('freebsd（未知平台）')
    expect(formatPlatform('DOS')).toBe('DOS（未知平台）')
  })

  it('空值与 null 给「未知平台」', () => {
    expect(formatPlatform(null)).toBe('未知平台')
    expect(formatPlatform('')).toBe('未知平台')
  })

  it('darwin 不会被当成人话直接呈现（回归：`平台 darwin`）', () => {
    expect(formatPlatform('darwin')).not.toContain('darwin')
  })
})

describe('#152 相对时间', () => {
  it('一分钟内是「刚刚」，且给出 59 秒仍为「刚刚」', () => {
    expect(formatRelativeTime(ago(0), NOW)).toBe('刚刚')
    expect(formatRelativeTime(ago(30 * SECOND), NOW)).toBe('刚刚')
    expect(formatRelativeTime(ago(59 * SECOND), NOW)).toBe('刚刚')
  })

  it('59 秒 → 60 秒这一步跨过「刚刚」：到点即「1 分钟前」', () => {
    expect(formatRelativeTime(ago(59 * SECOND), NOW)).toBe('刚刚')
    expect(formatRelativeTime(ago(60 * SECOND), NOW)).toBe('1 分钟前')
    expect(formatRelativeTime(ago(5 * MINUTE), NOW)).toBe('5 分钟前')
    expect(formatRelativeTime(ago(59 * MINUTE), NOW)).toBe('59 分钟前')
  })

  it('同一天内一小时以上给「N 小时前」', () => {
    expect(formatRelativeTime(new Date(2026, 8, 11, 11, 0, 0).toISOString(), NOW)).toBe('3 小时前')
    expect(formatRelativeTime(new Date(2026, 8, 11, 13, 0, 0).toISOString(), NOW)).toBe('1 小时前')
  })

  it('跨天以本地日历日为准：昨天 22:30 是「昨天 22:30」而不是「2 小时前」', () => {
    const now = new Date(2026, 8, 11, 0, 30, 0)
    const then = new Date(2026, 8, 10, 22, 30, 0)
    expect(formatRelativeTime(then.toISOString(), now)).toBe('昨天 22:30')
  })

  it('昨天给 HH:mm（补零），不是「24 小时前」', () => {
    expect(formatRelativeTime(new Date(2026, 8, 10, 9, 5, 0).toISOString(), NOW)).toBe('昨天 09:05')
    expect(formatRelativeTime(new Date(2026, 8, 10, 23, 59, 0).toISOString(), NOW)).toBe(
      '昨天 23:59',
    )
  })

  it('前天与更早给日期；去年必须带年份', () => {
    expect(formatRelativeTime(new Date(2026, 8, 9, 10, 0, 0).toISOString(), NOW)).toBe('9月9日')
    expect(formatRelativeTime(new Date(2026, 7, 24, 10, 0, 0).toISOString(), NOW)).toBe('8月24日')
    expect(formatRelativeTime(new Date(2025, 8, 11, 10, 0, 0).toISOString(), NOW)).toBe(
      '2025年9月11日',
    )
    expect(formatRelativeTime(new Date(2024, 0, 1, 10, 0, 0).toISOString(), NOW)).toBe(
      '2024年1月1日',
    )
  })

  it('未来时刻保留绝对时间（配对码/邀请有效期是截止时刻，不能编「分钟后」）', () => {
    const inFiveMinutes = new Date(NOW.getTime() + 5 * MINUTE).toISOString()
    expect(formatRelativeTime(inFiveMinutes, NOW)).toBe(formatIso(inFiveMinutes))
    // 轻微时钟偏差（未来数秒）算「刚刚」，不显示负数或未来时间。
    expect(formatRelativeTime(new Date(NOW.getTime() + 10 * SECOND).toISOString(), NOW)).toBe(
      '刚刚',
    )
  })

  it('null 给占位符，非法串原样返回（都不伪装成时间）', () => {
    expect(formatRelativeTime(null, NOW)).toBe('—')
    expect(formatRelativeTime('not-a-time', NOW)).toBe('not-a-time')
  })

  it('绝对时间仍是绝对时间（RelativeTime 的 title 用它）', () => {
    expect(formatIso('2026-09-11T00:06:00.000Z')).toMatch(/^\d{4}\/\d{2}\/\d{2} \d{2}:\d{2}$/)
    expect(formatIso(null)).toBe('—')
    expect(formatIso('not-a-time')).toBe('not-a-time')
  })

  it('相对文案不再出现 `2026/09/11 00:06` 这种长串（Issue #152 现象 10）', () => {
    const text = formatRelativeTime(ago(2 * HOUR), NOW)
    expect(text).toBe('2 小时前')
    expect(text).not.toMatch(/\d{4}\//)
  })
})
