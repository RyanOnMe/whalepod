/**
 * 下游交接接收面板（#380；ADR-0017 §5）：接收方视角的固定版本交接包。
 *
 * - pending receipt → 确认表单（「本次准备做什么」必填、差异可选）；确认**不等于**
 *   接受任务、不会自动开始执行（这里也从不触发任何 Run）。
 * - confirmed → 显示固化理解与该版本；上游有新版本时给「采用新版本」表单
 *   （理解必填；旧 receipt 与旧 Run 保留原版本，采用只产生新 receipt）。
 * - #428：同一任务收到多份交接时逐份可见；待办用 `#handoff-receipt-<receiptId>`
 *   指到具体一张卡。改派时未确认回执随责任转移（服务端同一事务完成）。
 * - 团队可见（交接是正式记录）；不是交接下游的任务什么也不渲染。
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { Link, useLocation } from 'react-router'
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

/**
 * 向上游提问（#428）：与「确认接收」解耦——接收方不必先确认理解，也不必接受任务；
 * 问题走上游任务的讨论区（人际交流，不驱动 Agent），带固定版本/下游任务上下文。
 * 失败保留已写文字；重试复用同一 Idempotency-Key（响应丢失不会发两遍）。
 */
function QuestionComposer({
  upstreamTaskId,
  revisionNumber,
  downstreamTitle,
}: {
  upstreamTaskId: string
  revisionNumber: number
  downstreamTitle: string
}): ReactNode {
  const [question, setQuestion] = useState('')
  const [state, setState] = useState<'idle' | 'sending' | 'sent' | 'error'>('idle')
  const idempotencyKey = useRef(crypto.randomUUID())
  async function send(): Promise<void> {
    const text = question.trim()
    if (text === '' || state === 'sending') return
    setState('sending')
    try {
      await api.mutate(`/tasks/${upstreamTaskId}/comments`, {
        idempotencyKey: idempotencyKey.current,
        body: { body: `【交接 v${revisionNumber} · ${downstreamTitle}】${text}` },
      })
      idempotencyKey.current = crypto.randomUUID()
      setQuestion((current) => (current.trim() === text ? '' : current))
      setState('sent')
    } catch {
      setState('error')
    }
  }
  return (
    <div className="handoff-question" data-testid="handoff-question">
      <label className="handoff-field">
        <span>向上游提问（可选，不要求先确认接收）</span>
        <textarea
          className="input"
          rows={2}
          aria-label="向上游提问"
          value={question}
          disabled={state === 'sending'}
          onChange={(event) => {
            setQuestion(event.target.value)
            if (state !== 'sending') setState('idle')
          }}
        />
      </label>
      <button
        type="button"
        className="button"
        disabled={state === 'sending' || question.trim() === ''}
        onClick={() => void send()}
      >
        {state === 'sending' ? '发送中…' : '发送问题'}
      </button>
      {state === 'sent' ? (
        <p className="mutation-hint" role="status">
          问题已发到上游任务讨论区。
        </p>
      ) : null}
      {state === 'error' ? (
        <p className="mutation-hint" role="alert">
          问题发送失败，文字已保留，可重试。
        </p>
      ) : null}
    </div>
  )
}

export function HandoffReceiptPanel({
  task,
  session,
  onReady,
}: {
  task: TaskView
  session: Session
  /** 回执读取完成：让页面在数据真正到位后再解析 `#handoff-receipt-*` 锚点。 */
  onReady?: () => void
}): ReactNode {
  const queryClient = useQueryClient()
  const directory = useMemberDirectory()
  const location = useLocation()
  const [actionError, setActionError] = useState<unknown>(null)
  const query = useQuery({
    queryKey: queryKeys.taskHandoffReceipts(task.id),
    queryFn: () => api.get<HandoffReceiptView[]>(`/tasks/${task.id}/handoff-receipts`),
  })
  const targetReceiptId = location.hash.startsWith('#handoff-receipt-')
    ? location.hash.slice('#handoff-receipt-'.length)
    : null
  const anchorRequested = location.hash === '#handoff-receipt' || targetReceiptId !== null
  const receipts = query.data ?? []
  const pending = receipts.filter((receipt) => receipt.status === 'pending')
  const confirmed = receipts.filter((receipt) => receipt.status === 'confirmed')

  // 待办直达的落点在回执查询完成后才存在：通知页面重新解析 hash 并聚焦。
  const notifiedReady = useRef(false)
  useEffect(() => {
    if (!query.isSuccess || notifiedReady.current) return
    notifiedReady.current = true
    onReady?.()
  }, [onReady, query.isSuccess])

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

  // 待办直达：加载中/失败也要给一个真实的落点，不能聚焦一个空容器。
  if (query.isPending) {
    if (!anchorRequested) return null
    return (
      <section
        id="handoff-receipt"
        tabIndex={-1}
        className="card handoff-receipt"
        data-testid="handoff-receipt-panel"
        aria-label="上游交接包"
      >
        <div className="room-column-head">
          <h2>上游交接包</h2>
        </div>
        <p role="status">正在读取交接回执…</p>
      </section>
    )
  }
  if (query.isError) {
    if (!anchorRequested) return null
    return (
      <section
        id="handoff-receipt"
        tabIndex={-1}
        className="card handoff-receipt"
        data-testid="handoff-receipt-panel"
        aria-label="上游交接包"
      >
        <div className="room-column-head">
          <h2>上游交接包</h2>
        </div>
        <ErrorBanner error={query.error} />
        <button type="button" className="button" onClick={() => void query.refetch()}>
          重新读取交接回执
        </button>
      </section>
    )
  }
  if (!anchorRequested && receipts.length === 0) return null

  const busy = confirmMutation.isPending || adoptMutation.isPending
  const isCurrentAssignee = task.assigneeUserId === session.userId
  return (
    <section
      id="handoff-receipt"
      tabIndex={-1}
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
      {task.assignmentStatus === 'pending' ? (
        <p className="mutation-hint" data-testid="handoff-task-not-accepted">
          任务尚未接受；确认理解不等于接受任务，接受任务仍走原入口。
        </p>
      ) : task.assignmentStatus === 'rejected' ? (
        <p className="mutation-hint" data-testid="handoff-task-not-accepted">
          任务指派已被拒绝；需要重新指派或由交付人重新交付后再确认。
        </p>
      ) : null}
      {actionError !== null ? <ErrorBanner error={actionError} /> : null}
      {receipts.length === 0 ? <p>这份任务没有待接收的交接。</p> : null}

      {pending.map((receipt) => {
        const canConfirm = isCurrentAssignee && receipt.receiverUserId === session.userId
        return (
          <div
            key={receipt.id}
            id={`handoff-receipt-${receipt.id}`}
            tabIndex={-1}
            data-testid="handoff-receipt-pending"
            data-receipt-id={receipt.id}
            className={targetReceiptId === receipt.id ? 'handoff-target' : undefined}
          >
            <p>
              来源：
              <Link to={`/tasks/${receipt.upstreamTaskId}`}>{receipt.upstreamTaskTitle}</Link>
              {` · 待确认版本 v${receipt.revisionNumber}`}
            </p>
            {canConfirm ? (
              <>
                <ConfirmForm
                  receipt={receipt}
                  label="确认接收"
                  submitLabel="确认接收（不动任务状态）"
                  busy={busy}
                  onSubmit={(understanding, differences) =>
                    confirmMutation.mutate({
                      receiptId: receipt.id,
                      understanding,
                      ...(differences.trim() !== '' ? { differences } : {}),
                    })
                  }
                />
                <QuestionComposer
                  upstreamTaskId={receipt.upstreamTaskId}
                  revisionNumber={receipt.revisionNumber}
                  downstreamTitle={receipt.downstreamTaskTitle}
                />
              </>
            ) : (
              <p className="mutation-hint">
                {`等待 ${directory.personOf(receipt.receiverUserId)} 确认「本次准备做什么」。`}
              </p>
            )}
          </div>
        )
      })}

      {confirmed.map((receipt) => {
        const hasNewer = receipt.latestRevisionNumber > receipt.revisionNumber
        const canAdopt = isCurrentAssignee && receipt.receiverUserId === session.userId
        return (
          <div
            key={receipt.id}
            id={`handoff-receipt-${receipt.id}`}
            tabIndex={-1}
            data-testid="handoff-receipt-active"
            data-receipt-id={receipt.id}
            className={targetReceiptId === receipt.id ? 'handoff-target' : undefined}
          >
            <HandoffPublishedContent revisionId={receipt.revisionId} />
            <p>
              来源：
              <Link to={`/tasks/${receipt.upstreamTaskId}`}>{receipt.upstreamTaskTitle}</Link>
              {` · 固定版本 v${receipt.revisionNumber}`}
            </p>
            <p className="mutation-hint">
              {/* 评审 B7：改派后旧 receipt 仍是团队事实——不是「你」的确认就报出人是谁
                  （回执属于接收人，别把别人的理解冒充成当前用户自己的）。 */}
              {`${session.userId === receipt.receiverUserId ? '你' : `${directory.personOf(receipt.receiverUserId)}`}确认的理解（${new Date(receipt.confirmedAt ?? receipt.updatedAt).toLocaleString()}）：${receipt.understanding ?? ''}`}
            </p>
            {receipt.differences !== null ? (
              // 评审 B7 同款：差异也属于接收人——改派后非接收人视角别冒充「你」。
              <p className="mutation-hint">{`${session.userId === receipt.receiverUserId ? '你' : `${directory.personOf(receipt.receiverUserId)}`}提出的差异：${receipt.differences}`}</p>
            ) : null}
            {hasNewer ? (
              <div data-testid="handoff-newer-version">
                <p role="status">
                  {`上游已发布新版本 v${receipt.latestRevisionNumber}；采用只影响后续执行，旧执行的材料不变。`}
                </p>
                {canAdopt ? (
                  <AdoptForm
                    receipt={receipt}
                    busy={busy}
                    onSubmit={(understanding, differences, expectedRevisionId) =>
                      adoptMutation.mutate({
                        receiptId: receipt.id,
                        understanding,
                        expectedRevisionId,
                        ...(differences.trim() !== '' ? { differences } : {}),
                      })
                    }
                  />
                ) : null}
              </div>
            ) : null}
            {canAdopt ? (
              <QuestionComposer
                upstreamTaskId={receipt.upstreamTaskId}
                revisionNumber={receipt.revisionNumber}
                downstreamTitle={receipt.downstreamTaskTitle}
              />
            ) : null}
          </div>
        )
      })}
    </section>
  )
}
