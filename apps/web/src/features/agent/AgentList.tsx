/**
 * Agent 管理（02 Task 7 Step 5）：列表 + 详情（当前 Revision + 历史）。
 * Owner/Admin 可新建 Agent（AgentRevisionForm），也可为已有 Agent 新建
 * Revision（CreateAgentRevisionForm，入口在详情页；03 §4
 * POST /agents/:agentId/revisions）；Member 只读（仅看列表与详情）。
 *
 * #167 三处改动：
 * - **去掉同义重复标题**：这里原来写着 `<h2>Agents</h2>`，而页面路由刚写过
 *   `<h1>Agent 管理</h1>`——同一屏两行意思一样的标题。现在本组件不出标题，改用
 *   `aria-labelledby` 指向页面 h1（默认 id 由 AgentsPage 渲染；可传
 *   `headingId` 覆盖，单测里独立渲染本组件时用）。
 * - **标签中文优先**：字段名一律「中文（English）」形态——`Persona`/`Provider`/
 *   `Model`/`Credential Slot`/`Max Tokens`/`Plugin Pack` 单看不知道是什么，而同屏的
 *   「名称 / 描述」是中文，一页两种语言。括号里保留 CONTEXT.md 的正式领域词，方便
 *   和协议字段、CLI 输出对上。文案常量在 shared/format.ts，与表单共用同一份。
 * - **排版收口到 page-grid 两栏**：宽屏（≥1024px）左列放列表与说明、右列放新建表单与
 *   选中 Agent 的详情；窄屏回落单列，且详情会提到表单之前（点开卡片要立刻看到内容）。
 *   此前 1120px 容器里表单只占左半、右半整片空着。
 */
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useState, type ReactNode } from 'react'
import { api } from '../../shared/api/client.js'
import { ErrorBanner } from '../../app/ErrorBanner.js'
import { CREDENTIAL_SLOT_LABEL, ROLE_LABEL, shortId } from '../../shared/format.js'
import { RelativeTime } from '../../shared/RelativeTime.js'
import type { AgentDetailView, AgentView, Session } from '../../shared/api/types.js'
import { queryKeys } from '../../app/query-client.js'
import { AgentRevisionForm } from './AgentRevisionForm.js'
import { CreateAgentRevisionForm } from './CreateAgentRevisionForm.js'

export interface AgentListProps {
  session: Session | null
  /** 页面 h1 的 id（区域名的唯一来源）；默认与被本组件引用的页面标题一致。 */
  headingId?: string
}

export function AgentList({
  session,
  headingId = 'agents-page-heading',
}: AgentListProps): ReactNode {
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
    <section className="agents-layout page-grid" aria-labelledby={headingId}>
      {/*
        两栏收口（#167）：左列「有哪些 Agent + 这一页在配什么」，右列「新建表单 + 选中
        Agent 的详情」。以前表单与列表同列、宽度只占 1120px 容器的一半（约 555px），
        右半整片空着。

        为什么列表在**左**：宽屏下左列 688px 是主列，列表是这一页的入口（点卡片看详情）。
        为什么表单在**右列最上面**：右列 368px 比两个并排输入框需要的还窄，表单放这里会
        被挤成一行一个；而窄屏单列的顺序（列表 → 表单 → 详情 → 说明卡）与宽屏一致，
        两种形态不用两套心智模型——详情卡在窄屏要提到表单之前的诱惑因此消失
        （见 global.css 里 :has() 那条的注释：详情是「点出来的补充」，排在新手路径之后）。
      */}
      <div className="page-col">
        {listQuery.isPending ? <p className="mutation-hint">正在加载 Agents…</p> : null}
        {listQuery.isError ? <ErrorBanner error={listQuery.error} /> : null}
        {listQuery.isSuccess && listQuery.data.length === 0 ? (
          <p className="empty-state">
            还没有 Agent
            {canManage ? '——用右栏的表单创建第一个' : ''}
            。创建后，Builder/Reviewer 会出现在这里。
          </p>
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

        {/*
          常驻说明：这一页在配什么。放在**列表列**而不是侧列，是因为窄屏单列时侧列会整列
          提到列表之前（详情要贴着卡片），若说明也住在侧列就会被顶到最上面——列表是这个
          页面的入口，不能被一张说明卡压住。

          这里**不**再抄一遍凭据槽的解释：表单该字段下已经有 CREDENTIAL_SLOT_HINT，
          同屏两份逐字相同的长解释只会互相稀释（#167 的目标是让人看懂，不是看两遍）。
        */}
        <section className="card" aria-labelledby="agents-about-heading">
          <h2 id="agents-about-heading">Revision 是什么</h2>
          <p className="field-hint">
            一个 Agent 是团队共用的长期 AI 角色。它每次运行（Run）用到的配置——人格、模型、
            插件组合——会被固化成一份不可变的 Profile Revision：改配置就是新建 Revision， 已经跑过的
            Run 不受影响。
          </p>
        </section>
      </div>

      <div className="page-col">
        {canManage ? (
          <AgentRevisionForm onCreated={onCreated} />
        ) : (
          <p className="mutation-hint">
            你是{session === null ? '访客' : ROLE_LABEL[session.role]}，Agent
            只读；仅所有者或管理员可创建或修改。
          </p>
        )}

        {selectedId !== null ? (
          <section
            className="card agent-detail"
            aria-label={`Agent 详情 ${selectedId.slice(0, 8)}`}
          >
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
          <div>
            <dt>人格设定（Persona）</dt>
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
