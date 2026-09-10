/**
 * Task Room 左侧区域（02 Task 7 Step 4）：Assignment 接受/拒绝 +
 * Agent revision 快照插槽。
 *
 * 快照插槽是空态插槽：Task Room 聚合视图（task/view.ts）目前不含 Agent 与
 * Profile Revision 数据（Run 数据随后续版本落 HTTP），因此这里只说明「Run
 * 创建后将显示什么」，不伪造内容。
 */
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useState, type ReactNode } from 'react'
import { api } from '../../shared/api/client.js'
import { ErrorBanner } from '../../app/ErrorBanner.js'
import { ASSIGNMENT_STATUS_LABEL } from '../../shared/format.js'
import { useMemberDirectory } from '../team/memberDirectory.js'
import type { Session, TaskView } from '../../shared/api/types.js'
import { queryKeys } from '../../app/query-client.js'

export interface AssignmentPanelProps {
  task: TaskView
  session: Session | null
}

export function AssignmentPanel({ task, session }: AssignmentPanelProps): ReactNode {
  const queryClient = useQueryClient()
  const [error, setError] = useState<unknown>(null)
  const isAssignee = session !== null && task.assigneeUserId === session.userId
  const directory = useMemberDirectory()

  const mutation = useMutation({
    mutationFn: (kind: 'accept' | 'reject') => api.mutate<TaskView>(`/tasks/${task.id}/${kind}`),
    onSuccess: () => {
      setError(null)
      void queryClient.invalidateQueries({ queryKey: queryKeys.taskRoom(task.id) })
    },
    onError: (mutationError: unknown) => {
      setError(mutationError)
    },
  })

  const decide = (kind: 'accept' | 'reject'): void => {
    if (mutation.isPending) return
    setError(null)
    mutation.mutate(kind)
  }

  let body: ReactNode
  if (task.assignmentStatus === 'accepted') {
    body = (
      <>
        <p className="assignment-note">
          {/* 视角区分：对责任人是你；对 Owner/Admin 与其他成员是第三方陈述。 */}
          {isAssignee ? '你已接受此任务。' : '责任人已接受此任务。'}
        </p>
        <section className="snapshot-slot" aria-label="Agent 快照">
          <h3>Agent 快照</h3>
          <p className="empty-state">
            Run 创建后，这里会显示该 Run 使用的 Agent 与 Profile Revision 快照（数据随 Run
            创建接口提供）。
          </p>
        </section>
      </>
    )
  } else if (task.assignmentStatus === 'rejected') {
    body = <p className="assignment-note">此任务已被拒绝，等待所有者或管理员重新指派。</p>
  } else if (isAssignee) {
    body = (
      <>
        <p className="assignment-note">你被指派负责此任务，请接受或拒绝。</p>
        <div className="assignment-actions">
          <button
            type="button"
            className="button button-primary"
            disabled={mutation.isPending}
            onClick={() => decide('accept')}
          >
            接受任务
          </button>
          <button
            type="button"
            className="button"
            disabled={mutation.isPending}
            onClick={() => decide('reject')}
          >
            拒绝任务
          </button>
        </div>
        {mutation.isPending ? <span className="mutation-hint">正在提交…</span> : null}
      </>
    )
  } else {
    body = (
      // #162：第三方陈述里的责任人写人名（此前是 `shortId()`）。判据锚点在句子上，
      // 因为「谁在等」这件事在这句话里，而不在某个独立的姓名格子里。
      <p className="assignment-note" data-testid="assignment-assignee-note">
        此任务分配给 {directory.personOf(task.assigneeUserId)}，等待其接受。
      </p>
    )
  }

  return (
    <section className="card assignment-panel" aria-labelledby="assignment-heading">
      <h2 id="assignment-heading">任务分配</h2>
      <div className="assignment-status">
        状态：
        <span className={`badge badge-assignment`}>
          {ASSIGNMENT_STATUS_LABEL[task.assignmentStatus]}
        </span>
      </div>
      {body}
      {error !== null ? <ErrorBanner error={error} /> : null}
    </section>
  )
}
