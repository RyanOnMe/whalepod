/**
 * 审批卡（P1-393：从 RunTimeline 拆出，挂在**等待审批的那一段运行**里）。
 *
 * 状态从该运行的事件流派生（03 §8：以 runId + callId 关联，不猜归属）：
 * - 责任人（Task assignee）：pending 时见完整卡（工具/原因/preview/过期时间）并可提交一次性决定；
 * - 其他成员：只有「等待责任人批准」等待态（服务端已按受众裁剪事件行，客户端不做二次裁剪，
 *   也不伪造决定入口）。
 *
 * 事件由调用方（连续对话的分页读取）注入，本组件不再自己取数——会话、审批与 Console
 * 共用同一条分页读取（ADR-0019 决定 5），审批卡因此在 >500 条事件的运行上也不会漏掉请求。
 */
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useState, type ReactNode } from 'react'
import { useLocation } from 'react-router'
import { api } from '../../shared/api/client.js'
import { ErrorBanner } from '../../app/ErrorBanner.js'
import { useHashFocus } from '../../shared/useHashFocus.js'
import { queryKeys } from '../../app/query-client.js'
import { RelativeTime } from '../../shared/RelativeTime.js'
import type { RunEventItem, Session, TaskView } from '../../shared/api/types.js'

/** §3.3 已决终态的中文标签；pending 不进此表（单独呈现）。 */
const APPROVAL_STATUS_LABEL: Readonly<Record<string, string>> = {
  allowed_once: '已批准一次',
  rejected: '已拒绝',
  expired: '已过期（按拒绝处理）',
  cancelled: '已取消',
}

export interface ApprovalCardState {
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
export function deriveApprovalCards(events: readonly RunEventItem[]): ApprovalCardState[] {
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

export interface ApprovalCardsProps {
  runId: string
  task: TaskView
  session: Session | null
  /** 该运行已读到的事件（分页读取的当前结果）。 */
  events: readonly RunEventItem[]
  /** 事件是否已读到末尾（没读到末尾时「暂无审批请求」不能当结论）。 */
  eventsComplete: boolean
  /** 审批锚点只有在执行视图可见时才落焦（详情面板打开时不抢）。 */
  visible: boolean
}

/** 审批卡：等待审批的运行段内呈现；决定提交走真人同一条 HTTP 路径。 */
export function ApprovalCards({
  runId,
  task,
  session,
  events,
  eventsComplete,
  visible,
}: ApprovalCardsProps): ReactNode {
  const queryClient = useQueryClient()
  const [error, setError] = useState<unknown>(null)
  const approvalAnchor = useLocation().hash.startsWith('#approval-')
  useHashFocus(eventsComplete && approvalAnchor && visible, true, events)

  const decide = useMutation({
    mutationFn: (input: { approvalId: string; decision: 'allowed_once' | 'rejected' }) =>
      api.mutate(`/approvals/${input.approvalId}/decisions`, {
        body: { decision: input.decision },
      }),
    onSuccess: () => {
      setError(null)
      void queryClient.invalidateQueries({ queryKey: queryKeys.run(runId) })
    },
    onError: (mutationError: unknown) => setError(mutationError),
  })

  const canDecide = session !== null && task.assigneeUserId === session.userId
  const cards = deriveApprovalCards(events)
  const pending = cards.filter((card) => card.status === 'pending')
  const decided = cards.filter((card) => card.status !== 'pending')

  const submitDecision = (card: ApprovalCardState, decision: 'allowed_once' | 'rejected') => {
    if (decide.isPending) return
    decide.mutate({ approvalId: card.approvalId, decision })
  }

  return (
    <section className="snapshot-slot" aria-label="审批">
      <h3>审批</h3>
      {error !== null ? <ErrorBanner error={error} /> : null}
      {canDecide
        ? pending.map((card) => (
            <div
              key={card.approvalId}
              id={`approval-${card.approvalId}`}
              tabIndex={-1}
              className="approval-card"
              data-testid="approval-card"
            >
              <div className="approval-head">
                <span data-testid="approval-tool">{card.toolName}</span>
                <span>
                  请求于 <RelativeTime iso={card.requestedAt} />
                </span>
              </div>
              {card.reason !== '' ? <p data-testid="approval-reason">{card.reason}</p> : null}
              <pre data-testid="approval-preview">{JSON.stringify(card.preview)}</pre>
              {card.expiresAt !== '' ? (
                <p data-testid="approval-expires">
                  有效期至 <RelativeTime iso={card.expiresAt} />
                </p>
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
        <p className="empty-state">
          {eventsComplete ? '这个 Run 暂时没有审批请求。' : '审批事件还没读完（读取不完整）。'}
        </p>
      ) : null}
      {decided.map((card) => (
        <p key={card.approvalId} data-testid="approval-decided">
          {card.toolName}：{APPROVAL_STATUS_LABEL[card.status] ?? card.status}
        </p>
      ))}
    </section>
  )
}
