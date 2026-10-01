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
import { ConfirmDialog } from '../../shared/ConfirmDialog.js'
import { isApiError } from '../../shared/api/errors.js'
import type { InstructionView } from '../../shared/api/types.js'

/** POST /tasks/:taskId/instructions 的响应：指令本体 + 它的命运。 */
export interface InstructionOutcome extends InstructionView {
  outcome: 'started_run' | 'followup' | 'queued' | 'rejected'
  runId: string | null
}

/**
 * #244 composer 审批档位预览：这句话将以什么权限跑。
 *
 * 三条来源（优先级从高到低，**由 TaskRoomPage 按服务端数据解析**，本组件只渲染）：
 * - `active_run`：有活跃 Run，这句话会成为追问，档位 = 该 Run 已固化的档；
 * - `task_override`：Task 覆盖档（`task.approvalPolicy`）；
 * - `revision_default`：无覆盖时服务端预解析的 Revision 默认（房间视图字段）。
 *
 * `null` = 无法预解析（本任务还没有 Run 可继承 Agent，首句本就走启动器）——如实显示
 * 「未知」，不猜。档位为 full_access 时发送前必须过确认（ADR-0009 决策 7：显式放权）。
 */
export type ApprovalPreview = {
  policy: 'approval_required' | 'full_access'
  source: 'active_run' | 'task_override' | 'revision_default'
} | null

const APPROVAL_POLICY_TEXT: Record<Exclude<ApprovalPreview, null>['policy'], string> = {
  approval_required: '需要逐次批准',
  full_access: '完全权限',
}

const APPROVAL_SOURCE_TEXT: Record<Exclude<ApprovalPreview, null>['source'], string> = {
  active_run: '当前运行',
  task_override: '任务覆盖',
  revision_default: 'Revision 默认',
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
   * 显式执行目标（⑥c）。`null` = 交给 Hub 三段式解析——目标字段按**实际钉住什么**发
   * （只钉设备就只发 deviceId；见下面的注释）。**必填**：生产唯一调用点总传值，留成可选会多出
   * 一个没人走的分支（评审 O6：`undefined` 那条实际上从没被验过）。
   */
  target: { deviceId: string; workspaceId: string } | null
  /**
   * 这段话是给哪个 Agent 的（可空：Hub 会去继承上一个 Run 的 Agent）。
   * ⑥c 的目标选择器落地前，起**第一个**运行仍需要显式选 Agent——那种情况由
   * 调用方（常驻的启动器）承担，这里只在已经能确定 Agent 时才提示可发。
   */
  /**
   * #244 审批档位预览（解析在 TaskRoomPage，见 `ApprovalPreview`）：只读展示 +
   * full_access 时的发送确认。**不提供就地改档**——改档是责任人动作（ApprovalPolicyBlock），
   * composer 的读者可能是被授权成员。
   */
  approvalPreview: ApprovalPreview
  onOutcome?: (outcome: InstructionOutcome) => void
}

export function InstructionComposer({
  taskId,
  hasActiveRun,
  target,
  approvalPreview,
  onOutcome,
}: InstructionComposerProps): ReactNode {
  const queryClient = useQueryClient()
  const [text, setText] = useState('')
  const [error, setError] = useState<unknown>(null)
  const [last, setLast] = useState<InstructionOutcome | null>(null)
  // #244：full_access 确认闸。pendingBody 存「点了发送那一刻」的正文——对话框是模态的，
  // 打开期间正文不可编辑，但确认动作必须发送用户看到的那句话，别在关闭时重读 state。
  const [confirmingFullAccess, setConfirmingFullAccess] = useState(false)
  const [pendingBody, setPendingBody] = useState('')

  const mutation = useMutation({
    mutationFn: (body: string) =>
      api.mutate<InstructionOutcome>(`/tasks/${taskId}/instructions`, {
        // 目标字段按**实际钉住了什么**发：
        //   自动解析（target 为 null）→ 一个都不发；
        //   只钉了设备（工作区还空）→ **只发 deviceId**（Hub 支持：会在该设备上挑可用工作区，
        //     见 instruction-target.ts 的 findAvailableWorkspaceForDevice）；
        //   设备与工作区都钉住 → 两个都发。
        // 修正（评审 B1）：原先"workspaceId 为空就两个都不发"让**只选设备**这一态说了假话——
        // 那时 chip 写着「显式指定」，载荷里却没有任何目标字段：用户以为钉死了设备 A，
        // 实际可能落在"沿用上一轮"的设备 B 上，而这一片要回答的正是"这句话会在哪里跑"。
        body:
          target === null || target.deviceId === ''
            ? { text: body }
            : target.workspaceId === ''
              ? { text: body, deviceId: target.deviceId }
              : { text: body, deviceId: target.deviceId, workspaceId: target.workspaceId },
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
    // 显式放权（ADR-0009 决策 7）要过一次确认——与 RunLauncher 的启动确认同口径，
    // 只不过这里挂在了「说这句话」的动作上（#244：放权确认长在放权发生的地方）。
    if (approvalPreview?.policy === 'full_access') {
      setPendingBody(body)
      setConfirmingFullAccess(true)
      return
    }
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
        onKeyDown={(event) => {
          // #229：Cmd/Ctrl+Enter 直发（与提交按钮同一条 form 路径）；纯 Enter 仍是换行。
          if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
            event.preventDefault()
            event.currentTarget.form?.requestSubmit()
          }
        }}
      />
      <div className="composer-actions">
        <button type="submit" className="button button-primary" disabled={mutation.isPending}>
          {mutation.isPending ? '发送中…' : '发送指令'}
        </button>
        <span className="mutation-hint" data-testid="instruction-routing-hint">
          {hasActiveRun ? '当前有运行 · 这句话会成为追问' : '当前没有运行 · 这句话会起新运行'}
        </span>
        {/* #244 审批档位胶囊：发送前可见「这句话将以什么权限跑」及其来源。
            full_access 时加 warn 视觉（与运行卡的放权标记同族），approval_required/未知保持中性。 */}
        <span
          className="composer-approval-pill"
          data-testid="instruction-approval-pill"
          data-policy={approvalPreview === null ? 'unknown' : approvalPreview.policy}
        >
          {approvalPreview === null
            ? '审批 · 未知（还没有可继承的运行）'
            : `审批 · ${APPROVAL_POLICY_TEXT[approvalPreview.policy]} · ${APPROVAL_SOURCE_TEXT[approvalPreview.source]}`}
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
      {confirmingFullAccess ? (
        <ConfirmDialog
          open
          title="以完全权限发送指令？"
          body="这句话将以完全权限执行：工具调用不再逐次请求批准，运行卡会标记「完全权限」。确认前请确信 Agent 的 persona 与插件组合可信。"
          confirmLabel="确认以完全权限发送"
          danger
          pending={mutation.isPending}
          onConfirm={() => {
            setConfirmingFullAccess(false)
            setError(null)
            mutation.mutate(pendingBody)
            setPendingBody('')
          }}
          onCancel={() => {
            setConfirmingFullAccess(false)
            setPendingBody('')
          }}
        />
      ) : null}
    </form>
  )
}
