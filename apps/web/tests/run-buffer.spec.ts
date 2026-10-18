/**
 * run-buffer 单测（P1-13）：append/订阅/封顶保留尾部/drop。
 * 语义边界：只进内存、可丢、有序性只观测不填补（03 §8）。
 */
import { describe, expect, it, vi } from 'vitest'
import {
  appendLiveDelta,
  dropRunLive,
  getRunLiveText,
  RUN_LIVE_BUFFER_MAX_CHARS,
  RUN_LIVE_BUFFER_MAX_SLOTS,
  resetRunLiveBuffers,
  subscribeRunLive,
} from '../src/shared/realtime/run-buffer.js'

describe('ownerRunBuffer', () => {
  it('append 累积文本并按 runId 隔离', () => {
    appendLiveDelta('run-a', 1, 'Hello, ')
    appendLiveDelta('run-a', 2, 'world')
    appendLiveDelta('run-b', 1, 'other')
    expect(getRunLiveText('run-a')).toBe('Hello, world')
    expect(getRunLiveText('run-b')).toBe('other')
    expect(getRunLiveText('run-c')).toBe('')
  })

  it('订阅者收到通知；退订后不再通知', () => {
    const listener = vi.fn()
    const unsubscribe = subscribeRunLive('run-a', listener)
    appendLiveDelta('run-a', 1, 'x')
    expect(listener).toHaveBeenCalledTimes(1)
    unsubscribe()
    appendLiveDelta('run-a', 2, 'y')
    expect(listener).toHaveBeenCalledTimes(1)
  })

  it('超过封顶保留尾部（最新内容优先）', () => {
    appendLiveDelta('run-a', 1, 'h'.repeat(RUN_LIVE_BUFFER_MAX_CHARS))
    appendLiveDelta('run-a', 2, 'TAIL')
    const text = getRunLiveText('run-a')
    expect(text).toHaveLength(RUN_LIVE_BUFFER_MAX_CHARS)
    expect(text.endsWith('TAIL')).toBe(true)
  })

  it('dropRunLive 释放缓冲', () => {
    appendLiveDelta('run-a', 1, 'x')
    dropRunLive('run-a')
    expect(getRunLiveText('run-a')).toBe('')
  })

  it('槽位有上限：会话里看过的第 9 个 Run 进来时，最早那个让位（不再无限占位）', () => {
    for (let index = 1; index <= RUN_LIVE_BUFFER_MAX_SLOTS; index += 1)
      appendLiveDelta(`run-${index}`, 1, `第 ${index} 段`)
    // 上限内的都在（终态段的"未持久化直播"要在记录里查得到）。
    expect(getRunLiveText(`run-${RUN_LIVE_BUFFER_MAX_SLOTS}`)).toBe(
      `第 ${RUN_LIVE_BUFFER_MAX_SLOTS} 段`,
    )
    appendLiveDelta('run-9', 1, '第 9 段')
    expect(getRunLiveText('run-1')).toBe('')
    expect(getRunLiveText('run-9')).toBe('第 9 段')
  })

  it('resetRunLiveBuffers 清空全部（测试隔离）', () => {
    appendLiveDelta('run-a', 1, 'x')
    resetRunLiveBuffers()
    expect(getRunLiveText('run-a')).toBe('')
  })
})
