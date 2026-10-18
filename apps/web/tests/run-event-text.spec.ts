/**
 * 未持久化直播输出的净剩判据（#393 复核实测：两条回复时旧等值比较必然误报）。
 */
import { describe, expect, it } from 'vitest'
import { liveResidue } from '../src/features/task/run-event-text.js'

describe('直播缓冲与已持久化回复的净剩', () => {
  it('回复把直播原文整段盖住时不剩任何东西', () => {
    expect(liveResidue('一模一样', ['一模一样'])).toBe('')
  })

  it('两条以上回复：逐条扣减后没有剩余（旧等值比较在这里误报重复）', () => {
    // 带工具调用的常见形态：直播原文是两段回复的拼接，回复列表也是两条。
    const live = '第一段输出。\n第二段输出。'
    expect(liveResidue(live, ['第一段输出。', '第二段输出。'])).toBe('')
    // 直播里还夹着阶段/工具之间的零碎文字 → 只显示剩下的那一点，不重复整段。
    expect(
      liveResidue('先看一眼文件。\n第一段输出。\n第二段输出。', ['第一段输出。', '第二段输出。']),
    ).toBe('先看一眼文件。')
  })

  it('回复不在直播里（断线后补读来的）时整段保留，不假装已经覆盖', () => {
    expect(liveResidue('中断前尚未形成正式消息的输出', ['正式回复'])).toBe(
      '中断前尚未形成正式消息的输出',
    )
    // 空直播：没有可显示的内容，也不该画那个块。
    expect(liveResidue('   ', ['正式回复'])).toBe('')
  })
})
