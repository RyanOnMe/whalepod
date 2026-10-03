/**
 * ⌘K 三类实体搜索（#263；P1-UX 三期刀三）。
 *
 * 判据：
 * 1. 一条输入搜三类：任务（服务端）+ 项目/Agent（本地过滤已有缓存）——三段齐出；
 * 2. 键盘跨段连续：↑↓ 在扁平序列里走（段头不可选），Enter 落到当前项；
 * 3. 落点可辨：项目 → 项目页 + 目标卡片高亮（`/#project-<id>`）；Agent → Agents 页 + 锚点；
 * 4. 诚实：段内无命中则该段不渲染；空关键词不发搜索请求；三段都空如实说没有。
 */
import { screen, waitFor, within } from '@testing-library/react'
import { userEvent } from '@testing-library/user-event'
import { describe, expect, it } from 'vitest'
import { renderApp } from './render.jsx'
import {
  BOB,
  agentsHandler,
  loggedInHandlers,
  makeTask,
  projectsHandler,
  recentTasksEmptyHandler,
  teamMembersHandler,
} from './fixtures.js'
import type { MockHandler } from './fixtures.js'
import type { AgentView, ProjectView } from '../src/shared/api/types.js'

const PROJECT: ProjectView = {
  id: '11111111-0000-4000-8000-000000000001',
  name: 'Login 服务',
  description: '',
  createdBy: BOB.userId,
  archivedAt: null,
  createdAt: '2026-08-24T00:00:00.000Z',
  updatedAt: '2026-08-24T00:00:00.000Z',
}

const AGENT: AgentView = {
  id: '22222222-0000-4000-8000-00000000000a',
  name: 'login-helper',
  description: '登录相关的活',
  createdBy: BOB.userId,
  archivedAt: null,
  currentRevisionId: null,
}

const TASK = makeTask({ id: 't-hit-1', title: '修复登录页', status: 'in_progress' })

/** 服务端任务搜索的桩：mock 的 respond 拿不到 URL（#254 的坑），无条件返回给定结果集。 */
function searchHandler(
  results: { id: string; title: string; projectName: string | null; lastActiveAt: string }[],
): MockHandler {
  return { method: 'GET', url: /\/api\/v1\/tasks\/search\?q=/, respond: () => okJson(results) }
}

function okJson(data: unknown): Response {
  return new Response(JSON.stringify({ ok: true, data }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })
}

function renderHome(extra: readonly MockHandler[]): ReturnType<typeof renderApp> {
  return renderApp('/', [
    ...loggedInHandlers(BOB, [projectsHandler([PROJECT]), agentsHandler([AGENT]), ...extra]),
    teamMembersHandler([]),
  ])
}

describe('⌘K 三类实体搜索（#263）', () => {
  it('三段齐出；↑↓ 跨段走到项目项；Enter 落到项目页并把目标卡片标出来', async () => {
    const user = userEvent.setup()
    renderHome([
      searchHandler([
        {
          id: TASK.id,
          title: '修复登录页',
          projectName: '登录服务',
          lastActiveAt: '2026-10-01T00:00:00.000Z',
        },
      ]),
    ])
    await screen.findByRole('navigation', { name: '主导航' })
    await user.keyboard('{Meta>}k')
    const dialog = await screen.findByRole('dialog', { name: '全局搜索' })
    await user.type(within(dialog).getByLabelText('搜索关键词'), 'login')
    // 三段齐出（段头是文字，不是可选项）；顺带验大小写不敏感（小写关键词命中 Login 服务）。
    expect(await within(dialog).findByText('任务')).toBeVisible()
    expect(within(dialog).getByText('项目')).toBeVisible()
    expect(within(dialog).getByText('Agent')).toBeVisible()
    // 扁平序列：任务 → 项目 → Agent；↓ 一次走到项目项，Enter 落到项目页。
    await user.keyboard('{ArrowDown}')
    await user.keyboard('{Enter}')
    await waitFor(() => {
      expect(screen.queryByRole('dialog', { name: '全局搜索' })).not.toBeInTheDocument()
    })
    const card = document.getElementById(`project-${PROJECT.id}`)
    expect(card).not.toBeNull()
    await waitFor(() => expect(card).toHaveClass('hash-focus'))
    expect(screen.getByRole('heading', { name: PROJECT.name })).toBeVisible()
  })

  it('Agent 落点：只剩 Agent 命中时 Enter 直达 Agents 页并锚点高亮', async () => {
    const user = userEvent.setup()
    renderHome([searchHandler([])])
    await screen.findByRole('navigation', { name: '主导航' })
    await user.click(screen.getByRole('button', { name: '搜索' }))
    const dialog = await screen.findByRole('dialog', { name: '全局搜索' })
    await user.type(within(dialog).getByLabelText('搜索关键词'), 'REPORT')
    // 大小写不敏感：小写的 login-helper 该被大写输入命中（清空后新输入）。
    await user.clear(within(dialog).getByLabelText('搜索关键词'))
    await user.type(within(dialog).getByLabelText('搜索关键词'), 'HELPER')
    const option = await within(dialog).findByRole('option', { name: /login-helper/ })
    expect(option).toBeVisible()
    await user.keyboard('{Enter}')
    const card = document.getElementById(`agent-${AGENT.id}`)
    expect(card).not.toBeNull()
    await waitFor(() => expect(card).toHaveClass('hash-focus'))
  })

  it('段内无命中不渲染该段段头；空关键词不发搜索请求；三段都空如实说没有', async () => {
    const user = userEvent.setup()
    const view = renderHome([searchHandler([])])
    await user.click(await screen.findByRole('button', { name: '搜索' }))
    const dialog = await screen.findByRole('dialog', { name: '全局搜索' })
    // 空关键词：不发搜索请求（本地列表取数不算「搜索」）。
    expect(
      view.fetchMock.mock.calls.filter(([url]) => String(url).includes('/tasks/search')),
    ).toHaveLength(0)
    await user.type(within(dialog).getByLabelText('搜索关键词'), '不存在的词')
    expect(await within(dialog).findByText(/没有匹配的任务、项目或 Agent/)).toBeVisible()
    // 三段都没有命中：连段头都不该出现（不画空段）。
    expect(within(dialog).queryByText('项目')).toBeNull()
    expect(within(dialog).queryByText('Agent')).toBeNull()

    // 只有项目命中时：只出现项目段（任务服务端桩返回空、Agent 名字不匹配）。
    await user.clear(within(dialog).getByLabelText('搜索关键词'))
    await user.type(within(dialog).getByLabelText('搜索关键词'), 'Login 服务')
    expect(await within(dialog).findByRole('option', { name: /Login 服务/ })).toBeVisible()
    expect(within(dialog).queryByText('Agent')).toBeNull()
    expect(within(dialog).queryByText('任务')).toBeNull()
  })

  it('本地列表读取失败时不替它说「没有」（如实标出缺口）', async () => {
    const user = userEvent.setup()
    const failing: MockHandler = {
      method: 'GET',
      url: /\/api\/v1\/agents$/,
      respond: () => new Response('boom', { status: 500 }),
    }
    renderApp('/', [
      ...loggedInHandlers(BOB, [
        projectsHandler([]),
        failing,
        recentTasksEmptyHandler(),
        searchHandler([]),
      ]),
      teamMembersHandler([]),
    ])
    await user.click(await screen.findByRole('button', { name: '搜索' }))
    const dialog = await screen.findByRole('dialog', { name: '全局搜索' })
    await user.type(within(dialog).getByLabelText('搜索关键词'), '任意')
    expect(await within(dialog).findByText(/项目\/Agent 列表读取失败/)).toBeVisible()
  })
})
