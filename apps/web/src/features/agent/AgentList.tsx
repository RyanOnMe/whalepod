/**
 * Agent 管理（02 Task 7 Step 5）：列表 + 详情（当前 Revision + 历史）。
 * Owner/Admin 可新建 Agent（AgentRevisionForm），也可为已有 Agent 新建
 * Revision（CreateAgentRevisionForm，入口在详情页；03 §4
 * POST /agents/:agentId/revisions）；Member 只读（仅看列表与详情）。
 */
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useState, type ReactNode } from 'react'
import { api } from '../../shared/api/client.js'
import { ErrorBanner } from '../../app/ErrorBanner.js'
import { ROLE_LABEL, shortId } from '../../shared/format.js'
import { RelativeTime } from '../../shared/RelativeTime.js'
import type { AgentDetailView, AgentView, Session } from '../../shared/api/types.js'
import { queryKeys } from '../../app/query-client.js'
import { AgentRevisionForm } from './AgentRevisionForm.js'
import { CreateAgentRevisionForm } from './CreateAgentRevisionForm.js'

export interface AgentListProps {
  session: Session | null
}

export function AgentList({ session }: AgentListProps): ReactNode {
  const queryClient = useQueryClient()
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const canManage = session !== null && (session.role === 'owner' || session.role === 'admin')

  const listQuery = useQuery({
    queryKey: queryKeys.agents,
    queryFn: () => api.get<AgentView[]>('/agents'),
  })
  const detailQuery = useQuery({
    queryKey: queryKeys.agentDetail(selectedId ?? ''),
    queryFn: () => api.get<AgentDetailView>(`/agents/${selectedId ?? ''}`),
    enabled: selectedId !== null,
  })

  const onCreated = (): void => {
    setSelectedId(null)
    void queryClient.invalidateQueries({ queryKey: queryKeys.agents })
  }

  return (
    <section className="agents-layout" aria-labelledby="agents-heading">
      <h2 id="agents-heading">Agents</h2>
      {canManage ? (
        <AgentRevisionForm onCreated={onCreated} />
      ) : (
        <p className="mutation-hint agent-readonly-hint">
          你是{session === null ? '访客' : ROLE_LABEL[session.role]}，Agent
          只读；仅所有者或管理员可创建或修改。
        </p>
      )}

      {listQuery.isPending ? <p className="mutation-hint">正在加载 Agents…</p> : null}
      {listQuery.isError ? <ErrorBanner error={listQuery.error} /> : null}
      {listQuery.isSuccess && listQuery.data.length === 0 ? (
        <p className="empty-state">还没有 Agent。创建后，Builder/Reviewer 会出现在这里。</p>
      ) : null}
      {listQuery.isSuccess && listQuery.data.length > 0 ? (
        <ul className="agent-list" role="list">
          {listQuery.data.map((agent) => (
            <li key={agent.id}>
              <button
                type="button"
                className={`agent-card ${agent.id === selectedId ? 'agent-card-selected' : ''}`}
                onClick={() => setSelectedId(agent.id === selectedId ? null : agent.id)}
                aria-pressed={agent.id === selectedId}
              >
                <span className="agent-name">{agent.name}</span>
                <span className="agent-description">
                  {agent.description !== '' ? agent.description : '无描述'}
                </span>
                <span className="agent-id">{shortId(agent.id)}</span>
              </button>
            </li>
          ))}
        </ul>
      ) : null}

      {selectedId !== null ? (
        <section className="card agent-detail" aria-label={`Agent 详情 ${selectedId.slice(0, 8)}`}>
          {detailQuery.isPending ? <p className="mutation-hint">正在加载详情…</p> : null}
          {detailQuery.isError ? <ErrorBanner error={detailQuery.error} /> : null}
          {detailQuery.isSuccess ? (
            <AgentDetailViewer
              key={detailQuery.data.id}
              agent={detailQuery.data}
              canManage={canManage}
            />
          ) : null}
        </section>
      ) : null}
    </section>
  )
}

function AgentDetailViewer({
  agent,
  canManage,
}: {
  agent: AgentDetailView
  canManage: boolean
}): ReactNode {
  const [showRevisionForm, setShowRevisionForm] = useState(false)
  const current = agent.currentRevision
  return (
    <>
      <h3>{agent.name}</h3>
      <p>{agent.description !== '' ? agent.description : '无描述'}</p>
      {current !== null ? (
        <dl className="revision-meta">
          <div>
            <dt>当前 Revision</dt>
            <dd>
              #{current.revision} · {current.model}
            </dd>
          </div>
          <div>
            <dt>Provider</dt>
            <dd>{current.provider}</dd>
          </div>
          <div>
            <dt>Credential Slot</dt>
            <dd>{current.credentialSlot}</dd>
          </div>
          <div>
            <dt>Max Tokens</dt>
            <dd>{current.maxTokens !== null ? String(current.maxTokens) : '默认'}</dd>
          </div>
          <div>
            <dt>Plugin Pack</dt>
            <dd>{shortId(current.pluginPackId)}</dd>
          </div>
          <div>
            <dt>Persona</dt>
            <dd className="persona">{current.persona}</dd>
          </div>
        </dl>
      ) : (
        <p className="empty-state">该 Agent 尚无 Revision。</p>
      )}
      {agent.revisions.length > 1 ? (
        <details className="revision-history">
          <summary>全部 Revision（{agent.revisions.length}）</summary>
          <ul role="list">
            {agent.revisions.map((revision) => (
              <li key={revision.id}>
                #{revision.revision} · {revision.model} · <RelativeTime iso={revision.createdAt} />
              </li>
            ))}
          </ul>
        </details>
      ) : null}
      {canManage ? (
        <div className="agent-revision-actions">
          {showRevisionForm ? (
            <>
              <CreateAgentRevisionForm agent={agent} />
              <button
                type="button"
                className="button button-quiet"
                onClick={() => setShowRevisionForm(false)}
              >
                收起
              </button>
            </>
          ) : (
            <button type="button" className="button" onClick={() => setShowRevisionForm(true)}>
              新建 Revision
            </button>
          )}
        </div>
      ) : null}
    </>
  )
}
