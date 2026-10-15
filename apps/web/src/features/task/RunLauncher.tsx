/**
 * Task Room 统一执行入口的新执行设置（#315；POST /tasks/:taskId/instructions）。
 *
 * 责任人（已接受指派）选 Agent + Revision（快照语义：选定即固定 digest，
 * 04 G4-06 的「运行中改设定不动本次 Run」由 Revision 不可变保证）、
 * 自己的在线设备与该设备下的 Workspace，附 prompt 发起。凭据槽位随所选
 * Revision 走（credentialSlot 在 Hub 侧快照进 run.start 载荷，UI 不碰凭据）。
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { Link } from 'react-router'
import { api } from '../../shared/api/client.js'
import { ErrorBanner } from '../../app/ErrorBanner.js'
import { useMemberDirectory } from '../team/memberDirectory.js'
import { ExecutionPreparation } from './ExecutionPreparation.js'
import { TargetPicker } from './TargetPicker.js'
import { InstructionSendIcon } from './InstructionSendIcon.js'
import type { InstructionOutcome } from './InstructionComposer.js'
import { queryKeys } from '../../app/query-client.js'
import { SelectMenu } from '../../shared/SelectMenu.js'
import { ConfirmDialog } from '../../shared/ConfirmDialog.js'
import type {
  AgentDetailView,
  AgentView,
  DeviceView,
  TaskView,
  WorkspaceView,
} from '../../shared/api/types.js'
import type { Session } from '../../shared/api/types.js'

export interface RunLauncherProps {
  task: TaskView
  session: Session
  /** 当前已有活跃 Run（一任务一活跃，03 §3.2）时不渲染。 */
  hasActiveRun: boolean
  embedded?: boolean
  onStarted?: (runId: string) => void
  onOutcome?: (outcome: InstructionOutcome) => void
  draft?: string
  onDraftChange?: (text: string) => void
  onSendingChange?: (sending: boolean) => void
}

const TERMINAL_TASK: ReadonlySet<string> = new Set(['done', 'cancelled'])

export function RunLauncher({
  task,
  session,
  hasActiveRun,
  embedded = false,
  onStarted,
  onOutcome,
  draft,
  onDraftChange,
  onSendingChange,
}: RunLauncherProps): ReactNode {
  const queryClient = useQueryClient()
  const directory = useMemberDirectory()
  const [agentId, setAgentId] = useState('')
  const [profileRevisionId, setProfileRevisionId] = useState('')
  const [deviceId, setDeviceId] = useState('')
  const [workspaceId, setWorkspaceId] = useState('')
  const [localPrompt, setLocalPrompt] = useState('')
  const prompt = draft ?? localPrompt
  const setPrompt = (text: string): void => {
    if (onDraftChange !== undefined) onDraftChange(text)
    else setLocalPrompt(text)
  }
  const [instant, setInstant] = useState(true)
  const [preparationBlocked, setPreparationBlocked] = useState(false)
  const onPreparationBlocked = useCallback((blocked: boolean) => setPreparationBlocked(blocked), [])
  const onPreparationTarget = useCallback((target: { deviceId: string; workspaceId: string }) => {
    setDeviceId(target.deviceId)
    setWorkspaceId(target.workspaceId)
  }, [])
  const intentKey = useRef<{ signature: string; key: string } | null>(null)
  const isAssignee = task.assigneeUserId === session.userId

  const agentsQuery = useQuery({
    queryKey: queryKeys.agents,
    queryFn: () => api.get<AgentView[]>('/agents'),
  })
  const agentDetailQuery = useQuery({
    queryKey: queryKeys.agentDetail(agentId),
    queryFn: () => api.get<AgentDetailView>(`/agents/${agentId}`),
    enabled: agentId !== '',
  })
  const devicesQuery = useQuery({
    queryKey: queryKeys.devices,
    queryFn: () => api.get<DeviceView[]>('/devices'),
    enabled: isAssignee,
  })
  const workspacesQuery = useQuery({
    queryKey: queryKeys.workspaces,
    queryFn: () => api.get<WorkspaceView[]>('/workspaces'),
    enabled: isAssignee,
  })

  // 初次选择 Agent 时固定当前 Revision；后台更新不得改变正在编辑的选择。
  useEffect(() => {
    if (
      profileRevisionId === '' &&
      agentDetailQuery.data?.id === agentId &&
      agentDetailQuery.data.currentRevisionId !== null
    ) {
      setProfileRevisionId(agentDetailQuery.data.currentRevisionId)
    }
  }, [agentId, agentDetailQuery.data, profileRevisionId])
  const revisions = agentDetailQuery.data?.revisions ?? []
  const effectiveRevisionId =
    profileRevisionId !== '' ? profileRevisionId : (agentDetailQuery.data?.currentRevisionId ?? '')

  const deviceWorkspaces = useMemo(
    () => (workspacesQuery.data ?? []).filter((ws) => ws.deviceId === deviceId && ws.available),
    [workspacesQuery.data, deviceId],
  )

  // #158：四处原生 <select> → vendored Menu（shared/SelectMenu）。选项文案与禁用态
  // 逐条沿用原 <option>：离线设备仍列出但不可选（不是隐藏——「看得见但选不了」才是
  // 实情），禁用项在 Menu 里同样既不响应指针也不进键盘序列。
  const agentOptions = useMemo(
    () =>
      (agentsQuery.data ?? [])
        .filter((agent) => agent.archivedAt === null)
        .map((agent) => ({ value: agent.id, label: agent.name, disabled: false })),
    [agentsQuery.data],
  )
  const revisionOptions = useMemo(
    () =>
      revisions.map((revision) => ({
        value: revision.id,
        label: `r${revision.revision} — ${revision.provider}/${revision.model}${
          revision.id === agentDetailQuery.data?.currentRevisionId ? '（当前）' : ''
        }`,
        disabled: false,
      })),
    [revisions, agentDetailQuery.data],
  )
  // #241：本次 Run 将解析到的审批档 = Task 覆盖 ?? 所选（缺省当前）Revision 的默认。
  // 与 Hub 建Run时的解析同式——UI 只用于「要不要二次确认」与提示，不越权预判结果。
  const selectedRevision = revisions.find((revision) => revision.id === effectiveRevisionId)
  const resolvedApprovalPolicy =
    task.approvalPolicy ?? selectedRevision?.approvalPolicy ?? 'approval_required'
  const [confirmingFullAccess, setConfirmingFullAccess] = useState(false)

  const start = useMutation({
    onMutate: () => onSendingChange?.(true),
    onSettled: () => onSendingChange?.(false),
    mutationFn: () => {
      const body = {
        agentId,
        profileRevisionId: effectiveRevisionId,
        ...(isAssignee && deviceId !== ''
          ? { deviceId, ...(workspaceId !== '' ? { workspaceId } : {}) }
          : {}),
        text: prompt,
        intent: { kind: 'new' as const },
        expectedApprovalPolicy: resolvedApprovalPolicy,
      }
      const signature = JSON.stringify(body)
      if (intentKey.current?.signature !== signature)
        intentKey.current = { signature, key: crypto.randomUUID() }
      return api.mutate<InstructionOutcome>(`/tasks/${task.id}/instructions`, {
        body,
        idempotencyKey: intentKey.current.key,
      })
    },
    onSuccess: (outcome) => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.taskRoom(task.id) })
      if (outcome.outcome !== 'rejected') setPrompt('')
      intentKey.current = null
      setConfirmingFullAccess(false)
      onOutcome?.(outcome)
      if (
        outcome.outcome === 'started_run' &&
        outcome.runId !== null &&
        typeof outcome.runId === 'string'
      )
        onStarted?.(outcome.runId)
    },
  })

  const submitRun = (): void => {
    if (!ready || start.isPending) return
    // 完全权限是显式放权（ADR-0009 决策 7）：确认一次再发。
    if (resolvedApprovalPolicy === 'full_access') {
      setConfirmingFullAccess(true)
      return
    }
    start.mutate()
  }

  useEffect(() => {
    if (preparationBlocked || hasActiveRun) setConfirmingFullAccess(false)
  }, [preparationBlocked, hasActiveRun])

  // 只有已接受指派的责任人、非终态任务、无活跃 Run 时可启动（03 §3.2 前置守卫；
  // Hub 侧仍有完整校验，这里是诚实呈现而非安全边界）。
  if (
    !embedded &&
    (session.userId !== task.assigneeUserId ||
      task.assignmentStatus !== 'accepted' ||
      TERMINAL_TASK.has(task.status) ||
      hasActiveRun)
  ) {
    return null
  }

  const selectedDevice = devicesQuery.data?.find((row) => row.id === deviceId)
  const selectedWorkspace = workspacesQuery.data?.find(
    (row) => row.workspaceId === workspaceId && row.deviceId === deviceId,
  )
  const explicitTargetReady =
    selectedDevice?.status === 'online' &&
    (workspaceId === '' ? deviceWorkspaces.length > 0 : selectedWorkspace?.available === true)
  const targetBlocker =
    isAssignee && deviceId !== '' && devicesQuery.isSuccess && workspacesQuery.isSuccess
      ? selectedDevice?.status !== 'online'
        ? '所选设备已离线或不可用，请让它上线或明确重新选择。草稿仍保留。'
        : workspaceId !== '' && selectedWorkspace?.available !== true
          ? '所选工作目录已不可用，请明确重新选择。草稿仍保留。'
          : deviceWorkspaces.length === 0
            ? '所选设备没有可用工作目录，请先登记或明确重新选择。'
            : null
      : null

  const ready =
    agentId !== '' &&
    !preparationBlocked &&
    selectedRevision !== undefined &&
    !hasActiveRun &&
    (!isAssignee ||
      (!devicesQuery.isPending &&
        !devicesQuery.isError &&
        !workspacesQuery.isPending &&
        !workspacesQuery.isError &&
        (deviceId !== ''
          ? explicitTargetReady
          : (workspacesQuery.data ?? []).some(
              (ws) =>
                ws.available &&
                (devicesQuery.data ?? []).some(
                  (device) => device.id === ws.deviceId && device.status === 'online',
                ),
            )))) &&
    prompt.trim().length > 0

  const feedback = start.isPending
    ? 'pending'
    : start.isError
      ? 'failed'
      : start.data?.outcome === 'rejected'
        ? 'rejected'
        : 'idle'

  return (
    <section
      className={embedded ? 'run-launcher' : 'card run-launcher'}
      aria-labelledby="run-launcher-heading"
    >
      <h3 id="run-launcher-heading">开始新执行</h3>
      <p className="mutation-hint">新执行不接续旧会话；配置版本与审批档将在开始时固定。</p>
      <form
        className="instruction-composer"
        onSubmit={(event) => {
          event.preventDefault()
          submitRun()
        }}
      >
        <div className="field">
          <SelectMenu
            id="run-agent"
            label="Agent"
            ariaLabel="选择 Agent"
            value={agentId}
            placeholder="选择 Agent…"
            options={agentOptions}
            onChange={(next) => {
              setAgentId(next)
              setProfileRevisionId('')
            }}
          />
        </div>
        {selectedRevision !== undefined ? (
          <p className="mutation-hint" data-testid="execution-revision">
            配置版本：r{selectedRevision.revision} · {selectedRevision.provider}/
            {selectedRevision.model}
          </p>
        ) : null}
        {agentId !== '' && agentDetailQuery.isSuccess && selectedRevision === undefined ? (
          <p className="mutation-hint" role="status">
            所选配置版本不可用，请重新选择版本或 Agent。
          </p>
        ) : null}
        <p className="mutation-hint" data-testid="execution-target-summary">
          执行环境：
          {!isAssignee
            ? '使用责任人的环境。'
            : deviceId === ''
              ? '自动选择你的可用环境，可在执行设置中指定。'
              : `显式指定：${selectedDevice?.name ?? '所选设备'} · ${workspaceId === '' ? '工作目录自动选择' : (selectedWorkspace?.name ?? '所选工作目录')}`}
        </p>
        {targetBlocker !== null ? (
          <p className="mutation-hint" role="status" data-testid="execution-target-blocker">
            {targetBlocker}
          </p>
        ) : null}
        {isAssignee &&
        devicesQuery.isSuccess &&
        workspacesQuery.isSuccess &&
        !(workspacesQuery.data ?? []).some(
          (ws) =>
            ws.available &&
            (devicesQuery.data ?? []).some(
              (device) => device.id === ws.deviceId && device.status === 'online',
            ),
        ) ? (
          <p className="mutation-hint" role="status">
            尚无在线且可用的执行环境。请先在<Link to="/devices">设备页</Link>
            完成配对并登记工作目录。
          </p>
        ) : null}
        {isAssignee &&
        selectedRevision !== undefined &&
        typeof selectedRevision.credentialSlot === 'string' &&
        typeof selectedRevision.provider === 'string' ? (
          <ExecutionPreparation
            taskId={task.id}
            selection={{
              agentId,
              profileRevisionId: selectedRevision.id,
              ...(deviceId === '' ? {} : { deviceId }),
              ...(workspaceId === '' ? {} : { workspaceId }),
            }}
            provider={selectedRevision.provider}
            credentialSlot={selectedRevision.credentialSlot}
            draft={prompt}
            onTrialDraft={setPrompt}
            onTarget={onPreparationTarget}
            onBlocked={onPreparationBlocked}
          />
        ) : null}
        {isAssignee &&
        selectedRevision !== undefined &&
        typeof selectedRevision.credentialSlot !== 'string' ? (
          <p className="mutation-hint" role="status">
            配置版本的凭据信息读取不完整，请重新读取配置；准备条件尚未确认。
          </p>
        ) : null}
        <details className="execution-settings">
          <summary>执行设置（配置版本与环境）</summary>
          <div className="field">
            <SelectMenu
              id="run-revision"
              label="Revision（选定即快照）"
              ariaLabel="选择 Revision"
              value={effectiveRevisionId}
              placeholder="先选 Agent…"
              options={revisionOptions}
              onChange={setProfileRevisionId}
              disabled={agentId === ''}
            />
          </div>
          <TargetPicker
            isAssignee={isAssignee}
            value={deviceId === '' ? null : { deviceId, workspaceId }}
            onChange={(next) => {
              setDeviceId(next?.deviceId ?? '')
              setWorkspaceId(next?.workspaceId ?? '')
            }}
            assigneeName={directory.personOf(task.assigneeUserId)}
            hasActiveRun={hasActiveRun}
            deviceAriaLabel="选择设备"
            workspaceAriaLabel="选择 Workspace"
            showDeviceStatus
          />
        </details>
        {[agentsQuery, agentDetailQuery, ...(isAssignee ? [devicesQuery, workspacesQuery] : [])]
          .filter((query) => query.isError)
          .map((query, i) => (
            <ErrorBanner key={i} error={query.error} />
          ))}
        <span
          className="composer-approval-pill"
          data-testid="instruction-approval-pill"
          data-policy={
            agentId === '' && task.approvalPolicy === null ? 'unknown' : resolvedApprovalPolicy
          }
        >
          {agentId === '' && task.approvalPolicy === null
            ? '审批 · 未知（请先选择 Agent）'
            : `审批 · ${resolvedApprovalPolicy === 'full_access' ? '完全权限' : '需要逐次批准'} · ${task.approvalPolicy === null ? 'Revision 默认' : '任务覆盖'}`}
        </span>
        <label>
          指令
          <textarea
            aria-label="指令"
            value={prompt}
            maxLength={10_000}
            disabled={start.isPending}
            onChange={(event) => setPrompt(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
                event.preventDefault()
                setInstant(true)
                event.currentTarget.form?.requestSubmit()
              }
            }}
            placeholder="这次 Run 要做什么（任务上下文由 Hub 注入）…"
            rows={4}
          />
        </label>
        {/* #225：错误走全站口径（message + requestId），不再自写第二套错误段。 */}
        {/* #241：解析结果可见——选了完全权限（覆盖或 Revision 默认）就说出来，
            不等人发现运行卡上的标记才知道自己放权了。 */}
        {resolvedApprovalPolicy === 'full_access' ? (
          <p className="mutation-hint" data-testid="run-policy-hint">
            本次 Run 将以「完全权限」运行：工具调用不再逐次请求批准。
          </p>
        ) : null}
        {start.isError ? <ErrorBanner error={start.error} /> : null}
        {start.data?.outcome === 'rejected' ? (
          <p className="mutation-hint" role="alert" data-testid="execution-start-refusal">
            指令未被受理：
            {start.data.instructionErrorMessage ??
              start.data.instructionErrorCode ??
              '设备拒绝启动'}
            。草稿仍保留。
          </p>
        ) : null}
        <button
          type="submit"
          className="button button-primary instruction-send"
          disabled={!ready || start.isPending}
          aria-busy={start.isPending}
          data-feedback={feedback}
          data-instant={instant ? '' : undefined}
          onPointerDown={() => setInstant(false)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' || event.key === ' ') setInstant(true)
          }}
        >
          <InstructionSendIcon feedback={feedback} />
          {start.isPending ? '发送中…' : '开始执行'}
        </button>
      </form>
      {confirmingFullAccess ? (
        <ConfirmDialog
          open
          title="以完全权限启动 Run？"
          body="这次 Run 的工具调用将直接执行、不再逐次请求批准（档位：任务覆盖或 Revision 默认的完全权限）。运行卡会标记「完全权限」。确认前请确信 Agent 的 persona 与插件组合可信。"
          confirmLabel="确认以完全权限启动"
          danger
          pending={start.isPending}
          onConfirm={() => {
            if (ready && !start.isPending) start.mutate()
          }}
          onCancel={() => setConfirmingFullAccess(false)}
        />
      ) : null}
    </section>
  )
}
