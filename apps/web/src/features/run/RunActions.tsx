/**
 * Run 行动（P1-16 G7-01/G7-04/G7-06 UI 面；02 Task 16 Step 6）。
 *
 * - 活跃 Run（queued..cancel_requested）显示「取消」：owner 或 Owner/Admin 可见
 *   （03 §4 权限列；member 不显示）。POST /runs/:id/cancel 幂等键按源 Run 固定，
 *   重复点击/重试天然幂等；等待 server 确认前按钮禁用，不本地猜测结果。
 * - 终态 Run 显示「重跑」：仅 Run owner（重跑=发起 Run，是责任人动作）。展开
 *   内联表单要求显式输入新指令（不静默复用旧 prompt），提交体带 rerunOfRunId
 *   指向来源 Run；幂等键在本次表单会话内固定（重复点击同键，服务端去重）。
 * - 不显示任何「恢复运行/重放工具」入口——Run 终态禁止复活。
 *
 * #225：走 react-query mutation——成功后本地失效 `run` 与 `task-room` 两个键
 * （event-router 的 `run.changed` 只失效 `['run', runId]`，运行卡列表来自
 * task-room 聚合，不补失效就只在 WS 事件到达时才更新）；错误走 ErrorBanner
 * （message + requestId），与全站口径一致。
 */
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useRef, useState, type ReactNode } from 'react'
import { api } from '../../shared/api/client.js'
import { ErrorBanner } from '../../app/ErrorBanner.js'
import { queryKeys } from '../../app/query-client.js'
import type { RunView, Session } from '../../shared/api/types.js'

const TERMINAL_RUN: ReadonlySet<string> = new Set(['completed', 'failed', 'cancelled', 'lost'])

function isOwnerOrAdmin(session: Session): boolean {
  return session.role === 'owner' || session.role === 'admin'
}

export function RunActions({ run, session }: { run: RunView; session: Session }): ReactNode {
  const queryClient = useQueryClient()
  const canCancel = run.ownerUserId === session.userId || isOwnerOrAdmin(session)
  const canRerun = run.ownerUserId === session.userId
  const isTerminal = TERMINAL_RUN.has(run.status)

  const [localError, setLocalError] = useState<string | null>(null)
  const [rerunOpen, setRerunOpen] = useState(false)
  const [prompt, setPrompt] = useState('')
  // 本次重跑表单会话的幂等键：打开时生成一次，重复确认共用（服务端幂等去重）。
  const rerunKey = useRef<string | null>(null)

  const invalidateRunState = (): void => {
    void queryClient.invalidateQueries({ queryKey: queryKeys.run(run.id) })
    void queryClient.invalidateQueries({ queryKey: queryKeys.taskRoom(run.taskId) })
  }

  const cancel = useMutation({
    mutationFn: () =>
      api.mutate(`/runs/${run.id}/cancel`, {
        // 按 Run 固定：取消是一次意图，重复请求必须命中同一条服务端路径。
        idempotencyKey: `cancel-${run.id}`,
      }),
    onSuccess: invalidateRunState,
  })
  const rerun = useMutation({
    mutationFn: (body: { prompt: string }) =>
      api.mutate(`/tasks/${run.taskId}/runs`, {
        idempotencyKey: rerunKey.current ?? crypto.randomUUID(),
        body: {
          agentId: run.agentId,
          deviceId: run.deviceId,
          workspaceId: run.workspaceId,
          prompt: body.prompt,
          rerunOfRunId: run.id,
        },
      }),
    onSuccess: () => {
      invalidateRunState()
      setRerunOpen(false)
      setPrompt('')
    },
  })

  const busy = cancel.isPending || rerun.isPending

  const openRerun = (): void => {
    setRerunOpen(true)
    if (rerunKey.current === null) rerunKey.current = crypto.randomUUID()
  }

  const confirmRerun = (): void => {
    // 本地校验不是 API 错误（没有 requestId）：行内说清即可，不走 ErrorBanner。
    if (prompt.trim() === '') {
      setLocalError('请填写新 Run 的指令')
      return
    }
    setLocalError(null)
    rerun.mutate({ prompt: prompt.trim() })
  }

  return (
    <div className="run-actions">
      {!isTerminal && canCancel ? (
        <button type="button" className="button" disabled={busy} onClick={() => cancel.mutate()}>
          取消 Run
        </button>
      ) : null}
      {isTerminal && canRerun ? (
        rerunOpen ? (
          <div className="run-rerun-form">
            <label htmlFor="run-rerun-prompt">新 Run 的指令</label>
            <textarea
              id="run-rerun-prompt"
              value={prompt}
              onChange={(event) => setPrompt(event.target.value)}
              rows={3}
              placeholder="重跑会创建全新的 Run（不会自动重放上一次的工具调用）"
            />
            <button type="button" className="button" disabled={busy} onClick={confirmRerun}>
              确认重跑
            </button>
          </div>
        ) : (
          <button type="button" className="button" onClick={openRerun}>
            重跑此 Run
          </button>
        )
      ) : null}
      {localError !== null ? (
        <p role="alert" className="run-actions-error">
          {localError}
        </p>
      ) : null}
      {cancel.isError ? <ErrorBanner error={cancel.error} /> : null}
      {rerun.isError ? <ErrorBanner error={rerun.error} /> : null}
    </div>
  )
}
