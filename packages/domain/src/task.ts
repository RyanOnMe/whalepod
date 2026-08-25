import { DomainError } from './errors.js'

// 状态迁移表以 03-领域模型与运行协议.md §3.1 为准。
// 「无活跃 Run」「已有发布 Artifact」等前置条件需要跨实体事实，
// 由 Hub 命令层在校验后调用；这里只固化纯状态边。

export type TaskStatus = 'open' | 'in_progress' | 'in_review' | 'done' | 'cancelled'

export type TaskEvent =
  | { type: 'run_started' }
  | { type: 'review_submitted' }
  | { type: 'complete' }
  | { type: 'cancel' }

const TASK_NEXT: Readonly<Record<TaskStatus, Partial<Record<TaskEvent['type'], TaskStatus>>>> = {
  open: { run_started: 'in_progress', cancel: 'cancelled' },
  in_progress: { review_submitted: 'in_review', cancel: 'cancelled' },
  in_review: { complete: 'done', run_started: 'in_progress', cancel: 'cancelled' },
  done: {},
  cancelled: {},
}

export function transitionTask(
  task: { status: TaskStatus },
  event: TaskEvent,
): { status: TaskStatus } {
  const status = TASK_NEXT[task.status][event.type]
  if (status === undefined) {
    throw new DomainError(
      'INVALID_TASK_TRANSITION',
      `cannot apply ${event.type} to a task in ${task.status}`,
    )
  }
  return { ...task, status }
}

export type AssignmentStatus = 'pending' | 'accepted' | 'rejected'

export type AssignmentEvent = { type: 'accept' } | { type: 'reject' } | { type: 'reassign' }

const ASSIGNMENT_NEXT: Readonly<
  Record<AssignmentStatus, Partial<Record<AssignmentEvent['type'], AssignmentStatus>>>
> = {
  pending: { accept: 'accepted', reject: 'rejected' },
  accepted: { reassign: 'pending' },
  rejected: { reassign: 'pending' },
}

export function transitionAssignment(
  task: { assignmentStatus: AssignmentStatus },
  event: AssignmentEvent,
): { assignmentStatus: AssignmentStatus } {
  const assignmentStatus = ASSIGNMENT_NEXT[task.assignmentStatus][event.type]
  if (assignmentStatus === undefined) {
    throw new DomainError(
      'INVALID_ASSIGNMENT_TRANSITION',
      `cannot apply ${event.type} to an assignment in ${task.assignmentStatus}`,
    )
  }
  return { ...task, assignmentStatus }
}
