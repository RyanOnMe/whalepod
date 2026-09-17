/**
 * 执行区输入（切片⑥b；ADR-0010 决策 2/4）。
 *
 * 这里的一句话**会驱动 Agent**——与左栏「讨论」的分工就是 ADR-0010 的核心：
 * 讨论只承载人际交流，且**永不触发运行**；要驱动 Agent 就把话说到这一栏。
 *
 * 提交后的四种命运必须如实告诉用户（Hub 的 `outcome`，201 表示"请求受理了"，
 * 不表示"这句话被受理了"——被拒也是 201）：
 *   started_run —— 起了新运行；
 *   followup    —— 当前 Run 在 running，直接作为追问下发；
 *   queued      —— 当前 Run 还没进 running（dispatching/queued），先排队，等它 running 再放行；
 *   rejected    —— **当场拒绝并给理由**（例如指令面已关）。
 *
 * 失败（非 2xx）时保留输入内容并展示 requestId；`DEVICE_OFFLINE` 单独给引导——
 * 这句拒绝的含义是"没有可用的执行目标"，用户需要知道下一步该做什么，而不是只看到错误码。
 */
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useState, type FormEvent, type ReactNode } from 'react'
import { api } from '../../shared/api/client.js'
import { ErrorBanner } from '../../app/ErrorBanner.js'
import { queryKeys } from '../../app/query-client.js'
import { isApiError } from '../../shared/api/errors.js'
import type { InstructionView } from '../../shared/api/types.js'

/** POST /tasks/:taskId/instructions 的响应：指令本体 + 它的命运。 */
export interface InstructionOutcome extends InstructionView {
  outcome: 'started_run' | 'followup' | 'queued' | 'rejected'
  runId: string | null
}

const OUTCOME_TEXT: Record<InstructionOutcome['outcome'], string> = {
  started_run: '已起新运行',
  followup: '已作为追问发给当前运行',
  queued: '已排队——当前运行开始后放行',
  rejected: '未受理',
}

export interface InstructionComposerProps {
  taskId: string
  /** 有活跃 Run 时提示"这句话会成为追问"，让用户提前知道自己的话会去哪。 */
  hasActiveRun: boolean
  /**
   * 这段话是给哪个 Agent 的（可空：Hub 会去继承上一个 Run 的 Agent）。
   * ⑥c 的目标选择器落地前，起**第一个**运行仍需要显式选 Agent——那种情况由
   * 调用方（常驻的启动器）承担，这里只在已经能确定 Agent 时才提示可发。
   */
  onOutcome?: (outcome: InstructionOutcome) => void
}

export function InstructionComposer({
  taskId,
  hasActiveRun,
  onOutcome,
}: InstructionComposerProps): ReactNode {
  const queryClient = useQueryClient()
  const [text, setText] = useState('')
  const [error, setError] = useState<unknown>(null)
  const [last, setLast] = useState<InstructionOutcome | null>(null)

  const mutation = useMutation({
    mutationFn: (body: string) =>
      api.mutate<InstructionOutcome>(`/tasks/${taskId}/instructions`, {
        body: { text: body },
      }),
    onSuccess: (outcome) => {
      setText('')
      setError(null)
      setLast(outcome)
      onOutcome?.(outcome)
      void queryClient.invalidateQueries({ queryKey: queryKeys.taskRoom(taskId) })
    },
    onError: (mutationError: unknown) => {
      // 失败时保留输入内容（与留言输入同一口径：失败不乐观更新、不吞掉用户打的字）。
      setError(mutationError)
      setLast(null)
    },
  })

  const submit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault()
    const body = text.trim()
    if (body === '' || mutation.isPending) return
    setError(null)
    mutation.mutate(body)
  }

  // `ApiError` 自带 wire 上的 code（errors.ts），不需要另造助手。
  const offlineGuidance = isApiError(error) && error.code === 'DEVICE_OFFLINE'

  return (
    <form className="instruction-composer" onSubmit={submit}>
      <label htmlFor={`instruction-text-${taskId}`}>指令</label>
      <textarea
        id={`instruction-text-${taskId}`}
        name="text"
        rows={2}
        maxLength={10_000}
        value={text}
        placeholder="让 Agent 干这个…"
        onChange={(event) => setText(event.target.value)}
      />
      <div className="composer-actions">
        <button type="submit" className="button button-primary" disabled={mutation.isPending}>
          {mutation.isPending ? '发送中…' : '发送指令'}
        </button>
        <span className="mutation-hint" data-testid="instruction-routing-hint">
          {hasActiveRun ? '当前有运行 · 这句话会成为追问' : '当前没有运行 · 这句话会起新运行'}
        </span>
      </div>
      {last !== null ? (
        <p className="instruction-outcome" role="status" data-testid="instruction-outcome">
          {OUTCOME_TEXT[last.outcome]}
          {last.runId === null ? null : <span className="mono"> · {last.runId.slice(0, 8)}</span>}
          {last.outcome === 'rejected' ? (
            <span data-testid="instruction-outcome-reason">
              {' · '}
              <span className="mono">{last.instructionErrorCode ?? 'REJECTED'}</span>{' '}
              {last.instructionErrorMessage ?? '未给出理由'}
            </span>
          ) : null}
        </p>
      ) : null}
      {error !== null ? <ErrorBanner error={error} /> : null}
      {offlineGuidance ? (
        // 409 的含义不是"你写错了"，而是"没有可用的执行目标"——必须告诉用户下一步做什么。
        <p className="mutation-hint" data-testid="instruction-offline-guidance">
          这台任务当前没有可用的执行目标：可以让责任人的设备上线（在「设备」页确认已上报），或
          在目标选择里显式指定设备与工作区。
        </p>
      ) : null}
    </form>
  )
}
