import { SettingsSection } from '../../vendor/collectui/collectui.js'
/**
 * 新建 Agent 表单（02 Task 7 Step 5）：姓名字段 + 首个 Profile Revision
 * （persona/provider/model/credentialSlot/maxTokens/pluginPackId）。
 *
 * #167：字段标签中文优先——Persona/Provider/Model/Credential Slot/Max Tokens/
 * Plugin Pack 单看不知道填什么，而同屏的「名称 / 描述」是中文。领域词按
 * CONTEXT.md 口径写成「中文（English）」（常量见 shared/format.ts）；`Credential Slot`
 * 是内部概念，除标签外还带一句解释性 field-hint，说明「填什么、谁配的、服务器看不看得到」。
 *
 * Plugin Pack 经 PackSelect 下拉选择（数据源 GET /plugin-packs，P1-17 已提供），
 * 不再接受手工粘贴 UUID；未选 Pack 时禁用提交（加载/失败/空列表同理，见
 * PackSelect 注释）。提交走 POST /agents（Owner/Admin）；pending 时禁用；
 * 失败展示 requestId。
 */
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useState, type FormEvent, type ReactNode } from 'react'
import type { ApprovalPolicy, CreateAgentRequest } from '@whalepod/protocol'
import { api } from '../../shared/api/client.js'
import { ErrorBanner } from '../../app/ErrorBanner.js'
import { CREDENTIAL_SLOT_HINT, CREDENTIAL_SLOT_LABEL, PERSONA_LABEL } from '../../shared/format.js'
import type { AgentView } from '../../shared/api/types.js'
import { queryKeys } from '../../app/query-client.js'
import { PackSelect } from './PackSelect.js'
import { SelectMenu } from '../../shared/SelectMenu.js'

export interface AgentRevisionFormProps {
  onCreated?: () => void
  embedded?: boolean
}

const DEFAULT_VALUES = {
  name: '',
  description: '',
  persona: '',
  provider: 'deepseek-official',
  model: 'deepseek-chat',
  credentialSlot: 'default',
  maxTokens: '',
  pluginPackId: '',
  approvalPolicy: 'approval_required' as ApprovalPolicy,
}

/** 审批档选项（#241）：full_access 的风险写进描述——选择时就知道在放权什么。 */
export const APPROVAL_POLICY_OPTIONS: ReadonlyArray<{
  value: ApprovalPolicy
  label: string
  disabled: boolean
}> = [
  { value: 'approval_required', label: '每次工具调用需批准（默认）', disabled: false },
  { value: 'full_access', label: '完全权限（工具调用直接放行）', disabled: false },
]

export function AgentRevisionForm({
  onCreated,
  embedded = false,
}: AgentRevisionFormProps): ReactNode {
  const queryClient = useQueryClient()
  const [values, setValues] = useState(DEFAULT_VALUES)
  const [error, setError] = useState<unknown>(null)

  const mutation = useMutation({
    mutationFn: () => {
      const body: CreateAgentRequest = {
        name: values.name.trim(),
        persona: values.persona.trim(),
        provider: values.provider.trim(),
        model: values.model.trim(),
        credentialSlot: values.credentialSlot.trim(),
        ...(values.description.trim() !== '' ? { description: values.description.trim() } : {}),
        ...(values.maxTokens.trim() !== '' ? { maxTokens: Number(values.maxTokens) } : {}),
        pluginPackId: values.pluginPackId.trim(),
        approvalPolicy: values.approvalPolicy,
      }
      return api.mutate<AgentView>('/agents', { body })
    },
    onSuccess: () => {
      setValues(DEFAULT_VALUES)
      setError(null)
      void queryClient.invalidateQueries({ queryKey: queryKeys.agents })
      onCreated?.()
    },
    onError: (mutationError: unknown) => {
      setError(mutationError)
    },
  })

  const submit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault()
    if (mutation.isPending || values.pluginPackId === '') return
    setError(null)
    mutation.mutate()
  }

  const set =
    (field: keyof typeof DEFAULT_VALUES) =>
    (value: string): void => {
      setValues((prev) => ({ ...prev, [field]: value }))
    }

  return (
    <form
      className="card agent-form"
      onSubmit={submit}
      onInvalidCapture={(event) => {
        // Native validation must be able to focus a required advanced field.
        const details = (event.target as HTMLElement).closest('details')
        if (details !== null) details.open = true
      }}
      aria-label="新建 Agent"
    >
      {embedded ? null : <h3>新建 Agent</h3>}
      <SettingsSection title="基本信息">
        <div className="field">
          <label htmlFor="agent-name">名称</label>
          <input
            id="agent-name"
            value={values.name}
            onChange={(event) => set('name')(event.target.value)}
            required
            maxLength={80}
          />
        </div>
        <div className="field">
          <label htmlFor="agent-description">描述（可选）</label>
          <input
            id="agent-description"
            value={values.description}
            onChange={(event) => set('description')(event.target.value)}
            maxLength={500}
          />
        </div>
      </SettingsSection>
      <SettingsSection title="角色">
        <div className="field">
          <label htmlFor="agent-persona">{PERSONA_LABEL}</label>
          <textarea
            id="agent-persona"
            rows={4}
            value={values.persona}
            onChange={(event) => set('persona')(event.target.value)}
            required
            maxLength={20_000}
          />
          <p className="field-hint">定义角色、目标与工作规则。</p>
        </div>
      </SettingsSection>
      <SettingsSection title="模型">
        <div className="field-row">
          <div className="field">
            <label htmlFor="agent-provider">模型服务商（Provider）</label>
            <input
              id="agent-provider"
              value={values.provider}
              onChange={(event) => set('provider')(event.target.value)}
              required
              maxLength={100}
            />
          </div>
          <div className="field">
            <label htmlFor="agent-model">模型（Model）</label>
            <input
              id="agent-model"
              value={values.model}
              onChange={(event) => set('model')(event.target.value)}
              required
              maxLength={200}
            />
          </div>
        </div>
      </SettingsSection>
      <SettingsSection title="工具与权限">
        <div className="field">
          {/* #167 × #158：可见标签与可访问名由 PackSelect → SelectMenu 渲染
            （`<label htmlFor={id}>` 指向触发器按钮），这里不重复一个 <label>；
            中文优先的文案「插件组合（Plugin Pack）」写在 PackSelect 的 label 上传下去。 */}
          <PackSelect
            id="agent-plugin-pack"
            value={values.pluginPackId}
            onChange={set('pluginPackId')}
          />
          <p className="field-hint">决定 Agent 可用的工具。</p>
        </div>
        <div className="field">
          <SelectMenu
            id="agent-approval-policy"
            label="审批档位（Approval Policy）"
            ariaLabel="选择审批档位"
            value={values.approvalPolicy}
            options={APPROVAL_POLICY_OPTIONS}
            onChange={(next) => set('approvalPolicy')(next as ApprovalPolicy)}
          />
          <p className="field-hint">
            完全权限会直接执行工具，不再逐次请求批准。Task 可覆盖此默认档位。
          </p>
        </div>
      </SettingsSection>
      <details className="agent-advanced">
        <summary>高级选项</summary>
        <div className="field-row">
          <div className="field">
            <label htmlFor="agent-credential-slot">{CREDENTIAL_SLOT_LABEL}</label>
            <input
              id="agent-credential-slot"
              value={values.credentialSlot}
              onChange={(event) => set('credentialSlot')(event.target.value)}
              required
              maxLength={80}
            />
            <p className="field-hint">{CREDENTIAL_SLOT_HINT}</p>
          </div>
          <div className="field">
            <label htmlFor="agent-max-tokens">单次最多生成 Token 数（Max Tokens，可选）</label>
            <input
              id="agent-max-tokens"
              type="number"
              min={1}
              value={values.maxTokens}
              onChange={(event) => set('maxTokens')(event.target.value)}
            />
            <p className="field-hint">留空表示不限制（走模型默认上限）。</p>
          </div>
        </div>
      </details>
      <div className="form-actions">
        <button
          type="submit"
          className="button button-primary"
          disabled={mutation.isPending || values.pluginPackId === ''}
        >
          {mutation.isPending ? '创建中…' : '创建 Agent'}
        </button>
      </div>
      {error !== null ? <ErrorBanner error={error} /> : null}
    </form>
  )
}
