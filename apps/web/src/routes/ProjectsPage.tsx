/**
 * Project 列表（02 Task 7 Interfaces：浏览流程 Setup/Login → Project → Task Room）。
 *
 * 已知缺口：GET /projects/:projectId/tasks（按项目列 Task）不在 P1-06 的 Hub 路由表里，
 * 因此本项目页不伪造 Task 列表；每个 Project 提供「创建任务」，创建成功后直接进入
 * 新建 Task 的 Task Room。成员选择器由 #136 提供（GET /team/members + 下拉，
 * 停用成员不进选择器——不再手贴 UUID）；创建者/责任人姓名由 #152 的成员名录
 * （features/team/memberDirectory）解析，解析不到给人话而不是短 UUID。
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useEffect, useState, type FormEvent, type ReactNode } from 'react'
import type { CreateProjectRequest, CreateTaskRequest, TeamMemberView } from '@whalepod/protocol'
import { useNavigate } from 'react-router'
import { api } from '../shared/api/client.js'
import { ErrorBanner } from '../app/ErrorBanner.js'
import { useSession } from '../app/session.js'
import { RelativeTime } from '../shared/RelativeTime.js'
import { TASK_STATUS_LABEL } from '../shared/format.js'
import { useMemberDirectory } from '../features/team/memberDirectory.js'
import type { ProjectView, TaskView } from '../shared/api/types.js'
import { queryKeys } from '../app/query-client.js'

export function ProjectsPage(): ReactNode {
  const queryClient = useQueryClient()
  const navigate = useNavigate()
  const listQuery = useQuery({
    queryKey: queryKeys.projects,
    queryFn: () => api.get<ProjectView[]>('/projects'),
  })
  // 创建者姓名（#152）：成员名录解析，解析不到给「未知成员」——不把创建者写成
  // 截断 UUID（实测截图里的 `by 01a08c11`）。
  const { nameOf } = useMemberDirectory()
  const [creatingFor, setCreatingFor] = useState<string | null>(null)
  const [listOpenFor, setListOpenFor] = useState<string | null>(null)

  return (
    <div className="projects-page">
      <h1>项目</h1>
      <CreateProjectForm
        onCreated={() => void queryClient.invalidateQueries({ queryKey: queryKeys.projects })}
      />
      {listQuery.isPending ? <p className="mutation-hint">正在加载项目…</p> : null}
      {listQuery.isError ? <ErrorBanner error={listQuery.error} /> : null}
      {listQuery.isSuccess && listQuery.data.length === 0 ? (
        <p className="empty-state">还没有项目——先创建第一个项目，再为它建 Task。</p>
      ) : null}
      {listQuery.isSuccess && listQuery.data.length > 0 ? (
        <ul className="project-list" role="list">
          {listQuery.data.map((project) => (
            <li key={project.id} className="card project-item">
              <div className="project-title">
                <h2>{project.name}</h2>
                <span className="project-meta">
                  创建于 <RelativeTime iso={project.createdAt} /> · 创建者{' '}
                  {nameOf(project.createdBy)}
                </span>
              </div>
              {project.description !== '' ? (
                <p className="project-description">{project.description}</p>
              ) : null}
              <div className="project-actions">
                <button
                  type="button"
                  className="button button-quiet"
                  aria-expanded={creatingFor === project.id}
                  onClick={() => setCreatingFor(creatingFor === project.id ? null : project.id)}
                >
                  {creatingFor === project.id ? '收起' : '创建任务'}
                </button>
                <button
                  type="button"
                  className="button button-quiet"
                  aria-expanded={listOpenFor === project.id}
                  onClick={() => setListOpenFor(listOpenFor === project.id ? null : project.id)}
                >
                  {listOpenFor === project.id ? '收起任务列表' : '任务列表'}
                </button>
              </div>
              {listOpenFor === project.id ? (
                <ProjectTaskList projectId={project.id} onOpen={(id) => navigate(`/tasks/${id}`)} />
              ) : null}
              {creatingFor === project.id ? (
                <CreateTaskForm
                  projectId={project.id}
                  onCreated={(task) => navigate(`/tasks/${task.id}`)}
                  onClose={() => setCreatingFor(null)}
                />
              ) : null}
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  )
}

/**
 * 项目任务列表（#137）：Task 建好后一旦离开 Task Room，此前没有任何界面入口能再
 * 找回它（URL 里的 UUID 没人记得住）。列表只读项目自己的任务（跨项目隔离由 Hub
 * 保证），责任人显示名复用 #152 的成员名录（与项目卡的创建者同一份解析与缓存）。
 */
function ProjectTaskList({
  projectId,
  onOpen,
}: {
  projectId: string
  onOpen: (taskId: string) => void
}): ReactNode {
  const tasksQuery = useQuery({
    queryKey: queryKeys.projectTasks(projectId),
    queryFn: () => api.get<TaskView[]>(`/projects/${projectId}/tasks`),
  })
  const { nameOf } = useMemberDirectory()

  if (tasksQuery.isPending) return <p className="mutation-hint">正在加载任务…</p>
  if (tasksQuery.isError) return <ErrorBanner error={tasksQuery.error} />
  const tasks = tasksQuery.data ?? []
  if (tasks.length === 0) return <p className="empty-state">这个项目还没有任务。</p>
  return (
    <ul className="task-list" role="list" aria-label="项目任务列表">
      {tasks.map((task) => (
        <li key={task.id} className="task-list-item">
          <button type="button" className="task-link" onClick={() => onOpen(task.id)}>
            {task.title}
          </button>
          <span className="task-meta">
            {TASK_STATUS_LABEL[task.status]} · 责任人 {nameOf(task.assigneeUserId)} · 更新于{' '}
            <RelativeTime iso={task.updatedAt} />
          </span>
        </li>
      ))}
    </ul>
  )
}

function CreateProjectForm({ onCreated }: { onCreated: () => void }): ReactNode {
  const [values, setValues] = useState({ name: '', description: '' })
  const [error, setError] = useState<unknown>(null)
  const mutation = useMutation({
    mutationFn: () => {
      const body: CreateProjectRequest = {
        name: values.name.trim(),
        ...(values.description.trim() !== '' ? { description: values.description.trim() } : {}),
      }
      return api.mutate<ProjectView>('/projects', { body })
    },
    onSuccess: () => {
      setValues({ name: '', description: '' })
      setError(null)
      onCreated()
    },
    onError: (mutationError: unknown) => {
      setError(mutationError)
    },
  })
  const submit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault()
    if (mutation.isPending) return
    setError(null)
    mutation.mutate()
  }
  return (
    <form className="card inline-form" onSubmit={submit} aria-label="创建项目">
      <div className="field">
        <label htmlFor="project-name">项目名称</label>
        <input
          id="project-name"
          value={values.name}
          onChange={(event) => setValues((prev) => ({ ...prev, name: event.target.value }))}
          required
          maxLength={120}
        />
      </div>
      <div className="field">
        <label htmlFor="project-description">描述（可选）</label>
        <input
          id="project-description"
          value={values.description}
          onChange={(event) => setValues((prev) => ({ ...prev, description: event.target.value }))}
          maxLength={4000}
        />
      </div>
      <div className="form-actions">
        <button type="submit" className="button button-primary" disabled={mutation.isPending}>
          {mutation.isPending ? '创建中…' : '创建项目'}
        </button>
      </div>
      {error !== null ? <ErrorBanner error={error} /> : null}
    </form>
  )
}

function CreateTaskForm({
  projectId,
  onCreated,
  onClose,
}: {
  projectId: string
  onCreated: (task: TaskView) => void
  onClose: () => void
}): ReactNode {
  const [values, setValues] = useState({ title: '', description: '', assigneeUserId: '' })
  const [error, setError] = useState<unknown>(null)
  const session = useSession()
  const membersQuery = useQuery({
    queryKey: queryKeys.teamMembers,
    queryFn: () => api.get<TeamMemberView[]>('/team/members'),
  })
  // 停用成员不进选择器（03 §2.2 assignee 必须未停用；后端同规则 fail-closed）。
  const selectableMembers = (membersQuery.data ?? []).filter((m) => m.enabled)
  // 列表就绪后默认选中自己（多数场景是给自己建任务）；用户改选后不覆盖。
  useEffect(() => {
    const preferred =
      selectableMembers.find((m) => m.userId === session?.userId) ?? selectableMembers[0]
    if (preferred === undefined) return
    setValues((prev) =>
      prev.assigneeUserId === '' ? { ...prev, assigneeUserId: preferred.userId } : prev,
    )
  }, [membersQuery.data, session?.userId])
  const mutation = useMutation({
    mutationFn: () => {
      const body: CreateTaskRequest = {
        title: values.title.trim(),
        assigneeUserId: values.assigneeUserId.trim(),
        ...(values.description.trim() !== '' ? { description: values.description.trim() } : {}),
      }
      return api.mutate<TaskView>(`/projects/${projectId}/tasks`, { body })
    },
    onSuccess: (task) => {
      setError(null)
      onCreated(task)
    },
    onError: (mutationError: unknown) => {
      setError(mutationError)
    },
  })
  const submit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault()
    if (mutation.isPending) return
    setError(null)
    mutation.mutate()
  }
  return (
    <form className="inline-form" onSubmit={submit} aria-label="创建任务">
      <div className="field">
        <label htmlFor={`task-title-${projectId}`}>任务标题</label>
        <input
          id={`task-title-${projectId}`}
          value={values.title}
          onChange={(event) => setValues((prev) => ({ ...prev, title: event.target.value }))}
          required
          maxLength={200}
        />
      </div>
      <div className="field">
        <label htmlFor={`task-desc-${projectId}`}>描述（可选）</label>
        <textarea
          id={`task-desc-${projectId}`}
          rows={3}
          value={values.description}
          onChange={(event) => setValues((prev) => ({ ...prev, description: event.target.value }))}
          maxLength={20_000}
        />
      </div>
      <div className="field">
        <label htmlFor={`task-assignee-${projectId}`}>责任人</label>
        <select
          id={`task-assignee-${projectId}`}
          value={values.assigneeUserId}
          onChange={(event) =>
            setValues((prev) => ({ ...prev, assigneeUserId: event.target.value }))
          }
          required
          disabled={membersQuery.isPending}
        >
          <option value="" disabled>
            {membersQuery.isPending
              ? '正在加载成员…'
              : selectableMembers.length === 0
                ? '没有可选成员'
                : '选择责任人'}
          </option>
          {selectableMembers.map((m) => (
            <option key={m.userId} value={m.userId}>
              {m.displayName}（@{m.username}）{m.userId === session?.userId ? ' · 你' : ''}
            </option>
          ))}
        </select>
        {membersQuery.isError ? <ErrorBanner error={membersQuery.error} /> : null}
      </div>
      <div className="form-actions">
        <button type="submit" className="button button-primary" disabled={mutation.isPending}>
          {mutation.isPending ? '创建中…' : '创建任务'}
        </button>
        <button type="button" className="button button-quiet" onClick={onClose}>
          取消
        </button>
      </div>
      {error !== null ? <ErrorBanner error={error} /> : null}
    </form>
  )
}
