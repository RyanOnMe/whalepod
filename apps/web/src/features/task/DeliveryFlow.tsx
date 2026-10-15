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
  const terminal = task.status === 'done' || task.status === 'cancelled'
  let next: string
  let action: string | null = null
  if (task.status === 'done') next = '任务已由责任人确认完成，交付与执行记录保留。'
  else if (task.status === 'cancelled') next = '任务已取消，交付与执行记录保留。'
  else if (task.assignmentStatus !== 'accepted')
    next = `请先由${handler}接受任务；团队仍可在讨论区协作。`
  else if (task.status === 'in_review') {
    next = `交付已提交验收，请由${handler}检查后确认完成。有意见时，可明确选择产出会话或新执行修订，修订后重新发布和提交验收。`
    if (isAssignee) action = '前往确认完成'
  } else if (active) next = '执行仍在进行，可先检查并发布候选；等执行结束后再发起复核或提交验收。'
  else if (ownCandidate) next = '请先预览或下载，检查你的候选交付物，确认后发布给团队。'
  else if (!published) next = '还没有已发布交付物，请由产出拥有者检查并发布，再由责任人提交验收。'
  else if (eligibility.success && eligibility.data.allowed && isAssignee) {
    next = '交付物已发布，可选复核后由你提交验收；不需要复核时也可直接提交。'
    action = '前往提交验收'
  } else next = `已有已发布交付物，请由${handler}核对验收条件并提交；最终完成仍需真人确认。`
  return (
    <section data-testid="delivery-flow" aria-labelledby="delivery-next-heading">
      <h3 id="delivery-next-heading">交付下一步</h3>
      <p data-testid="delivery-next" role="status">
        {next}
      </p>
      {!terminal ? (
        <p className="mutation-hint">
          可选复核：从已发布产出发起；复核完成不会自动验收或完成任务。
        </p>
      ) : null}
      {action === null ? null : (
        <a href="#task-actions" onClick={() => document.getElementById('task-actions')?.focus()}>
          {action}
        </a>
      )}
    </section>
  )
}
