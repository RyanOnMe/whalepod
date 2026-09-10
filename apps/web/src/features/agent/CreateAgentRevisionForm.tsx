/**
 * 已有 Agent 新建 Revision 表单（03 §4：POST /agents/:agentId/revisions，
 * Owner/Admin；Hub 侧锁 Agent 行串行化 revision 编号，archived Agent 拒绝 409）。
 *
 * 字段与 protocol 的 CreateAgentRevisionRequest 同形（persona/provider/model/
 * credentialSlot/maxTokens/pluginPackId）。初值预填当前 Revision——典型操作
 * 是只换 Pack 或微调参数后提交（P1-17 的 Pack 替换流程）；Agent 尚无
 * Revision 时用与新建 Agent 表单相同的默认值。Plugin Pack 经 PackSelect
 * 下拉选择（数据源 GET /plugin-packs）。成功后提示新 Revision 号并失效
 * Agent 详情/列表缓存；失败展示 requestId。
 *
 * #167：字段标签与新建表单**共用** shared/format.ts 的 PERSONA_LABEL /
 * CREDENTIAL_SLOT_LABEL / CREDENTIAL_SLOT_HINT——同一屏两个表单不能各写一套说法
 * （此前详情与表单都写裸 `Credential Slot`，同源只是巧合，一改就漂）。
 */
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useState, type FormEvent, type ReactNode } from 'react'
import type { CreateAgentRevisionRequest } from '@whalepod/protocol'
import { api } from '../../shared/api/client.js'
import { ErrorBanner } from '../../app/ErrorBanner.js'
import { CREDENTIAL_SLOT_HINT, CREDENTIAL_SLOT_LABEL, PERSONA_LABEL } from '../../shared/format.js'
import type { AgentDetailView, ProfileRevisionView } from '../../shared/api/types.js'
import { queryKeys } from '../../app/query-client.js'
import { PackSelect } from './PackSelect.js'

export interface CreateAgentRevisionFormProps {
  agent: AgentDetailView
}

function initialValues(agent: AgentDetailView) {
  const current = agent.currentRevision
  return {
    persona: current?.persona ?? '',
    provider: current?.provider ?? 'deepseek-official',
    model: current?.model ?? 'deepseek-chat',
    credentialSlot: current?.credentialSlot ?? 'default',
    maxTokens:
      current?.maxTokens !== null && current?.maxTokens !== undefined
        ? String(current.maxTokens)
        : '',
    pluginPackId: current?.pluginPackId ?? '',
  }
}

export function CreateAgentRevisionForm({ agent }: CreateAgentRevisionFormProps): ReactNode {
  const queryClient = useQueryClient()
  const [values, setValues] = useState(() => initialValues(agent))
  const [error, setError] = useState<unknown>(null)
  const [notice, setNotice] = useState<string | null>(null)

  const mutation = useMutation({
    mutationFn: () => {
      const body: CreateAgentRevisionRequest = {
        persona: values.persona.trim(),
        provider: values.provider.trim(),
        model: values.model.trim(),
        credentialSlot: values.credentialSlot.trim(),
        ...(values.maxTokens.trim() !== '' ? { maxTokens: Number(values.maxTokens) } : {}),
        pluginPackId: values.pluginPackId,
      }
      return api.mutate<ProfileRevisionView>(`/agents/${agent.id}/revisions`, { body })
    },
    onSuccess: (revision) => {
      setNotice(`Revision #${revision.revision} 已创建，并设为该 Agent 的当前 Revision。`)
      setError(null)
      void queryClient.invalidateQueries({ queryKey: queryKeys.agentDetail(agent.id) })
      void queryClient.invalidateQueries({ queryKey: queryKeys.agents })
    },
    onError: (mutationError: unknown) => {
      setError(mutationError)
      setNotice(null)
    },
  })

  const submit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault()
    if (mutation.isPending || values.pluginPackId === '') return
    setError(null)
    setNotice(null)
    mutation.mutate()
  }

  const set =
    (field: keyof ReturnType<typeof initialValues>) =>
    (value: string): void => {
      setValues((prev) => ({ ...prev, [field]: value }))
    }

  return (
    <form
      className="agent-revision-form"
      onSubmit={submit}
      aria-label={`新建 Revision ${agent.name}`}
    >
      <h4>新建 Revision</h4>
      <div className="field">
        <label htmlFor="revision-persona">{PERSONA_LABEL}</label>
        <textarea
          id="revision-persona"
          rows={4}
          value={values.persona}
          onChange={(event) => set('persona')(event.target.value)}
          required
          maxLength={20_000}
        />
      </div>
      <div className="field-row">
        <div className="field">
          <label htmlFor="revision-provider">模型服务商（Provider）</label>
          <input
            id="revision-provider"
            value={values.provider}
            onChange={(event) => set('provider')(event.target.value)}
            required
            maxLength={100}
          />
        </div>
        <div className="field">
          <label htmlFor="revision-model">模型（Model）</label>
          <input
            id="revision-model"
            value={values.model}
            onChange={(event) => set('model')(event.target.value)}
            required
            maxLength={200}
          />
        </div>
      </div>
      <div className="field-row">
        <div className="field">
          <label htmlFor="revision-credential-slot">{CREDENTIAL_SLOT_LABEL}</label>
          <input
            id="revision-credential-slot"
            value={values.credentialSlot}
            onChange={(event) => set('credentialSlot')(event.target.value)}
            required
            maxLength={80}
          />
          <p className="field-hint">{CREDENTIAL_SLOT_HINT}</p>
        </div>
        <div className="field">
          <label htmlFor="revision-max-tokens">单次最多生成 Token 数（Max Tokens，可选）</label>
          <input
            id="revision-max-tokens"
            type="number"
            min={1}
            value={values.maxTokens}
            onChange={(event) => set('maxTokens')(event.target.value)}
          />
        </div>
      </div>
      <div className="field">
        {/* #167 × #158：标签文案由 PackSelect 的 label 传下去（见上），不重复 <label>。 */}
        <PackSelect
          id="revision-plugin-pack"
          value={values.pluginPackId}
          onChange={set('pluginPackId')}
        />
        <p className="field-hint">选择新 Revision 使用的 Plugin Pack（列表来自插件管理）。</p>
      </div>
      <div className="form-actions">
        <button
          type="submit"
          className="button button-primary"
          disabled={mutation.isPending || values.pluginPackId === ''}
        >
          {mutation.isPending ? '创建中…' : '创建 Revision'}
        </button>
      </div>
      {notice !== null ? (
        <div className="success-banner" role="status">
          <p>{notice}</p>
        </div>
      ) : null}
      {error !== null ? <ErrorBanner error={error} /> : null}
    </form>
  )
}
