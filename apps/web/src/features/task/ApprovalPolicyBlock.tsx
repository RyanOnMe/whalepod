/**
 * 审批档位块（#241；ADR-0009 决策 7）：Task 级 approval_policy 覆盖的查看与设置。
 *
 * 解析口径（要说清，不然「继承」像玄学）：Agent Revision 带默认档 → Task 可覆盖
 * （NULL = 继承，不物化）→ **每次建 Run** 时解析成具体档位固化进 `runs.approval_policy`。
 * 所以本页只展示「覆盖状态」；具体某个 Run 用哪档看它自己的运行卡。
 *
 * 权限：仅 Task 责任人可改（放权放松的是他的凭据风险——Hub 命令层同口径 403）。
 * full_access 是显式放权：确认对话框说清风险才发 PATCH。
 */
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useState, type ReactNode } from 'react'
import type { ApprovalPolicy } from '@whalepod/protocol'
import { apiRequest } from '../../shared/api/client.js'
import { ErrorBanner } from '../../app/ErrorBanner.js'
import { ConfirmDialog } from '../../shared/ConfirmDialog.js'
import { SelectMenu } from '../../shared/SelectMenu.js'
import { APPROVAL_POLICY_OPTIONS } from '../agent/AgentRevisionForm.js'
import { queryKeys } from '../../app/query-client.js'
import type { TaskView } from '../../shared/api/types.js'

export interface ApprovalPolicyBlockProps {
  task: TaskView
  sessionUserId: string
}

const POLICY_LABEL: Readonly<Record<ApprovalPolicy, string>> = {
  approval_required: '每次工具调用需批准',
  full_access: '完全权限（工具调用直接放行）',
}

export function ApprovalPolicyBlock({ task, sessionUserId }: ApprovalPolicyBlockProps): ReactNode {
  const queryClient = useQueryClient()
  const [selected, setSelected] = useState<TaskView['approvalPolicy']>(task.approvalPolicy)
  const [confirmingFullAccess, setConfirmingFullAccess] = useState(false)
  const [error, setError] = useState<unknown>(null)
  const isResponsible = task.assigneeUserId === sessionUserId

  const apply = useMutation({
    mutationFn: (next: TaskView['approvalPolicy']) =>
      // 值 = 覆盖；null = 清除回继承；键在场即生效（协议层语义）。
      apiRequest<TaskView>(`/tasks/${task.id}`, {
        method: 'PATCH',
        body: { approvalPolicy: next },
      }),
    onSuccess: () => {
      setError(null)
      void queryClient.invalidateQueries({ queryKey: queryKeys.taskRoom(task.id) })
    },
    onError: (mutationError: unknown) => {
      setError(mutationError)
    },
  })

  const requestApply = (next: TaskView['approvalPolicy']): void => {
    if (apply.isPending) return
    if (next === 'full_access') {
      setConfirmingFullAccess(true)
      return
    }
    apply.mutate(next)
  }

  return (
    <section className="card approval-policy-block" aria-labelledby="approval-policy-heading">
      <h2 id="approval-policy-heading">审批档位</h2>
      <p className="assignment-note" data-testid="approval-policy-state">
        {task.approvalPolicy === null
          ? '未覆盖：跟随所用 Agent 的 Revision 默认档（每次建运行时解析固化）。'
          : `已覆盖为「${POLICY_LABEL[task.approvalPolicy]}」——本任务的新运行一律用这档，不跟随 Revision 默认。`}
      </p>
      {isResponsible ? (
        <>
          <div className="field">
            <SelectMenu
              id="task-approval-policy"
              label="覆盖设置"
              ariaLabel="选择审批档覆盖"
              value={selected ?? ''}
              options={[
                // 「继承」是**真选项**（value=''，可选）而不是 placeholder——
                // placeholder 在菜单里是禁用项，清除覆盖这条路径就走不通了。
                { value: '', label: '继承（跟随 Agent Revision 默认）', disabled: false },
                ...APPROVAL_POLICY_OPTIONS,
              ]}
              onChange={(next) => setSelected(next === '' ? null : (next as ApprovalPolicy))}
              disabled={apply.isPending}
            />
            <p className="field-hint">只有责任人（你）能改这一项：档位放松的是你的凭据风险。</p>
          </div>
          <div className="assignment-actions">
            <button
              type="button"
              className="button"
              data-testid="approval-policy-apply"
              disabled={apply.isPending || selected === task.approvalPolicy}
              onClick={() => requestApply(selected)}
            >
              {apply.isPending ? '正在保存…' : '应用'}
            </button>
          </div>
        </>
      ) : (
        <p className="mutation-hint">只有任务责任人可以修改审批档位。</p>
      )}
      {error !== null ? <ErrorBanner error={error} /> : null}
      {confirmingFullAccess ? (
        <ConfirmDialog
          open
          title="放行完全权限？"
          body="本任务的新运行将不再逐次请求批准，Agent 的工具调用直接执行（用你的设备与凭据）。确认前请确信所用 Agent 的 persona 与插件组合可信。"
          confirmLabel="确认放行完全权限"
          danger
          pending={apply.isPending}
          onConfirm={() => {
            setConfirmingFullAccess(false)
            apply.mutate('full_access')
          }}
          onCancel={() => setConfirmingFullAccess(false)}
        />
      ) : null}
    </section>
  )
}
