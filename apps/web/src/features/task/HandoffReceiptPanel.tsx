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
import { isApiError } from '../../shared/api/errors.js'
import { useMemberDirectory } from '../team/memberDirectory.js'
import { ErrorBanner } from '../../app/ErrorBanner.js'
import { queryKeys } from '../../app/query-client.js'
import type { HandoffReceiptView, Session, TaskView } from '../../shared/api/types.js'
import type { HandoffRevisionView } from '@whalepod/protocol'
import { HandoffPublishedContent } from './HandoffPublishedContent.js'

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
  const [contentReady, setContentReady] = useState(false)
  return (
    <div className="handoff-confirm-form" data-testid={`handoff-${label}-form`}>
      <HandoffPublishedContent
        key={receipt.revisionId}
        revisionId={receipt.revisionId}
        onReady={setContentReady}
      />
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
        disabled={busy || !contentReady || understanding.trim() === ''}
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

function AdoptForm({
  receipt,
  busy,
  onSubmit,
}: {
  receipt: HandoffReceiptView
  busy: boolean
  onSubmit: (understanding: string, differences: string, revisionId: string) => void
}): ReactNode {
  const query = useQuery({
    queryKey: ['handoff-adopt-version', receipt.upstreamTaskId, receipt.latestRevisionNumber],
    queryFn: () =>
      api.get<HandoffRevisionView[]>(`/tasks/${receipt.upstreamTaskId}/handoff-revisions`),
  })
  if (query.isPending) return <p role="status">正在读取待采用版本…</p>
  if (query.isError) return <ErrorBanner error={query.error} />
  const target = query.data.find(
    (version) => version.revisionNumber === receipt.latestRevisionNumber,
  )
  if (target === undefined) return <p role="alert">待采用版本不可用，请刷新后重试。</p>
  return (
    <ConfirmForm
      key={target.id}
      receipt={{ ...receipt, revisionId: target.id }}
      label="采用新版本"
      submitLabel={`采用 v${receipt.latestRevisionNumber}`}
      busy={busy}
      onSubmit={(understanding, differences) => onSubmit(understanding, differences, target.id)}
    />
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
  const directory = useMemberDirectory()
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
    mutationFn: (input: {
      receiptId: string
      understanding: string
      differences?: string
      expectedRevisionId: string
    }) =>
      api.mutate<HandoffReceiptView>(`/handoff-receipts/${input.receiptId}/adopt`, {
        body: {
          understanding: input.understanding,
          expectedRevisionId: input.expectedRevisionId,
          ...(input.differences !== undefined && input.differences.trim() !== ''
            ? { differences: input.differences }
            : {}),
        },
      }),
    onSuccess: () => {
      setActionError(null)
      invalidate()
    },
    onError: (error: unknown) => {
      setActionError(error)
      // 版本竞态是「看的内容已经旧了」：立即重读，别让用户对着旧 v 反复撞 409。
      if (isApiError(error) && error.code === 'CONFLICT') invalidate()
    },
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
          <HandoffPublishedContent revisionId={active.revisionId} />
          <p>
            来源：
            <Link to={`/tasks/${active.upstreamTaskId}`}>{active.upstreamTaskTitle}</Link>
            {` · 固定版本 v${active.revisionNumber}`}
          </p>
          <p className="mutation-hint">
            {/* 评审 B7：改派后旧 receipt 仍是团队事实——不是「你」的确认就报出人是谁
                （回执属于接收人，别把别人的理解冒充成当前用户自己的）。 */}
            {`${session.userId === active.receiverUserId ? '你' : `${directory.personOf(active.receiverUserId)}`}确认的理解（${new Date(active.confirmedAt ?? active.updatedAt).toLocaleString()}）：${active.understanding ?? ''}`}
          </p>
          {active.differences !== null ? (
            // 评审 B7 同款：差异也属于接收人——改派后非接收人视角别冒充「你」。
            <p className="mutation-hint">{`${session.userId === active.receiverUserId ? '你' : `${directory.personOf(active.receiverUserId)}`}提出的差异：${active.differences}`}</p>
          ) : null}
          {hasNewer ? (
            <div data-testid="handoff-newer-version">
              <p role="status">
                {`上游已发布新版本 v${active.latestRevisionNumber}；采用只影响后续执行，旧执行的材料不变。`}
              </p>
              {session.userId === active.receiverUserId ? (
                <AdoptForm
                  receipt={active}
                  busy={busy}
                  onSubmit={(understanding, differences, expectedRevisionId) =>
                    adoptMutation.mutate({
                      receiptId: active.id,
                      understanding,
                      expectedRevisionId,
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
