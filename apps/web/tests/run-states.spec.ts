/**
 * #234：运行状态集合的关系判据（对协议真源防漂移）。
 *
 * 三集合收敛到 features/task/run-states.ts 后，这里把「三者之间的关系」
 * 钉死：协议（RunStatusSchema）新增或改名状态时必须红，逼着web 端语义
 * 重新过一遍，而不是静默漂移。
 */
import { describe, expect, it } from 'vitest'
import { RunStatusSchema } from '@whalepod/protocol'
import { ACTIVE_RUN, QUEUEING_RUN, TERMINAL_RUN } from '../src/features/task/run-states.js'

const allStatuses = RunStatusSchema.options

describe('运行状态集合关系（#234）', () => {
  it('ACTIVE ∪ TERMINAL 恰好覆盖协议 RunStatus 全集，且互不相交', () => {
    const union = new Set([...ACTIVE_RUN, ...TERMINAL_RUN])
    expect([...union].sort()).toEqual([...allStatuses].sort())
    for (const status of ACTIVE_RUN) {
      expect(TERMINAL_RUN.has(status)).toBe(false)
    }
  })

  it('QUEUEING ⊂ ACTIVE（排队窗口是活跃的子集）', () => {
    for (const status of QUEUEING_RUN) {
      expect(ACTIVE_RUN.has(status)).toBe(true)
    }
  })

  it('cancel_requested ∈ ACTIVE \\ QUEUEING：取消中的 Run 仍挡重复起 Run，但不再是排队窗口', () => {
    // #209 R3 的语义钉：hub 对 cancel_requested 上的追问当场拒绝（RUN_CANCELLING），
    // 而「一任务同时至多一个活跃 Run」的守卫仍把它算活跃。
    expect(ACTIVE_RUN.has('cancel_requested')).toBe(true)
    expect(QUEUEING_RUN.has('cancel_requested')).toBe(false)
  })

  it('running ∉ QUEUEING：running 是立即下发窗口，不排队', () => {
    expect(QUEUEING_RUN.has('running')).toBe(false)
  })
})
