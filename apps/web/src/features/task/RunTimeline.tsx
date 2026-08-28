/**
 * 中间区域：Run 状态时间线 + 审批卡片插槽（02 Task 7 Step 4；P1-13 接通直播）。
 * Run 数据来自 Task Room 聚合视图；点击某行选中该 Run，下方出现
 * RunLivePanel（直播 + 事件时间线）。审批卡在等待审批时显示（决定动作是
 * P1-14 的 HTTP 闭环，本组件只呈现）。
 */
import type { ReactNode } from 'react'
import { formatIso, RUN_STATUS_LABEL } from '../../shared/format.js'
import type { TaskRoomRun } from '../../shared/api/types.js'

export interface RunTimelineProps {
  runs: TaskRoomRun[]
  /** 当前选中的 Run（直播面板跟随）；undefined = 未选中。 */
  selectedRunId?: string | undefined
  onSelect?: (runId: string) => void
}

export function RunTimeline({ runs, selectedRunId, onSelect }: RunTimelineProps): ReactNode {
  if (runs.length === 0) {
    return (
      <p className="empty-state">
        还没有 Run。接受任务后，用上方「启动 Run」发起执行，历史会出现在这里。
      </p>
    )
  }
  return (
    <ul className="run-list" role="list">
      {runs.map((run) => (
        <li key={run.id} className="run-item">
          <button
            type="button"
            className={`run-item-button${selectedRunId === run.id ? ' selected' : ''}`}
            onClick={() => onSelect?.(run.id)}
            aria-pressed={selectedRunId === run.id}
          >
            <div className="run-item-head">
              <span className="run-id">Run {run.id.slice(0, 8)}</span>
              <span className={`badge badge-run badge-run-${run.status}`}>
                {RUN_STATUS_LABEL[run.status]}
              </span>
            </div>
            <dl className="run-item-meta">
              <div>
                <dt>创建</dt>
                <dd>{formatIso(run.createdAt)}</dd>
              </div>
              <div>
                <dt>开始</dt>
                <dd>{formatIso(run.startedAt)}</dd>
              </div>
              <div>
                <dt>结束</dt>
                <dd>{formatIso(run.finishedAt)}</dd>
              </div>
            </dl>
          </button>
        </li>
      ))}
    </ul>
  )
}

/** 审批卡插槽：等待人工许可时显示审批卡（P1-14 接通决定动作）。 */
export function ApprovalSlot(): ReactNode {
  return (
    <section className="card snapshot-slot" aria-label="审批">
      <h3>审批</h3>
      <p className="empty-state">
        当 Run 需要人工许可时，审批卡片会出现在这里（批准/拒绝动作随后续版本提供）。
      </p>
    </section>
  )
}
