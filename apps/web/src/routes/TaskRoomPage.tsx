/**
 * Task Room（切片⑥a-2：ADR-0010 的**两栏**形态）：
 * - 顶部：Task 目标/状态/责任人 + 责任人行动（features/task/TaskHeader）
 * - **左栏「讨论」**：团队成员之间的话（CommentList/CommentComposer）——这一栏**永不触发运行**
 *   （ADR-0010 决策 4：`@Agent` 不再是评论语法）；
 * - **右栏「执行」**：驱动 Agent 的指令流（InstructionList）+ Run 与审批（RunTimeline/
 *   ApprovalSlot/ExecutionComposer），以及**可折叠的任务详情**（指派接受/拒绝 + 交付物 + 复核）。
 *
 * 为什么把指派与交付物折进执行栏底部（用户 2026-09-15 选定）：这两件事都不是高频动作，
 * 为它们留一条常驻窄栏会让两栏（讨论｜执行）的对比被削弱；折叠后默认不占视觉重量，
 * 需要时一层展开即可，功能一个不少。
 *
 * 加载/错误状态显式呈现，不伪装成空数据；空态说明下一步。
 * 区段标题一律中文（#152）；Agent/Run/Task 这类领域术语保留英文（CONTEXT.md 的领域语言）。
 */
import { useQuery } from '@tanstack/react-query'
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { Link, useLocation, useParams } from 'react-router'
import { api } from '../shared/api/client.js'
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
  // #250「对这个工件继续说」：交付物区注入的引用 token，落点是左栏讨论输入框。
  // nonce 保证同一 token 连点两次也落两次账；composer 消费后回调清状态。
  const [insertToken, setInsertToken] = useState<{ text: string; nonce: number } | null>(null)

  const query = useQuery({
    queryKey: queryKeys.taskRoom(taskId ?? ''),
    queryFn: () => api.get<TaskRoomView>(`/tasks/${taskId ?? ''}`),
    enabled: taskId !== undefined,
    refetchOnMount: 'always',
  })

  // ApprovalSlot owns approval anchors, which depend on its separate event query.
  const approvalAnchor = useLocation().hash.startsWith('#approval-')
  useHashFocus(query.isSuccess && !approvalAnchor, true, query.data)

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
    if (query.isSuccess && seenActivity === undefined) setSeenActivity(activityCount)
  }, [query.isSuccess, activityCount, seenActivity])
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
  return (
    <div className="crossfade-stack">
      {fromSkeleton ? <RoomSkeleton leaving={skeletonPresence.leaving} /> : null}
      <div className={fromSkeleton ? 'task-room crossfade-in' : 'task-room'}>
        <TaskHeader
          task={task}
          session={session}
          reviewEligibility={query.data.reviewEligibility}
        />
        {/* #378：任务约定（执行前的共同依据）——只读/起草/确认，不触发任何执行。 */}
        <TaskAgreementPanel task={task} session={session} />
        <div className="task-room-split">
          {/* 讨论栏：只有人说话，永不触发运行 */}
          <section className="task-room-col" aria-labelledby="comments-heading">
            <div className="card room-column">
              <div className="room-column-head">
                <h2 id="comments-heading" tabIndex={-1}>
                  讨论
                </h2>
                <span className="room-column-note">团队成员之间 · 不触发 Agent</span>
              </div>
              {hasNewActivity ? (
                <button
                  type="button"
                  className="execution-activity-hint"
                  data-testid="execution-activity-hint"
                  onClick={() => {
                    setSeenActivity(activityCount)
                    execHeadingRef.current?.focus()
                  }}
                >
                  执行区有新活动——点开看看
                </button>
              ) : null}
              {/* ⑥f：讨论里可以引用某次运行——引用只能指向**本任务**的运行，所以把 runs 与
                「点引用 → 开 Console」都从页面注入（解析逻辑在 runReference.ts，可单测）。 */}
              <CommentList
                comments={comments}
                session={session}
                runs={runs}
                onOpenRun={setConsoleRunId}
              />
              <CommentComposer
                taskId={task.id}
                runs={runs}
                runLabels={runOrdinalLabels(runs)}
                insertToken={insertToken}
                onInsertTokenConsumed={() => setInsertToken(null)}
              />
            </div>
          </section>

          {/* 执行栏：指令 + 运行 + 审批 */}
          <section className="task-room-col" aria-labelledby="instructions-heading">
            <div className="card room-column">
              <div className="room-column-head">
                <h2 id="instructions-heading" ref={execHeadingRef} tabIndex={-1}>
                  执行
                </h2>
              </div>
              {instructionsMissing ? (
                // 缺字段 ≠ 没有指令：显式说出来，不静默成空列表（复核 #209 观察 5 / R1）。
                // ① 文案里不留 Markdown 星号（复核实测页面上会原样显示 `**`），也不夹协议字段名；
                // ② 视觉档**不能复用 `.empty-state`**——复核实测它与同栏「还没有人驱动过这个任务」
                //    渲染完全一致，用户只会读成"又一个空态"，而这正是要区分的两件事。
                <p className="stream-incomplete" role="status" data-testid="instructions-missing">
                  指令流读取不完整：服务端这次的响应里没有指令流。请注意，这并不是"还没有指令"。
                </p>
              ) : (
                // 缺字段时**不渲染列表**：否则空态"还没有人驱动过这个任务"会与上面的告警同时出现，
                // 两句话自相矛盾（判据实测抓到）。要么说"读取不完整"，要么说"还没有指令"，不并列。
                <InstructionList
                  instructions={instructions}
                  session={session}
                  authorName={directory.personOf}
                  queuedIds={queuedIds}
                  lastToolCallByRun={lastToolCallByRun}
                  onOpenRun={setConsoleRunId}
                />
              )}
              {session !== null ? (
                <>
                  {/* 下游交接包（#380）：接收确认不自动开始执行——面板在 composer 之上，
                      「先确认再执行」的次序就是页面次序。 */}
                  <HandoffReceiptPanel task={task} session={session} />
                  <ExecutionComposer
                    key={task.id}
                    task={task}
                    session={session}
                    confirmingTask={query.isFetching && !query.isFetchedAfterMount}
                    runs={runs}
                    approvalPreview={approvalPreview}
                    artifacts={artifacts}
                    agreement={agreementSummary}
                    handoff={handoffSummary}
                    reviewRequest={reviewRequest}
                    revisionRequest={revisionRequest}
                  />
                </>
              ) : null}
            </div>

            <div className="card" aria-labelledby="runs-heading">
              <h2 id="runs-heading">运行</h2>
              <RunTimeline runs={runs} selectedRunId={selectedRunId} onSelect={setSelectedRunId} />
              {selectedRunId !== undefined && session !== null ? (
                <>
                  <RunLivePanel
                    runId={selectedRunId}
                    session={session}
                    runLabels={runOrdinalLabels(runs)}
                    onOpenConsole={() => setConsoleRunId(selectedRunId)}
                  />
                  <RunInputManifest
                    key={selectedRunId}
                    runId={selectedRunId}
                    taskId={task.id}
                    runLabels={runOrdinalLabels(runs)}
                  />
                  <RunHandoffDraft
                    runId={selectedRunId}
                    task={task}
                    session={session}
                    runTerminal={TERMINAL_RUN.has(
                      runs.find((run) => run.id === selectedRunId)?.status ?? 'queued',
                    )}
                  />
                </>
              ) : null}
              <ApprovalSlot runs={runs} task={task} session={session} />
            </div>

            {/* 上游「已交接」（#380）：交付与接收关系追踪；无可发布版本也无交付时自隐。 */}
            {session !== null ? <HandoffDeliveryPanel task={task} session={session} /> : null}

            {/* 指派与启程：**常驻**，不折进详情——接受指派是责任人进入工作前的必经一步
              （没接受就不能起 Run），把它藏进折叠区等于把门藏在门后。 */}
            <AssignmentPanel task={task} session={session} hasActiveRun={activeRun !== undefined} />

            {/* 任务详情：交付物与复核——低频，折起来不占视觉重量（用户选定方案①） */}
            {/* **默认展开**（仍可手动折叠）：Q5 的 G6-04 证明「发布交付物」是金路径的一部分
              （e2e 要点发布按钮），默认折叠会让它 hidden、直接断链；折叠能力保留，
              但默认不把必经动作藏起来。 */}
            <details className="card task-details" open>
              <summary>任务详情（交付物 · 复核）</summary>
              <div className="task-details-body">
                <section aria-labelledby="artifacts-heading">
                  <h3 id="artifacts-heading">交付物</h3>
                  <ArtifactList
                    artifacts={artifacts}
                    session={session}
                    taskId={task.id}
                    runs={runs}
                    onRequestRevision={(artifactId) => {
                      setReviewRequest(null)
                      setRevisionRequest({
                        taskId: task.id,
                        artifactId,
                        nonce: crypto.randomUUID(),
                      })
                      execHeadingRef.current?.focus()
                    }}
                    onRequestReview={(artifactId) => {
                      setRevisionRequest(null)
                      setReviewRequest({ taskId: task.id, artifactId, nonce: crypto.randomUUID() })
                      execHeadingRef.current?.focus()
                    }}
                    onReferenceRun={(runId) =>
                      setInsertToken({ text: formatRunReference(runId), nonce: Date.now() })
                    }
                  />
                </section>
                <ReviewerSlot />
                <DeliveryFlow
                  task={task}
                  session={session}
                  artifacts={artifacts}
                  runs={runs}
                  reviewEligibility={query.data.reviewEligibility}
                />
              </div>
            </details>
          </section>
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
 * 加载骨架（#231 的形态 + #277 的退场）：两栏各 4 条，形状与真内容对齐——所以退场时
 * 可以**绝对定位叠在内容之上**淡出（见 `.crossfade-stack`），不错位、也不多占高度。
 */
function RoomSkeleton({ leaving = false }: { leaving?: boolean }): ReactNode {
  return (
    <div
      className={`room-skeleton${leaving ? ' leaving' : ''}`}
      aria-busy="true"
      data-testid="room-skeleton"
    >
      <div className="task-room-split">
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
