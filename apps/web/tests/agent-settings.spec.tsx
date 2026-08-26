/**
 * Agent 管理（02 Task 7 Step 5）：
 * - Owner/Admin 可见创建表单并成功创建（校验请求体与幂等头，成功后表单复位）；
 * - Member 只读：看不到创建表单，只显示说明；
 * - Plugin Pack 选择降级为手工 UUID（P1-17 缺口），非法 UUID 被表单校验拦截；
 * - 列表 → 详情（当前 Revision）可选展示。
 */
import { screen, waitFor } from '@testing-library/react'
import { userEvent } from '@testing-library/user-event'
import { describe, expect, it } from 'vitest'
import { ALICE, BOB, agentsHandler, initOf, loggedInHandlers, ok } from './fixtures.js'
import type { MockHandler } from './fixtures.js'
import { renderApp } from './render.jsx'

const builderAgent = {
  id: 'f0000000-0000-4000-8000-000000000001',
  name: 'Builder',
  description: '实现任务的构建者',
  createdBy: ALICE.userId,
  archivedAt: null,
  currentRevisionId: 'f0000000-0000-4000-8000-000000000010',
}

const revision = {
  id: 'f0000000-0000-4000-8000-000000000010',
  agentId: builderAgent.id,
  revision: 1,
  persona: 'You are a careful builder.',
  provider: 'deepseek',
  model: 'deepseek-chat',
  credentialSlot: 'default',
  maxTokens: null,
  pluginPackId: 'eeeeeeee-0000-4000-8000-000000000001',
  profileDigest: 'a'.repeat(64),
  createdBy: ALICE.userId,
  createdAt: '2026-08-25T00:00:00.000Z',
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
    renderApp('/agents', loggedInHandlers(ALICE, [agentsHandler([builderAgent])]))
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
    await user.type(
      screen.getByLabelText('Plugin Pack UUID'),
      'eeeeeeee-0000-4000-8000-000000000001',
    )
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
    renderApp('/agents', loggedInHandlers(BOB, [agentsHandler([builderAgent])]))
    expect(await screen.findByRole('button', { name: /Builder/ })).toBeVisible()
    expect(screen.queryByRole('button', { name: '创建 Agent' })).not.toBeInTheDocument()
    expect(screen.getByText(/Agent 只读/)).toBeVisible()
  })

  it('Plugin Pack 手工 UUID：说明可见，非法 UUID 被表单校验拦截', async () => {
    const user = userEvent.setup()
    renderApp('/agents', loggedInHandlers(ALICE, [agentsHandler([])]))
    expect(await screen.findByText(/Pack 目录随 P1-17 提供/)).toBeVisible()
    const packInput = screen.getByLabelText('Plugin Pack UUID')
    await user.type(packInput, 'not-a-uuid')
    expect(packInput).toBeInvalid()
    // 校验通过后恢复有效
    await user.clear(packInput)
    await user.type(packInput, 'eeeeeeee-0000-4000-8000-000000000001')
    expect(packInput).toBeValid()
  })

  it('点击 Agent 卡片查看详情（当前 Revision）', async () => {
    const user = userEvent.setup()
    renderApp(
      '/agents',
      loggedInHandlers(ALICE, [agentsHandler([builderAgent]), agentDetailHandler()]),
    )
    await user.click(await screen.findByRole('button', { name: /Builder/ }))
    expect(await screen.findByText('#1 · deepseek-chat')).toBeVisible()
    // 详情 <dt> 与表单 <label> 同名文案，两个都在页面上（表单 + 详情）
    expect(screen.getAllByText('Credential Slot')).toHaveLength(2)
    expect(screen.getAllByText('Persona')).toHaveLength(2)
  })

  it('空列表展示下一步引导空态', async () => {
    renderApp('/agents', loggedInHandlers(ALICE, [agentsHandler([])]))
    expect(await screen.findByText(/还没有 Agent。/)).toBeVisible()
  })
})
