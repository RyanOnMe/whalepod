/**
 * Task Room 顶部区域（02 Task 7 Step 4）：Task 目标、状态、当前责任人，
 * 以及只对「已接受任务的当前责任人」开放的 提交验收/完成/取消 行动。
 * 行动走真实 mutation；pending 时禁用；失败展示 requestId。
 */
import { TaskReviewEligibilitySchema } from '@whalepod/protocol'
import type { TaskReviewEligibility } from '@whalepod/protocol'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useEffect, useState, type ReactNode } from 'react'
import { Link } from 'react-router'
import { api } from '../../shared/api/client.js'
import { ErrorBanner } from '../../app/ErrorBanner.js'
import { ConfirmDialog } from '../../shared/ConfirmDialog.js'
import { ASSIGNMENT_STATUS_LABEL, TASK_STATUS_LABEL } from '../../shared/format.js'
import { RelativeTime } from '../../shared/RelativeTime.js'
import { useMemberDirectory } from '../team/memberDirectory.js'
import { useAgentName } from './useAgentName.js'
import type { Session, TaskView } from '../../shared/api/types.js'
import { queryKeys } from '../../app/query-client.js'

export interface TaskHeaderProps {
  task: TaskView
  session: Session | null
  reviewEligibility?: TaskReviewEligibility | undefined
}

type TaskAction = 'submit-review' | 'complete' | 'cancel'

const ACTION_LABEL: Readonly<Record<TaskAction, string>> = {
  'submit-review': '提交验收',
  complete: '完成任务',
  cancel: '取消任务',
}

const ACTION_CONFIRM: Readonly<Record<TaskAction, string>> = {
  'submit-review': '将任务提交验收？提交后进入待验收；复核意见由你判断，最终仍需责任人确认完成。',
  complete: '确认已检查交付物并完成任务？Agent 复核不会自动完成任务。',
  cancel: '取消任务？有活跃 Run 时 Hub 会同步请求取消。',
}

export function TaskHeader({ task, session, reviewEligibility }: TaskHeaderProps): ReactNode {
  const queryClient = useQueryClient()
  // #229：确认中（待确认的行动）；null = 无对话框。
  const [confirming, setConfirming] = useState<TaskAction | null>(null)
  const [error, setError] = useState<unknown>(null)
  const directory = useMemberDirectory()
  // #239：Agent 执行者的显示名（member 指派为 null，不发请求）。
  const agent = useAgentName(task.assigneeAgentId)

  const isAssignee = session !== null && task.assigneeUserId === session.userId
  const canAct = isAssignee && task.assignmentStatus === 'accepted'
  const checked = TaskReviewEligibilitySchema.safeParse(reviewEligibility)
  const canSubmit = checked.success && checked.data.allowed
  const reviewReason = !checked.success
    ? '暂时无法确认验收条件，请刷新任务后重试。'
    : checked.data.reason === 'active_run'
      ? '执行仍在进行。请由责任人等待执行结束或取消后再提交。'
      : checked.data.reason === 'no_published_artifact'
        ? '请先检查并发布至少一个交付物，再由责任人提交验收。'
        : checked.data.reason === null
          ? '已满足提交条件；提交和最终完成由真人确认。'
          : '当前责任人接受任务并开始推进后，才能提交验收。'

  const confirmingAllowed =
    canAct &&
    (confirming === 'submit-review'
      ? task.status === 'in_progress' && canSubmit
      : confirming === 'complete'
        ? task.status === 'in_review'
        : confirming === 'cancel' && task.status !== 'done' && task.status !== 'cancelled')
  useEffect(() => {
    if (confirming !== null && !confirmingAllowed) setConfirming(null)
  }, [confirming, confirmingAllowed])

  const mutation = useMutation({
    mutationFn: (kind: TaskAction) => api.mutate<TaskView>(`/tasks/${task.id}/${kind}`),
    onSuccess: () => {
      setConfirming(null)
      setError(null)
      // 成功后精确失效该 Task 的 Room 查询（02 Task 7 Step 6）。
      void queryClient.invalidateQueries({ queryKey: queryKeys.taskRoom(task.id) })
    },
    onError: (mutationError: unknown) => {
      setError(mutationError)
    },
  })

  const run = (kind: TaskAction): void => {
    if (mutation.isPending) return
    setError(null)
    // #229：window.confirm → ConfirmDialog（原生 confirm 阻塞主线程、键盘与
    // 焦点行为与产品形态脱节）；确认才发 mutation，语义不变。
    setConfirming(kind)
  }

  // #162：责任人写人名（显示名（@用户名）），不写 `shortId()`。视角词「你」保留：
  // 它不是身份标识，而是「这个人就是你」的短说。查不到人时由名录给人话兜底。
  const assigneeLabel = isAssignee ? '你' : directory.personOf(task.assigneeUserId)

  return (
    <header className="task-header">
      {/* #225：离开任务房间不只有侧栏一条路（与权限页「回到任务房间」方向一致）。 */}
      <p className="mutation-hint">
        <Link to="/" data-testid="task-back-link">
          ← 回到项目列表
        </Link>
      </p>
      <div className="task-header-title">
        <h1>{task.title}</h1>
        <span className={`badge badge-task badge-task-${task.status}`}>
          {TASK_STATUS_LABEL[task.status]}
        </span>
        <span className={`badge badge-assignment`}>
          {ASSIGNMENT_STATUS_LABEL[task.assignmentStatus]}
        </span>
      </div>
      <dl className="task-meta">
        <div>
          <dt>当前责任人</dt>
          {/* #162 判据锚点：这一格必须说出「是谁」（显示名或明确兜底），不得是短 id。
              #239：Agent 指派时这格仍是**真人**（做出指派的人）——责任在人；Agent 另列一格。 */}
          <dd data-testid="task-assignee">{assigneeLabel}</dd>
        </div>
        {task.assigneeAgentId !== null ? (
          <div>
            <dt>执行 Agent</dt>
            <dd data-testid="task-agent">{agent?.name}</dd>
          </div>
        ) : null}
        <div>
          <dt>创建时间</dt>
          <dd>
            <RelativeTime iso={task.createdAt} />
          </dd>
        </div>
        {task.acceptedAt !== null ? (
          <div>
            <dt>接受时间</dt>
            <dd>
              <RelativeTime iso={task.acceptedAt} />
            </dd>
          </div>
        ) : null}
        {task.completedAt !== null ? (
          <div>
            <dt>完成时间</dt>
            <dd>
              <RelativeTime iso={task.completedAt} />
            </dd>
          </div>
        ) : null}
      </dl>
      {task.description !== '' ? <p className="task-description">{task.description}</p> : null}
      {/* 切片⑥e：任务级「谁能驱动 Agent」入口。放头部而不是执行栏：授权是低频操作，
          独立成页后从这里进（也可从成员页进）。 */}
      <p className="mutation-hint">
        <Link to={`/tasks/${task.id}/permissions`} data-testid="task-permissions-link">
          谁能驱动这个任务的 Agent →
        </Link>
      </p>

      {canAct ? (
        <div id="task-actions" tabIndex={-1} className="task-actions" aria-label="任务行动">
          <span className="visually-hidden">仅当前责任人可用</span>
          {task.status === 'in_progress' ? (
            <button
              type="button"
              className="button"
              disabled={mutation.isPending || !canSubmit}
              onClick={() => run('submit-review')}
            >
              提交验收
            </button>
          ) : null}
          {task.status === 'in_review' ? (
            <button
              type="button"
              className="button button-primary"
              disabled={mutation.isPending}
              onClick={() => run('complete')}
            >
              完成任务
            </button>
          ) : null}
          {task.status !== 'done' && task.status !== 'cancelled' ? (
            <button
              type="button"
              className="button button-danger"
              disabled={mutation.isPending}
              onClick={() => run('cancel')}
            >
              取消任务
            </button>
          ) : null}
          {mutation.isPending ? <span className="mutation-hint">正在提交…</span> : null}
        </div>
      ) : isAssignee ? (
        <p className="mutation-hint">接受任务后即可提交验收、完成或取消任务。</p>
      ) : null}
      {canAct && task.status === 'in_progress' ? (
        <p className="mutation-hint" role="status" data-testid="review-condition">
          {reviewReason}
        </p>
      ) : null}
      {error !== null ? <ErrorBanner error={error} /> : null}
      {confirming !== null ? (
        <ConfirmDialog
          open
          title={`${ACTION_LABEL[confirming]}？`}
          body={ACTION_CONFIRM[confirming]}
          confirmLabel={`确认${ACTION_LABEL[confirming]}`}
          danger={confirming === 'cancel'}
          pending={mutation.isPending}
          onConfirm={() => {
            if (confirmingAllowed) mutation.mutate(confirming)
          }}
          onCancel={() => setConfirming(null)}
        />
      ) : null}
    </header>
  )
}
