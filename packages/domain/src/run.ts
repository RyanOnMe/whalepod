import { DomainError } from './errors.js'

// 状态迁移表以 03-领域模型与运行协议.md §3.2 为准：
// 终态 completed | failed | cancelled | lost 之间禁止迁移。
// 与 02-第一阶段实施计划.md Task 2 示例的差异（以 03 为准）：
// waiting_approval 与 cancel_requested 不接受 failed。
export type RunStatus =
  | 'queued'
  | 'dispatching'
  | 'running'
  | 'waiting_approval'
  | 'cancel_requested'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'lost'

export type RunEvent =
  | { type: 'dispatch_acked' }
  | { type: 'runtime_ready' }
  | { type: 'approval_opened' }
  | { type: 'approval_closed'; remainingPending: number }
  | { type: 'cancel_before_dispatch' }
  | { type: 'cancel_requested' }
  | { type: 'cancel_confirmed' }
  | { type: 'completed' }
  | { type: 'failed' }
  | { type: 'lease_expired' }

const RUN_NEXT: Readonly<Record<RunStatus, Partial<Record<RunEvent['type'], RunStatus>>>> = {
  queued: { dispatch_acked: 'dispatching', cancel_before_dispatch: 'cancelled', failed: 'failed' },
  dispatching: {
    runtime_ready: 'running',
    cancel_requested: 'cancel_requested',
    failed: 'failed',
    lease_expired: 'lost',
  },
  running: {
    approval_opened: 'waiting_approval',
    cancel_requested: 'cancel_requested',
    completed: 'completed',
    failed: 'failed',
    lease_expired: 'lost',
  },
  waiting_approval: {
    approval_closed: 'running',
    cancel_requested: 'cancel_requested',
    lease_expired: 'lost',
  },
  cancel_requested: { cancel_confirmed: 'cancelled', lease_expired: 'lost' },
  completed: {},
  failed: {},
  cancelled: {},
  lost: {},
}

export function transitionRun(run: { status: RunStatus }, event: RunEvent): { status: RunStatus } {
  // waiting_approval 只表示存在至少一条 pending Approval；
  // 还有剩余 pending 时状态不变，最后一条结束后才回到 running。
  if (
    run.status === 'waiting_approval' &&
    event.type === 'approval_closed' &&
    event.remainingPending > 0
  ) {
    return run
  }
  const status = RUN_NEXT[run.status][event.type]
  if (status === undefined) {
    throw new DomainError(
      'INVALID_RUN_TRANSITION',
      `cannot apply ${event.type} to a run in ${run.status}`,
    )
  }
  return { ...run, status }
}
