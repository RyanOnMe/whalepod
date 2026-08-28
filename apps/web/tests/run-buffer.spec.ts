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

  it('resetRunLiveBuffers 清空全部（测试隔离）', () => {
    appendLiveDelta('run-a', 1, 'x')
    resetRunLiveBuffers()
    expect(getRunLiveText('run-a')).toBe('')
  })
})
