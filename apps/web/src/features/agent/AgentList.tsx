/** Agent list, explicit creation and on-demand revision details. Fields remain mounted
 * while creation is collapsed; role and server mutation guards are unchanged. */
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useRef, useState, type ReactNode } from 'react'
import { usePresence } from '../../shared/usePresence.js'
import { SURFACE_EXIT_MS } from '../../shared/motion.js'
import { HelpDisclosure } from '../../shared/HelpDisclosure.js'
import { PageHeader } from '../../shared/PageHeader.js'
import {
  EmptyPanel,
  ChoiceCard,
  AdminDetailHeading,
  EnterItem,
} from '../../vendor/collectui/collectui.js'
import { WorkspaceIcon } from '../../shared/WorkspaceIcon.js'
import { api } from '../../shared/api/client.js'
import { ErrorBanner } from '../../app/ErrorBanner.js'
import { CREDENTIAL_SLOT_LABEL, ROLE_LABEL, shortId } from '../../shared/format.js'
import { RelativeTime } from '../../shared/RelativeTime.js'
import type { AgentDetailView, AgentView, Session } from '../../shared/api/types.js'
import { queryKeys } from '../../app/query-client.js'
import { useHashFocus } from '../../shared/useHashFocus.js'
import { AgentRevisionForm } from './AgentRevisionForm.js'
import { CreateAgentRevisionForm } from './CreateAgentRevisionForm.js'

export interface AgentListProps {
  session: Session | null
  /** 页面标题与列表区域共用的可访问名称。 */
  headingId?: string
}

export function AgentList({
  session,
  headingId = 'agents-page-heading',
}: AgentListProps): ReactNode {
  const cards = useRef(new Map<string, HTMLButtonElement>())
  const [creating, setCreating] = useState(false)
  const queryClient = useQueryClient()
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const detailPresence = usePresence(selectedId, SURFACE_EXIT_MS)
  const displayedId = selectedId ?? detailPresence.value
  const canManage = session !== null && (session.role === 'owner' || session.role === 'admin')

  const listQuery = useQuery({
    queryKey: queryKeys.agents,
    queryFn: () => api.get<AgentView[]>('/agents'),
  })
  // #263：⌘K 搜到 Agent 后落到 `/agents#agent-<id>`——列表落地后把目标卡片标出来。
  useHashFocus(listQuery.isSuccess)
  const detailQuery = useQuery({
    queryKey: queryKeys.agentDetail(displayedId ?? ''),
    queryFn: () => api.get<AgentDetailView>(`/agents/${displayedId ?? ''}`),
    enabled: selectedId !== null,
  })

  const onCreated = (): void => {
    setCreating(false)
    setSelectedId(null)
    void queryClient.invalidateQueries({ queryKey: queryKeys.agents })
  }

  return (
    <section className="agents-layout page-grid" aria-labelledby={headingId}>
      <PageHeader
        id={headingId}
        title="Agents"
        actions={
          canManage ? (
            <button
              className="button button-primary"
              type="button"
              aria-expanded={creating}
              onClick={() => setCreating((value) => !value)}
            >
              新建 Agent
            </button>
          ) : null
        }
      />
      {canManage ? (
        <div className="agent-create-panel" hidden={!creating}>
          <AgentRevisionForm embedded onCreated={onCreated} />
        </div>
      ) : null}

      <div className="page-col">
        {listQuery.isPending ? <p className="mutation-hint">正在加载 Agents…</p> : null}
        {listQuery.isError ? <ErrorBanner error={listQuery.error} /> : null}
        {listQuery.isSuccess && listQuery.data.length === 0 ? (
          <EmptyPanel
            title="暂无 Agent"
            description={
              canManage ? '创建第一个 Agent，开始分配任务。' : '请联系管理员添加 Agent。'
            }
            icon={<WorkspaceIcon name="Agents" />}
          />
        ) : null}
        {listQuery.isSuccess && listQuery.data.length > 0 ? (
          <ul className="agent-list" role="list">
            {listQuery.data.map((agent, index) => (
              <EnterItem key={agent.id} id={`agent-${agent.id}`} index={index}>
                <ChoiceCard
                  name={agent.name}
                  description={agent.description}
                  icon={<WorkspaceIcon name="Agents" />}
                  selected={agent.id === selectedId}
                  buttonRef={(node) => {
                    if (node === null) cards.current.delete(agent.id)
                    else cards.current.set(agent.id, node)
                  }}
                  onSelect={() => {
                    setCreating(false)
                    setSelectedId(agent.id === selectedId ? null : agent.id)
                  }}
                />
              </EnterItem>
            ))}
          </ul>
        ) : null}

        <HelpDisclosure label="配置版本说明">
          <p>
            每次执行都会固定 Agent
            的模型、角色与插件配置。修改配置会产生新版本，已有运行保持原配置。
          </p>
        </HelpDisclosure>
      </div>

      <div className="page-col">
        {!canManage ? (
          <p className="mutation-hint agent-readonly-hint">
            你是{session === null ? '访客' : ROLE_LABEL[session.role]}，Agent
            只读；仅所有者或管理员可创建或修改。
          </p>
        ) : null}

        {displayedId !== null ? (
          <section
            className="card agent-detail"
            data-closing={detailPresence.leaving ? '' : undefined}
            inert={selectedId === null}
            aria-hidden={selectedId === null}
            aria-label={`Agent 详情 ${listQuery.data?.find((agent) => agent.id === displayedId)?.name ?? '所选 Agent'}`}
          >
            <AdminDetailHeading
              title={
                listQuery.data?.find((agent) => agent.id === displayedId)?.name ?? 'Agent 详情'
              }
              icon={<WorkspaceIcon name="Agents" />}
              action={
                <button
                  type="button"
                  aria-label="关闭 Agent 详情"
                  onClick={() => {
                    const card = cards.current.get(displayedId)
                    setSelectedId(null)
                    card?.focus()
                  }}
                >
                  ×
                </button>
              }
            />
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
      </div>
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
      {agent.description ? <p>{agent.description}</p> : null}
      {current !== null ? (
        <>
          <div className="agent-current">
            <span>当前版本</span>
            <strong>
              #{current.revision} · {current.model}
            </strong>
          </div>
          <p className="agent-persona">{current.persona}</p>
          <HelpDisclosure label="配置详情">
            <dl className="revision-meta">
              <div>
                <dt>模型服务商（Provider）</dt>
                <dd>{current.provider}</dd>
              </div>
              <div>
                <dt>{CREDENTIAL_SLOT_LABEL}</dt>
                <dd>{current.credentialSlot}</dd>
              </div>
              <div>
                <dt>单次最多生成 Token 数（Max Tokens）</dt>
                <dd>{current.maxTokens !== null ? String(current.maxTokens) : '未限制'}</dd>
              </div>
              <div>
                <dt>插件组合（Plugin Pack）</dt>
                {/* Pack id 是 UUID：这里只给短码当线索，别名由插件页的 Pack 卡承担。 */}
                <dd>{shortId(current.pluginPackId)}</dd>
              </div>
            </dl>
          </HelpDisclosure>
        </>
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
