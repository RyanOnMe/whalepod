import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
  type SetStateAction,
} from 'react'
import { Link } from 'react-router'
import { ErrorBanner } from '../../app/ErrorBanner.js'
import { api } from '../../shared/api/client.js'
import SpringCheck from '../../vendor/react-bits-micro/SpringCheck.js'
import { SelectMenu } from '../../shared/SelectMenu.js'
import { queryKeys } from '../../app/query-client.js'
import type {
  AgentDetailView,
  AgentView,
  DeviceView,
  InstructionDriverView,
  RunView,
  Session,
  TaskRoomRun,
  TaskRoomArtifact,
  TaskView,
} from '../../shared/api/types.js'
import {
  InstructionComposer,
  type ApprovalPreview,
  type InstructionOutcome,
} from './InstructionComposer.js'
import { RunLauncher } from './RunLauncher.js'
import { useMemberDirectory } from '../team/memberDirectory.js'
import { ACTIVE_RUN, TERMINAL_RUN } from './run-states.js'
import { runOrdinalLabels } from './runLabels.js'

import {
  useExecutionDraft,
  EMPTY_EXECUTION_SETTINGS,
  type ExecutionDraft,
  type ExecutionSettings,
  type ExecutionMode as Mode,
} from './execution-drafts.js'
import { defaultComposeTarget, followsDefaultMode } from './execution-defaults.js'
export interface ArtifactReviewRequest {
  taskId: string
  artifactId: string
  nonce: string
}

/**
 * 历史运行的「继续此会话」（ADR-0019 决定 2）：把来源交给底部统一输入框，
 * 保留已有文字；是否可发送仍由下面的 reason 链判定（不自动改投）。
 */
export interface ContinueSessionRequest {
  taskId: string
  runId: string
  nonce: string
}

/**
 * 读取面还没带回刚起的运行时的占位行（#393 实测的窗口）。
 *
 * 只用于**派生**：运行序号（`runOrdinalLabels`）、活跃判定（reason 链、默认目标）、
 * 来源落点。不渲染，也不冒充审批档（审批胶囊取服务端预览，不读这一行）。
 * 状态给 `queued`：Hub 建 Run 到 Node 首次 ack 之间真实就是 queued。
 */
function startedRunPlaceholder(id: string): TaskRoomRun {
  return {
    id,
    status: 'queued',
    createdAt: new Date().toISOString(),
    startedAt: null,
    finishedAt: null,
    rerunOfRunId: null,
    resumeFromRunId: null,
    approvalPolicy: 'approval_required',
    specRevision: null,
    purpose: 'business',
    deviceName: null,
    workspaceName: null,
    lastToolCall: null,
    lastPhase: null,
  }
}

/** 模式与来源属于草稿意图：后台状态变化只阻塞，不替用户改投。 */
export function ExecutionComposer({
  task,
  session,
  runs,
  approvalPreview,
  confirmingTask = false,
  artifacts,
  agreement,
  handoff,
  reviewRequest = null,
  revisionRequest = null,
  continueRequest = null,
  onDiscuss,
  compact = false,
}: {
  onDiscuss?: () => void
  compact?: boolean
  task: TaskView
  session: Session
  runs: TaskRoomRun[]
  approvalPreview: ApprovalPreview
  confirmingTask?: boolean
  artifacts: TaskRoomArtifact[]
  /** 任务约定摘要（#378；TaskRoomView.agreement）：绑定提示与「有新版本」横幅的数据源。 */
  agreement: { enabled: boolean; latestConfirmedNumber: number | null; hasDraft: boolean }
  /**
   * 下游交接摘要（#380；TaskRoomView.handoff）：存在已确认 receipt 时执行区默认
   * 勾选「附带上游交接材料」并展示固定版本号；null = 本任务不是交接的下游。
   */
  handoff: {
    receiptId: string
    revisionNumber: number
    upstreamTaskTitle: string
    hasNewerVersion: boolean
  } | null
  reviewRequest?: ArtifactReviewRequest | null
  revisionRequest?: ArtifactReviewRequest | null
  /** 历史运行的「继续此会话」：把该运行设为来源（mode=resume），保留已有文字。 */
  continueRequest?: ContinueSessionRequest | null
}): ReactNode {
  const directory = useMemberDirectory()
  const responsible = directory.personOf(task.assigneeUserId)
  // #393 实测：`runs` 是**读取面**，刚起的运行要等一次失效重拉才出现。那一拍若不把它当
  // 已知，标签会退回「所选执行」、理由链会误报「所选执行已结束或发生变化」——刚发出去的
  // 指令明明就在跑（真实链路实测）。记住刚起的运行，读取面到位前按已知运行参与派生
  // （占位行只进派生：序号、活跃判定、来源落点；它不渲染，也不冒充审批档）。
  const [startedRunId, setStartedRunId] = useState<string | null>(null)
  const runsWithStarted = useMemo(
    () =>
      startedRunId === null || runs.some((run) => run.id === startedRunId)
        ? runs
        : [...runs, startedRunPlaceholder(startedRunId)],
    [runs, startedRunId],
  )
  const active = runsWithStarted.find((run) => ACTIVE_RUN.has(run.status))
  const terminal = runsWithStarted.filter((run) => TERMINAL_RUN.has(run.status))
  const staleRunsAboutStarted =
    startedRunId !== null && !runs.some((run) => run.id === startedRunId)
  const [lastOutcome, setLastOutcome] = useState<InstructionOutcome | null>(null)
  // #380：存在已确认接收关系时默认附带（界面在发送前展示固定版本号；取消勾选 =
  // 本次不带交接材料，Run 快照为 null——缺省不带是协议语义，勾选才是显式选择）。
  const [includeHandoff, setIncludeHandoff] = useState(handoff !== null)
  // 评审 B6：接收方在别的机器上确认后，房间实时拿到摘要（null → 非 null）——此时
  // 默认勾选也要生效；只在「从未有过 → 有」这一步重置，不覆盖用户主动取消的勾选。
  const hadHandoff = useRef(handoff !== null)
  useEffect(() => {
    if (!hadHandoff.current && handoff !== null) setIncludeHandoff(true)
    hadHandoff.current = handoff !== null
  }, [handoff])
  // ADR-0019 决定 3：默认目标是规则给的，不是每次都要重新做一次选择。
  const initialDraft = (): ExecutionDraft => {
    const target = defaultComposeTarget(runs)
    return {
      ownerId: task.assigneeUserId,
      text: '',
      mode: target.mode,
      modeOrigin: 'auto',
      sourceId: target.sourceId,
      reviewArtifactIds: [],
      revisionContext: null,
      launch: { key: 'new-', settings: { ...EMPTY_EXECUTION_SETTINGS } },
      sending: false,
    }
  }
  const memory = useExecutionDraft(task.id, session.userId, initialDraft)
  const {
    text: draft,
    sending,
    mode,
    sourceId,
    reviewArtifactIds,
    revisionContext,
  } = memory.snapshot
  const setDraft = useCallback(
    (change: SetStateAction<string>) =>
      memory.update((old) => ({
        ...old,
        text: typeof change === 'function' ? change(old.text) : change,
      })),
    [memory.update],
  )
  const setSending = useCallback(
    (sending: boolean) => memory.update((old) => ({ ...old, sending })),
    [memory.update],
  )
  const [settingsOpen, setSettingsOpen] = useState(false)
  const focusMode = useRef(false)
  const settingsDisclosure = { open: settingsOpen, onChange: setSettingsOpen }
  // 用户明确选择模式/来源 → 默认规则不再改写草稿（modeOrigin='user'）。
  const setMode = (mode: Mode) => memory.update((old) => ({ ...old, mode, modeOrigin: 'user' }))
  const setSourceId = (sourceId: string) =>
    memory.update((old) => ({ ...old, sourceId, modeOrigin: 'user' }))
  // ADR-0019 决定 4：只跟随「空白、未调整设置、未发送」的自动草稿；运行状态一变
  // （起新运行/结束）就把默认目标落回草稿，用户动过的一律不动。
  // 读取面还没带回刚起的运行时（`staleRunsAboutStarted`），runs 是「还没更新」而不是
  // 「没有历史」——那一拍不改草稿，等读取面到位（真实链路实测过的窗口）。
  useEffect(() => {
    if (staleRunsAboutStarted) return
    if (startedRunId !== null) setStartedRunId(null)
    if (!followsDefaultMode(memory.snapshot)) return
    const target = defaultComposeTarget(runs)
    if (target.mode === memory.snapshot.mode && target.sourceId === memory.snapshot.sourceId) return
    memory.update((old) => ({
      ...old,
      mode: target.mode,
      modeOrigin: 'auto',
      sourceId: target.sourceId,
    }))
  }, [runs, memory.snapshot, staleRunsAboutStarted, startedRunId])
  const setReviewArtifactIds = (change: SetStateAction<string[]>) =>
    memory.update((old) => ({
      ...old,
      reviewArtifactIds: typeof change === 'function' ? change(old.reviewArtifactIds) : change,
    }))
  const setRevisionContext = (revisionContext: ArtifactReviewRequest | null) =>
    memory.update((old) => ({ ...old, revisionContext }))
  const launcherKey = `${mode}-${revisionContext?.nonce ?? ''}`
  const launchSettings =
    memory.snapshot.launch.key === launcherKey
      ? memory.snapshot.launch.settings
      : EMPTY_EXECUTION_SETTINGS
  const setLaunchSettings = useCallback(
    (change: SetStateAction<ExecutionSettings>) =>
      memory.update((old) => {
        const before =
          old.launch.key === launcherKey ? old.launch.settings : EMPTY_EXECUTION_SETTINGS
        return {
          ...old,
          launch: {
            key: launcherKey,
            settings: typeof change === 'function' ? change(before) : change,
          },
        }
      }),
    [memory.update, launcherKey],
  )
  const published = artifacts.filter((artifact) => artifact.status === 'published')
  const handledRequest = useRef<string | null>(null)
  const revisionMaterial = published.find((a) => a.id === revisionContext?.artifactId)
  const handledRevision = useRef<string | null>(null)
  useEffect(() => {
    if (
      revisionRequest === null ||
      revisionRequest.taskId !== task.id ||
      sending ||
      handledRevision.current === revisionRequest.nonce
    )
      return
    handledRevision.current = revisionRequest.nonce
    setRevisionContext(revisionRequest)
    setMode('resume')
    setSourceId('')
    setDraft((current) =>
      current.trim() === '' ? '请根据所选交付物中的意见修订产出，并说明本次调整。' : current,
    )
  }, [revisionRequest, task.id, sending])

  const isNewExecution = mode === 'new' || mode === 'review'
  const isSourceMode = mode === 'followup' || mode === 'resume'
  useEffect(() => {
    if (
      reviewRequest === null ||
      reviewRequest.taskId !== task.id ||
      handledRequest.current === reviewRequest.nonce ||
      sending
    )
      return
    handledRequest.current = reviewRequest.nonce
    setRevisionContext(null)
    setReviewArtifactIds([reviewRequest.artifactId])
    setMode('review')
    setSourceId('')
    setDraft((current) =>
      current.trim() === '' ? '请复核所选已发布交付物，指出问题与可执行的修订建议。' : current,
    )
  }, [reviewRequest, task.id, sending])

  // ADR-0019 决定 2：历史运行的「继续此会话」把来源交给这里——保留已有文字，
  // 只改来源；能否发送仍交给下面的 reason 链（不自动改投、不自动跳过）。
  const handledContinue = useRef<string | null>(null)
  useEffect(() => {
    if (
      continueRequest === null ||
      continueRequest.taskId !== task.id ||
      handledContinue.current === continueRequest.nonce
    )
      return
    handledContinue.current = continueRequest.nonce
    memory.update((old) => ({
      ...old,
      mode: 'resume',
      modeOrigin: 'user',
      sourceId: continueRequest.runId,
    }))
    const frame = requestAnimationFrame(() =>
      document.getElementById(`instruction-text-${task.id}`)?.focus(),
    )
    return () => cancelAnimationFrame(frame)
  }, [continueRequest, task.id])
  const isAssignee = task.assigneeUserId === session.userId
  const grants = useQuery({
    queryKey: queryKeys.instructionGrants(task.id),
    queryFn: () => api.get<InstructionDriverView[]>(`/tasks/${task.id}/instruction-grants`),
    enabled: !isAssignee,
    refetchOnMount: 'always',
  })
  const allowed =
    isAssignee || (grants.isSuccess && grants.data.some((row) => row.userId === session.userId))
  const source = useQuery({
    queryKey: queryKeys.run(sourceId),
    queryFn: () => api.get<RunView>(`/runs/${sourceId}`),
    enabled: allowed && isSourceMode && sourceId !== '',
    refetchOnMount: 'always',
  })
  const agents = useQuery({
    queryKey: queryKeys.agents,
    queryFn: () => api.get<AgentView[]>('/agents'),
    enabled: allowed,
    refetchOnMount: 'always',
  })
  /**
   * 默认继续（续聊）要固定来源设备与工作区，设备离线时**客户端先挡**（ADR-0019 决定 3）：
   * #394 之前 Hub 只看版本列（`node.hello` 回填、断连不清），续跑固定来源设备时会照建 Run
   * （p1-393 e2e 实测停掉 Node 后续跑仍 201）；#394 起服务端也按 30s 在线窗口 fail-closed。
   * 客户端闸保留是为了更早、更友好地保留草稿并说清原因，不是服务端判据的替代。
   * 判据取设备读面（与启动器同一份 `queryKeys.devices` 缓存，按 `device.changed` 实时失效）；
   * 查不到该设备（例如被授权成员看不到责任人的设备）时**不阻断**——不知道就不猜。
   */
  const devices = useQuery({
    queryKey: queryKeys.devices,
    queryFn: () => api.get<DeviceView[]>('/devices'),
    enabled: allowed && mode === 'resume',
    refetchOnMount: 'always',
  })
  const sourceDevice = devices.data?.find((device) => device.id === source.data?.deviceId)
  const sourceAgent = useQuery({
    queryKey: queryKeys.agentDetail(source.data?.agentId ?? ''),
    queryFn: () => api.get<AgentDetailView>(`/agents/${source.data!.agentId}`),
    enabled: allowed && mode === 'resume' && source.isSuccess,
    refetchOnMount: 'always',
  })
  const revision = sourceAgent.data?.revisions.find(
    (row) => row.id === source.data?.profileRevisionId,
  )
  const sourcePlacement = runsWithStarted.find((run) => run.id === sourceId)
  const sourceLabel = runOrdinalLabels(runsWithStarted).get(sourceId) ?? '所选执行'
  let reason: string | null = null
  if (confirmingTask) reason = '正在重新确认任务状态，草稿仍保留…'
  else if (memory.snapshot.ownerId !== task.assigneeUserId)
    reason = '任务责任人已变化。草稿仍保留，请重新确认责任人与执行安排。'
  else if (!isAssignee && (grants.isPending || (grants.isFetching && !grants.isFetchedAfterMount)))
    reason = '正在确认操作权限…'
  else if (!isAssignee && grants.isError) reason = '暂时无法确认权限，请重试。'
  else if (!allowed) reason = '只有责任人和已授权成员可以发送指令；你仍可在讨论区协作。'
  else if (task.assignmentStatus !== 'accepted') reason = '责任人接受任务后才能开始执行。'
  else if (task.status === 'done' || task.status === 'cancelled')
    reason = '任务已结束，不能继续执行。'
  else if (revisionContext !== null && revisionMaterial === undefined)
    reason = '修订依据已不可用，请重新选择已发布意见。草稿仍保留。'
  else if (isNewExecution && active !== undefined)
    reason = '已有执行进行中，请明确选择发送追问，或等它结束后开始新执行。'
  else if (mode === 'review' && reviewArtifactIds.length === 0) reason = '请明确选择本次复核材料。'
  else if (mode === 'review' && reviewArtifactIds.some((id) => !published.some((a) => a.id === id)))
    reason = '所选材料已不可用，请重新选择已发布交付物。草稿仍保留。'
  else if (mode === 'followup' && (active === undefined || active.id !== sourceId))
    reason = '所选执行已结束或发生变化。草稿仍保留，请选择继续会话或开始新执行。'
  else if (mode === 'resume' && active !== undefined)
    reason = '已有执行进行中，结束后才能继续会话。'
  else if (isSourceMode && sourceId === '') reason = '请先选择来源执行。'
  else if (isSourceMode && source.isError) reason = '无法读取来源执行，请重试。'
  else if (
    isSourceMode &&
    (!source.isSuccess || (source.isFetching && !source.isFetchedAfterMount))
  )
    reason = '正在读取来源执行…'
  else if (isSourceMode && source.isSuccess && source.data.taskId !== task.id)
    reason = '来源执行不属于当前任务，请重新选择。'
  else if (mode === 'resume' && source.isSuccess && !TERMINAL_RUN.has(source.data.status))
    reason = '来源执行尚未结束，请等待结束后再继续会话。'
  else if (mode === 'resume' && source.data?.ownerUserId !== task.assigneeUserId)
    reason = '来源执行属于此前的责任人，请基于已发布交接材料开始新执行。'
  else if (mode === 'resume' && source.data?.dshSessionId === null)
    reason = '这次执行没有可续接的会话，请开始新执行。'
  else if (mode === 'resume' && sourceDevice?.status === 'offline')
    // 不自动改投、不跳过来源：说清原因并保留草稿，是否开始新执行由用户明确决定。
    // 只拦"暂时不在线"这一种：设备**已撤销**是永久失效，服务端会带 DEVICE_REVOKED 与
    // requestId 明确回绝（页面另有就该现场续跑的说明），客户端抢答会把那条更准的话术吞掉。
    reason =
      '来源设备当前离线。草稿仍保留：让该设备上线继续这条会话，或明确选择开始新执行并重新确认环境。'
  else if (mode === 'resume' && sourceAgent.isError) reason = '无法读取来源配置版本，请重试。'
  else if (
    mode === 'resume' &&
    (sourceAgent.isPending || (sourceAgent.isFetching && !sourceAgent.isFetchedAfterMount))
  )
    reason = '正在确认来源配置版本…'
  else if (mode === 'resume' && typeof sourceAgent.data?.archivedAt === 'string')
    reason = '来源 Agent 已归档，请明确选择可用 Agent 开始新执行。'
  else if (mode === 'resume' && sourceAgent.isSuccess && revision === undefined)
    reason = '来源配置版本已不可用，请开始新执行。'
  else if (mode === 'resume' && revision === undefined) reason = '正在确认来源配置版本…'
  const policy: ApprovalPreview =
    mode === 'resume'
      ? revision === undefined
        ? null
        : {
            policy: task.approvalPolicy ?? revision.approvalPolicy,
            source: task.approvalPolicy === null ? 'revision_default' : 'task_override',
          }
      : approvalPreview
  // #378：活跃 Run 绑定的约定版本落后于任务最新已确认版本 → 提示三选一（追问/取消/保持本次）。
  // 「保持本次」按 Run 记一次：同一次运行不再打扰，换了一次运行（新 id）重新提示。
  const queryClient = useQueryClient()
  const [keptStaleRunId, setKeptStaleRunId] = useState<string | null>(null)
  const cancelRunMutation = useMutation({
    mutationFn: (runId: string) => api.mutate<RunView>(`/runs/${runId}/cancel`),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.taskRoom(task.id) })
    },
  })
  const agreementNowStale =
    active !== undefined &&
    active.specRevision !== null &&
    agreement.latestConfirmedNumber !== null &&
    active.specRevision.revisionNumber < agreement.latestConfirmedNumber &&
    keptStaleRunId !== active.id
  const started = (outcome: InstructionOutcome): void => {
    setLastOutcome(outcome)
    if (outcome.outcome === 'started_run' && outcome.runId !== null) {
      // 刚起来的 Run 就是新的默认目标：源头仍是默认规则（origin='auto'），
      // 用户若之后明确改选，modeOrigin 会被改成 'user' 不再跟随。
      setStartedRunId(outcome.runId)
      memory.update((old) => ({
        ...old,
        mode: 'followup',
        modeOrigin: 'auto',
        revisionContext: null,
        sourceId: outcome.runId!,
      }))
    }
  }
  useEffect(() => {
    if (focusMode.current) {
      const frame = requestAnimationFrame(() => {
        focusMode.current = false
        document.getElementById(`execution-mode-${task.id}`)?.focus()
      })
      return () => cancelAnimationFrame(frame)
    }
  }, [mode, task.id])
  const executionSettings = (
    <>
      <SelectMenu
        appearance="glide"
        id={`execution-mode-${task.id}`}
        label="执行方式"
        value={mode}
        disabled={sending}
        options={[
          { value: 'new', label: '开始新执行（不接旧会话）', disabled: false },
          {
            value: 'review',
            label: '复核交付物（单独执行）',
            disabled: published.length === 0 && mode !== 'review',
          },
          {
            value: 'followup',
            label: '发送追问（指定活跃执行）',
            disabled: revisionContext !== null || (active === undefined && mode !== 'followup'),
          },
          {
            value: 'resume',
            label: '继续会话（创建新执行记录）',
            disabled: terminal.length === 0,
          },
        ]}
        onChange={(next) => {
          focusMode.current = true
          setMode(next as Mode)
          if (next === 'review') setRevisionContext(null)
          if (next === 'followup' && active !== undefined) setSourceId(active.id)
          if (
            next === 'resume' &&
            revisionContext === null &&
            !terminal.some((run) => run.id === sourceId)
          )
            setSourceId(terminal.at(-1)?.id ?? '')
        }}
      />
      {mode === 'resume' ? (
        <SelectMenu
          appearance="glide"
          id={`execution-source-${task.id}`}
          label="来源执行"
          value={sourceId}
          disabled={sending}
          placeholder="选择要继续的会话…"
          options={terminal.map((run) => ({
            value: run.id,
            label: runOrdinalLabels(runs).get(run.id) ?? '历史执行',
            disabled: false,
          }))}
          onChange={setSourceId}
        />
      ) : null}
      {isSourceMode ? (
        <p className="mutation-hint" data-testid="execution-context">
          接收 Agent：
          {agents.data?.find((agent) => agent.id === source.data?.agentId)?.name ??
            (agents.isError ? '名称暂不可用' : '读取中')}{' '}
          · 来源：{sourceLabel}
          {mode === 'resume'
            ? ` · 沿用来源配置版本${revision === undefined ? '' : ` r${revision.revision}（${revision.provider}/${revision.model}）`}与执行环境，创建新记录（${sourcePlacement?.deviceName ?? '来源设备'}${sourcePlacement?.workspaceName ? ` · ${sourcePlacement.workspaceName}` : ''}）`
            : ' · 追问只发往该执行'}
        </p>
      ) : null}
      <button
        type="button"
        className="button button-quiet"
        disabled={sending}
        onClick={() => memory.clear(initialDraft())}
      >
        清空草稿
      </button>
      {memory.snapshot.ownerId !== task.assigneeUserId ? (
        <button
          type="button"
          className="button"
          disabled={sending}
          onClick={() => {
            memory.intentKey.current = null
            memory.update((old) => ({
              ...initialDraft(),
              text: old.text,
              mode: 'new',
              sourceId: '',
            }))
          }}
        >
          重新确认执行安排（保留正文）
        </button>
      ) : null}
      <p className="mutation-hint" data-testid="execution-responsibility">
        {isAssignee
          ? '使用你的执行环境；审批由你处理。'
          : `使用${responsible}的执行环境；审批由其处理。`}
      </p>
    </>
  )
  return (
    <div
      id="task-execution"
      tabIndex={-1}
      className="execution-composer"
      data-testid="execution-composer"
    >
      {/* #378：任务约定的绑定提示——新执行（new/resume）缺省绑定最新已确认版本。 */}
      {agreement.enabled ? (
        <p className="mutation-hint" data-testid="agreement-binding-hint">
          本任务已启用任务约定：开始新执行/继续会话将绑定当前正式版本
          {agreement.latestConfirmedNumber !== null
            ? ` v${agreement.latestConfirmedNumber}`
            : '（尚无已确认版本，服务端会拒绝执行）'}
          {agreement.hasDraft ? '；存在未确认草稿，不作为执行依据' : ''}。
        </p>
      ) : null}
      {/* #378：执行中约定更新——三选一（追问 / 取消 / 保持本次）都只由用户点，不自动动。 */}
      {agreementNowStale ? (
        <AgreementUpdateNotice
          boundNumber={active?.specRevision?.revisionNumber ?? null}
          latestNumber={agreement.latestConfirmedNumber}
          onAsk={() => {
            setDraft(
              `任务约定已更新到 v${agreement.latestConfirmedNumber}（本次执行绑定的是 v${active?.specRevision?.revisionNumber}）。请以最新版本为准说明需要调整的地方，再继续。`,
            )
            if (active !== undefined) {
              setMode('followup')
              setSourceId(active.id)
            }
          }}
          onCancelRun={() => cancelRunMutation.mutate(active!.id)}
          cancelling={cancelRunMutation.isPending}
          onKeep={() => setKeptStaleRunId(active?.id ?? null)}
          error={cancelRunMutation.isError ? cancelRunMutation.error : null}
        />
      ) : null}
      {revisionContext !== null ? (
        <section
          className="review-settings"
          aria-labelledby="revision-settings"
          data-testid="revision-context"
        >
          <h3 id="revision-settings">修订设置</h3>
          <p className="mutation-hint">
            修订依据：{revisionMaterial?.title ?? '所选材料已不可用'} ·{' '}
            {revisionMaterial?.sha256.slice(0, 12)}
          </p>
          <p className="mutation-hint">
            {
              '请选择产出 Agent 的来源会话，或明确选择开始新执行并重新选 Agent，不自动沿用最近的 Reviewer。本次新记录固定所选意见材料，续跑仍保留旧会话上下文；开始后任务回到进行中，修订产出须重新检查、发布和提交验收。'
            }
          </p>
          <button
            type="button"
            className="button button-quiet"
            disabled={sending}
            onClick={() => setRevisionContext(null)}
          >
            取消修订设置（保留草稿）
          </button>
        </section>
      ) : null}
      {mode === 'review' ? (
        <section className="review-settings" aria-labelledby="artifact-review-settings">
          <h3 id="artifact-review-settings">复核设置</h3>
          <p data-testid="review-scope" className="mutation-hint">
            {
              '材料副本只读，不代表整次执行只读；所选 Agent 仍可使用工具，沿用当前审批设置。请明确选择复核 Agent。已有草稿会保留，选择材料不会自动发送。'
            }
          </p>
          {published.map((artifact) => (
            <SpringCheck
              key={artifact.id}
              className="review-material"
              ariaLabel={`复核材料：${artifact.title}`}
              checked={reviewArtifactIds.includes(artifact.id)}
              disabled={
                sending ||
                (!reviewArtifactIds.includes(artifact.id) && reviewArtifactIds.length >= 64)
              }
              onChange={(checked) =>
                setReviewArtifactIds((ids) =>
                  checked ? [...ids, artifact.id] : ids.filter((id) => id !== artifact.id),
                )
              }
              label={
                <>
                  {artifact.title} · {artifact.sha256.slice(0, 12)}
                </>
              }
            />
          ))}
          <p className="mutation-hint">
            已选择 {reviewArtifactIds.length} 项，最多64项；新发布不会自动加入。
          </p>
          {reviewArtifactIds.some((id) => !published.some((a) => a.id === id)) ? (
            <button
              type="button"
              className="button"
              disabled={sending}
              onClick={() =>
                setReviewArtifactIds((ids) =>
                  ids.filter((id) => published.some((a) => a.id === id)),
                )
              }
            >
              清除失效材料选择
            </button>
          ) : null}
        </section>
      ) : null}
      {reason !== null ? (
        <p className="mutation-hint" role="status" data-testid="execution-blocker">
          {reason}
        </p>
      ) : null}
      {!allowed ? (
        <p className="mutation-hint" data-testid="execution-responsibility">
          由{responsible}执行并处理审批。
        </p>
      ) : null}
      {!allowed ? (
        <a
          href="#comments-heading"
          onClick={() => {
            onDiscuss?.()
            document.getElementById('comments-heading')?.focus()
          }}
        >
          前往讨论
        </a>
      ) : null}
      {!allowed ? (
        <Link to={`/tasks/${task.id}/permissions`}>查看谁能驱动这个任务的 Agent</Link>
      ) : null}
      {grants.isError ||
      (isSourceMode && source.isError) ||
      (mode === 'resume' && sourceAgent.isError) ? (
        <button
          type="button"
          className="button"
          onClick={() => {
            void grants.refetch()
            if (sourceId !== '') void source.refetch()
            if (source.data !== undefined) void sourceAgent.refetch()
          }}
        >
          重新确认
        </button>
      ) : null}
      {(allowed &&
        task.assignmentStatus === 'accepted' &&
        task.status !== 'done' &&
        task.status !== 'cancelled') ||
      draft !== '' ? (
        <fieldset disabled={sending} style={{ border: 0, padding: 0, margin: 0 }}>
          {handoff !== null && isNewExecution ? (
            <SpringCheck
              className="handoff-attach"
              testId="handoff-attach"
              ariaLabel="附带上游交接材料"
              checked={includeHandoff}
              disabled={sending || reason !== null}
              onChange={setIncludeHandoff}
              label={
                <>
                  {`附带上游交接材料：「${handoff.upstreamTaskTitle}」v${handoff.revisionNumber}`}
                  {handoff.hasNewerVersion
                    ? `（上游已有新版本，本次仍固定 v${handoff.revisionNumber}）`
                    : null}
                </>
              }
            />
          ) : null}
          {handoff !== null && mode === 'resume' ? (
            <p className="mutation-hint">
              {`续跑沿用来源执行固化的材料清单（含交接材料，如有）：上游新版本不改本次输入。`}
            </p>
          ) : null}
          {isNewExecution ? (
            <RunLauncher
              key={launcherKey}
              task={task}
              blocked={reason !== null}
              artifactInputIds={
                revisionContext !== null
                  ? [revisionContext.artifactId]
                  : mode === 'review'
                    ? reviewArtifactIds
                    : undefined
              }
              handoffReceiptId={includeHandoff && handoff !== null ? handoff.receiptId : undefined}
              buttonLabel={mode === 'review' ? '开始复核' : '开始执行'}
              settings={launchSettings}
              onSettingsChange={setLaunchSettings}
              session={session}
              hasActiveRun={active !== undefined}
              embedded
              compact={compact}
              settingsContent={executionSettings}
              settingsDisclosure={settingsDisclosure}
              onOutcome={setLastOutcome}
              draft={draft}
              intentKeyRef={memory.intentKey}
              onDraftChange={setDraft}
              onSendingChange={setSending}
              onStarted={(runId) => {
                setStartedRunId(runId)
                memory.update((old) => ({
                  ...old,
                  mode: 'followup',
                  modeOrigin: 'auto',
                  revisionContext: null,
                  sourceId: runId,
                }))
              }}
            />
          ) : (
            <InstructionComposer
              compact={compact}
              settingsContent={executionSettings}
              settingsDisclosure={settingsDisclosure}
              receiverLabel={
                // ADR-0019 决定 3：默认续聊/追问要在输入框上有一个**简短目标标签**，
                // 用户不必展开设置就知道这句话会去哪。
                `${
                  agents.data?.find((agent) => agent.id === source.data?.agentId)?.name ??
                  '来源未确认'
                }${mode === 'resume' ? ` · 续聊${sourceLabel}` : mode === 'followup' ? ` · 追问${sourceLabel}` : ''}`
              }
              key={`${task.id}-${mode}-${sourceId}-${revisionContext?.nonce ?? ''}`}
              blocked={reason !== null}
              artifactInputIds={
                mode === 'resume' && revisionContext !== null
                  ? [revisionContext.artifactId]
                  : undefined
              }
              initialOutcome={
                mode === 'followup' && lastOutcome?.runId === sourceId ? lastOutcome : null
              }
              taskId={task.id}
              hasActiveRun={mode === 'followup'}
              target={null}
              draft={draft}
              intentKeyRef={memory.intentKey}
              onDraftChange={setDraft}
              onSendingChange={setSending}
              approvalPreview={policy}
              intent={{ kind: mode, runId: sourceId }}
              onOutcome={started}
            />
          )}
        </fieldset>
      ) : null}
    </div>
  )
}

/**
 * #378「执行中约定更新」横幅：只呈现事实与三个入口，**不自动**追问、取消或改写草稿。
 * 「按新版本追问」只把建议文字放进执行草稿（用户仍要自己按发送）；「取消本次执行」直接
 * 调既有取消端点；「保持本次」只收起提示（版本采用与否由下一次执行的选择表达）。
 */
function AgreementUpdateNotice({
  boundNumber,
  latestNumber,
  onAsk,
  onCancelRun,
  cancelling,
  onKeep,
  error,
}: {
  boundNumber: number | null
  latestNumber: number | null
  onAsk: () => void
  onCancelRun: () => void
  cancelling: boolean
  onKeep: () => void
  error: unknown
}): ReactNode {
  return (
    <section
      className="agreement-update-notice"
      role="status"
      data-testid="agreement-update-notice"
    >
      <p>
        {`任务约定已在执行中更新为 v${latestNumber}（本次执行绑定的是${
          boundNumber === null ? '未绑定版本' : ` v${boundNumber}`
        }）。你可以继续本次执行，或按新版本处理。`}
      </p>
      <div className="agreement-actions">
        <button type="button" className="button" disabled={cancelling} onClick={onAsk}>
          按新版本追问（填入草稿）
        </button>
        <button type="button" className="button" disabled={cancelling} onClick={onCancelRun}>
          {cancelling ? '正在取消…' : '取消本次执行'}
        </button>
        <button
          type="button"
          className="button button-quiet"
          disabled={cancelling}
          onClick={onKeep}
        >
          保持本次（下次执行采用新版本）
        </button>
      </div>
      <p className="mutation-hint">本次执行的历史与产出不会被改写；新版本只影响之后的执行。</p>
      {error != null ? <ErrorBanner error={error} /> : null}
    </section>
  )
}
