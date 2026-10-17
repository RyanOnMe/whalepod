/**
 * 下游交接接收面板（#380；ADR-0017 §5）：接收方视角的固定版本交接包。
 *
 * - pending receipt → 确认表单（「本次准备做什么」必填、差异可选）；确认**不等于**
 *   接受任务、不会自动开始执行（这里也从不触发任何 Run）。
 * - confirmed → 显示固化理解与该版本；上游有新版本时给「采用新版本」表单
 *   （理解必填；旧 receipt 与旧 Run 保留原版本，采用只产生新 receipt）。
 * - 团队可见（交接是正式记录）；不是交接下游的任务什么也不渲染。
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useState, type ReactNode } from 'react'
import { Link } from 'react-router'
import { api } from '../../shared/api/client.js'
import { ErrorBanner } from '../../app/ErrorBanner.js'
import { queryKeys } from '../../app/query-client.js'
import type { HandoffReceiptView, Session, TaskView } from '../../shared/api/types.js'

function ConfirmForm({
  receipt,
  label,
  submitLabel,
  busy,
  onSubmit,
}: {
  receipt: HandoffReceiptView
  label: string
  submitLabel: string
  busy: boolean
  onSubmit: (understanding: string, differences: string) => void
}): ReactNode {
  const [understanding, setUnderstanding] = useState('')
  const [differences, setDifferences] = useState('')
  return (
    <div className="handoff-confirm-form" data-testid={`handoff-${label}-form`}>
      <label className="handoff-field">
        <span>本次准备做什么（必填）</span>
        <textarea
          className="input"
          rows={2}
          aria-label={`${label}：本次准备做什么`}
          value={understanding}
          onChange={(event) => setUnderstanding(event.target.value)}
        />
      </label>
      <label className="handoff-field">
        <span>与交接包不同的地方（可选，会作为讨论发到上游任务）</span>
        <textarea
          className="input"
          rows={2}
          aria-label={`${label}：差异`}
          value={differences}
          onChange={(event) => setDifferences(event.target.value)}
        />
      </label>
      <button
        type="button"
        className="button button-primary"
        disabled={busy || understanding.trim() === ''}
        onClick={() => onSubmit(understanding, differences)}
      >
        {submitLabel}
      </button>
      {understanding.trim() === '' ? (
        <span className="mutation-hint">填写「本次准备做什么」后才能提交。</span>
      ) : null}
    </div>
  )
}

export function HandoffReceiptPanel({
  task,
  session,
}: {
  task: TaskView
  session: Session
}): ReactNode {
  const queryClient = useQueryClient()
  const [actionError, setActionError] = useState<unknown>(null)
  const query = useQuery({
    queryKey: queryKeys.taskHandoffReceipts(task.id),
    queryFn: () => api.get<HandoffReceiptView[]>(`/tasks/${task.id}/handoff-receipts`),
  })
  const receipts = query.data ?? []
  const confirmed = receipts.filter((receipt) => receipt.status === 'confirmed')
  const active = confirmed.reduce<HandoffReceiptView | undefined>(
    (best, receipt) =>
      best === undefined || receipt.revisionNumber > best.revisionNumber ? receipt : best,
    undefined,
  )
  const pending = receipts.find((receipt) => receipt.status === 'pending')

  const invalidate = (): void => {
    void queryClient.invalidateQueries({ queryKey: queryKeys.taskHandoffReceipts(task.id) })
    void queryClient.invalidateQueries({ queryKey: queryKeys.taskRoom(task.id) })
  }
  const confirmMutation = useMutation({
    mutationFn: (input: { receiptId: string; understanding: string; differences?: string }) =>
      api.mutate<HandoffReceiptView>(`/handoff-receipts/${input.receiptId}/confirm`, {
        body: {
          understanding: input.understanding,
          ...(input.differences !== undefined && input.differences.trim() !== ''
            ? { differences: input.differences }
            : {}),
        },
      }),
    onSuccess: () => {
      setActionError(null)
      invalidate()
    },
    onError: (error: unknown) => setActionError(error),
  })
  const adoptMutation = useMutation({
    mutationFn: (input: { receiptId: string; understanding: string; differences?: string }) =>
      api.mutate<HandoffReceiptView>(`/handoff-receipts/${input.receiptId}/adopt`, {
        body: {
          understanding: input.understanding,
          ...(input.differences !== undefined && input.differences.trim() !== ''
            ? { differences: input.differences }
            : {}),
        },
      }),
    onSuccess: () => {
      setActionError(null)
      invalidate()
    },
    onError: (error: unknown) => setActionError(error),
  })

  if (query.isPending || query.isError || (active === undefined && pending === undefined)) {
    return null
  }
  const busy = confirmMutation.isPending || adoptMutation.isPending
  const hasNewer = active !== undefined && active.latestRevisionNumber > active.revisionNumber
  return (
    <section
      className="card handoff-receipt"
      data-testid="handoff-receipt-panel"
      aria-label="上游交接包"
    >
      <div className="room-column-head">
        <h2>上游交接包</h2>
        <span className="room-column-note">
          固定版本；接收确认不等于接受任务，也不会自动开始执行
        </span>
      </div>
      {actionError !== null ? <ErrorBanner error={actionError} /> : null}

      {active !== undefined ? (
        <div data-testid="handoff-receipt-active">
          <p>
            来源：
            <Link to={`/tasks/${active.upstreamTaskId}`}>{active.upstreamTaskTitle}</Link>
            {` · 固定版本 v${active.revisionNumber}`}
          </p>
          <p className="mutation-hint">
            {`你确认的理解（${new Date(active.confirmedAt ?? active.updatedAt).toLocaleString()}）：${active.understanding ?? ''}`}
          </p>
          {active.differences !== null ? (
            <p className="mutation-hint">你提出的差异：{active.differences}</p>
          ) : null}
          {hasNewer ? (
            <div data-testid="handoff-newer-version">
              <p role="status">
                {`上游已发布新版本 v${active.latestRevisionNumber}；采用只影响后续执行，旧执行的材料不变。`}
              </p>
              {session.userId === active.receiverUserId ? (
                <ConfirmForm
                  receipt={active}
                  label="采用新版本"
                  submitLabel={`采用 v${active.latestRevisionNumber}`}
                  busy={busy}
                  onSubmit={(understanding, differences) =>
                    adoptMutation.mutate({
                      receiptId: active.id,
                      understanding,
                      ...(differences.trim() !== '' ? { differences } : {}),
                    })
                  }
                />
              ) : null}
            </div>
          ) : null}
        </div>
      ) : null}

      {pending !== undefined ? (
        <div data-testid="handoff-receipt-pending">
          <p>
            来源：
            <Link to={`/tasks/${pending.upstreamTaskId}`}>{pending.upstreamTaskTitle}</Link>
            {` · 待确认版本 v${pending.revisionNumber}`}
          </p>
          {session.userId === pending.receiverUserId ? (
            <ConfirmForm
              receipt={pending}
              label="确认接收"
              submitLabel="确认接收（不动任务状态）"
              busy={busy}
              onSubmit={(understanding, differences) =>
                confirmMutation.mutate({
                  receiptId: pending.id,
                  understanding,
                  ...(differences.trim() !== '' ? { differences } : {}),
                })
              }
            />
          ) : (
            <p className="mutation-hint">等待接收人确认「本次准备做什么」。</p>
          )}
        </div>
      ) : null}
    </section>
  )
}
