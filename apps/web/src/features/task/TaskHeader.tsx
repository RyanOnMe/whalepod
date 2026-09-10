/**
 * Task Room 顶部区域（02 Task 7 Step 4）：Task 目标、状态、当前责任人，
 * 以及只对「已接受任务的当前责任人」开放的 提交验收/完成/取消 行动。
 * 行动走真实 mutation；pending 时禁用；失败展示 requestId。
 */
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useState, type ReactNode } from 'react'
import { api } from '../../shared/api/client.js'
import { ErrorBanner } from '../../app/ErrorBanner.js'
import { ASSIGNMENT_STATUS_LABEL, TASK_STATUS_LABEL } from '../../shared/format.js'
import { RelativeTime } from '../../shared/RelativeTime.js'
import { useMemberDirectory } from '../team/memberDirectory.js'
import type { Session, TaskView } from '../../shared/api/types.js'
import { queryKeys } from '../../app/query-client.js'

export interface TaskHeaderProps {
  task: TaskView
  session: Session | null
}

type TaskAction = 'submit-review' | 'complete' | 'cancel'

const ACTION_CONFIRM: Readonly<Record<TaskAction, string>> = {
  'submit-review': '将任务提交验收？提交后由你或 Reviewer 复核并完成。',
  complete: '确认任务已完成并标记 done？',
  cancel: '取消任务？有活跃 Run 时 Hub 会同步请求取消。',
}

export function TaskHeader({ task, session }: TaskHeaderProps): ReactNode {
  const queryClient = useQueryClient()
  const [action, setAction] = useState<TaskAction | null>(null)
  const [error, setError] = useState<unknown>(null)
  const directory = useMemberDirectory()

  const isAssignee = session !== null && task.assigneeUserId === session.userId
  const canAct = isAssignee && task.assignmentStatus === 'accepted'

  const mutation = useMutation({
    mutationFn: (kind: TaskAction) => api.mutate<TaskView>(`/tasks/${task.id}/${kind}`),
    onSuccess: () => {
      setAction(null)
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
    if (!window.confirm(ACTION_CONFIRM[kind])) return
    setAction(kind)
    mutation.mutate(kind)
  }

  // #162：责任人写人名（显示名（@用户名）），不写 `shortId()`。视角词「你」保留：
  // 它不是身份标识，而是「这个人就是你」的短说。查不到人时由名录给人话兜底。
  const assigneeLabel = isAssignee ? '你' : directory.personOf(task.assigneeUserId)

  return (
    <header className="task-header">
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
          {/* #162 判据锚点：这一格必须说出「是谁」（显示名或明确兜底），不得是短 id。 */}
          <dd data-testid="task-assignee">{assigneeLabel}</dd>
        </div>
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

      {canAct ? (
        <div className="task-actions" aria-label="任务行动">
          <span className="visually-hidden">仅当前责任人可用</span>
          {task.status === 'in_progress' ? (
            <button
              type="button"
              className="button"
              disabled={mutation.isPending}
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
      {error !== null ? <ErrorBanner error={error} /> : null}
    </header>
  )
}
