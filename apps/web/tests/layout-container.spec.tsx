/**
 * #152 布局与响应式一致（Web 面结构断言）。
 *
 * 判据只看**结构**，不看像素：内容容器 / 两栏栅格 / 折叠表单 / 折叠导航都必须在
 * DOM 里可判定，否则「宽屏不留半屏空白」「390px 顶栏单行」这类事只能靠肉眼看截图。
 * 具体断点与像素宽度由 e2e（apps/web/tests/e2e/*.spec.ts，真浏览器 + setViewportSize）
 * 判定，本 spec 负责任务里那类脆的东西不会被悄悄改回去：
 * - 设备页 / 成员页各自是「主列 + 侧列」两栏（.page-grid > .page-col × 2），且左右
 *   内容归属正确（设备列表在左、CLI 说明在右；成员名单在左、邀请面板在右）；
 * - 项目页「新建项目」是折叠入口，aria-expanded 与「创建任务」同款语义；
 * - 顶栏导航收在同一个 <details> 折叠入口里（宽屏由 CSS 展开，不复制第二份链接）。
 */
import { screen, within } from '@testing-library/react'
import { userEvent } from '@testing-library/user-event'
import { describe, expect, it } from 'vitest'
import type { ProjectView } from '../src/shared/api/types.js'
import type { PluginPackView } from '@whalepod/protocol'
import {
  ALICE,
  agentsHandler,
  devicesHandler,
  loggedInHandlers,
  makeDevice,
  ok,
  packsHandler,
  projectsHandler,
  teamMembersHandler,
} from './fixtures.js'
import type { MockHandler } from './fixtures.js'
import type { AgentView, ProfileRevisionView } from '../src/shared/api/types.js'
import { renderApp } from './render.jsx'

// #167 Agents 页两栏断言用：一个 Agent + 它的当前 Revision + 一个 Pack（Pack 下拉数据源）。
const BUILDER_AGENT: AgentView = {
  id: 'f0000000-0000-4000-8000-000000000001',
  name: 'Builder',
  description: '实现任务的构建者',
  createdBy: ALICE.userId,
  archivedAt: null,
  currentRevisionId: 'f0000000-0000-4000-8000-000000000010',
}

const BUILDER_REVISION: ProfileRevisionView = {
  id: 'f0000000-0000-4000-8000-000000000010',
  agentId: BUILDER_AGENT.id,
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

const CORE_PACK: PluginPackView = {
  id: 'eeeeeeee-0000-4000-8000-000000000001',
  name: 'core-empty',
  packDigest: 'f'.repeat(64),
  installations: [],
  entries: [],
  createdBy: ALICE.userId,
  createdAt: '2026-08-22T09:00:00.000Z',
}

function agentDetailHandler(): MockHandler {
  return {
    method: 'GET',
    url: new RegExp(`/api/v1/agents/${BUILDER_AGENT.id}$`),
    respond: () =>
      ok({ ...BUILDER_AGENT, currentRevision: BUILDER_REVISION, revisions: [BUILDER_REVISION] }),
  }
}

const PROJECT: ProjectView = {
  id: '11111111-0000-4000-8000-000000000001',
  name: '潮汐观测站',
  description: '',
  createdBy: ALICE.userId,
  archivedAt: null,
  createdAt: '2026-08-24T00:00:00.000Z',
  updatedAt: '2026-08-24T00:00:00.000Z',
}

/** 取出页面里的两栏栅格，并断言它确实是「恰好两列」。 */
function twoColumnGrid(container: HTMLElement): [HTMLElement, HTMLElement] {
  const grid = container.querySelector('.page-grid')
  expect(grid).not.toBeNull()
  const columns = [...(grid?.children ?? [])].filter((child) =>
    child.classList.contains('page-col'),
  ) as HTMLElement[]
  expect(columns).toHaveLength(2)
  return [columns[0] as HTMLElement, columns[1] as HTMLElement]
}

describe('#152 布局：内容容器与两栏栅格', () => {
  it('设备页：主列 = 配对码 + 已配对设备，侧列 = CLI 安装与配对', async () => {
    const { container } = renderApp(
      '/devices',
      loggedInHandlers(ALICE, [
        devicesHandler([makeDevice({ name: 'mac-mini' })]),
        teamMembersHandler(),
      ]),
    )
    await screen.findByRole('heading', { name: '已配对设备' })

    const [main, aside] = twoColumnGrid(container)
    // 主列：配对码签发 + 设备骨架都在同一列里
    expect(within(main).getByRole('heading', { name: '配对码' })).toBeVisible()
    expect(within(main).getByRole('heading', { name: '已配对设备' })).toBeVisible()
    expect(await within(main).findByText('mac-mini')).toBeVisible()
    // 侧列：CLI 说明与主列同级并排，不再压在设备列表下面
    expect(within(aside).getByRole('heading', { name: 'CLI 安装与配对' })).toBeVisible()
    expect(within(main).queryByRole('heading', { name: 'CLI 安装与配对' })).not.toBeInTheDocument()
  })

  it('CLI 命令文本逐字不变：分段换行不能把空白混进命令（复制语义）', async () => {
    // 配对命令在窄栏里必须换行（#152），因此拆成了显式字符串表达式 + nowrap token。
    // JSX 缩进一旦混进文本，真人复制到终端就是一条跑不通的命令。
    const { container } = renderApp('/devices', loggedInHandlers(ALICE, [devicesHandler([])]))
    await screen.findByRole('heading', { name: 'CLI 安装与配对' })
    const commands = [...container.querySelectorAll('.cli-steps pre code')].map(
      (element) => element.textContent,
    )
    expect(commands).toEqual([
      'npm install -g whalepod-node',
      'whalepod-node pair --hub <hub-url> --code <code>',
      'whalepod-node start',
    ])
  })

  it('成员页：主列 = 团队成员名单，侧列 = 邀请面板', async () => {
    const { container } = renderApp('/members', loggedInHandlers(ALICE, [teamMembersHandler()]))
    await screen.findByRole('heading', { name: '团队成员' })

    const [main, aside] = twoColumnGrid(container)
    expect(within(main).getByRole('heading', { name: '团队成员' })).toBeVisible()
    expect(await within(main).findByText('Alice')).toBeVisible()
    // Owner 能邀请：邀请面板在侧列（Member 视角只读的文案不在本用例范围）
    expect(within(aside).getByRole('heading', { name: '邀请成员' })).toBeVisible()
    expect(within(aside).getByRole('button', { name: '生成邀请链接' })).toBeVisible()
  })

  it('#167 Agents 页：左列 = 列表与 Revision 说明，右列 = 新建表单与选中详情', async () => {
    const user = userEvent.setup()
    const { container } = renderApp(
      '/agents',
      loggedInHandlers(ALICE, [
        agentsHandler([BUILDER_AGENT]),
        agentDetailHandler(),
        packsHandler([CORE_PACK]),
      ]),
    )
    // 点开一张 Agent 卡：详情是懒渲染的（enabled: selectedId !== null），
    // 不点卡片就没有 .agent-detail 可判。
    await user.click(await screen.findByRole('button', { name: /Builder/ }))
    expect(await screen.findByText('#1 · deepseek-chat')).toBeVisible()

    // 收口前（#167 之前）这里只有一个 flex 列：1120px 容器里表单只占左半、右半空着。
    const [main, aside] = twoColumnGrid(container)
    // 左列 = 入口（列表）+ 常驻说明；右列 = 表单 + 详情
    expect(within(main).getByRole('button', { name: /Builder/ })).toBeVisible()
    expect(within(main).getByRole('heading', { name: 'Revision 是什么' })).toBeVisible()
    // 表单标题是 h3（h1 已被页面标题占用、说明是 h2）——层级 h1 → h2 → h3 不断档
    expect(within(aside).getByRole('heading', { level: 3, name: '新建 Agent' })).toBeVisible()
    expect(within(aside).getByRole('region', { name: /Agent 详情/ })).toBeVisible()
    // 归属不许含糊：详情不得留在列表列，说明也不许跑到表单列（窄屏整列上移的正是表单列）
    expect(within(main).queryByRole('region', { name: /Agent 详情/ })).not.toBeInTheDocument()
    expect(
      within(aside).queryByRole('heading', { name: 'Revision 是什么' }),
    ).not.toBeInTheDocument()

    // #167 删掉的那条重复标题：页面标题的 id 由 AgentList 的区域名引用，
    // 屏上只有「Agents」一个标题，不再有紧随其后的同义 h2。
    const heading = screen.getByRole('heading', { level: 1, name: 'Agents' })
    expect(heading).toHaveAttribute('id', 'agents-page-heading')
    // 层级 h1 → h2（侧列说明）→ h3（新建表单 / 详情里的 Agent 名）不断档，
    // 且**只有一个 h2**：被删掉的重复标题原来正是第二个 h2。
    expect(container.querySelectorAll('h2')).toHaveLength(1)
    expect(container.querySelectorAll('h3')).toHaveLength(2)

    // 单列顺序 = DOM 顺序（列表/说明 → 表单 → 详情），窄屏不需要 order 补救：
    // 详情是「点出来的补充」，排在表单之后；曾经靠 :has() 把它提到表单之前，那条规则
    // 已删（宽屏两栏列归属只由 DOM 决定，两处顺序天然一致）。
    const grid = container.querySelector('.page-grid')
    expect(aside.parentElement).toBe(grid)
    expect(aside.querySelector(':scope > .agent-detail')).not.toBeNull()
    // 表单在详情之前（DOM 顺序即窄屏阅读顺序）
    const asideChildren = [...(aside.children as unknown as HTMLElement[])].map(
      (el) => el.className,
    )
    expect(asideChildren.indexOf('card agent-detail')).toBeGreaterThan(
      asideChildren.findIndex((name) => name.includes('agent-form')),
    )
    // 常驻说明住在列表列，不在表单列
    expect(main.querySelector(':scope > [aria-labelledby="agents-about-heading"]')).not.toBeNull()
    expect(aside.querySelector(':scope > [aria-labelledby="agents-about-heading"]')).toBeNull()
  })
})

describe('#152 布局：项目页折叠表单与顶栏折叠入口', () => {
  it('「新建项目」默认收起（aria-expanded=false 且无表单），点开后才出现表单', async () => {
    const user = userEvent.setup()
    renderApp('/', loggedInHandlers(ALICE, [projectsHandler([PROJECT]), teamMembersHandler()]))
    await screen.findByRole('heading', { name: '潮汐观测站' })

    const toggle = screen.getByRole('button', { name: '新建项目' })
    expect(toggle).toHaveAttribute('aria-expanded', 'false')
    // 首屏直接被项目列表占住：表单不在 DOM 里，列表在（与「创建任务」同款折叠语义）
    expect(screen.queryByLabelText('项目名称')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: '任务列表' })).toBeVisible()

    await user.click(toggle)
    expect(screen.getByRole('button', { name: '收起' })).toHaveAttribute('aria-expanded', 'true')
    expect(await screen.findByLabelText('项目名称')).toBeVisible()

    await user.click(screen.getByRole('button', { name: '收起' }))
    expect(screen.queryByLabelText('项目名称')).not.toBeInTheDocument()
  })

  it('顶栏导航收在单个折叠入口里（同一条链接，不复制第二份）', async () => {
    const { container } = renderApp('/', loggedInHandlers(ALICE, [projectsHandler([PROJECT])]))
    await screen.findByRole('heading', { name: '项目' })

    const menu = container.querySelector('details.app-nav-menu')
    expect(menu).not.toBeNull()
    // 折叠入口有可读名字，导航本身仍是 aria-label="主导航" 的那一个
    const summary = menu?.querySelector('summary.app-nav-toggle')
    expect(summary).toHaveAttribute('aria-label', '主导航菜单')
    const navs = container.querySelectorAll('nav[aria-label="主导航"]')
    expect(navs).toHaveLength(1)
    expect(navs[0]?.closest('details')).toBe(menu)
    expect(within(navs[0] as HTMLElement).getAllByRole('link')).toHaveLength(5)
  })
})
