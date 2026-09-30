/**
 * Run 行动（P1-16 G7-01/G7-04/G7-06 UI 面；02 Task 16 Step 6）。
 *
 * - 活跃 Run（queued..cancel_requested）显示「取消」：owner 或 Owner/Admin 可见
 *   （03 §4 权限列；member 不显示）。POST /runs/:id/cancel 幂等键按源 Run 固定，
 *   重复点击/重试天然幂等；等待 server 确认前按钮禁用，不本地猜测结果。
 * - 终态 Run 两个动作（仅 Run owner——发起 Run 是责任人动作）：
 *   「重跑此 Run」（rerun，不带上下文重来，提交体带 rerunOfRunId）与
 *   「接着上次聊」（resume，ADR-0009 切片⑤——persisted load 续会话，提交体带
 *   resumeFromRunId）。两者共用内联表单但**目标固定取来源 Run**：Hub 的
 *   resume 守卫要求同 Device 且同 Workspace（机器判据），这里不给换选的入口，
 *   与守卫互为镜像。幂等键在本次表单会话内固定（重复点击同键，服务端去重）。
 * - 不显示任何「恢复运行/重放工具」入口——Run 终态禁止复活（resume 是新 Run，
 *   不是复活旧 Run）。
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
import { TERMINAL_RUN } from '../task/run-states.js'

function isOwnerOrAdmin(session: Session): boolean {
  return session.role === 'owner' || session.role === 'admin'
}

/** 终态后的两种再出发方式（ADR-0009 决策 8：两个动作、两列血缘）。 */
type AgainMode = 'rerun' | 'resume'

const AGAIN_FORM: Readonly<
  Record<AgainMode, { label: string; placeholder: string; confirm: string }>
> = {
  rerun: {
    label: '新 Run 的指令',
    placeholder: '重跑会创建全新的 Run（不会自动重放上一次的工具调用）',
    confirm: '确认重跑',
  },
  resume: {
    label: '续跑要说的话',
    placeholder: '会接着上次的会话继续（记得上文，不会重放工具调用）',
    confirm: '确认续跑',
  },
}

export function RunActions({ run, session }: { run: RunView; session: Session }): ReactNode {
  const queryClient = useQueryClient()
  const canCancel = run.ownerUserId === session.userId || isOwnerOrAdmin(session)
  const canRerun = run.ownerUserId === session.userId
  const isTerminal = TERMINAL_RUN.has(run.status)

  const [localError, setLocalError] = useState<string | null>(null)
  const [againOpen, setAgainOpen] = useState<AgainMode | null>(null)
  const [prompt, setPrompt] = useState('')
  // 本次表单会话的幂等键：打开时生成一次，重复确认共用（服务端幂等去重）。
  const againKey = useRef<string | null>(null)

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
  const again = useMutation({
    mutationFn: (input: { mode: AgainMode; prompt: string }) =>
      api.mutate(`/tasks/${run.taskId}/runs`, {
        idempotencyKey: againKey.current ?? crypto.randomUUID(),
        body: {
          agentId: run.agentId,
          deviceId: run.deviceId,
          workspaceId: run.workspaceId,
          prompt: input.prompt,
          // 两个动作互斥（协议 superRefine fail-closed）：rerun 带前者、resume 带后者。
          ...(input.mode === 'rerun' ? { rerunOfRunId: run.id } : { resumeFromRunId: run.id }),
        },
      }),
    onSuccess: () => {
      invalidateRunState()
      setAgainOpen(null)
      setPrompt('')
    },
  })

  const busy = cancel.isPending || again.isPending

  const openAgain = (mode: AgainMode): void => {
    setAgainOpen(mode)
    if (againKey.current === null) againKey.current = crypto.randomUUID()
  }

  const confirmAgain = (): void => {
    // 本地校验不是 API 错误（没有 requestId）：行内说清即可，不走 ErrorBanner。
    if (againOpen === null) return
    if (prompt.trim() === '') {
      setLocalError(againOpen === 'rerun' ? '请填写新 Run 的指令' : '请填写续跑要说的话')
      return
    }
    setLocalError(null)
    again.mutate({ mode: againOpen, prompt: prompt.trim() })
  }

  const form = againOpen === null ? null : AGAIN_FORM[againOpen]

  return (
    <div className="run-actions">
      {!isTerminal && canCancel ? (
        <button
          type="button"
          className="button"
          data-testid="cancel-run-button"
          disabled={busy}
          onClick={() => cancel.mutate()}
        >
          取消 Run
        </button>
      ) : null}
      {isTerminal && canRerun ? (
        form === null ? (
          <div className="run-again-entry">
            <button
              type="button"
              className="button"
              data-testid="rerun-button"
              onClick={() => openAgain('rerun')}
            >
              重跑此 Run
            </button>
            <button
              type="button"
              className="button"
              data-testid="resume-button"
              onClick={() => openAgain('resume')}
            >
              接着上次聊
            </button>
          </div>
        ) : (
          <div className="run-rerun-form">
            <label htmlFor="run-rerun-prompt">{form.label}</label>
            <textarea
              id="run-rerun-prompt"
              data-testid="rerun-prompt"
              value={prompt}
              onChange={(event) => setPrompt(event.target.value)}
              rows={3}
              placeholder={form.placeholder}
            />
            <button
              type="button"
              className="button"
              data-testid="rerun-confirm-button"
              disabled={busy}
              onClick={confirmAgain}
            >
              {form.confirm}
            </button>
          </div>
        )
      ) : null}
      {localError !== null ? (
        <p role="alert" className="run-actions-error">
          {localError}
        </p>
      ) : null}
      {cancel.isError ? <ErrorBanner error={cancel.error} /> : null}
      {again.isError ? <ErrorBanner error={again.error} /> : null}
    </div>
  )
}
