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
import type { CreateAgentRequest } from '@whalepod/protocol'
import { api } from '../../shared/api/client.js'
import { ErrorBanner } from '../../app/ErrorBanner.js'
import { CREDENTIAL_SLOT_HINT, CREDENTIAL_SLOT_LABEL, PERSONA_LABEL } from '../../shared/format.js'
import type { AgentView } from '../../shared/api/types.js'
import { queryKeys } from '../../app/query-client.js'
import { PackSelect } from './PackSelect.js'

export interface AgentRevisionFormProps {
  onCreated?: () => void
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
}

export function AgentRevisionForm({ onCreated }: AgentRevisionFormProps): ReactNode {
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
    <form className="card agent-form" onSubmit={submit} aria-label="新建 Agent">
      <h3>新建 Agent</h3>
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
        <p className="field-hint">
          这个 Agent 的角色设定（system prompt 形态）：它是什么角色、按什么规矩干活。
        </p>
      </div>
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
      <div className="field">
        {/* #167 × #158：可见标签与可访问名由 PackSelect → SelectMenu 渲染
            （`<label htmlFor={id}>` 指向触发器按钮），这里不重复一个 <label>；
            中文优先的文案「插件组合（Plugin Pack）」写在 PackSelect 的 label 上传下去。 */}
        <PackSelect
          id="agent-plugin-pack"
          value={values.pluginPackId}
          onChange={set('pluginPackId')}
        />
        <p className="field-hint">
          选择 Agent 首个 Revision 使用的 Plugin Pack（列表来自插件管理）。
        </p>
      </div>
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
