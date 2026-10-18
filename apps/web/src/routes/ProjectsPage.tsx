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
import { useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react'
import type { CreateProjectRequest, CreateTaskRequest } from '@whalepod/protocol'
import { useNavigate } from 'react-router'
import { PageHeader } from '../shared/PageHeader.js'
import { api } from '../shared/api/client.js'
import { assignmentDriveToast, parseAssignmentDrive } from '../shared/assignment-drive.js'
import { ErrorBanner } from '../app/ErrorBanner.js'
import { useSession } from '../app/session.js'
import { pushToast } from '../app/toast.js'
import { SelectMenu } from '../shared/SelectMenu.js'
import { Switch } from '../vendor/dsh-ui/index.js'
import { RelativeTime } from '../shared/RelativeTime.js'
import { TASK_STATUS_LABEL } from '../shared/format.js'
import { useMemberDirectory } from '../features/team/memberDirectory.js'
import {
  createTaskFailureCopy,
  type RejectedSelectionField,
} from '../features/task/createTaskFailure.js'
import type { AgentView, ProjectView, TaskView } from '../shared/api/types.js'
import { PersonalAttention } from '../features/attention/PersonalAttention.js'
import { queryKeys } from '../app/query-client.js'
import { EXIT_PRESENCE_MS } from '../shared/motion.js'
import { useHashFocus } from '../shared/useHashFocus.js'
import { usePresence } from '../shared/usePresence.js'

export function ProjectsPage(): ReactNode {
  const queryClient = useQueryClient()
  const navigate = useNavigate()
  const listQuery = useQuery({
    queryKey: queryKeys.projects,
    queryFn: () => api.get<ProjectView[]>('/projects'),
  })
  // #263：⌘K 搜到项目后落到 `/#project-<id>`——列表落地后把目标卡片标出来。
  useHashFocus(listQuery.isSuccess)
  // #277：骨架的在场语义（数据到了先演完退场再卸载），与任务房同一处理。
  const projectsSkeleton = usePresence(
    listQuery.isPending ? ('skeleton' as const) : null,
    EXIT_PRESENCE_MS,
  )
  // 创建者姓名（#152）：成员名录解析，解析不到给「未知成员」——不把创建者写成
  // 截断 UUID（实测截图里的 `by 01a08c11`）。
  const { nameOf } = useMemberDirectory()
  const [creatingFor, setCreatingFor] = useState<string | null>(null)
  const [listOpenFor, setListOpenFor] = useState<string | null>(null)
  // #152：创建项目表单默认收起——常驻展开会把项目列表与「任务列表」入口挤出首屏。
  // 交互与「创建任务」同款：一个按钮 + aria-expanded，点开才渲染表单。
  const [creatingProject, setCreatingProject] = useState(false)

  return (
    <div className="projects-page secondary-page">
      <PageHeader
        title="项目"
        actions={
          <button
            type="button"
            className="button"
            aria-expanded={creatingProject}
            onClick={() => setCreatingProject(!creatingProject)}
          >
            {creatingProject ? '收起' : '新建项目'}
          </button>
        }
      />
      <PersonalAttention />
      {creatingProject ? (
        <CreateProjectForm
          onCreated={() => {
            void queryClient.invalidateQueries({ queryKey: queryKeys.projects })
            // 建成即收起：结果（新项目卡片）就在下面，不需要占着半屏表单。
            setCreatingProject(false)
          }}
        />
      ) : null}
      {/*
        #277：骨架退场期间叠在列表之上淡出（`.crossfade-stack`），列表侧挂入场类——
        与任务房同一处理，别让两个页面一个硬切一个不硬切。
      */}
      <div className="crossfade-stack">
        {projectsSkeleton.value === null ? null : (
          <div
            className={`room-skeleton${projectsSkeleton.leaving ? ' leaving' : ''}`}
            aria-busy="true"
            data-testid="projects-skeleton"
          >
            {Array.from({ length: 3 }, (_, i) => (
              <span key={i} className="skeleton-line" />
            ))}
          </div>
        )}
        {listQuery.isError ? <ErrorBanner error={listQuery.error} /> : null}
        {listQuery.isSuccess && listQuery.data.length === 0 ? (
          <p className="empty-state">还没有项目——先创建第一个项目，再为它建 Task。</p>
        ) : null}
        {listQuery.isSuccess && listQuery.data.length > 0 ? (
          <ul
            className={
              projectsSkeleton.value === null ? 'project-list' : 'project-list crossfade-in'
            }
            role="list"
          >
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
                  <ProjectTaskList
                    projectId={project.id}
                    onOpen={(id) => navigate(`/tasks/${id}`)}
                  />
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
  // #344：责任人与「创建后执行」是两件事，拆成两个控件——
  // 责任人只选真人（默认自己）；「创建后立即执行」默认关闭，仅责任人为自己时可开启，
  // 开启后才选 Agent。两条提交路径沿用既有 API：分给真人 = assigneeUserId（待接受）；
  // 开启执行 = assigneeAgentId（责任人恒为创建者，出生 accepted，Hub 自动驱动，#239）。
  const [values, setValues] = useState({
    title: '',
    description: '',
    assignee: '',
    agentId: '',
  })
  const [executeNow, setExecuteNow] = useState(false)
  const [error, setError] = useState<unknown>(null)
  // #348：服务端已明确拒绝过**哪个字段**（责任人不活跃 / Agent 已归档）——即便名册缓存还
  // 没刷新（竞态残窗），后续提交也先拦住，直到该字段被重选（清错字段会让另一条入口卡住，
  // 见 createTaskFailureCopy）。
  const [rejectedField, setRejectedField] = useState<RejectedSelectionField | null>(null)
  /** 重选某字段（或该字段退出请求）时撤掉它的拒绝标记与旧横幅——状态与提示不许互相打架。 */
  const clearRejectionFor = (field: RejectedSelectionField): void => {
    setRejectedField((prev) => (prev === field ? null : prev))
    setError(null)
  }
  // 幂等键按「意图签名」持有（#345）：见 mutationFn 里的用法。
  const intentKey = useRef<{ signature: string; key: string } | null>(null)
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
  // 只有责任人为自己时才能「创建后立即执行」：环境归属是责任人本人的设备与工作目录，
  // 替别人开执行等于替别人动他的机器——那件事只能由对方接受任务后自己做。
  const isSelf = session !== null && values.assignee === session.userId
  const willExecute = executeNow && isSelf
  const selectedAgentId = willExecute && values.agentId !== '' ? values.agentId : null
  // 名册/Agent 集合在表单打开期间会变（成员被停用、Agent 被归档）。已选值离开可选集合时
  // **提交前**显式阻塞并要求重选（#345 评审 F2/F9）：既不带着不可用的责任人出门（Hub 会 400），
  // 也不让触发器显示成「未选择」而实际仍会带上旧值（显示与实际不一致）。绝不自动换人。
  const assigneeStale =
    values.assignee !== '' && !selectableMembers.some((m) => m.userId === values.assignee)
  const agentStale =
    willExecute && values.agentId !== '' && !selectableAgents.some((a) => a.id === values.agentId)
  const selectionUnavailable = assigneeStale || agentStale || rejectedField !== null
  // 服务端拒绝的引导（#348）：主位是人话 + 下一步，「细节（排障用）」带错误码与原文。
  const failureCopy = error === null ? null : createTaskFailureCopy(error)
  const failureGuidance = failureCopy === null ? null : failureCopy.guidance
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
      // #312：驱动结果在 `data` 的**兄弟位**（`{ ok, data, drive }`），必须用
      // mutateWithSiblings 取整个信封——只取 data 时 `drive` 永远读不到，
      // toast 从不出现（真实页面实测 16s 无 toast）。
      //
      // #345（与 RunLauncher/InstructionComposer 同式，ADR-0013 的「同义键」）：
      // 同一意图的重试复用同一把幂等键——Hub 按 `task.create:<key>` 回放，
      // 超时重试不会建出第二个任务、也不会二次驱动（routes.ts 的同一把 key 传给
      // 驱动）；正文/责任人/执行选择变了才换新键（那是新意图，不是重试）。
      const signature = JSON.stringify(body)
      if (intentKey.current?.signature !== signature) {
        intentKey.current = { signature, key: crypto.randomUUID() }
      }
      return api.mutateWithSiblings<TaskView>(`/projects/${projectId}/tasks`, {
        body,
        idempotencyKey: intentKey.current.key,
      })
    },
    onSuccess: (result) => {
      setError(null)
      // 意图已落地：下一次提交（改内容后的新任务）换新键。
      intentKey.current = null
      // #239：指派 Agent 的自动驱动结果如实告知（指派成功≠执行已开始）。
      // #312：四种受理命运各说各话——只有 started_run 能说「已自动开始执行」；
      // 认不出的形状不说话（parseAssignmentDrive 返回 null）。
      const drive = parseAssignmentDrive(result.siblings['drive'])
      if (drive !== null) pushToast(assignmentDriveToast(drive))
      // 任务已创建（201 不吞）：失败分支也走这里，用户落到刚建的任务里，
      // 在任务执行区手动发起——重试发生在**这个任务**上，不重开一个。
      onCreated(result.data)
    },
    onError: (mutationError: unknown) => {
      setError(mutationError)
      // #348：服务端点名了候选失效 → 记下**哪个字段**，后续提交先拦（引导由 failureGuidance 给）。
      const failure = createTaskFailureCopy(mutationError)
      if (failure !== null) setRejectedField(failure.field)
    },
  })
  const submit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault()
    if (mutation.isPending) return
    setError(null)
    mutation.mutate()
  }
  // 开启执行的落点：站在执行区手动发起的同一套服务端守卫后面（审批/权限不变），
  // 差别只是这次把标题与描述当指令、由创建者在自己的现场立即发起。
  //
  // 开关禁用时**说明原因**（#345 评审 F4）：原因写进可见提示，不只挂在 title 上
  // （title 键盘/读屏够不着，移动端也没有 hover）；名册/Agent 还在加载时不许断言
  // 「还没有可用的 Agent」——那是在替服务端猜。
  const switchReason =
    !isSelf && values.assignee !== ''
      ? `责任人是${directory.personOf(values.assignee)}——只有责任人为自己时可以创建后立即执行。`
      : directory.isPending || agentsQuery.isPending
        ? '正在读取成员与 Agent…'
        : selectableAgents.length === 0
          ? '还没有可用的 Agent——先到 Agents 页创建，才能开启「创建后立即执行」。'
          : null
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
            label 仍指向它；只是元素变成 <button aria-haspopup="menu">。
            #344：这一栏只选真人——Agent 从「责任人」里退出，移到下面的执行开关。 */}
        <SelectMenu
          id={`task-assignee-${projectId}`}
          label="责任人"
          value={values.assignee}
          placeholder={
            directory.isPending
              ? '正在加载成员…'
              : selectableMembers.length === 0
                ? '没有可选的成员'
                : '选择成员'
          }
          options={selectableMembers.map((m) => ({
            value: m.userId,
            label: `${m.displayName}（@${m.username}）${m.userId === session?.userId ? ' · 你' : ''}`,
            disabled: false,
          }))}
          onChange={(next) => {
            // 责任人改成别人时必须关掉执行并清掉已选 Agent——否则用户以为在执行，
            // 实际请求会带着「别人 + Agent」出门（静默改投）；这里显式关，提示随后说明。
            // （状态更新不进 updater：updater 必须是纯函数，副作用留在事件里。）
            const stillSelf = session !== null && next === session.userId
            if (!stillSelf) {
              setExecuteNow(false)
              // 关掉执行后 Agent 不再参与请求：Agent 维度的拒绝标记随之失效（评审 P1）。
              setRejectedField((prev) => (prev === 'agent' ? null : prev))
            }
            clearRejectionFor('assignee')
            setValues((prev) => ({
              ...prev,
              assignee: next,
              agentId: stillSelf ? prev.agentId : '',
            }))
          }}
          disabled={directory.isPending}
        />
        {directory.isError ? <ErrorBanner error={directory.error} /> : null}
        {agentsQuery.isError ? <ErrorBanner error={agentsQuery.error} /> : null}
        {/* 分给别人：说清对方要接受任务、执行由对方安排（不替别人动他的环境）。 */}
        {!isSelf && values.assignee !== '' ? (
          <p className="mutation-hint" data-testid="assignee-member-hint">
            对方需要接受任务并安排执行（用他本人的环境）；你也可以在任务里跟进。
          </p>
        ) : null}
      </div>
      <div className="field">
        {/* #344：「创建后立即执行」是显式动作，默认关闭。开启 = 创建后立即以标题与描述
            作为指令、在你的环境执行（等价于 #239 的显式指派 Agent 执行），责任人仍是你。
            整行包成 label：vendored Switch 本体只有 36×20，文本也点得动才算够用的命中区
            （与复核材料那排 label 包 checkbox 同一处理）。 */}
        <label className="field-switch">
          <Switch
            checked={willExecute}
            onChange={(next) => {
              setExecuteNow(next)
              // 关掉执行后 Agent 不再参与请求：Agent 维度的拒绝标记与旧横幅随之失效
              // （评审 P1：否则用户关了开关仍被拦，且提示说的不是当前意图）。
              if (!next) clearRejectionFor('agent')
            }}
            label="创建后立即执行"
            disabled={directory.isPending || !isSelf || selectableAgents.length === 0}
            {...(switchReason === null ? {} : { title: switchReason })}
          />
          <span className="field-switch-label">创建后立即执行</span>
        </label>
        {switchReason !== null ? (
          <p className="mutation-hint" data-testid="execute-now-reason">
            {switchReason}
          </p>
        ) : null}
        {willExecute ? (
          <SelectMenu
            id={`task-execution-agent-${projectId}`}
            label="执行 Agent"
            value={values.agentId}
            placeholder={selectableAgents.length === 0 ? '没有可用的 Agent' : '选择 Agent'}
            options={selectableAgents.map((a) => ({
              value: a.id,
              label: `${a.name}（Agent）`,
              disabled: false,
            }))}
            onChange={(next) => {
              clearRejectionFor('agent')
              setValues((prev) => ({ ...prev, agentId: next }))
            }}
            disabled={agentsQuery.isPending}
          />
        ) : null}
        {willExecute ? (
          <p className="mutation-hint" data-testid="execute-now-hint">
            以任务标题与描述作为指令，用你自己的设备与工作目录立即执行；验收与审批仍在你手上。
          </p>
        ) : null}
        {isSelf && !willExecute ? (
          <p className="mutation-hint">不开启则只创建任务，执行由你在任务里安排。</p>
        ) : null}
      </div>
      {selectionUnavailable ? (
        <p className="mutation-hint" role="status" data-testid="selection-unavailable-hint">
          {assigneeStale || rejectedField === 'assignee'
            ? '所选责任人当前不可指派（可能被停用，或名册未读到）'
            : '所选执行 Agent 当前不可用（可能被归档，或列表未读到）'}
          ——请重新选择后再创建（不会自动换人）。
        </p>
      ) : null}
      <div className="form-actions">
        {/* #158 起这条空值守卫是本表单**唯一**的拦截：责任人从原生
            `<select required>` 换成按钮触发器后，浏览器侧的「不选不放行」随 required
            一起消失（按钮不是表单可校验元素）。评审实测：成员列表未落地时默认选中
            拿不到值，缺这条守卫会发出 `assigneeUserId: ""` 的请求，被协议层
            z.uuid() 拒成 400（packages/protocol/src/http.ts）。别删。
            #239 收窄、#344 再拆、#345 补齐：守卫口径 = 责任人非空 + 名册里还在，
            且开启执行时必须已选一个**仍可用**的 Agent。 */}
        <button
          type="submit"
          className="button button-primary"
          disabled={
            mutation.isPending ||
            values.assignee === '' ||
            selectionUnavailable ||
            (willExecute && values.agentId === '')
          }
        >
          {mutation.isPending ? '创建中…' : willExecute ? '创建并开始执行' : '创建任务'}
        </button>
        <button type="button" className="button button-quiet" onClick={onClose}>
          取消
        </button>
      </div>
      {error !== null ? (
        <ErrorBanner
          error={error}
          {...(failureGuidance !== null ? { guidance: failureGuidance } : {})}
        />
      ) : null}
    </form>
  )
}
