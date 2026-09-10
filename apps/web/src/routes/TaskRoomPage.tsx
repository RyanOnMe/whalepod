/**
 * Task Room（02 Task 7 Step 4 四区布局）：
 * - 顶部：Task 目标/状态/责任人 + 责任人行动（features/task/TaskHeader）
 * - 左侧：Assignment 接受/拒绝 + Agent revision 快照（AssignmentPanel）
 * - 中间：Comment 时间线 + Run 状态 + 审批卡插槽（CommentComposer/RunTimeline）
 * - 右侧：交付物列表 + 复核插槽（ArtifactList）
 * 加载/错误状态显式呈现，不伪装成空数据；空态说明下一步。
 * 区段标题一律中文（#152）：Artifact→交付物、Reviewer→复核；Agent/Run/Task 这类
 * 领域术语保留英文（CONTEXT.md 的领域语言）。
 */
import { useQuery } from '@tanstack/react-query'
import { useState, type ReactNode } from 'react'
import { Link, useParams } from 'react-router'
import { api } from '../shared/api/client.js'
import { ErrorBanner } from '../app/ErrorBanner.js'
import { useSession } from '../app/session.js'
import { queryKeys } from '../app/query-client.js'
import type { TaskRoomView } from '../shared/api/types.js'
import { ArtifactList, ReviewerSlot } from '../features/task/ArtifactList.js'
import { AssignmentPanel } from '../features/task/AssignmentPanel.js'
import { CommentComposer, CommentList } from '../features/task/CommentComposer.js'
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
  const hasActiveRun = runs.some((run) => ACTIVE_RUN.has(run.status))
  return (
    <div className="task-room">
      <TaskHeader task={task} session={session} />
      <div className="task-room-grid">
        <aside className="task-room-col task-room-left">
          <AssignmentPanel task={task} session={session} />
          {session !== null ? (
            <RunLauncher task={task} session={session} hasActiveRun={hasActiveRun} />
          ) : null}
        </aside>
        <section className="task-room-col task-room-middle" aria-label="任务讨论与运行">
          <section className="card" aria-labelledby="comments-heading">
            <h2 id="comments-heading">讨论</h2>
            <CommentList comments={comments} session={session} />
            <CommentComposer taskId={task.id} />
          </section>
          <section className="card" aria-labelledby="runs-heading">
            <h2 id="runs-heading">Run</h2>
            <RunTimeline runs={runs} selectedRunId={selectedRunId} onSelect={setSelectedRunId} />
            {selectedRunId !== undefined && session !== null ? (
              <RunLivePanel
                runId={selectedRunId}
                session={session}
                runLabels={runOrdinalLabels(runs)}
              />
            ) : null}
            <ApprovalSlot runs={runs} task={task} session={session} />
          </section>
        </section>
        <aside className="task-room-col task-room-right" aria-label="交付物">
          <section className="card" aria-labelledby="artifacts-heading">
            <h2 id="artifacts-heading">交付物</h2>
            <ArtifactList artifacts={artifacts} session={session} taskId={task.id} runs={runs} />
          </section>
          <ReviewerSlot />
        </aside>
      </div>
    </div>
  )
}
