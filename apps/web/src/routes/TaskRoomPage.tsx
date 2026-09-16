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
import type { TaskRoomView } from '../shared/api/types.js'
import { ArtifactList, ReviewerSlot } from '../features/task/ArtifactList.js'
import { AssignmentPanel } from '../features/task/AssignmentPanel.js'
import { CommentComposer, CommentList } from '../features/task/CommentComposer.js'
import { InstructionComposer } from '../features/task/InstructionComposer.js'
import { InstructionList } from '../features/task/InstructionList.js'
import { RunLauncher } from '../features/task/RunLauncher.js'
import { RunLivePanel } from '../features/task/RunLivePanel.js'
import { runOrdinalLabels } from '../features/task/runLabels.js'
import { ApprovalSlot, RunTimeline } from '../features/task/RunTimeline.js'
import { TaskHeader } from '../features/task/TaskHeader.js'

/** 活跃 Run 状态集（03 §3.2：一任务同时至多一个）。 */
const ACTIVE_RUN: ReadonlySet<string> = new Set([
  'queued',
  'dispatching',
  'running',
  'waiting_approval',
  'cancel_requested',
])

export function TaskRoomPage(): ReactNode {
  const { taskId } = useParams()
  const session = useSession()
  const directory = useMemberDirectory()
  const [selectedRunId, setSelectedRunId] = useState<string | undefined>(undefined)

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
  // `instructions` 是 ③c-2a 新增的字段：旧缓存或未跟上的 mock 可能没有它，
  // 缺字段不该让整页炸掉（首版就是这么挂在 10 个既有用例上的）。
  const instructions = query.data.instructions ?? []
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
            <InstructionList
              instructions={instructions}
              session={session}
              authorName={directory.personOf}
            />
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
    </div>
  )
}
