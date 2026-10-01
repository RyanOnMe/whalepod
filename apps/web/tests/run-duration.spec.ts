/**
 * 运行时长（#248；#243 第 4 条「时间感」）纯函数判据。
 *
 * 格式四档 + runDurationText 的三种事实：终态=固定总时长、活跃=随 now 走的已耗时、
 * 未开始=没有时间事实就不给值（不假装）。
 */
import { describe, expect, it } from 'vitest'
import { formatDuration, runDurationText } from '../src/features/task/runDuration.js'
import type { TaskRoomRun } from '../src/shared/api/types.js'

function run(over: Partial<TaskRoomRun> = {}): TaskRoomRun {
  return {
    id: 'r-1',
    status: 'running',
    createdAt: '2026-10-01T00:00:00.000Z',
    startedAt: '2026-10-01T00:00:05.000Z',
    finishedAt: null,
    rerunOfRunId: null,
    resumeFromRunId: null,
    approvalPolicy: 'approval_required',
    deviceName: null,
    workspaceName: null,
    lastToolCall: null,
    ...over,
  }
}

describe('formatDuration', () => {
  it('四档格式：秒 / 分秒 / 小时分 / 天小时', () => {
    expect(formatDuration(3_000)).toBe('3秒')
    expect(formatDuration(59_000)).toBe('59秒')
    expect(formatDuration(60_000)).toBe('1分0秒')
    expect(formatDuration(21 * 60_000 + 9_000)).toBe('21分9秒') // 对照物的口径
    expect(formatDuration((2 * 3600 + 4 * 60) * 1000)).toBe('2小时4分')
    expect(formatDuration((25 * 3600 + 3 * 60) * 1000)).toBe('1天1小时')
  })

  it('负值与零：给空串不给假话（时间还没开始走）', () => {
    expect(formatDuration(0)).toBe('0秒')
    expect(formatDuration(-5_000)).toBe('0秒')
  })
})

describe('runDurationText', () => {
  it('终态 Run：固定总时长 = finishedAt − startedAt，与 now 无关', () => {
    const text = runDurationText(
      run({
        status: 'completed',
        startedAt: '2026-10-01T00:00:00.000Z',
        finishedAt: '2026-10-01T00:21:09.000Z',
      }),
      new Date('2026-10-02T00:00:00.000Z').getTime(),
    )
    expect(text).toBe('21分9秒')
  })

  it('活跃且已开始：已耗时 = now − startedAt（随 now 走）', () => {
    const now = new Date('2026-10-01T00:10:00.000Z').getTime()
    expect(runDurationText(run({ status: 'running' }), now)).toBe('9分55秒')
  })

  it('未开始（无 startedAt）：null——没有时间事实就不给值', () => {
    expect(runDurationText(run({ status: 'queued', startedAt: null }), 12345)).toBeNull()
  })

  it('活跃但缺 finishedAt 的终态（数据不完整）：null 而不是编造', () => {
    expect(runDurationText(run({ status: 'completed', finishedAt: null }), 12345)).toBeNull()
  })
})
