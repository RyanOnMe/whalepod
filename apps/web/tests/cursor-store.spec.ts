/**
 * P1-08 cursor-store 单元验收（内存型 cursor；02 Task 8 Step 5）。
 *
 * - commit 只接受非负十进制并保持单调（bigint 可能超 Number.MAX_SAFE_INTEGER，
 *   按十进制字符串逐位比较）；
 * - reset 放弃本地光标（resync 后从 0 重放保留窗口）。
 */
import { describe, expect, it } from 'vitest'
import { CursorStore } from '../src/shared/realtime/cursor-store.js'

describe('CursorStore', () => {
  it('starts at 0 and keeps the highest committed cursor', () => {
    const store = new CursorStore()
    expect(store.load()).toBe('0')
    store.commit('12')
    expect(store.load()).toBe('12')
    store.commit('5') // 非单调：忽略
    expect(store.load()).toBe('12')
  })

  it('ignores malformed cursors', () => {
    const store = new CursorStore()
    store.commit('12')
    store.commit('12abc')
    store.commit('-3')
    store.commit('')
    expect(store.load()).toBe('12')
  })

  it('compares bigint cursors beyond Number.MAX_SAFE_INTEGER as decimal strings', () => {
    const store = new CursorStore()
    const big = '900719925474099312345678'
    store.commit(big)
    expect(store.load()).toBe(big)
    store.commit('99999999999999999999999') // 位数更短但值更小…按十进制比较
    expect(store.load()).toBe(big)
    const bigger = '900719925474099312345679'
    store.commit(bigger) // 同长相邻值：应推进
    expect(store.load()).toBe(bigger)
  })

  it('resets to 0 (resync → replay the retention window)', () => {
    const store = new CursorStore()
    store.commit('12')
    store.reset()
    expect(store.load()).toBe('0')
    store.commit('1') // reset 后较旧 cursor 也按单调规则接受（从 0 起的合法新值）
    expect(store.load()).toBe('1')
  })
})
