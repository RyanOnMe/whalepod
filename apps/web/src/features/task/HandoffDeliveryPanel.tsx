/**
 * 上游「已交接」面板（#380；ADR-0017 §5）：把已发布交接版本交付给成员，
 * 并追踪每条接收关系的状态（待确认 / 已确认理解）。
 *
 * 交付 = 选成员 + 新建同项目下游任务（责任人 = 被选成员）或关联该成员名下的
 * 既有任务；交付只是建立接收关系（pending receipt），不建 Run、不改任务状态。
 * 只有上游 Task 责任人能交付（服务端 403 收口；这里对非责任人只展示）。
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useMemo, useState, type ReactNode } from 'react'
import { Link } from 'react-router'
import { api } from '../../shared/api/client.js'
import { ErrorBanner } from '../../app/ErrorBanner.js'
import { queryKeys } from '../../app/query-client.js'
import { SelectMenu } from '../../shared/SelectMenu.js'
import { useMemberDirectory } from '../team/memberDirectory.js'
import type {
  HandoffReceiptView,
  HandoffRevisionView,
  Session,
  TaskView,
} from '../../shared/api/types.js'

export function HandoffDeliveryPanel({
  task,
  session,
}: {
  task: TaskView
  session: Session
}): ReactNode {
  const queryClient = useQueryClient()
  const directory = useMemberDirectory()
  const [revisionId, setRevisionId] = useState('')
  const [receiverId, setReceiverId] = useState('')
  const [downstreamTaskId, setDownstreamTaskId] = useState('')
  const [newTitle, setNewTitle] = useState('')
  const [actionError, setActionError] = useState<unknown>(null)

  const revisions = useQuery({
    queryKey: queryKeys.taskHandoffRevisions(task.id),
    queryFn: () => api.get<HandoffRevisionView[]>(`/tasks/${task.id}/handoff-revisions`),
  })
  const deliveries = useQuery({
    queryKey: queryKeys.taskHandoffDeliveries(task.id),
    queryFn: () => api.get<HandoffReceiptView[]>(`/tasks/${task.id}/handoff-deliveries`),
  })
  // 关联既有任务：同项目、责任人 = 被选成员、未完结（服务端还会复核一遍）。
  const projectTasks = useQuery({
    queryKey: queryKeys.projectTasks(task.projectId),
    queryFn: () => api.get<TaskView[]>(`/projects/${task.projectId}/tasks`),
  })

  const deliver = useMutation({
    mutationFn: () =>
      api.mutate<HandoffReceiptView>(`/handoff-revisions/${revisionId}/deliver`, {
        body: {
          receiverUserId: receiverId,
          ...(downstreamTaskId !== ''
            ? { downstreamTaskId }
            : { newTask: { title: newTitle.trim() } }),
        },
      }),
    onSuccess: () => {
      setActionError(null)
      setDownstreamTaskId('')
      setNewTitle('')
      void queryClient.invalidateQueries({ queryKey: queryKeys.taskHandoffDeliveries(task.id) })
      void queryClient.invalidateQueries({ queryKey: queryKeys.projectTasks(task.projectId) })
    },
    onError: (error: unknown) => setActionError(error),
  })

  const linkableTasks = useMemo(
    () =>
      (projectTasks.data ?? []).filter(
        (candidate) =>
          candidate.assigneeUserId === receiverId &&
          candidate.status !== 'done' &&
          candidate.status !== 'cancelled',
      ),
    [projectTasks.data, receiverId],
  )
  const published = revisions.data ?? []
  const rows = deliveries.data ?? []
  const canDeliver = session.userId === task.assigneeUserId

  if (published.length === 0 && rows.length === 0) return null
  const busy = deliver.isPending
  const ready =
    revisionId !== '' &&
    receiverId !== '' &&
    (downstreamTaskId !== '' || newTitle.trim() !== '') &&
    !busy

  return (
    <section
      className="card handoff-delivery"
      data-testid="handoff-delivery-panel"
      aria-label="已交接"
    >
      <div className="room-column-head">
        <h2>已交接</h2>
        <span className="room-column-note">交付只建立接收关系；确认与执行都在接收方</span>
      </div>
      {actionError !== null ? <ErrorBanner error={actionError} /> : null}

      {rows.length === 0 ? (
        <p className="mutation-hint" data-testid="handoff-delivery-none">
          这份交接包还没有交付给任何人。
        </p>
      ) : (
        <ul className="handoff-delivery-list" data-testid="handoff-delivery-list">
          {rows.map((row) => (
            <li key={row.id}>
              {`v${row.revisionNumber} → `}
              <Link to={`/tasks/${row.downstreamTaskId}`}>{row.downstreamTaskTitle}</Link>
              {`（${directory.personOf(row.receiverUserId)}）`}
              {row.status === 'pending' ? (
                <span className="badge" data-testid={`handoff-delivery-pending-${row.id}`}>
                  待确认
                </span>
              ) : (
                <span data-testid={`handoff-delivery-confirmed-${row.id}`}>
                  {`已确认：${row.understanding ?? ''}`}
                </span>
              )}
            </li>
          ))}
        </ul>
      )}

      {canDeliver && published.length > 0 ? (
        <div className="handoff-deliver-form" data-testid="handoff-deliver-form">
          <SelectMenu
            id={`handoff-revision-${task.id}`}
            label="交接版本"
            value={revisionId}
            disabled={busy}
            placeholder="选择要交付的版本…"
            options={published.map((revision) => ({
              value: revision.id,
              label: `v${revision.revisionNumber}（${new Date(revision.publishedAt).toLocaleDateString()}）`,
              disabled: false,
            }))}
            onChange={setRevisionId}
          />
          <SelectMenu
            id={`handoff-receiver-${task.id}`}
            label="交付给"
            value={receiverId}
            disabled={busy || directory.isPending}
            placeholder="选择成员…"
            options={directory.members.map((member) => ({
              value: member.userId,
              label: member.displayName,
              disabled: false,
            }))}
            onChange={(next) => {
              setReceiverId(next)
              setDownstreamTaskId('')
            }}
          />
          {receiverId !== '' ? (
            <>
              <SelectMenu
                id={`handoff-downstream-${task.id}`}
                label="下游任务"
                value={downstreamTaskId}
                disabled={busy}
                options={[
                  // 不传 placeholder：空串就是「新建任务」这个真实选项（placeholder 项
                  // 的 id 也是空串，两者并存在 vendored Menu 里会撞条目）。
                  { value: '', label: '新建任务', disabled: false },
                  ...linkableTasks.map((candidate) => ({
                    value: candidate.id,
                    label: candidate.title,
                    disabled: false,
                  })),
                ]}
                onChange={setDownstreamTaskId}
              />
              {downstreamTaskId === '' ? (
                <label className="handoff-field">
                  <span>新任务标题</span>
                  <input
                    className="input"
                    aria-label="新任务标题"
                    value={newTitle}
                    onChange={(event) => setNewTitle(event.target.value)}
                  />
                </label>
              ) : null}
              <button
                type="button"
                className="button button-primary"
                disabled={!ready}
                onClick={() => deliver.mutate()}
              >
                交付给该成员
              </button>
            </>
          ) : null}
        </div>
      ) : null}
      {!canDeliver && published.length > 0 ? (
        <p className="mutation-hint">只有任务责任人能发起交付。</p>
      ) : null}
    </section>
  )
}
