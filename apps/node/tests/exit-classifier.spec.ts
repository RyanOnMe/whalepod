/**
 * Runtime 退出分类器（P1-16；02 Task 16 exit-classifier）。
 *
 * 判定基线（G7-03「不自动重启」的状态归因核心）：
 * - 已有终态事实（completed/cancelled/failed 已上报）→ ignore（退出只是尾声）；
 * - 取消在途（run.cancel 已发、Runtime 未确认）→ cancelled_forced（03 §3.2：
 *   cancel_requested 15s 未确认 → Supervisor 终止 → cancelled(forced=true)）；
 * - 其余（非零退出、信号、退出但无终态帧）→ runtime_lost（Run failed(RUNTIME_LOST)，
 *   不自动重启、不重放副作用工具）。
 */
import { describe, expect, it } from 'vitest'
import { classifyRuntimeExit, describeRuntimeExit } from '../src/supervisor/exit-classifier.js'

describe('classifyRuntimeExit', () => {
  it('ignores exits after a terminal fact was already reported', () => {
    expect(classifyRuntimeExit({ reported: 'completed', cancelInFlight: false })).toBe('ignore')
    expect(classifyRuntimeExit({ reported: 'cancelled', cancelInFlight: true })).toBe('ignore')
    expect(classifyRuntimeExit({ reported: 'failed', cancelInFlight: false })).toBe('ignore')
  })

  it('maps an exit with cancel in flight to forced cancellation', () => {
    expect(classifyRuntimeExit({ reported: 'none', cancelInFlight: true })).toBe('cancelled_forced')
  })

  it('maps any unreported exit (non-zero, signal, clean) to runtime_lost', () => {
    expect(classifyRuntimeExit({ reported: 'none', cancelInFlight: false })).toBe('runtime_lost')
  })
})

describe('describeRuntimeExit', () => {
  it('renders exit code and signal without paths or secrets', () => {
    expect(describeRuntimeExit(1, null)).toBe('runtime exited unexpectedly (code=1)')
    expect(describeRuntimeExit(null, 'SIGKILL')).toBe(
      'runtime exited unexpectedly (signal=SIGKILL)',
    )
    expect(describeRuntimeExit(0, null)).toBe('runtime exited unexpectedly (code=0)')
  })
})
