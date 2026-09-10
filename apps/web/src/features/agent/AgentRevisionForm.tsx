/**
 * 新建 Agent 表单（02 Task 7 Step 5）：姓名字段 + 首个 Profile Revision
 * （persona/provider/model/credentialSlot/maxTokens/pluginPackId）。
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
        <label htmlFor="agent-persona">Persona</label>
        <textarea
          id="agent-persona"
          rows={4}
          value={values.persona}
          onChange={(event) => set('persona')(event.target.value)}
          required
          maxLength={20_000}
        />
      </div>
      <div className="field-row">
        <div className="field">
          <label htmlFor="agent-provider">Provider</label>
          <input
            id="agent-provider"
            value={values.provider}
            onChange={(event) => set('provider')(event.target.value)}
            required
            maxLength={100}
          />
        </div>
        <div className="field">
          <label htmlFor="agent-model">Model</label>
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
          <label htmlFor="agent-credential-slot">Credential Slot</label>
          <input
            id="agent-credential-slot"
            value={values.credentialSlot}
            onChange={(event) => set('credentialSlot')(event.target.value)}
            required
            maxLength={80}
          />
        </div>
        <div className="field">
          <label htmlFor="agent-max-tokens">Max Tokens（可选）</label>
          <input
            id="agent-max-tokens"
            type="number"
            min={1}
            value={values.maxTokens}
            onChange={(event) => set('maxTokens')(event.target.value)}
          />
        </div>
      </div>
      <div className="field">
        {/* #158：可见标签由 PackSelect 内部的 SelectMenu 渲染（同一个 label 元素
            既提供可访问名也做屏上文字），这里不再重复一个 <label>。 */}
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
