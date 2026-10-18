/**
 * Task Room 左侧区域（02 Task 7 Step 4）：Assignment 接受/拒绝 +
 * Agent revision 快照插槽。
 *
 * 快照插槽是空态插槽：Task Room 聚合视图（task/view.ts）目前不含 Agent 与
 * Profile Revision 数据（Run 数据随后续版本落 HTTP），因此这里只说明「Run
 * 创建后将显示什么」，不伪造内容。
 */
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useRef, useState, type FormEvent, type ReactNode } from 'react'
import { api } from '../../shared/api/client.js'
import { isApiError } from '../../shared/api/errors.js'
import { SelectMenu } from '../../shared/SelectMenu.js'
import { ErrorBanner } from '../../app/ErrorBanner.js'
import { ASSIGNMENT_STATUS_LABEL } from '../../shared/format.js'
import { useMemberDirectory } from '../team/memberDirectory.js'
import { useAgentName } from './useAgentName.js'
import type { Session, TaskView } from '../../shared/api/types.js'
import { queryKeys } from '../../app/query-client.js'

export interface AssignmentPanelProps {
  task: TaskView
  session: Session | null
  hasActiveRun: boolean
  compact?: boolean
}

export function AssignmentPanel({
  task,
  session,
  hasActiveRun,
  compact = false,
}: AssignmentPanelProps): ReactNode {
  const queryClient = useQueryClient()
  const [error, setError] = useState<unknown>(null)
  const isAssignee = session !== null && task.assigneeUserId === session.userId
  const directory = useMemberDirectory()
  // #239：Agent 执行者的显示名（member 指派为 null，不发请求）。
  const agent = useAgentName(task.assigneeAgentId)

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
  if (task.assigneeAgentId !== null) {
    // #239（ADR-0009 决策 6）：Agent 指派没有受理动作——指派即受理即驱动。
    // 不渲染 accept/reject（对 Agent-task 这两个端点恒 409），把「谁负责」说清楚。
    body = (
      <p className="assignment-note" data-testid="assignment-agent-note">
        此任务由 {isAssignee ? '你' : directory.personOf(task.assigneeUserId)} 指派给 Agent
        {agent === null ? '' : `「${agent.name}」`}执行——指派即驱动，无需接受。责任人
        {isAssignee ? '是你' : `是 ${directory.personOf(task.assigneeUserId)}`}
        ，验收与审批都在责任人手上。
      </p>
    )
  } else if (task.assignmentStatus === 'accepted') {
    body = (
      <>
        <p className="assignment-note">
          {/* 视角区分：对责任人是你；对 Owner/Admin 与其他成员是第三方陈述。 */}
          {isAssignee ? '你已接受此任务。' : '责任人已接受此任务。'}
        </p>
        {!compact ? (
          <section className="snapshot-slot" aria-label="Agent 快照">
            <h3>Agent 快照</h3>
            <p className="empty-state">
              Run 创建后，这里会显示该 Run 使用的 Agent 与 Profile Revision 快照（数据随 Run
              创建接口提供）。
            </p>
          </section>
        ) : null}
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

  if (compact && task.assignmentStatus === 'accepted') return null

  return (
    <section
      id="task-assignment"
      tabIndex={-1}
      className="card assignment-panel"
      aria-labelledby="assignment-heading"
    >
      <h2 id="assignment-heading" className={compact ? 'visually-hidden' : undefined}>
        任务分配
      </h2>
      <div className="assignment-status" hidden={compact && task.assignmentStatus === 'accepted'}>
        状态：
        <span className={`badge badge-assignment`}>
          {ASSIGNMENT_STATUS_LABEL[task.assignmentStatus]}
        </span>
      </div>
      {body}
      {task.assignmentStatus === 'rejected' &&
      task.status !== 'done' &&
      task.status !== 'cancelled' &&
      session !== null &&
      (session.role === 'owner' || session.role === 'admin') ? (
        hasActiveRun ? (
          <p className="mutation-hint">有运行进行中，结束后才能重新指派。</p>
        ) : (
          <ReassignmentForm task={task} />
        )
      ) : null}
      {error !== null ? <ErrorBanner error={error} /> : null}
    </section>
  )
}

/** 拒绝后的恢复入口：保留既有授权与候选拥有关系，不自动接受新责任。 */
function ReassignmentForm({ task }: { task: TaskView }): ReactNode {
  const directory = useMemberDirectory()
  const queryClient = useQueryClient()
  const [open, setOpen] = useState(false)
  const [userId, setUserId] = useState('')
  const key = useRef<string | null>(null)
  const candidates = directory.members.filter((member) => member.enabled)
  const mutation = useMutation({
    mutationFn: () =>
      api.mutate<TaskView>(`/tasks/${task.id}/reassign`, {
        body: { assigneeUserId: userId },
        ...(key.current === null ? {} : { idempotencyKey: key.current }),
      }),
    onSuccess: () => {
      setOpen(false)
      setUserId('')
      key.current = null
      for (const queryKey of [
        queryKeys.taskRoom(task.id),
        queryKeys.projectTasks(task.projectId),
        queryKeys.recentTasks,
        queryKeys.instructionGrants(task.id),
      ]) {
        void queryClient.invalidateQueries({ queryKey })
      }
    },
  })
  const submit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault()
    if (userId === '' || mutation.isPending || directory.isPending || directory.isError) return
    key.current ??= crypto.randomUUID()
    mutation.mutate()
  }
  if (!open)
    return (
      <button type="button" className="button button-primary" onClick={() => setOpen(true)}>
        重新指派
      </button>
    )
  return (
    <form onSubmit={submit} aria-label="重新指派任务">
      {directory.isPending ? <p className="mutation-hint">正在读取可指派成员…</p> : null}
      {directory.isError ? <ErrorBanner error={directory.error} /> : null}
      {!directory.isPending && !directory.isError && candidates.length === 0 ? (
        <p className="empty-state">没有可指派的启用成员。</p>
      ) : null}
      <SelectMenu
        id={`reassign-member-${task.id}`}
        label="新责任人"
        value={userId}
        placeholder="选择启用成员…"
        options={candidates.map((member) => ({
          value: member.userId,
          label: directory.personOf(member.userId),
          disabled: false,
        }))}
        disabled={directory.isPending || directory.isError || mutation.isPending}
        onChange={(value) => {
          setUserId(value)
          key.current = null
          mutation.reset()
        }}
      />
      <p className="mutation-hint">
        新责任人需要接受任务。现有指令授权名单会保留，可在权限页检查；历史候选产出仍只属于原拥有者。
      </p>
      {mutation.isError ? <ErrorBanner error={mutation.error} /> : null}
      {isApiError(mutation.error) && mutation.error.code === 'CONFLICT' ? (
        <p className="mutation-hint">运行状态已变化，请查看当前运行，结束后再重新指派。</p>
      ) : null}
      <div className="form-actions">
        <button
          type="submit"
          className="button button-primary"
          disabled={userId === '' || directory.isPending || directory.isError || mutation.isPending}
        >
          确认重新指派
        </button>
        <button
          type="button"
          className="button"
          disabled={mutation.isPending}
          onClick={() => {
            setOpen(false)
            mutation.reset()
          }}
        >
          返回
        </button>
      </div>
    </form>
  )
}
