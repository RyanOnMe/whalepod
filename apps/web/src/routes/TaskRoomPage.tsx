/** 聚焦任务工作区（ADR-0018）：执行/讨论独立输入，详情按需查看。 */
import { useQuery } from '@tanstack/react-query'
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { Link, useLocation, useParams } from 'react-router'
import { api } from '../shared/api/client.js'
import { formatBytes } from '../shared/format.js'
import { EXIT_PRESENCE_MS } from '../shared/motion.js'
import { useHashFocus } from '../shared/useHashFocus.js'
import { usePresence } from '../shared/usePresence.js'
import { ErrorBanner } from '../app/ErrorBanner.js'
import { useSession } from '../app/session.js'
import { useMemberDirectory } from '../features/team/memberDirectory.js'
import { queryKeys } from '../app/query-client.js'
import type { InstructionView, RunEventItem, TaskRoomView } from '../shared/api/types.js'
import { ArtifactList, ReviewerSlot } from '../features/task/ArtifactList.js'
import { AssignmentPanel } from '../features/task/AssignmentPanel.js'
import { CommentComposer, CommentList } from '../features/task/CommentComposer.js'
import { DeliveryFlow } from '../features/task/DeliveryFlow.js'
import { RunInputManifest } from '../features/task/RunInputManifest.js'
import { RunHandoffDraft } from '../features/task/RunHandoffDraft.js'
import { HandoffReceiptPanel } from '../features/task/HandoffReceiptPanel.js'
import { HandoffDeliveryPanel } from '../features/task/HandoffDeliveryPanel.js'
import {
  ExecutionComposer,
  type ArtifactReviewRequest,
} from '../features/task/ExecutionComposer.js'
import type { ApprovalPreview } from '../features/task/InstructionComposer.js'
import { RunConsole } from '../features/task/RunConsole.js'
import { InstructionList } from '../features/task/InstructionList.js'
import { RunLivePanel } from '../features/task/RunLivePanel.js'
import { runOrdinalLabels } from '../features/task/runLabels.js'
import { ACTIVE_RUN, QUEUEING_RUN, TERMINAL_RUN } from '../features/task/run-states.js'
import { formatRunReference } from '../features/task/runReference.js'
import { ApprovalSlot, RunTimeline } from '../features/task/RunTimeline.js'
import RubberSegment from '../vendor/react-bits-micro/RubberSegment.js'
import { TaskHeader } from '../features/task/TaskHeader.js'
import { TaskAgreementPanel } from '../features/task/TaskAgreementPanel.js'

export function TaskRoomPage(): ReactNode {
  const { taskId } = useParams()
  return <TaskRoom key={taskId} />
}

// Route parameters can change while both rooms remain cached. Keep local intent
// and selected Run state within one Task, including expanded input/console views.
function TaskRoom(): ReactNode {
  const { taskId } = useParams()
  const location = useLocation()
  const [channel, setChannel] = useState<'execution' | 'discussion'>(() =>
    location.hash === '#comments-heading' ? 'discussion' : 'execution',
  )
  const [inspector, setInspector] = useState<'agreement' | 'artifacts' | 'run' | null>(null)
  const [hasOpenedRun, setHasOpenedRun] = useState(false)
  const [inspectedArtifactId, setInspectedArtifactId] = useState<string | null>(null)
  const inspectorTrigger = useRef<HTMLElement | null>(null)
  const inspectorRef = useRef<HTMLElement>(null)
  const restoreInspectorFocus = useRef(false)
  const focusExecution = useRef(false)
  const openInspector = (
    next: 'agreement' | 'artifacts' | 'run',
    artifactId: string | null = null,
  ) => {
    inspectorTrigger.current =
      document.activeElement instanceof HTMLElement ? document.activeElement : null
    if (next === 'run') setHasOpenedRun(true)
    setInspectedArtifactId(artifactId)
    setInspector(next)
  }
  const closeInspector = () => {
    restoreInspectorFocus.current = true
    setInspector(null)
  }
  useEffect(() => {
    if (inspector !== null) inspectorRef.current?.focus()
    else if (restoreInspectorFocus.current) {
      restoreInspectorFocus.current = false
      inspectorTrigger.current?.focus()
    }
  }, [inspector])
  useEffect(() => {
    if (location.hash === '#comments-heading') {
      setChannel('discussion')
      setInspector(null)
    } else if (
      location.hash.startsWith('#approval-') ||
      location.hash === '#task-execution' ||
      location.hash === '#task-assignment'
    ) {
      setChannel('execution')
      setInspector(null)
    } else if (location.hash.startsWith('#artifact-')) {
      setInspector('artifacts')
      setInspectedArtifactId(null)
    }
  }, [location.hash, location.key])
  const session = useSession()
  const directory = useMemberDirectory()
  const [revisionRequest, setRevisionRequest] = useState<ArtifactReviewRequest | null>(null)
  const [reviewRequest, setReviewRequest] = useState<ArtifactReviewRequest | null>(null)
  const [selectedRunId, setSelectedRunId] = useState<string | undefined>(undefined)
  // ⑥d：Console 覆盖层显示哪个 Run（undefined = 关）。与 `selectedRunId`（内联面板）分开：
  // 内联面板是默认视图，覆盖层是"放大看"，两者可以同时存在。
  const [consoleRunId, setConsoleRunId] = useState<string | undefined>(undefined)
  // #273：关掉 Console 时先把退场演完再卸载（`usePresence` 保留上一次的 runId + 挂 leaving）。
  // 退场中途又打开另一个 Run 会**取消**退场（hook 的语义），不会出现"新的被旧的定时器摘掉"。
  const consolePresence = usePresence(consoleRunId ?? null, EXIT_PRESENCE_MS)
  // #250「对这个工件继续说」：交付物区注入的引用 token，落点是独立的团队讨论输入框。
  // nonce 保证同一 token 连点两次也落两次账；composer 消费后回调清状态。
  const [insertToken, setInsertToken] = useState<{ text: string; nonce: number } | null>(null)

  const query = useQuery({
    queryKey: queryKeys.taskRoom(taskId ?? ''),
    queryFn: () => api.get<TaskRoomView>(`/tasks/${taskId ?? ''}`),
    enabled: taskId !== undefined,
    refetchOnMount: 'always',
  })

  // ApprovalSlot owns approval anchors, which depend on its separate event query.
  const approvalAnchor = location.hash.startsWith('#approval-')
  const hashViewReady = location.hash.startsWith('#artifact-')
    ? inspector === 'artifacts'
    : location.hash === '#comments-heading'
      ? channel === 'discussion' && inspector === null
      : location.hash === '#task-execution' || location.hash === '#task-assignment'
        ? channel === 'execution' && inspector === null
        : true
  useHashFocus(query.isSuccess && !approvalAnchor && hashViewReady, true, query.data)

  // #277：加载骨架也有在场语义——数据到达后它先演完退场，再卸载（硬切就是从这儿来的）。
  const skeletonPresence = usePresence(
    query.isPending ? ('skeleton' as const) : null,
    EXIT_PRESENCE_MS,
  )

  // #231（ADR-0010 决策 6 的信息真空债）：只盯讨论栏的用户要能知道执行区来了
  // 新动静。首屏数据是基线（不算「新」）；活动数（指令+运行）超过已看过的值才提示。
  const execHeadingRef = useRef<HTMLHeadingElement>(null)
  // Hooks 必须先于下方所有条件 return（pending/error 分支不经过它们时 Hooks 数不一致）。
  const activityCount = (query.data?.instructions?.length ?? 0) + (query.data?.runs.length ?? 0)
  const [seenActivity, setSeenActivity] = useState<number | undefined>(undefined)
  useEffect(() => {
    if (query.isSuccess && (seenActivity === undefined || channel === 'execution'))
      setSeenActivity(activityCount)
  }, [query.isSuccess, activityCount, seenActivity, channel])
  useEffect(() => {
    if (channel === 'execution' && focusExecution.current) {
      focusExecution.current = false
      execHeadingRef.current?.focus()
    }
  }, [channel, inspector])
  const hasNewActivity = seenActivity !== undefined && activityCount > seenActivity

  if (taskId === undefined) {
    return (
      <div className="card error-state" role="alert">
        <h1>任务地址无效</h1>
        <p>
          <Link to="/">返回项目列表</Link>
        </p>
      </div>
    )
  }

  if (query.isPending) {
    // #231：骨架行预告两栏布局（纯文本「正在加载」会让页面结构跳变）。
    // #277：数据到达后它不立刻消失——见下面 `.crossfade-stack` 的退场叠加。
    return <RoomSkeleton />
  }
  if (query.isError) {
    return (
      <div className="task-room-error">
        <ErrorBanner error={query.error} />
        <button type="button" className="button" onClick={() => void query.refetch()}>
          重试
        </button>
      </div>
    )
  }
  // #277：数据到了——骨架再留 `EXIT_PRESENCE_MS` 演完退场（叠在内容之上淡出，见
  // `.crossfade-stack`）；内容只在"从骨架过来"时挂入场类（普通路由进入不演，
  // 免得变成只对部分页面生效的"路由过渡"）。这就是原先硬切的那一刀。
  const fromSkeleton = skeletonPresence.value !== null

  const { task, comments, runs, artifacts } = query.data
  // #378：agreement 是新字段——旧桩/旧缓存 payload 可能没有它；按「未启用」兜底而不是
  // 崩溃（真服务端恒发；这里是读模型的向前兼容，不是把缺字段当正常数据用）。
  const agreementSummary = query.data.agreement ?? {
    enabled: false,
    latestConfirmedNumber: null,
    hasDraft: false,
  }
  // #380：下游交接摘要与 agreement 同一向前兼容口径（真服务端恒发；旧桩缺字段按
  // 「不是交接的下游」兜底，不让房间崩）。
  const handoffSummary = query.data.handoff ?? null
  // `instructions` 是 ③c-2a 的字段，hub 侧**无条件**返回它（`task/view.ts`）。
  // 复核 #209 观察 5 指出：本仓没有 query 持久化，"旧缓存可能没有它"这个理由不成立——
  // 这里唯一能挡的是**服务端契约违约**，而静默兜成空列表会让用户看到"还没有人驱动过这个任务"
  // 而不是"数据不完整"。所以缺字段时**显式呈现**（见下面的告警块），不假装成空。
  const instructionsMissing = query.data.instructions === undefined
  const instructions = (query.data.instructions ?? []) as InstructionView[]
  // ③c-1 的排队语义：指令是 `pending` 且当前活跃 Run 处在**可排队窗口**
  // （`QUEUEING_RUN`，与 hub 同源）时，它排在这个 Run 后面等放行——「已排队」是这一刻的
  // **显示态**，不是服务端状态（服务端只有 3 个枚举值）。复核 #209 的页面级变异证明：
  // 不算这个，四态里的「已排队」在真实页面上**永远不会出现**。
  const activeRun = runs.find((run) => ACTIVE_RUN.has(run.status))
  const queuedIds = new Set(
    activeRun !== undefined && QUEUEING_RUN.has(activeRun.status)
      ? instructions.filter((item) => item.instructionState === 'pending').map((item) => item.id)
      : [],
  )
  // #246 工具轨迹内联：runId → 最近一次工具调用摘要（服务端已按 project 受众解析），
  // 供指令流的 chip 只读消费。
  const lastToolCallByRun = new Map(
    runs
      .filter((run) => run.lastToolCall !== null)
      .map((run) => [run.id, run.lastToolCall!] as const),
  )
  // #244 审批档位预览（与 Hub 同式，优先级从高到低）：
  //   有活跃 Run → 追问，档位 = 该 Run 已固化的档（`activeRun.approvalPolicy`）；
  //   Task 覆盖 → `task.approvalPolicy`；
  //   其余 → 服务端预解析的 Revision 默认（房间视图 `nextRunApprovalPolicy`；null = 无可继承 Run）。
  // 解析只在此处做一遍，InstructionComposer 只消费（`ApprovalPreview`），别处不复制这条链。
  const approvalPreview: ApprovalPreview =
    activeRun !== undefined
      ? { policy: activeRun.approvalPolicy, source: 'active_run' }
      : task.approvalPolicy !== null
        ? { policy: task.approvalPolicy, source: 'task_override' }
        : query.data.nextRunApprovalPolicy !== null
          ? { policy: query.data.nextRunApprovalPolicy, source: 'revision_default' }
          : null
  const visibleRunId = selectedRunId ?? activeRun?.id ?? runs.at(-1)?.id
  const visibleArtifacts = artifacts.filter(
    (artifact) =>
      artifact.status === 'published' ||
      (artifact.status === 'candidate' && artifact.ownerUserId === session?.userId),
  )
  const showExecution = () => {
    focusExecution.current = true
    setChannel('execution')
    setSeenActivity(activityCount)
    setInspector(null)
  }
  return (
    <div className="crossfade-stack focused-workspace">
      {fromSkeleton ? <RoomSkeleton leaving={skeletonPresence.leaving} /> : null}
      <div className={fromSkeleton ? 'task-room crossfade-in' : 'task-room'}>
        <TaskHeader
          task={task}
          session={session}
          reviewEligibility={query.data.reviewEligibility}
          compact
        />
        <div className="workspace-toolbar">
          <RubberSegment
            label="工作区视图"
            testIdPrefix="workspace-view-"
            value={channel}
            onChange={(next) => {
              setChannel(next)
              setInspector(null)
            }}
            items={[
              { value: 'execution', label: 'Agent 执行' },
              { value: 'discussion', label: '团队讨论' },
            ]}
          />
          <div className="workspace-tools">
            <button
              type="button"
              className="button button-quiet"
              aria-expanded={inspector === 'agreement'}
              onClick={() => openInspector('agreement')}
            >
              任务约定
              {agreementSummary.enabled
                ? ` · ${agreementSummary.latestConfirmedNumber === null ? '待确认' : `v${agreementSummary.latestConfirmedNumber}`}`
                : ''}
            </button>
            <button
              type="button"
              className="button button-quiet"
              aria-expanded={inspector === 'artifacts'}
              onClick={() => openInspector('artifacts')}
            >
              交付与复核
            </button>
            <button
              type="button"
              className="button button-quiet"
              aria-expanded={inspector === 'run'}
              onClick={() => openInspector('run')}
            >
              运行详情
            </button>
          </div>
        </div>
        <div className="workspace-body" data-inspecting={inspector !== null ? '' : undefined}>
          <div className="workspace-conversation">
            <section
              id="discussion-channel"
              className="workspace-channel"
              hidden={channel !== 'discussion'}
              aria-labelledby="comments-heading"
            >
              <div className="workspace-transcript">
                <h2 id="comments-heading" tabIndex={-1}>
                  讨论
                </h2>
                <p className="room-column-note">团队成员之间 · 不触发 Agent</p>
                {hasNewActivity || activeRun?.status === 'waiting_approval' ? (
                  <button
                    type="button"
                    className="execution-activity-hint"
                    data-testid="execution-activity-hint"
                    onClick={showExecution}
                  >
                    {activeRun?.status === 'waiting_approval'
                      ? '执行等待审批——前往处理'
                      : '执行区有新活动——点开看看'}
                  </button>
                ) : null}
                <CommentList
                  comments={comments}
                  session={session}
                  runs={runs}
                  onOpenRun={setConsoleRunId}
                />
              </div>
              <div className="workspace-dock discussion-dock">
                <p className="room-column-note">发送给团队成员</p>
                <CommentComposer
                  taskId={task.id}
                  runs={runs}
                  runLabels={runOrdinalLabels(runs)}
                  insertToken={insertToken}
                  onInsertTokenConsumed={() => setInsertToken(null)}
                />
              </div>
            </section>
            <section
              id="execution-channel"
              className="workspace-channel"
              hidden={channel !== 'execution'}
              aria-labelledby="instructions-heading"
            >
              <div className="workspace-transcript">
                <h2
                  id="instructions-heading"
                  ref={execHeadingRef}
                  tabIndex={-1}
                  className="visually-hidden"
                >
                  执行
                </h2>
                <AssignmentPanel
                  compact
                  task={task}
                  session={session}
                  hasActiveRun={activeRun !== undefined}
                />
                {instructionsMissing ? (
                  <p className="stream-incomplete" role="status" data-testid="instructions-missing">
                    指令流读取不完整：服务端这次的响应里没有指令流。请注意，这并不是“还没有指令”。
                  </p>
                ) : instructions.length === 0 && runs.length === 0 ? (
                  <div className="workspace-welcome">
                    <h2>我们要完成什么？</h2>
                    {task.description ? <p>{task.description}</p> : null}
                  </div>
                ) : (
                  <InstructionList
                    instructions={instructions}
                    session={session}
                    authorName={directory.personOf}
                    queuedIds={queuedIds}
                    lastToolCallByRun={lastToolCallByRun}
                    onOpenRun={setConsoleRunId}
                  />
                )}
                <h2 id="runs-heading" className="visually-hidden">
                  运行
                </h2>
                {runs.length > 0 ? (
                  <section className="workspace-runs" aria-labelledby="runs-heading">
                    <RunTimeline
                      runs={runs}
                      selectedRunId={visibleRunId}
                      onSelect={setSelectedRunId}
                    />
                    {visibleRunId !== undefined && session !== null ? (
                      <RunLivePanel
                        compact
                        key={visibleRunId}
                        runId={visibleRunId}
                        session={session}
                        runLabels={runOrdinalLabels(runs)}
                        onOpenConsole={() => setConsoleRunId(visibleRunId)}
                      />
                    ) : null}
                  </section>
                ) : null}
                {visibleArtifacts.length > 0 ? (
                  <section className="workspace-artifacts" aria-label="本任务交付物">
                    {visibleArtifacts.map((artifact) => (
                      <button
                        type="button"
                        className="workspace-file"
                        key={artifact.id}
                        aria-label={`查看交付物 ${artifact.title}`}
                        onClick={() => openInspector('artifacts', artifact.id)}
                      >
                        <span className="workspace-file-icon" aria-hidden="true">
                          <svg viewBox="0 0 24 28" width="24" height="28" fill="none">
                            <path
                              d="M5 1h9l6 6v18a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V3a2 2 0 0 1 2-2Z"
                              stroke="currentColor"
                              strokeWidth="1.4"
                            />
                            <path
                              d="M14 1v7h6M7 14h9M7 18h9M7 22h5"
                              stroke="currentColor"
                              strokeWidth="1.4"
                              strokeLinecap="round"
                            />
                          </svg>
                        </span>
                        <span>
                          <strong>{artifact.title}</strong>
                          <small>
                            {artifact.status === 'candidate'
                              ? '仅你可见 · 待检查发布'
                              : '已发布给团队'}{' '}
                            · {formatBytes(artifact.byteSize)}
                          </small>
                        </span>
                        <span aria-hidden="true">↗</span>
                      </button>
                    ))}
                  </section>
                ) : null}
                <div className="workspace-approvals">
                  <ApprovalSlot
                    runs={runs}
                    task={task}
                    session={session}
                    visible={channel === 'execution' && inspector === null}
                  />
                </div>
                {session !== null ? <HandoffReceiptPanel task={task} session={session} /> : null}
              </div>
              {session !== null ? (
                <div className="workspace-dock">
                  <ExecutionComposer
                    compact
                    key={task.id}
                    task={task}
                    session={session}
                    confirmingTask={query.isFetching && !query.isFetchedAfterMount}
                    runs={runs}
                    approvalPreview={approvalPreview}
                    artifacts={visibleArtifacts}
                    agreement={agreementSummary}
                    handoff={handoffSummary}
                    reviewRequest={reviewRequest}
                    revisionRequest={revisionRequest}
                    onDiscuss={() => {
                      setChannel('discussion')
                      requestAnimationFrame(() =>
                        document.getElementById('comments-heading')?.focus(),
                      )
                    }}
                  />
                </div>
              ) : null}
            </section>
          </div>
          <aside
            className="workspace-inspector"
            role="region"
            aria-label="工作区详情"
            hidden={inspector === null}
            ref={inspectorRef}
            tabIndex={-1}
            onKeyDown={(event) => {
              if (event.key === 'Escape') {
                event.stopPropagation()
                closeInspector()
              }
            }}
          >
            <div className="workspace-inspector-head">
              <h2>
                {inspector === 'agreement'
                  ? '任务约定'
                  : inspector === 'run'
                    ? '运行详情'
                    : '交付与复核'}
              </h2>
              <button
                type="button"
                className="button button-quiet"
                aria-label="关闭工作区详情"
                onClick={closeInspector}
              >
                关闭
              </button>
            </div>
            <div hidden={inspector !== 'agreement'}>
              <TaskAgreementPanel task={task} session={session} />
            </div>
            <div hidden={inspector !== 'run'}>
              {visibleRunId !== undefined && session !== null && hasOpenedRun ? (
                <>
                  <RunInputManifest
                    key={visibleRunId}
                    runId={visibleRunId}
                    taskId={task.id}
                    runLabels={runOrdinalLabels(runs)}
                  />
                  <RunHandoffDraft
                    key={`handoff-draft-${visibleRunId}`}
                    runId={visibleRunId}
                    task={task}
                    session={session}
                    runTerminal={TERMINAL_RUN.has(
                      runs.find((run) => run.id === visibleRunId)?.status ?? 'queued',
                    )}
                  />
                </>
              ) : (
                <p className="empty-state">还没有 Run。开始执行后可查看输入与交接草稿。</p>
              )}
            </div>
            <div hidden={inspector !== 'artifacts'}>
              {inspectedArtifactId !== null ? (
                <button
                  type="button"
                  className="button button-quiet"
                  onClick={() => setInspectedArtifactId(null)}
                >
                  查看全部交付物
                </button>
              ) : null}
              <section aria-labelledby="artifacts-heading">
                <h3 id="artifacts-heading">交付物</h3>
                <ArtifactList
                  artifacts={
                    inspectedArtifactId === null
                      ? visibleArtifacts
                      : visibleArtifacts.filter((artifact) => artifact.id === inspectedArtifactId)
                  }
                  session={session}
                  taskId={task.id}
                  runs={runs}
                  onRequestRevision={(artifactId) => {
                    setReviewRequest(null)
                    setRevisionRequest({ taskId: task.id, artifactId, nonce: crypto.randomUUID() })
                    showExecution()
                  }}
                  onRequestReview={(artifactId) => {
                    setRevisionRequest(null)
                    setReviewRequest({ taskId: task.id, artifactId, nonce: crypto.randomUUID() })
                    showExecution()
                  }}
                  onReferenceRun={(runId) => {
                    setChannel('discussion')
                    setInspector(null)
                    setInsertToken({ text: formatRunReference(runId), nonce: Date.now() })
                  }}
                />
              </section>
              <ReviewerSlot />
              <DeliveryFlow
                task={task}
                session={session}
                artifacts={visibleArtifacts}
                runs={runs}
                reviewEligibility={query.data.reviewEligibility}
              />
              {session !== null ? <HandoffDeliveryPanel task={task} session={session} /> : null}
            </div>
          </aside>
        </div>
        {consolePresence.value === null ? null : (
          <RunConsoleHost
            runId={consolePresence.value}
            runs={runs}
            leaving={consolePresence.leaving}
            onClose={() => setConsoleRunId(undefined)}
          />
        )}
      </div>
    </div>
  )
}

/**
 * 聚焦工作区加载骨架。数据到达后沿用 crossfade-stack 退场，不额外占布局高度。
 */
function RoomSkeleton({ leaving = false }: { leaving?: boolean }): ReactNode {
  return (
    <div
      className={`room-skeleton${leaving ? ' leaving' : ''}`}
      aria-busy="true"
      data-testid="room-skeleton"
    >
      <div className="workspace-skeleton">
        {Array.from({ length: 4 }, (_, i) => (
          <span key={`l-${i}`} className="skeleton-line" />
        ))}
        {Array.from({ length: 4 }, (_, i) => (
          <span key={`r-${i}`} className="skeleton-line" />
        ))}
      </div>
    </div>
  )
}

/**
 * Console 的取数壳（⑥d）：事件由这里取，`RunConsole` 只负责展示与筛选——
 * 这样筛选逻辑（`matchesFilter`）可以脱离请求单独判。
 */
function RunConsoleHost({
  runId,
  runs,
  leaving,
  onClose,
}: {
  runId: string
  runs: TaskRoomView['runs']
  /** #273：正在退场（`usePresence` 给的窗口），透传给 `RunConsole` 挂 `.leaving`。 */
  leaving: boolean
  onClose: () => void
}): ReactNode {
  const eventsQuery = useQuery({
    queryKey: queryKeys.runEvents(runId),
    queryFn: () => api.get<{ events: RunEventItem[] }>(`/runs/${runId}/events`),
  })
  const label = runOrdinalLabels(runs).get(runId) ?? '运行'
  return (
    <RunConsole
      runId={runId}
      runLabel={label}
      runStatus={runs.find((run) => run.id === runId)?.status}
      leaving={leaving}
      events={eventsQuery.data?.events ?? []}
      eventsPending={eventsQuery.isPending}
      // 取数失败必须传下去：console 拿到的空数组既可能是"真的没有事件"，也可能是"没读到"，
      // 排障界面把后者说成前者就是在骗操作者（评审 S1）。
      eventsError={eventsQuery.error ?? undefined}
      onClose={onClose}
    />
  )
}
