import { DomainError } from './errors.js'

// 状态迁移表以 03-领域模型与运行协议.md §3.2 为准：
// 终态 completed | failed | cancelled | lost 之间禁止迁移。
// #52/ADR-0007 修订（取代 P1-02 对 02 Task 2 示例的「waiting_approval 不接受
// 终态」收紧）：waiting_approval 接受 completed/failed——审批的执行闸门在 Runtime
// 路径（ask-all 阻塞），不是 Hub 侧的终态前置条件；Runtime 在悬置审批下报出终态
// 是对该 Run 的最终裁决，Hub 记账必须能收敛（落终态同事务折叠 pending
// Approval）。cancel_requested 仍不收终态裁决边：取消的收敛由确认/强杀/租约负责，
// 表外冲突事件由 Hub 做事件留证 + Run 级降级收敛，不再连接级惩罚（毒帧循环）。
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
    // ADR-0007：Runtime 在悬置审批下的终态是 Run 的最终裁决；Hub 落终态的
    // 同事务把 pending Approval 折叠为 cancelled（cause=run_terminal_fold）。
    completed: 'completed',
    failed: 'failed',
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
