/** 连续对话工作区（ADR-0019）：执行区按 Run 成段连续阅读，详情按需查看。 */
import { useQuery } from '@tanstack/react-query'
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { Link, useLocation, useParams } from 'react-router'
import { WorkspaceIcon } from '../shared/WorkspaceIcon.js'
import { EmptyPanel, SheetHeading } from '../vendor/collectui/collectui.js'
import { api } from '../shared/api/client.js'
import { EXIT_PRESENCE_MS } from '../shared/motion.js'
import { useHashFocus } from '../shared/useHashFocus.js'
import { usePresence } from '../shared/usePresence.js'
import { useConversationFollow } from '../shared/useConversationFollow.js'
import { useReadingAnchor } from '../shared/useReadingAnchor.js'
import { ErrorBanner } from '../app/ErrorBanner.js'
import { useSession } from '../app/session.js'
import { useMemberDirectory } from '../features/team/memberDirectory.js'
import { queryKeys } from '../app/query-client.js'
import type { InstructionView, RunEventItem, TaskRoomView } from '../shared/api/types.js'
import { AssignmentPanel } from '../features/task/AssignmentPanel.js'
import { CommentComposer, CommentList } from '../features/task/CommentComposer.js'
import { DeliveryFlow } from '../features/task/DeliveryFlow.js'
import { HandoffReceiptPanel } from '../features/task/HandoffReceiptPanel.js'
import { HandoffDeliveryPanel } from '../features/task/HandoffDeliveryPanel.js'
import { ExecutionComposer } from '../features/task/ExecutionComposer.js'
import { RunDetailPanel } from '../features/task/RunDetailPanel.js'
import { RunSegment } from '../features/task/RunSegment.js'
import { InstructionBubble } from '../features/task/InstructionBubble.js'
import { RunConsole } from '../features/task/RunConsole.js'
import {
  CONVERSATION_WINDOW,
  CONVERSATION_WINDOW_STEP,
  buildConversation,
  conversationBottomKey,
  visibleRunWindow,
} from '../features/task/conversation.js'
import { useRunEventWindow, useRunReads } from '../features/task/useRunWindows.js'
import { runOrdinalLabels } from '../features/task/runLabels.js'
import { ACTIVE_RUN, QUEUEING_RUN } from '../features/task/run-states.js'
import { formatRunReference } from '../features/task/runReference.js'
import RubberSegment from '../vendor/react-bits-micro/RubberSegment.js'
import { TaskHeader } from '../features/task/TaskHeader.js'
import { TaskAgreementPanel } from '../features/task/TaskAgreementPanel.js'
import { ArtifactList, ReviewerSlot } from '../features/task/ArtifactList.js'
import type { ArtifactReviewRequest } from '../features/task/ExecutionComposer.js'
import type { ApprovalPreview } from '../features/task/InstructionComposer.js'

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
  // ADR-0019 决定 2：历史运行的「继续此会话」把来源交给底部统一输入框（保留已有文字）。
  const [continueRequest, setContinueRequest] = useState<{
    taskId: string
    runId: string
    nonce: string
  } | null>(null)
  // 运行详情面板里选中的运行（undefined = 默认最近一次，不改变底部输入框的目标）。
  const [detailRunId, setDetailRunId] = useState<string | undefined>(undefined)
  // ⑥d：Console 覆盖层显示哪个 Run（undefined = 关）。与详情面板的选中分开：
  // 覆盖层是"放大看"，两者可以同时存在。
  const [consoleRunId, setConsoleRunId] = useState<string | undefined>(undefined)
  // #273：关掉 Console 时先把退场演完再卸载（`usePresence` 保留上一次的 runId + 挂 leaving）。
  const consolePresence = usePresence(consoleRunId ?? null, EXIT_PRESENCE_MS)
  // #250「对这个工件继续说」：交付物区注入的引用 token，落点是独立的团队讨论输入框。
  const [insertToken, setInsertToken] = useState<{ text: string; nonce: number } | null>(null)
  // ADR-0019 决定 1：首屏最近 20 段，顶部每次加载更早 20 次。
  const [runWindow, setRunWindow] = useState(CONVERSATION_WINDOW)

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

  const execHeadingRef = useRef<HTMLHeadingElement>(null)
  // Hooks 必须先于下方所有条件 return（pending/error 分支不经过它们时 Hooks 数不一致）。
  const runs = useMemo(() => query.data?.runs ?? [], [query.data])
  const instructions = useMemo(
    () => (query.data?.instructions ?? []) as InstructionView[],
    [query.data],
  )
  const visibleArtifacts = useMemo(
    () =>
      (query.data?.artifacts ?? []).filter(
        (artifact) =>
          artifact.status === 'published' ||
          (artifact.status === 'candidate' && artifact.ownerUserId === session?.userId),
      ),
    [query.data, session?.userId],
  )
  const runWindowView = useMemo(() => visibleRunWindow(runs, runWindow), [runs, runWindow])
  const reads = useRunReads(runWindowView.visible)
  const conversation = useMemo(() => {
    const eventsByRun = new Map<string, readonly RunEventItem[]>()
    for (const run of runWindowView.visible)
      eventsByRun.set(run.id, reads.get(run.id)?.events ?? [])
    return buildConversation({
      runs,
      instructions,
      artifacts: visibleArtifacts,
      eventsByRun,
      window: runWindow,
    })
  }, [runs, instructions, visibleArtifacts, runWindowView.visible, reads, runWindow])
  // 「都读完了」= 事件与详情都落地（含失败）：段的形状在详情读到后还会变（操作入口、
  // 失败说明），只等事件会让阅读锚点在布局继续变化时提前谢幕（生产验收实测过的 1845px 漂移）。
  const readsSettled = runWindowView.visible.every((run) => {
    const read = reads.get(run.id)
    return (read?.eventsStatus ?? 'pending') !== 'pending' && read?.detailSettled === true
  })

  const [scroller, setScroller] = useState<HTMLDivElement | null>(null)
  const bottomKey = conversationBottomKey(conversation)
  const follow = useConversationFollow(scroller, bottomKey)
  const anchor = useReadingAnchor(scroller, readsSettled, follow.refreshFollowing)
  const loadEarlier = () => {
    anchor.capture()
    setRunWindow((current) => current + CONVERSATION_WINDOW_STEP)
  }

  const activityCount = (query.data?.instructions?.length ?? 0) + runs.length
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

  const { task } = query.data
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
  // ③c-1 的排队语义：指令是 `pending` 且当前活跃 Run 处在**可排队窗口**
  // （`QUEUEING_RUN`，与 hub 同源）时，它排在这个 Run 后面等放行——「已排队」是这一刻的
  // **显示态**，不是服务端状态（服务端只有 3 个枚举值）。
  const activeRun = runs.find((run) => ACTIVE_RUN.has(run.status))
  const queuedIds = new Set(
    activeRun !== undefined && QUEUEING_RUN.has(activeRun.status)
      ? instructions.filter((item) => item.instructionState === 'pending').map((item) => item.id)
      : [],
  )
  // #244 审批档位预览（与 Hub 同式，优先级从高到低）：
  //   有活跃 Run → 追问，档位 = 该 Run 已固化的档（`activeRun.approvalPolicy`）；
  //   Task 覆盖 → `task.approvalPolicy`；
  //   其余 → 服务端预解析的 Revision 默认（房间视图 `nextRunApprovalPolicy`；null = 无可继承 Run）。
  const approvalPreview: ApprovalPreview =
    activeRun !== undefined
      ? { policy: activeRun.approvalPolicy, source: 'active_run' }
      : task.approvalPolicy !== null
        ? { policy: task.approvalPolicy, source: 'task_override' }
        : query.data.nextRunApprovalPolicy !== null
          ? { policy: query.data.nextRunApprovalPolicy, source: 'revision_default' }
          : null
  const detailRun =
    runs.find((run) => run.id === detailRunId) ?? activeRun ?? runs.at(-1) ?? undefined
  const showExecution = () => {
    focusExecution.current = true
    setChannel('execution')
    setSeenActivity(activityCount)
    setInspector(null)
  }
  const openRunDetail = (runId: string) => {
    setDetailRunId(runId)
    openInspector('run')
  }
  // ADR-0019 决定 2：入口在运行详情里，点它就是「把这句话交回底部输入框」——顺手把详情
  // 收起来，否则窄屏下详情占满这一栏（≤1199px 的 `[data-inspecting]` 规则），用户看不见
  // 自己刚被送到哪里。
  const continueSession = (runId: string) => {
    setContinueRequest({ taskId: task.id, runId, nonce: crypto.randomUUID() })
    closeInspector()
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
                  comments={query.data.comments}
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
              <div
                className="workspace-transcript conversation-transcript"
                data-testid="conversation-scroll"
                ref={setScroller}
              >
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
                ) : conversation.entries.length === 0 ? (
                  <div className="workspace-welcome">
                    <EmptyPanel
                      title="我们要完成什么？"
                      description={task.description || undefined}
                      icon={<WorkspaceIcon name="Agents" />}
                    />
                  </div>
                ) : (
                  <>
                    {conversation.hiddenRuns > 0 ? (
                      <button
                        type="button"
                        className="button button-quiet load-earlier"
                        data-testid="load-earlier"
                        onClick={loadEarlier}
                      >
                        加载更早记录（还有 {conversation.hiddenRuns} 次运行）
                      </button>
                    ) : null}
                    <ol className="conversation-list" data-testid="conversation-list">
                      {conversation.entries.map((entry) =>
                        entry.kind === 'run' ? (
                          <RunSegment
                            key={entry.key}
                            task={task}
                            session={session}
                            segment={entry.segment}
                            entryKey={entry.key}
                            read={
                              reads.get(entry.segment.run.id) ?? {
                                detail: undefined,
                                detailSettled: false,
                                events: [],
                                eventsStatus: 'pending',
                                retry: () => undefined,
                              }
                            }
                            queuedIds={queuedIds}
                            authorName={directory.personOf}
                            onOpenDetail={openRunDetail}
                            onOpenConsole={setConsoleRunId}
                            onOpenArtifact={(artifactId) => openInspector('artifacts', artifactId)}
                            onStreamGrowth={follow.followNow}
                            approvalVisible={channel === 'execution' && inspector === null}
                          />
                        ) : (
                          <li
                            key={entry.key}
                            className="conversation-orphan"
                            data-conversation-entry={entry.key}
                          >
                            <ol className="conversation-items">
                              <InstructionBubble
                                instruction={entry.instruction}
                                session={session}
                                queued={queuedIds.has(entry.instruction.id)}
                                onOpenRun={setConsoleRunId}
                                authorName={directory.personOf}
                              />
                            </ol>
                          </li>
                        ),
                      )}
                    </ol>
                  </>
                )}
                {session !== null ? <HandoffReceiptPanel task={task} session={session} /> : null}
                {follow.following ? null : (
                  <button
                    type="button"
                    className="conversation-jump"
                    data-testid="conversation-jump"
                    onClick={follow.resume}
                  >
                    回到最新
                  </button>
                )}
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
                    continueRequest={continueRequest}
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
            data-artifact-focused={
              inspector === 'artifacts' && inspectedArtifactId !== null ? '' : undefined
            }
            role="region"
            aria-label="工作区详情"
            hidden={inspector === null}
            ref={inspectorRef}
            tabIndex={-1}
            onKeyDown={(event) => {
              if (
                event.key === 'Escape' &&
                document.querySelector('[aria-modal="true"]') === null &&
                event.target instanceof Node &&
                event.currentTarget.contains(event.target)
              ) {
                event.stopPropagation()
                closeInspector()
              }
            }}
          >
            <SheetHeading
              icon={
                <WorkspaceIcon
                  name={
                    inspector === 'agreement' ? '复核' : inspector === 'run' ? 'Agents' : '文件'
                  }
                />
              }
              title={
                inspector === 'agreement'
                  ? '任务约定'
                  : inspector === 'run'
                    ? '运行详情'
                    : inspectedArtifactId !== null
                      ? (visibleArtifacts.find((artifact) => artifact.id === inspectedArtifactId)
                          ?.title ?? '交付物')
                      : '交付与复核'
              }
              close={
                <button
                  type="button"
                  className="icon-button"
                  title="关闭"
                  aria-label="关闭工作区详情"
                  onClick={closeInspector}
                >
                  <WorkspaceIcon name="关闭" />
                </button>
              }
            />
            <div hidden={inspector !== 'agreement'}>
              <TaskAgreementPanel embedded task={task} session={session} />
            </div>
            <div hidden={inspector !== 'run'}>
              {hasOpenedRun ? (
                <RunDetailPanel
                  key={detailRun?.id ?? 'none'}
                  task={task}
                  session={session}
                  runs={runs}
                  selectedRunId={detailRun?.id}
                  onSelectRun={setDetailRunId}
                  onOpenConsole={setConsoleRunId}
                  onContinueSession={continueSession}
                />
              ) : null}
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
                <h3
                  id="artifacts-heading"
                  className={inspectedArtifactId !== null ? 'visually-hidden' : undefined}
                >
                  交付物
                </h3>
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
 * Console 的取数壳（⑥d；P1-393 起走共享分页读取）：事件由这里取，`RunConsole`
 * 只负责展示与筛选——这样筛选逻辑（`matchesFilter`）可以脱离请求单独判。
 * 分页失败时已读事件照常展示，并给重试入口（不把「没读完」说成「没有事件」）。
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
  const read = useRunEventWindow(runId)
  const label = runOrdinalLabels(runs).get(runId) ?? '运行'
  return (
    <RunConsole
      runId={runId}
      runLabel={label}
      runStatus={runs.find((run) => run.id === runId)?.status}
      leaving={leaving}
      events={read.events}
      eventsPending={read.status === 'pending'}
      // 取数失败必须传下去：console 拿到的空数组既可能是"真的没有事件"，也可能是"没读到"，
      // 排障界面把后者说成前者就是在骗操作者（评审 S1）。
      eventsError={read.status === 'incomplete' ? new Error('events incomplete') : undefined}
      onRetry={read.retry}
      onClose={onClose}
    />
  )
}
