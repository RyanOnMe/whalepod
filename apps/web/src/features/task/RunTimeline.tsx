/**
 * 中间区域：Run 状态时间线 + Approval 卡（02 Task 7 Step 4；P1-13 接通直播，
 * P1-14 接通一次性审批决定）。
 *
 * Run 数据来自 Task Room 聚合视图；点击某行选中该 Run，下方出现
 * RunLivePanel（直播 + 事件时间线）。Approval 卡从 Run 事件流派生：
 * - 责任人（Task assignee；活跃 Run 期间与 Run owner 恒同一人，G2-05）：
 *   pending 时见完整卡（工具/原因/preview/过期时间）并可提交一次性决定；
 * - 其他成员：只有「等待责任人批准」等待态（服务端已按受众裁剪事件行，
 *   客户端不做二次裁剪，也不伪造决定入口）。
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useState, type ReactNode } from 'react'
import { api } from '../../shared/api/client.js'
import { ErrorBanner } from '../../app/ErrorBanner.js'
import { queryKeys } from '../../app/query-client.js'
import { formatIso, RUN_STATUS_LABEL } from '../../shared/format.js'
import type { RunEventItem, Session, TaskRoomRun, TaskView } from '../../shared/api/types.js'

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

// ---------------------------------------------------------------------------
// Approval 卡（P1-14）
// ---------------------------------------------------------------------------

/** §3.3 已决终态的中文标签；pending 不进此表（单独呈现）。 */
const APPROVAL_STATUS_LABEL: Readonly<Record<string, string>> = {
  allowed_once: '已批准一次',
  rejected: '已拒绝',
  expired: '已过期（按拒绝处理）',
  cancelled: '已取消',
}

/** 事件流派生出的 Approval 卡状态（03 §8：以 runId + callId 关联，不猜归属）。 */
interface ApprovalCardState {
  readonly approvalId: string
  readonly toolName: string
  readonly reason: string
  readonly preview: unknown
  readonly requestedAt: string
  readonly expiresAt: string
  status: 'pending' | string
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** 从受众已裁剪的事件行派生每张卡的当前状态；畸形行跳过（fail-closed 呈现）。 */
function deriveApprovalCards(events: RunEventItem[]): ApprovalCardState[] {
  const cards = new Map<string, ApprovalCardState>()
  for (const item of events) {
    const event = item.event as Record<string, unknown>
    if (event.type === 'approval.requested' && isRecord(event.approval)) {
      const approval = event.approval
      const approvalId = approval['approvalId']
      if (typeof approvalId !== 'string') continue
      cards.set(approvalId, {
        approvalId,
        toolName: typeof approval['toolName'] === 'string' ? approval['toolName'] : '未知工具',
        reason: typeof approval['reason'] === 'string' ? approval['reason'] : '',
        preview: approval['preview'],
        requestedAt:
          typeof approval['requestedAt'] === 'string' ? approval['requestedAt'] : item.occurredAt,
        expiresAt: typeof approval['expiresAt'] === 'string' ? approval['expiresAt'] : '',
        status: typeof approval['status'] === 'string' ? approval['status'] : 'pending',
      })
      continue
    }
    if (event.type === 'approval.decided' && typeof event['approvalId'] === 'string') {
      const existing = cards.get(event['approvalId'])
      if (existing !== undefined) {
        existing.status = typeof event['status'] === 'string' ? event['status'] : existing.status
      }
    }
  }
  return [...cards.values()]
}

export interface ApprovalSlotProps {
  runs: TaskRoomRun[]
  task: TaskView
  session: Session | null
}

/** 审批卡插槽：等待审批的 Run 存在时显示卡与决定入口（03 §4 决策路由）。 */
export function ApprovalSlot({ runs, task, session }: ApprovalSlotProps): ReactNode {
  const queryClient = useQueryClient()
  const waitingRun = runs.find((run) => run.status === 'waiting_approval')
  const [error, setError] = useState<unknown>(null)

  const eventsQuery = useQuery({
    queryKey: waitingRun !== undefined ? queryKeys.runEvents(waitingRun.id) : ['approval-idle'],
    queryFn: () => api.get<{ events: RunEventItem[] }>(`/runs/${waitingRun?.id ?? ''}/events`),
    enabled: waitingRun !== undefined,
  })

  // 决定提交走真人同一条 HTTP 路径；成功后失效 Run 事件查询翻转卡片状态。
  const decide = useMutation({
    mutationFn: (input: {
      runId: string
      approvalId: string
      decision: 'allowed_once' | 'rejected'
    }) =>
      api.mutate(`/approvals/${input.approvalId}/decisions`, {
        body: { decision: input.decision },
      }),
    onSuccess: (_data, input) => {
      setError(null)
      void queryClient.invalidateQueries({ queryKey: queryKeys.run(input.runId) })
    },
    onError: (mutationError: unknown) => setError(mutationError),
  })

  const canDecide = session !== null && task.assigneeUserId === session.userId
  const cards = waitingRun !== undefined ? deriveApprovalCards(eventsQuery.data?.events ?? []) : []
  const pending = cards.filter((card) => card.status === 'pending')
  const decided = cards.filter((card) => card.status !== 'pending')

  const submitDecision = (card: ApprovalCardState, decision: 'allowed_once' | 'rejected') => {
    if (waitingRun === undefined || decide.isPending) return
    decide.mutate({ runId: waitingRun.id, approvalId: card.approvalId, decision })
  }

  return (
    <section className="card snapshot-slot" aria-label="审批">
      <h3>审批</h3>
      {error !== null ? <ErrorBanner error={error} /> : null}
      {waitingRun === undefined ? (
        <p className="empty-state">当前没有等待审批的操作。</p>
      ) : eventsQuery.isPending ? (
        <p className="mutation-hint">正在加载审批…</p>
      ) : (
        <>
          {canDecide
            ? pending.map((card) => (
                <div key={card.approvalId} className="approval-card" data-testid="approval-card">
                  <div className="approval-head">
                    <span data-testid="approval-tool">{card.toolName}</span>
                    <span>请求于 {formatIso(card.requestedAt)}</span>
                  </div>
                  {card.reason !== '' ? <p data-testid="approval-reason">{card.reason}</p> : null}
                  <pre data-testid="approval-preview">{JSON.stringify(card.preview)}</pre>
                  {card.expiresAt !== '' ? (
                    <p data-testid="approval-expires">有效期至 {formatIso(card.expiresAt)}</p>
                  ) : null}
                  <div className="approval-actions">
                    <button
                      type="button"
                      className="button"
                      data-testid="approve-button"
                      disabled={decide.isPending}
                      onClick={() => submitDecision(card, 'allowed_once')}
                    >
                      批准一次
                    </button>
                    <button
                      type="button"
                      className="button secondary"
                      data-testid="reject-button"
                      disabled={decide.isPending}
                      onClick={() => submitDecision(card, 'rejected')}
                    >
                      拒绝
                    </button>
                  </div>
                </div>
              ))
            : pending.map((card) => (
                // project 受众（03 §8）：只有「等待责任人批准」，无参数正文。
                <p key={card.approvalId} className="mutation-hint" data-testid="approval-waiting">
                  等待责任人批准
                </p>
              ))}
          {pending.length === 0 && decided.length === 0 ? (
            <p className="empty-state">这个 Run 暂时没有审批请求。</p>
          ) : null}
          {decided.map((card) => (
            <p key={card.approvalId} data-testid="approval-decided">
              {card.toolName}：{APPROVAL_STATUS_LABEL[card.status] ?? card.status}
            </p>
          ))}
        </>
      )}
    </section>
  )
}
