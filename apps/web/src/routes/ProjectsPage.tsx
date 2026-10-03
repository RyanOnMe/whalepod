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
import type { CreateProjectRequest, CreateTaskRequest } from '@whalepod/protocol'
import { useNavigate } from 'react-router'
import { api } from '../shared/api/client.js'
import { ErrorBanner } from '../app/ErrorBanner.js'
import { useSession } from '../app/session.js'
import { pushToast } from '../app/toast.js'
import { SelectMenu } from '../shared/SelectMenu.js'
import { RelativeTime } from '../shared/RelativeTime.js'
import { TASK_STATUS_LABEL } from '../shared/format.js'
import { useMemberDirectory } from '../features/team/memberDirectory.js'
import type { AssignmentDriveView, AgentView, ProjectView, TaskView } from '../shared/api/types.js'
import { queryKeys } from '../app/query-client.js'
import { useHashFocus } from '../shared/useHashFocus.js'

export function ProjectsPage(): ReactNode {
  const queryClient = useQueryClient()
  const navigate = useNavigate()
  const listQuery = useQuery({
    queryKey: queryKeys.projects,
    queryFn: () => api.get<ProjectView[]>('/projects'),
  })
  // #263：⌘K 搜到项目后落到 `/#project-<id>`——列表落地后把目标卡片标出来。
  useHashFocus(listQuery.isSuccess)
  // 创建者姓名（#152）：成员名录解析，解析不到给「未知成员」——不把创建者写成
  // 截断 UUID（实测截图里的 `by 01a08c11`）。
  const { nameOf } = useMemberDirectory()
  const [creatingFor, setCreatingFor] = useState<string | null>(null)
  const [listOpenFor, setListOpenFor] = useState<string | null>(null)
  // #152：创建项目表单默认收起——常驻展开会把项目列表与「任务列表」入口挤出首屏。
  // 交互与「创建任务」同款：一个按钮 + aria-expanded，点开才渲染表单。
  const [creatingProject, setCreatingProject] = useState(false)

  return (
    <div className="projects-page">
      <div className="page-head">
        <h1>项目</h1>
        <button
          type="button"
          className="button"
          aria-expanded={creatingProject}
          onClick={() => setCreatingProject(!creatingProject)}
        >
          {creatingProject ? '收起' : '新建项目'}
        </button>
      </div>
      {creatingProject ? (
        <CreateProjectForm
          onCreated={() => {
            void queryClient.invalidateQueries({ queryKey: queryKeys.projects })
            // 建成即收起：结果（新项目卡片）就在下面，不需要占着半屏表单。
            setCreatingProject(false)
          }}
        />
      ) : null}
      {listQuery.isPending ? (
        <div className="room-skeleton" aria-busy="true" data-testid="projects-skeleton">
          {Array.from({ length: 3 }, (_, i) => (
            <span key={i} className="skeleton-line" />
          ))}
        </div>
      ) : null}
      {listQuery.isError ? <ErrorBanner error={listQuery.error} /> : null}
      {listQuery.isSuccess && listQuery.data.length === 0 ? (
        <p className="empty-state">还没有项目——先创建第一个项目，再为它建 Task。</p>
      ) : null}
      {listQuery.isSuccess && listQuery.data.length > 0 ? (
        <ul className="project-list" role="list">
          {listQuery.data.map((project) => (
            <li key={project.id} id={`project-${project.id}`} className="card project-item">
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

  if (tasksQuery.isPending)
    return (
      <div className="room-skeleton" aria-busy="true">
        {Array.from({ length: 3 }, (_, i) => (
          <span key={i} className="skeleton-line" />
        ))}
      </div>
    )
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

/** 创建项目表单（#152 起由页面上的「新建项目」按钮收起/展开后才渲染）。 */
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
  // #239：责任人选择是多态的——成员（value = userId）或 Agent（value = 'agent:<id>'）。
  // 前缀编码而不是第二个 state：SelectMenu 是单值控件，一个受控值就够了。
  const [values, setValues] = useState({ title: '', description: '', assignee: '' })
  const [error, setError] = useState<unknown>(null)
  const session = useSession()
  // 责任人下拉与项目卡/任务列表共用同一份名册（#152 的共用 hook，同一 queryKey）：
  // 只在 hook 里定义策略，避免「同一个 key 两套 staleTime」这种漂移。
  const directory = useMemberDirectory()
  // Agent 候选与 RunLauncher 共用同一 queryKey（queryKeys.agents）。
  const agentsQuery = useQuery({
    queryKey: queryKeys.agents,
    queryFn: () => api.get<AgentView[]>('/agents'),
  })
  // 停用成员不进选择器（03 §2.2 assignee 必须未停用；后端同规则 fail-closed）；
  // 归档 Agent 同理不进（指派给归档 Agent 会被 Hub 400 拒）。
  const selectableMembers = directory.members.filter((m) => m.enabled)
  const selectableAgents = (agentsQuery.data ?? []).filter((a) => a.archivedAt === null)
  const selectedAgentId = values.assignee.startsWith('agent:')
    ? values.assignee.slice('agent:'.length)
    : null
  // 列表就绪后默认选中自己（多数场景是给自己建任务）；用户改选后不覆盖。
  useEffect(() => {
    const preferred =
      selectableMembers.find((m) => m.userId === session?.userId) ?? selectableMembers[0]
    if (preferred === undefined) return
    setValues((prev) => (prev.assignee === '' ? { ...prev, assignee: preferred.userId } : prev))
  }, [directory.members, session?.userId])
  const mutation = useMutation({
    mutationFn: () => {
      const body: CreateTaskRequest =
        selectedAgentId !== null
          ? {
              title: values.title.trim(),
              assigneeAgentId: selectedAgentId,
              ...(values.description.trim() !== ''
                ? { description: values.description.trim() }
                : {}),
            }
          : {
              title: values.title.trim(),
              assigneeUserId: values.assignee,
              ...(values.description.trim() !== ''
                ? { description: values.description.trim() }
                : {}),
            }
      return api.mutate<TaskView & { drive?: AssignmentDriveView }>(
        `/projects/${projectId}/tasks`,
        {
          body,
        },
      )
    },
    onSuccess: (result) => {
      setError(null)
      // #239：指派 Agent 的自动驱动结果如实告知（指派成功≠执行已开始）。
      if (result.drive?.outcome === 'failed') {
        pushToast(`任务已创建，但自动执行未开始（${result.drive.error.code}）——可在执行区手动发起`)
      } else if (result.drive !== undefined) {
        pushToast('任务已创建，Agent 已自动开始执行')
      }
      onCreated(result)
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
        {/* #158：责任人从原生 <select> 换成 vendored Menu 的包装（shared/SelectMenu）。
            id 仍是 #task-assignee-<projectId>（每项目一个，e2e 按前缀定位），
            label 仍指向它；只是元素变成 <button aria-haspopup="menu">。 */}
        <SelectMenu
          id={`task-assignee-${projectId}`}
          label="责任人"
          value={values.assignee}
          placeholder={
            directory.isPending
              ? '正在加载成员…'
              : selectableMembers.length === 0 && selectableAgents.length === 0
                ? '没有可选项'
                : '选择责任人'
          }
          options={[
            ...selectableMembers.map((m) => ({
              value: m.userId,
              label: `${m.displayName}（@${m.username}）${m.userId === session?.userId ? ' · 你' : ''}`,
              disabled: false,
            })),
            ...selectableAgents.map((a) => ({
              value: `agent:${a.id}`,
              label: `${a.name}（Agent · 指派即执行）`,
              disabled: false,
            })),
          ]}
          onChange={(next) => setValues((prev) => ({ ...prev, assignee: next }))}
          disabled={directory.isPending}
        />
        {directory.isError ? <ErrorBanner error={directory.error} /> : null}
        {agentsQuery.isError ? <ErrorBanner error={agentsQuery.error} /> : null}
        {/* #239：选了 Agent 就说清「指派会发生什么」——不让人在不知情下触发执行。 */}
        {selectedAgentId !== null ? (
          <p className="mutation-hint" data-testid="agent-assign-hint">
            指派给 Agent 会立即以任务标题与描述作为指令开始执行；验收与审批仍在你手上。
          </p>
        ) : null}
      </div>
      <div className="form-actions">
        {/* #158 起这条空值守卫是本表单**唯一**的拦截：责任人从原生
            `<select required>` 换成按钮触发器后，浏览器侧的「不选不放行」随 required
            一起消失（按钮不是表单可校验元素）。评审实测：成员列表未落地时默认选中
            拿不到值，缺这条守卫会发出 `assigneeUserId: ""` 的请求，被协议层
            z.uuid() 拒成 400（packages/protocol/src/http.ts）。别删。
            #239：守卫口径从「assigneeUserId 非空」改为「选择值非空」（成员或 Agent）。 */}
        <button
          type="submit"
          className="button button-primary"
          disabled={mutation.isPending || values.assignee === ''}
        >
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
