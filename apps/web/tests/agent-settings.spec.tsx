/**
 * Agent 管理（02 Task 7 Step 5 + P1-17 补口）：
 * - Owner/Admin 可见创建表单并成功创建（校验请求体与幂等头，成功后表单复位）；
 * - Member 只读：看不到创建表单/新建 Revision 入口，只显示说明；
 * - Plugin Pack 下拉：选项来自 GET /plugin-packs（数据源断言），未选禁用提交；
 *   空 Pack 列表提示先去插件管理创建；
 * - 已有 Agent「新建 Revision」：预填当前 Revision 值，POST
 *   /agents/:agentId/revisions 请求体与 CreateAgentRevisionRequest 对齐（幂等键），
 *   成功后详情刷新为新 Revision；
 * - 列表 → 详情（当前 Revision）可选展示。
 */
import { screen, waitFor, within } from '@testing-library/react'
import { userEvent } from '@testing-library/user-event'
import { describe, expect, it } from 'vitest'
import { CreateAgentRevisionRequestSchema } from '@whalepod/protocol'
import type { PluginPackView } from '@whalepod/protocol'
import {
  ALICE,
  BOB,
  agentsHandler,
  created,
  initOf,
  loggedInHandlers,
  ok,
  packsHandler,
} from './fixtures.js'
import type { MockHandler } from './fixtures.js'
import type { ProfileRevisionView } from '../src/shared/api/types.js'
import { renderApp } from './render.jsx'

const builderAgent = {
  id: 'f0000000-0000-4000-8000-000000000001',
  name: 'Builder',
  description: '实现任务的构建者',
  createdBy: ALICE.userId,
  archivedAt: null,
  currentRevisionId: 'f0000000-0000-4000-8000-000000000010',
}

const revision: ProfileRevisionView = {
  id: 'f0000000-0000-4000-8000-000000000010',
  agentId: builderAgent.id,
  revision: 1,
  persona: 'You are a careful builder.',
  provider: 'deepseek',
  model: 'deepseek-chat',
  credentialSlot: 'default',
  maxTokens: 8192,
  pluginPackId: 'eeeeeeee-0000-4000-8000-000000000001',
  profileDigest: 'a'.repeat(64),
  createdBy: ALICE.userId,
  createdAt: '2026-08-25T00:00:00.000Z',
}

/** Setup 创建的 core-empty Pack（与 revision.pluginPackId 对齐）。 */
const corePack: PluginPackView = {
  id: 'eeeeeeee-0000-4000-8000-000000000001',
  name: 'core-empty',
  packDigest: 'f'.repeat(64),
  installations: [],
  entries: [],
  createdBy: ALICE.userId,
  createdAt: '2026-08-22T09:00:00.000Z',
}

const reviewPack: PluginPackView = {
  ...corePack,
  id: 'dddddddd-0000-4000-8000-000000000001',
  name: 'review-pack',
}

function agentDetailHandler(): MockHandler {
  return {
    method: 'GET',
    url: new RegExp(`/api/v1/agents/${builderAgent.id}$`),
    respond: () => ok({ ...builderAgent, currentRevision: revision, revisions: [revision] }),
  }
}

describe('agent-settings', () => {
  it('Owner 看到创建表单与 Agent 列表', async () => {
    renderApp(
      '/agents',
      loggedInHandlers(ALICE, [agentsHandler([builderAgent]), packsHandler([corePack])]),
    )
    expect(await screen.findByRole('heading', { name: 'Agent 管理' })).toBeVisible()
    expect(screen.getByRole('button', { name: '创建 Agent' })).toBeVisible()
    expect(await screen.findByRole('button', { name: /Builder/ })).toBeVisible()
  })

  it('Owner 创建 Agent：请求体与幂等头正确，成功后表单复位', async () => {
    let list = [builderAgent]
    const user = userEvent.setup()
    const { fetchMock } = renderApp('/agents', [
      ...loggedInHandlers(ALICE, [
        { method: 'GET', url: /\/api\/v1\/agents$/, respond: () => ok(list) },
        {
          method: 'POST',
          url: /\/api\/v1\/agents$/,
          respond: () => {
            const createdAgent = {
              ...builderAgent,
              id: 'f0000000-0000-4000-8000-000000000002',
              name: 'Reviewer',
            }
            list = [...list, createdAgent]
            return { status: 201, body: { ok: true, data: createdAgent } }
          },
        },
        packsHandler([corePack]),
      ]),
    ])
    await screen.findByRole('button', { name: /Builder/ })
    await user.type(screen.getByLabelText('名称'), 'Reviewer')
    await user.type(screen.getByLabelText('Persona'), 'You are a careful reviewer.')
    // provider/model/credentialSlot 表单预填了默认值，先清空再输入（避免叠加）
    await user.clear(screen.getByLabelText('Provider'))
    await user.type(screen.getByLabelText('Provider'), 'deepseek')
    await user.clear(screen.getByLabelText('Model'))
    await user.type(screen.getByLabelText('Model'), 'deepseek-chat')
    await user.clear(screen.getByLabelText('Credential Slot'))
    await user.type(screen.getByLabelText('Credential Slot'), 'default')
    // Plugin Pack 从下拉选择（数据源 GET /plugin-packs）；未选时提交按钮禁用
    expect(screen.getByRole('button', { name: '创建 Agent' })).toBeDisabled()
    await user.selectOptions(screen.getByLabelText('Plugin Pack'), corePack.id)
    expect(screen.getByRole('button', { name: '创建 Agent' })).toBeEnabled()
    await user.click(screen.getByRole('button', { name: '创建 Agent' }))

    expect(await screen.findByRole('button', { name: /Reviewer/ })).toBeVisible()
    // 成功后表单复位
    await waitFor(() => {
      expect(screen.getByLabelText('名称')).toHaveValue('')
      expect(screen.getByLabelText('Persona')).toHaveValue('')
    })

    const createCall = fetchMock.mock.calls.find(([input, requestInit]) => {
      const initMethod = requestInit?.method ?? 'GET'
      return initMethod === 'POST' && String(input).endsWith('/agents')
    })
    expect(createCall).toBeDefined()
    const init = initOf(createCall as [RequestInfo | URL, RequestInit?])
    expect(new Headers(init.headers).get('idempotency-key')).toMatch(/^[0-9a-f-]{36}$/)
    expect(JSON.parse(String(init.body ?? ''))).toMatchObject({
      name: 'Reviewer',
      persona: 'You are a careful reviewer.',
      provider: 'deepseek',
      model: 'deepseek-chat',
      credentialSlot: 'default',
      pluginPackId: 'eeeeeeee-0000-4000-8000-000000000001',
    })
  })

  it('Member 只读：没有创建表单，只有说明', async () => {
    renderApp(
      '/agents',
      loggedInHandlers(BOB, [agentsHandler([builderAgent]), packsHandler([corePack])]),
    )
    expect(await screen.findByRole('button', { name: /Builder/ })).toBeVisible()
    expect(screen.queryByRole('button', { name: '创建 Agent' })).not.toBeInTheDocument()
    expect(screen.getByText(/Agent 只读/)).toBeVisible()
    // #152：角色名统一中文（此前这里直接印内部枚举值 `member` 与 `Owner/Admin`）
    expect(screen.getByText('你是成员，Agent 只读；仅所有者或管理员可创建或修改。')).toBeVisible()
  })

  it('Plugin Pack 下拉：选项来自 GET /plugin-packs，未选时提交禁用', async () => {
    const user = userEvent.setup()
    renderApp(
      '/agents',
      loggedInHandlers(ALICE, [
        agentsHandler([builderAgent]),
        packsHandler([corePack, reviewPack]),
      ]),
    )
    const select = (await screen.findByLabelText('Plugin Pack')) as HTMLSelectElement
    expect(select).toBeRequired()
    // 数据源断言：两个 Pack 均以下拉选项出现（不再是手工粘贴 UUID）
    expect(await screen.findByRole('option', { name: 'core-empty' })).toBeVisible()
    expect(screen.getByRole('option', { name: 'review-pack' })).toBeVisible()
    // 未选 Pack：提交禁用
    expect(screen.getByRole('button', { name: '创建 Agent' })).toBeDisabled()
    await user.selectOptions(select, reviewPack.id)
    expect(select).toHaveValue(reviewPack.id)
    expect(screen.getByRole('button', { name: '创建 Agent' })).toBeEnabled()
  })

  it('Plugin Pack 列表为空：无选项，提示先去插件管理创建', async () => {
    renderApp('/agents', loggedInHandlers(ALICE, [agentsHandler([]), packsHandler([])]))
    const select = (await screen.findByLabelText('Plugin Pack')) as HTMLSelectElement
    expect(select).toBeRequired()
    expect(screen.queryByRole('option', { name: 'core-empty' })).not.toBeInTheDocument()
    expect(await screen.findByText(/暂无可用 Pack/)).toBeVisible()
    expect(screen.getByRole('link', { name: '插件管理' })).toHaveAttribute('href', '/plugins')
    expect(screen.getByRole('button', { name: '创建 Agent' })).toBeDisabled()
  })

  it('点击 Agent 卡片查看详情（当前 Revision）', async () => {
    const user = userEvent.setup()
    renderApp(
      '/agents',
      loggedInHandlers(ALICE, [
        agentsHandler([builderAgent]),
        agentDetailHandler(),
        packsHandler([corePack]),
      ]),
    )
    await user.click(await screen.findByRole('button', { name: /Builder/ }))
    expect(await screen.findByText('#1 · deepseek-chat')).toBeVisible()
    // 详情 <dt> 与表单 <label> 同名文案，两个都在页面上（表单 + 详情）
    expect(screen.getAllByText('Credential Slot')).toHaveLength(2)
    expect(screen.getAllByText('Persona')).toHaveLength(2)
  })

  it('Owner 新建 Revision：预填当前 Revision，下拉换 Pack，载荷与幂等键正确，详情刷新', async () => {
    const user = userEvent.setup()
    // 可变详情：POST 成功后 refetch 返回新当前 Revision（与 production 的
    // invalidate + refetch 语义一致）
    let currentRevision = revision
    let allRevisions = [revision]
    const { fetchMock } = renderApp('/agents', [
      ...loggedInHandlers(ALICE, [
        agentsHandler([builderAgent]),
        packsHandler([corePack, reviewPack]),
        {
          method: 'GET',
          url: new RegExp(`/api/v1/agents/${builderAgent.id}$`),
          respond: () => ok({ ...builderAgent, currentRevision, revisions: allRevisions }),
        },
        {
          method: 'POST',
          url: new RegExp(`/api/v1/agents/${builderAgent.id}/revisions$`),
          respond: () => {
            const next: ProfileRevisionView = {
              ...revision,
              id: 'f0000000-0000-4000-8000-000000000020',
              revision: 2,
              pluginPackId: reviewPack.id,
              profileDigest: 'b'.repeat(64),
              createdAt: '2026-08-26T00:00:00.000Z',
            }
            currentRevision = next
            allRevisions = [...allRevisions, next]
            return created(next)
          },
        },
      ]),
    ])
    await user.click(await screen.findByRole('button', { name: /Builder/ }))
    const detail = screen.getByRole('region', { name: /Agent 详情/ })
    await user.click(within(detail).getByRole('button', { name: '新建 Revision' }))

    // 预填当前 Revision 值
    expect(within(detail).getByLabelText('Persona')).toHaveValue('You are a careful builder.')
    expect(within(detail).getByLabelText('Provider')).toHaveValue('deepseek')
    expect(within(detail).getByLabelText('Model')).toHaveValue('deepseek-chat')
    expect(within(detail).getByLabelText('Credential Slot')).toHaveValue('default')
    expect(within(detail).getByLabelText('Max Tokens（可选）')).toHaveValue(8192)
    // Pack 下拉：当前用的 core-empty 已预选，切到 review-pack（数据源 GET /plugin-packs）
    const packSelect = within(detail).getByLabelText('Plugin Pack') as HTMLSelectElement
    expect(packSelect).toHaveValue(corePack.id)
    await user.selectOptions(packSelect, reviewPack.id)
    // Max Tokens 清空 → 可选字段不出现在载荷
    await user.clear(within(detail).getByLabelText('Max Tokens（可选）'))
    await user.click(within(detail).getByRole('button', { name: '创建 Revision' }))

    expect(await within(detail).findByText(/Revision #2 已创建/)).toBeVisible()
    // 详情刷新：当前 Revision 变为 #2
    expect(await within(detail).findByText('#2 · deepseek-chat')).toBeVisible()

    const postCall = fetchMock.mock.calls.find(
      ([input, init]) =>
        (init?.method ?? 'GET') === 'POST' &&
        String(input).endsWith(`/agents/${builderAgent.id}/revisions`),
    ) as [RequestInfo | URL, RequestInit?] | undefined
    expect(postCall).toBeDefined()
    const init = initOf(postCall as [RequestInfo | URL, RequestInit?])
    expect(new Headers(init.headers).get('idempotency-key')).toMatch(/^[0-9a-f-]{36}$/)
    expect(CreateAgentRevisionRequestSchema.parse(JSON.parse(String(init.body ?? '')))).toEqual({
      persona: 'You are a careful builder.',
      provider: 'deepseek',
      model: 'deepseek-chat',
      credentialSlot: 'default',
      pluginPackId: reviewPack.id,
    })
  })

  it('Member 详情没有「新建 Revision」入口', async () => {
    const user = userEvent.setup()
    renderApp(
      '/agents',
      loggedInHandlers(BOB, [
        agentsHandler([builderAgent]),
        agentDetailHandler(),
        packsHandler([corePack]),
      ]),
    )
    await user.click(await screen.findByRole('button', { name: /Builder/ }))
    expect(await screen.findByText('#1 · deepseek-chat')).toBeVisible()
    expect(screen.queryByRole('button', { name: '新建 Revision' })).not.toBeInTheDocument()
  })

  it('新建 Revision 表单：无可用 Pack 时提交禁用并提示去插件管理', async () => {
    const user = userEvent.setup()
    // 尚无 Revision 的 Agent：表单走默认值，Pack 必选是提交门槛
    const freshAgent = {
      ...builderAgent,
      id: 'f0000000-0000-4000-8000-000000000003',
      name: 'Fresh',
      currentRevisionId: null,
    }
    const freshDetailHandler: MockHandler = {
      method: 'GET',
      url: new RegExp(`/api/v1/agents/${freshAgent.id}$`),
      respond: () => ok({ ...freshAgent, currentRevision: null, revisions: [] }),
    }
    renderApp(
      '/agents',
      loggedInHandlers(ALICE, [agentsHandler([freshAgent]), freshDetailHandler, packsHandler([])]),
    )
    await user.click(await screen.findByRole('button', { name: /Fresh/ }))
    const detail = screen.getByRole('region', { name: /Agent 详情/ })
    expect(await within(detail).findByText('该 Agent 尚无 Revision。')).toBeVisible()
    await user.click(within(detail).getByRole('button', { name: '新建 Revision' }))
    expect(within(detail).getByText(/暂无可用 Pack/)).toBeVisible()
    expect(within(detail).getByRole('button', { name: '创建 Revision' })).toBeDisabled()
  })

  it('空列表展示下一步引导空态', async () => {
    renderApp('/agents', loggedInHandlers(ALICE, [agentsHandler([]), packsHandler([corePack])]))
    expect(await screen.findByText(/还没有 Agent。/)).toBeVisible()
  })
})
