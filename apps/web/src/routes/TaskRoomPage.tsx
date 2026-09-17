/**
 * Task Room（切片⑥a-2：ADR-0010 的**两栏**形态）：
 * - 顶部：Task 目标/状态/责任人 + 责任人行动（features/task/TaskHeader）
 * - **左栏「讨论」**：团队成员之间的话（CommentList/CommentComposer）——这一栏**永不触发运行**
 *   （ADR-0010 决策 4：`@Agent` 不再是评论语法）；
 * - **右栏「执行」**：驱动 Agent 的指令流（InstructionList）+ Run 与审批（RunTimeline/
 *   ApprovalSlot/RunLauncher），以及**可折叠的任务详情**（指派接受/拒绝 + 交付物 + 复核）。
 *
 * 为什么把指派与交付物折进执行栏底部（用户 2026-09-15 选定）：这两件事都不是高频动作，
 * 为它们留一条常驻窄栏会让两栏（讨论｜执行）的对比被削弱；折叠后默认不占视觉重量，
 * 需要时一层展开即可，功能一个不少。
 *
 * 加载/错误状态显式呈现，不伪装成空数据；空态说明下一步。
 * 区段标题一律中文（#152）；Agent/Run/Task 这类领域术语保留英文（CONTEXT.md 的领域语言）。
 */
import { useQuery } from '@tanstack/react-query'
import { useState, type ReactNode } from 'react'
import { Link, useParams } from 'react-router'
import { api } from '../shared/api/client.js'
import { ErrorBanner } from '../app/ErrorBanner.js'
import { useSession } from '../app/session.js'
import { useMemberDirectory } from '../features/team/memberDirectory.js'
import { queryKeys } from '../app/query-client.js'
import type { InstructionView, RunEventItem, TaskRoomView } from '../shared/api/types.js'
import { ArtifactList, ReviewerSlot } from '../features/task/ArtifactList.js'
import { AssignmentPanel } from '../features/task/AssignmentPanel.js'
import { CommentComposer, CommentList } from '../features/task/CommentComposer.js'
import { InstructionComposer } from '../features/task/InstructionComposer.js'
import { RunConsole } from '../features/task/RunConsole.js'
import { InstructionList } from '../features/task/InstructionList.js'
import { RunLauncher } from '../features/task/RunLauncher.js'
import { RunLivePanel } from '../features/task/RunLivePanel.js'
import { runOrdinalLabels } from '../features/task/runLabels.js'
import { ApprovalSlot, RunTimeline } from '../features/task/RunTimeline.js'
import { TaskHeader } from '../features/task/TaskHeader.js'

/**
 * 活跃 Run 状态集（03 §3.2：一任务同时至多一个）。
 *
 * 与 hub 的关系（复核 #209 O-1）：hub 侧对应的是"Run 是否还在跑"的那一族；本集合**比
 * `QUEUEING_RUN` 多一个 `cancel_requested`**——取消中的 Run 仍算"活跃"（挡住重复起 Run），
 * 但它**不是**指令可以排队的窗口。两个集合语义不同，别再各写第三份。
 */
const ACTIVE_RUN: ReadonlySet<string> = new Set([
  'queued',
  'dispatching',
  'running',
  'waiting_approval',
  'cancel_requested',
])

/**
 * **可以排队**的活跃 Run 状态集——必须与 hub 的 `FOLLOWUP_QUEUEING_STATUSES`
 * （`apps/hub/src/modules/run/followup.ts`）逐字对齐：hub 只把
 * `queued`/`dispatching`/`waiting_approval` 当作"指令可以排在它后面等放行"的窗口；
 * `running` 是立即下发，`cancel_requested` 与各终态则**当场拒绝**（`RUN_CANCELLING`）。
 *
 * 复核 #209 R3 实测：我原先写成 `status !== 'running'`，于是 `cancel_requested` 也会显示
 * 「已排队」——而 hub 其实已经把那条指令判死了。这条**可达**：Run 在排队窗口时用户发的指令
 * 落成 `pending`，随后用户取消 Run，该指令仍是 `pending` 且挂在这个 Run 上。
 */
const QUEUEING_RUN: ReadonlySet<string> = new Set(['queued', 'dispatching', 'waiting_approval'])

export function TaskRoomPage(): ReactNode {
  const { taskId } = useParams()
  const session = useSession()
  const directory = useMemberDirectory()
  const [selectedRunId, setSelectedRunId] = useState<string | undefined>(undefined)
  // ⑥d：Console 覆盖层显示哪个 Run（undefined = 关）。与 `selectedRunId`（内联面板）分开：
  // 内联面板是默认视图，覆盖层是"放大看"，两者可以同时存在。
  const [consoleRunId, setConsoleRunId] = useState<string | undefined>(undefined)

  const query = useQuery({
    queryKey: queryKeys.taskRoom(taskId ?? ''),
    queryFn: () => api.get<TaskRoomView>(`/tasks/${taskId ?? ''}`),
    enabled: taskId !== undefined,
  })

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
    return <p className="mutation-hint">正在加载任务…</p>
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

  const { task, comments, runs, artifacts } = query.data
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
  const hasActiveRun = runs.some((run) => ACTIVE_RUN.has(run.status))
  return (
    <div className="task-room">
      <TaskHeader task={task} session={session} />
      <div className="task-room-split">
        {/* 讨论栏：只有人说话，永不触发运行 */}
        <section className="task-room-col" aria-labelledby="comments-heading">
          <div className="card room-column">
            <div className="room-column-head">
              <h2 id="comments-heading">讨论</h2>
              <span className="room-column-note">团队成员之间 · 不触发 Agent</span>
            </div>
            <CommentList comments={comments} session={session} />
            <CommentComposer taskId={task.id} />
          </div>
        </section>

        {/* 执行栏：指令 + 运行 + 审批 */}
        <section className="task-room-col" aria-labelledby="instructions-heading">
          <div className="card room-column">
            <div className="room-column-head">
              <h2 id="instructions-heading">执行</h2>
              <span className="room-column-note">
                {hasActiveRun
                  ? '当前有运行进行中 · 继续说会成为追问'
                  : '当前没有运行 · 这句话会起新运行'}
              </span>
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
              />
            )}
            {/* ⑥b：执行区输入——这里的一句话会驱动 Agent（与左栏讨论的分工是 ADR-0010 的核心）。 */}
            {session !== null ? (
              <InstructionComposer taskId={task.id} hasActiveRun={hasActiveRun} />
            ) : null}
          </div>

          <div className="card" aria-labelledby="runs-heading">
            <h2 id="runs-heading">运行</h2>
            <RunTimeline runs={runs} selectedRunId={selectedRunId} onSelect={setSelectedRunId} />
            {selectedRunId !== undefined && session !== null ? (
              <RunLivePanel
                runId={selectedRunId}
                session={session}
                runLabels={runOrdinalLabels(runs)}
                onOpenConsole={() => setConsoleRunId(selectedRunId)}
              />
            ) : null}
            <ApprovalSlot runs={runs} task={task} session={session} />
          </div>

          {/* 指派与启程：**常驻**，不折进详情——接受指派是责任人进入工作前的必经一步
              （没接受就不能起 Run），把它藏进折叠区等于把门藏在门后。
              ⑥b 的执行区输入框落地后，RunLauncher 会被它取代。 */}
          <AssignmentPanel task={task} session={session} />
          {session !== null ? (
            <RunLauncher task={task} session={session} hasActiveRun={hasActiveRun} />
          ) : null}

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
                />
              </section>
              <ReviewerSlot />
            </div>
          </details>
        </section>
      </div>
      {consoleRunId === undefined ? null : (
        <RunConsoleHost
          runId={consoleRunId}
          runs={runs}
          onClose={() => setConsoleRunId(undefined)}
        />
      )}
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
  onClose,
}: {
  runId: string
  runs: TaskRoomView['runs']
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
      events={eventsQuery.data?.events ?? []}
      eventsPending={eventsQuery.isPending}
      onClose={onClose}
    />
  )
}
