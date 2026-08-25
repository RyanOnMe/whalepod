import { describe, expect, it } from 'vitest'
import { expectDomainError } from './helpers.js'
import type { AssignmentEvent, AssignmentStatus, TaskEvent, TaskStatus } from '../src/task.js'
import { transitionAssignment, transitionTask } from '../src/task.js'

// 合法边与状态迁移表以 03-领域模型与运行协议.md §3.1 为准。
const TASK_STATUSES: readonly TaskStatus[] = [
  'open',
  'in_progress',
  'in_review',
  'done',
  'cancelled',
]
const TASK_EVENTS: readonly TaskEvent[] = [
  { type: 'run_started' },
  { type: 'review_submitted' },
  { type: 'complete' },
  { type: 'cancel' },
]

const TASK_LEGAL: Readonly<Record<TaskStatus, Partial<Record<TaskEvent['type'], TaskStatus>>>> = {
  open: { run_started: 'in_progress', cancel: 'cancelled' },
  in_progress: { review_submitted: 'in_review', cancel: 'cancelled' },
  in_review: { complete: 'done', run_started: 'in_progress', cancel: 'cancelled' },
  done: {},
  cancelled: {},
}

describe('transitionTask', () => {
  it('open -> in_progress when the first Run starts', () => {
    expect(transitionTask({ status: 'open' }, { type: 'run_started' })).toEqual({
      status: 'in_progress',
    })
  })

  it('in_progress -> in_review when the assignee submits for review', () => {
    expect(transitionTask({ status: 'in_progress' }, { type: 'review_submitted' })).toEqual({
      status: 'in_review',
    })
  })

  it('in_review -> done when the assignee completes explicitly', () => {
    expect(transitionTask({ status: 'in_review' }, { type: 'complete' })).toEqual({
      status: 'done',
    })
  })

  it('in_review -> in_progress when a new Run starts', () => {
    expect(transitionTask({ status: 'in_review' }, { type: 'run_started' })).toEqual({
      status: 'in_progress',
    })
  })

  it.each(['open', 'in_progress', 'in_review'] as const)('%s -> cancelled on cancel', (status) => {
    expect(transitionTask({ status }, { type: 'cancel' })).toEqual({ status: 'cancelled' })
  })

  it('never completes a Task implicitly; only complete from in_review does', () => {
    expectDomainError(
      () => transitionTask({ status: 'in_progress' }, { type: 'complete' }),
      'INVALID_TASK_TRANSITION',
    )
  })

  it.each(TASK_STATUSES.flatMap((status) => TASK_EVENTS.map((event) => [status, event] as const)))(
    '%s + %s follows the transition table exactly',
    (status, event) => {
      const expected = TASK_LEGAL[status][event.type]
      if (expected !== undefined) {
        expect(transitionTask({ status }, event)).toEqual({ status: expected })
      } else {
        expectDomainError(() => transitionTask({ status }, event), 'INVALID_TASK_TRANSITION')
      }
    },
  )

  it.each(['done', 'cancelled'] as const)('never revives a terminal Task (%s)', (status) => {
    for (const event of TASK_EVENTS) {
      expectDomainError(() => transitionTask({ status }, event), 'INVALID_TASK_TRANSITION')
    }
  })
})

const ASSIGNMENT_STATUSES: readonly AssignmentStatus[] = ['pending', 'accepted', 'rejected']
const ASSIGNMENT_EVENTS: readonly AssignmentEvent[] = [
  { type: 'accept' },
  { type: 'reject' },
  { type: 'reassign' },
]

const ASSIGNMENT_LEGAL: Readonly<
  Record<AssignmentStatus, Partial<Record<AssignmentEvent['type'], AssignmentStatus>>>
> = {
  pending: { accept: 'accepted', reject: 'rejected' },
  accepted: { reassign: 'pending' },
  rejected: { reassign: 'pending' },
}

describe('transitionAssignment', () => {
  it('pending -> accepted when the assignee accepts', () => {
    expect(transitionAssignment({ assignmentStatus: 'pending' }, { type: 'accept' })).toEqual({
      assignmentStatus: 'accepted',
    })
  })

  it('pending -> rejected when the assignee rejects', () => {
    expect(transitionAssignment({ assignmentStatus: 'pending' }, { type: 'reject' })).toEqual({
      assignmentStatus: 'rejected',
    })
  })

  it.each(['rejected', 'accepted'] as const)('%s -> pending on reassign', (assignmentStatus) => {
    expect(transitionAssignment({ assignmentStatus }, { type: 'reassign' })).toEqual({
      assignmentStatus: 'pending',
    })
  })

  it.each(
    ASSIGNMENT_STATUSES.flatMap((status) =>
      ASSIGNMENT_EVENTS.map((event) => [status, event] as const),
    ),
  )('%s + %s follows the transition table exactly', (assignmentStatus, event) => {
    const expected = ASSIGNMENT_LEGAL[assignmentStatus][event.type]
    if (expected !== undefined) {
      expect(transitionAssignment({ assignmentStatus }, event)).toEqual({
        assignmentStatus: expected,
      })
    } else {
      expectDomainError(
        () => transitionAssignment({ assignmentStatus }, event),
        'INVALID_ASSIGNMENT_TRANSITION',
      )
    }
  })
})
