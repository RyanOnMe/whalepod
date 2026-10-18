import type { ReactNode } from 'react'
import { TaskReviewEligibilitySchema } from '@whalepod/protocol'
import type { TaskReviewEligibility } from '@whalepod/protocol'
import type { Session, TaskRoomArtifact, TaskRoomRun, TaskView } from '../../shared/api/types.js'
import { useMemberDirectory } from '../team/memberDirectory.js'
import { ACTIVE_RUN } from './run-states.js'

/** Explains the next existing action; never creates another acceptance gate or command path. */
export function DeliveryFlow({
  task,
  session,
  artifacts,
  runs,
  reviewEligibility,
}: {
  task: TaskView
  session: Session | null
  artifacts: TaskRoomArtifact[]
  runs: TaskRoomRun[]
  reviewEligibility?: TaskReviewEligibility | undefined
}): ReactNode {
  const directory = useMemberDirectory()
  const isAssignee = task.assigneeUserId === session?.userId
  const handler = isAssignee ? '你' : `责任人${directory.personOf(task.assigneeUserId)}`
  const active = runs.some((run) => ACTIVE_RUN.has(run.status))
  const published = artifacts.some((a) => a.status === 'published')
  const ownCandidate = artifacts.some(
    (a) => a.status === 'candidate' && a.ownerUserId === session?.userId,
  )
  const eligibility = TaskReviewEligibilitySchema.safeParse(reviewEligibility)
  let next: string
  let action: string | null = null
  if (task.status === 'done') next = '任务已由责任人确认完成。'
  else if (task.status === 'cancelled') next = '任务已取消，记录保留。'
  else if (task.assignmentStatus !== 'accepted')
    next = `请先由${handler}接受任务；团队仍可在讨论区协作。`
  else if (task.status === 'in_review') {
    next = `已提交验收。请由${handler}检查后确认完成；需修改时先修订并重新发布。`
    if (isAssignee) action = '前往确认完成'
  } else if (active) next = '执行仍在进行。可先检查并发布候选，结束后再提交验收。'
  else if (ownCandidate) next = '请先预览或下载候选，检查后发布给团队。'
  else if (!published) next = '还没有已发布交付物。发布后再由责任人提交验收。'
  else if (eligibility.success && eligibility.data.allowed && isAssignee) {
    next = '交付物已发布。可发起复核，或直接提交验收。'
    action = '前往提交验收'
  } else next = `已有已发布交付物，请由${handler}核对验收条件并提交；最终完成仍需真人确认。`
  return (
    <section
      className="delivery-next-step"
      data-testid="delivery-flow"
      aria-labelledby="delivery-next-heading"
    >
      <h3 id="delivery-next-heading">下一步</h3>
      <p data-testid="delivery-next" role="status">
        {next}
      </p>
      {action === null ? null : (
        <a href="#task-actions" onClick={() => document.getElementById('task-actions')?.focus()}>
          {action}
        </a>
      )}
    </section>
  )
}
