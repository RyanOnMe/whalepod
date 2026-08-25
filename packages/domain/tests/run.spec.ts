import { describe, expect, it } from 'vitest'
import { expectDomainError } from './helpers.js'
import type { RunEvent, RunStatus } from '../src/run.js'
import { transitionRun } from '../src/run.js'

// 合法边与状态迁移表以 03-领域模型与运行协议.md §3.2 为准（与 02 Task 2 示例
// 冲突处以 03 为准：waiting_approval/cancel_requested 不接受 failed）。
const RUN_STATUSES: readonly RunStatus[] = [
  'queued',
  'dispatching',
  'running',
  'waiting_approval',
  'cancel_requested',
  'completed',
  'failed',
  'cancelled',
  'lost',
]
const RUN_EVENTS: readonly RunEvent[] = [
  { type: 'dispatch_acked' },
  { type: 'runtime_ready' },
  { type: 'approval_opened' },
  { type: 'approval_closed', remainingPending: 0 },
  { type: 'cancel_before_dispatch' },
  { type: 'cancel_requested' },
  { type: 'cancel_confirmed' },
  { type: 'completed' },
  { type: 'failed' },
  { type: 'lease_expired' },
]

const RUN_LEGAL: Readonly<Record<RunStatus, Partial<Record<RunEvent['type'], RunStatus>>>> = {
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

describe('transitionRun', () => {
  it('requires Runtime ready before running', () => {
    expect(transitionRun({ status: 'dispatching' }, { type: 'runtime_ready' })).toEqual({
      status: 'running',
    })
  })

  it('never revives a terminal Run', () => {
    expectDomainError(
      () => transitionRun({ status: 'lost' }, { type: 'runtime_ready' }),
      'INVALID_RUN_TRANSITION',
    )
  })

  it('cancels a queued Run only before dispatch ack', () => {
    expect(transitionRun({ status: 'queued' }, { type: 'cancel_before_dispatch' })).toEqual({
      status: 'cancelled',
    })
    expectDomainError(
      () => transitionRun({ status: 'queued' }, { type: 'cancel_requested' }),
      'INVALID_RUN_TRANSITION',
    )
  })

  it('rejects failed in waiting_approval and cancel_requested (03 状态机无此边)', () => {
    expectDomainError(
      () => transitionRun({ status: 'waiting_approval' }, { type: 'failed' }),
      'INVALID_RUN_TRANSITION',
    )
    expectDomainError(
      () => transitionRun({ status: 'cancel_requested' }, { type: 'failed' }),
      'INVALID_RUN_TRANSITION',
    )
  })

  it('stays in waiting_approval while pending Approvals remain', () => {
    const run = { status: 'waiting_approval' } as const
    expect(transitionRun(run, { type: 'approval_closed', remainingPending: 2 })).toEqual(run)
  })

  it('returns to running when the last pending Approval closes', () => {
    expect(
      transitionRun(
        { status: 'waiting_approval' },
        { type: 'approval_closed', remainingPending: 0 },
      ),
    ).toEqual({ status: 'running' })
  })

  it('rejects approval_closed outside waiting_approval', () => {
    expectDomainError(
      () => transitionRun({ status: 'running' }, { type: 'approval_closed', remainingPending: 0 }),
      'INVALID_RUN_TRANSITION',
    )
    expectDomainError(
      () => transitionRun({ status: 'running' }, { type: 'approval_closed', remainingPending: 3 }),
      'INVALID_RUN_TRANSITION',
    )
  })

  it.each(RUN_STATUSES.flatMap((status) => RUN_EVENTS.map((event) => [status, event] as const)))(
    '%s + %s follows the transition table exactly',
    (status, event) => {
      const expected = RUN_LEGAL[status][event.type]
      if (expected !== undefined) {
        expect(transitionRun({ status }, event)).toEqual({ status: expected })
      } else {
        expectDomainError(() => transitionRun({ status }, event), 'INVALID_RUN_TRANSITION')
      }
    },
  )

  it.each(['completed', 'failed', 'cancelled', 'lost'] as const)(
    'never revives a terminal Run (%s)',
    (status) => {
      for (const event of RUN_EVENTS) {
        expectDomainError(() => transitionRun({ status }, event), 'INVALID_RUN_TRANSITION')
      }
    },
  )
})
