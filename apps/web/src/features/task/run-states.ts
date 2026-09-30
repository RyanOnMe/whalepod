/**
 * Run 状态集合的单一真源（#234；此前 TaskRoomPage/RunActions/RunLivePanel
 * 三处各写一份，漂移无判据）。
 *
 * 三集合的语义与关系（关系判据在 tests/run-states.spec.ts，对协议
 * `RunStatusSchema.options` 防漂移——协议加状态时那里必须红）：
 *   ACTIVE_RUN   —— 「Run 还在跑」的一族（挡重复起 Run；比 QUEUEING 多一个
 *                   cancel_requested：取消中仍算活跃，但不是排队窗口）；
 *   QUEUEING_RUN —— 「指令可以排在它后面等放行」的窗口。**必须与 hub 的
 *                   `FOLLOWUP_QUEUEING_STATUSES`（apps/hub/src/modules/run/
 *                   followup.ts）逐字对齐**：hub 只把 queued/dispatching/
 *                   waiting_approval 当排队窗口；running 是立即下发，
 *                   cancel_requested 与各终态当场拒绝（RUN_CANCELLING）。
 *                   #209 R3 实测教训：写成 `status !== 'running'` 会让
 *                   cancel_requested 显示「已排队」而 hub 已判死那条指令。
 *   TERMINAL_RUN —— 四个终态。Run 终态禁止复活（红线）。
 */
export const ACTIVE_RUN: ReadonlySet<string> = new Set([
  'queued',
  'dispatching',
  'running',
  'waiting_approval',
  'cancel_requested',
])

export const QUEUEING_RUN: ReadonlySet<string> = new Set([
  'queued',
  'dispatching',
  'waiting_approval',
])

export const TERMINAL_RUN: ReadonlySet<string> = new Set([
  'completed',
  'failed',
  'cancelled',
  'lost',
])
