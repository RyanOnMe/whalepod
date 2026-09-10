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
import { openSelect, selectOption, selectTrigger } from './select-menu.js'

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
    // #167：页面标题只说一次。此前 h1「Agent 管理」+ 紧接着的 h2「Agents」是同义重复
    // （机器判据见 e2e 的 expectNoDuplicateHeadings），现在只留 h1，文案取主导航同一套。
    expect(await screen.findByRole('heading', { name: 'Agents', level: 1 })).toBeVisible()
    expect(screen.queryByRole('heading', { name: 'Agent 管理' })).not.toBeInTheDocument()
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
    await user.type(screen.getByLabelText('人格设定（Persona）'), 'You are a careful reviewer.')
    // provider/model/credentialSlot 表单预填了默认值，先清空再输入（避免叠加）
    await user.clear(screen.getByLabelText('模型服务商（Provider）'))
    await user.type(screen.getByLabelText('模型服务商（Provider）'), 'deepseek')
    await user.clear(screen.getByLabelText('模型（Model）'))
    await user.type(screen.getByLabelText('模型（Model）'), 'deepseek-chat')
    await user.clear(screen.getByLabelText('凭据槽（Credential Slot）'))
    await user.type(screen.getByLabelText('凭据槽（Credential Slot）'), 'default')
    // #167：Credential Slot 是内部概念，除标签外必须有一句「填什么」的解释。
    expect(screen.getByText(/设备所有者在本机给 API 密钥起的名字/)).toBeVisible()
    // Plugin Pack 从下拉选择（数据源 GET /plugin-packs）；未选时提交按钮禁用。
    // #158 × #167：控件是 vendored Menu（不是原生 select），走真人路径（点开 → 点选项）；
    // 标签文案由 PackSelect 的 label 渲染，已中文化为「插件组合（Plugin Pack）」。
    expect(screen.getByRole('button', { name: '创建 Agent' })).toBeDisabled()
    await selectOption(user, '插件组合（Plugin Pack）', 'core-empty')
    expect(await selectTrigger('插件组合（Plugin Pack）')).toHaveTextContent('core-empty')
    expect(screen.getByRole('button', { name: '创建 Agent' })).toBeEnabled()
    await user.click(screen.getByRole('button', { name: '创建 Agent' }))

    expect(await screen.findByRole('button', { name: /Reviewer/ })).toBeVisible()
    // 成功后表单复位
    await waitFor(() => {
      expect(screen.getByLabelText('名称')).toHaveValue('')
      expect(screen.getByLabelText('人格设定（Persona）')).toHaveValue('')
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
    const trigger = await screen.findByLabelText('插件组合（Plugin Pack）')
    // #158 反面钉：这一处**不再是原生 <select>**，而是 vendored Menu 的触发器按钮。
    expect(trigger.tagName).toBe('BUTTON')
    expect(trigger).toHaveAttribute('aria-haspopup', 'menu')
    expect(trigger).toHaveAttribute('aria-expanded', 'false')
    // 数据源断言：两个 Pack 都作为菜单项出现（不再是手工粘贴 UUID）
    const list = await openSelect(user, '插件组合（Plugin Pack）')
    expect(list.getByRole('menuitem', { name: 'core-empty' })).toBeVisible()
    // 打开后 aria-expanded 如实变 true（与 #152 折叠入口同一套语义）
    expect(trigger).toHaveAttribute('aria-expanded', 'true')
    // 未选 Pack：提交禁用
    expect(screen.getByRole('button', { name: '创建 Agent' })).toBeDisabled()
    await user.click(list.getByRole('menuitem', { name: 'review-pack' }))
    expect(screen.queryByRole('menu')).not.toBeInTheDocument()
    expect(trigger).toHaveTextContent('review-pack')
    expect(trigger).toHaveAttribute('aria-expanded', 'false')
    expect(screen.getByRole('button', { name: '创建 Agent' })).toBeEnabled()
  })

  it('Plugin Pack 列表为空：无选项，提示先去插件管理创建', async () => {
    renderApp('/agents', loggedInHandlers(ALICE, [agentsHandler([]), packsHandler([])]))
    const trigger = await screen.findByLabelText('插件组合（Plugin Pack）')
    // 异步查询而不是同步断言：列表查询落地前控件先以「正在加载 Packs…」占位（实测踩过）
    await within(trigger).findByText('没有可选 Pack')
    // 说明文字只有一条（不做两句重复的提示）
    // 没有可选项时触发器禁用（原生 select 无可用 option 时的等价呈现，不伪造可点入口）
    expect(trigger).toBeDisabled()
    // 空态提示是「一句话 + 链接」两段文本，按链接定位（整段文本会被元素切开，正则匹配不到）
    expect(await screen.findByRole('link', { name: '插件管理' })).toBeVisible()
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
    // #167：表单 <label> 与详情 <dt> 现在共用 shared/format.ts 的同一份文案常量
    // （不是两处各写一遍恰好同字），同屏两处都该是「中文（English）」形态。
    expect(screen.getAllByText('凭据槽（Credential Slot）')).toHaveLength(2)
    expect(screen.getAllByText('人格设定（Persona）')).toHaveLength(2)
    // 详情不再出现裸英文标签（回归：截图上的 `Persona` / `Credential Slot` 两列）
    expect(screen.queryByText('Credential Slot')).not.toBeInTheDocument()
    expect(screen.queryByText('Persona')).not.toBeInTheDocument()
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
    expect(within(detail).getByLabelText('人格设定（Persona）')).toHaveValue(
      'You are a careful builder.',
    )
    expect(within(detail).getByLabelText('模型服务商（Provider）')).toHaveValue('deepseek')
    expect(within(detail).getByLabelText('模型（Model）')).toHaveValue('deepseek-chat')
    expect(within(detail).getByLabelText('凭据槽（Credential Slot）')).toHaveValue('default')
    expect(within(detail).getByLabelText('单次最多生成 Token 数（Max Tokens，可选）')).toHaveValue(
      8192,
    )
    // Pack 下拉：当前用的 core-empty 已预选，切到 review-pack（数据源 GET /plugin-packs）
    const packTrigger = within(detail).getByLabelText('插件组合（Plugin Pack）')
    expect(packTrigger).toHaveTextContent('core-empty') // 预选当前 Revision 用的 Pack
    await selectOption(user, '插件组合（Plugin Pack）', 'review-pack', within(detail))
    // Max Tokens 清空 → 可选字段不出现在载荷
    await user.clear(within(detail).getByLabelText('单次最多生成 Token 数（Max Tokens，可选）'))
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
    expect(within(detail).getByRole('link', { name: '插件管理' })).toBeVisible()
    expect(within(detail).getByRole('button', { name: '创建 Revision' })).toBeDisabled()
  })

  it('#167 侧列说明文案无多余空格（#169 排版门只看标点边界，渲染后的空格靠这条钉）', async () => {
    const { container } = renderApp(
      '/agents',
      loggedInHandlers(ALICE, [agentsHandler([builderAgent]), packsHandler([corePack])]),
    )
    const about = await screen.findByRole('heading', { name: 'Revision 是什么' })
    const paragraph = (about.parentElement as HTMLElement).querySelector('p.field-hint')
    // 逐字比对：`配置——人格` 之间不许有空格（初版 JSX 折行折叠出了一个）、
    // `Revision。改配置` 之间也不许有（同一个坑的另一半）。#169 的门按源码行判标点，
    // 判不到"折行发生在表达式之间"的情形，所以在这里按渲染结果钉一次。
    expect(paragraph?.textContent).toBe(
      '一个 Agent 是团队共用的长期 AI 角色。它每次运行（Run）用到的配置——人格、模型、' +
        '插件组合——会被固化成一份不可变的 Profile Revision。改配置就是新建 Revision，' +
        '已经跑过的 Run 不受影响。',
    )
    expect(container.textContent ?? '').not.toContain('配置 ——')
    expect(container.textContent ?? '').not.toContain('Revision。 改配置')
  })

  it('空列表展示下一步引导空态', async () => {
    renderApp('/agents', loggedInHandlers(ALICE, [agentsHandler([]), packsHandler([corePack])]))
    // #167：空态文案改成指路（「用右栏的表单创建第一个」），文案随 #167 的窄屏顺序
    // 调整过一次（详情/表单列在窄屏提到列表之前，空团队时表单在下面）。
    expect(await screen.findByText(/还没有 Agent/)).toBeVisible()
  })
})
