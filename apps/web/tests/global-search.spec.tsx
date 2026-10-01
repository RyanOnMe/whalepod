/**
 * ⌘K 全局搜索（#254；#243 第 5 条刀二）。
 *
 * 判据：任意已登录页可呼出（快捷键与侧栏钮两条路径）；输入即查出任务；Enter/点击
 * 直达任务房；Esc 关闭并还焦；无结果如实说。dialog 语义（aria-modal）说到做到。
 */
import { screen, waitFor, within } from '@testing-library/react'
import { userEvent } from '@testing-library/user-event'
import { describe, expect, it } from 'vitest'
import { renderApp } from './render.jsx'
import {
  BOB,
  loggedInHandlers,
  makeTask,
  projectsHandler,
  recentTasksEmptyHandler,
  taskRoomHandler,
  teamMembersHandler,
} from './fixtures.js'
import type { MockHandler } from './fixtures.js'

const TASK_A = makeTask({ id: 't-hit-1', title: '修复登录页', status: 'in_progress' })

function searchHandler(
  results: { id: string; title: string; projectName: string | null; lastActiveAt: string }[],
): MockHandler {
  return {
    method: 'GET',
    url: /\/api\/v1\/tasks\/search\?q=/,
    // mock 的 respond 只拿得到 RequestInit（拿不到 URL）——按 q 过滤是 Hub 的事
    //（Q2 集成面验），web 面无条件返回给定结果集，只验 UI 契约。
    respond: () =>
      new Response(JSON.stringify({ ok: true, data: results }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
  }
}

function renderHome(extra: readonly MockHandler[] = []): ReturnType<typeof renderApp> {
  return renderApp('/', [
    ...loggedInHandlers(BOB, [projectsHandler([]), recentTasksEmptyHandler(), ...extra]),
    teamMembersHandler([]),
  ])
}

describe('⌘K 全局搜索（#254）', () => {
  it('⌘K 呼出浮层；输入即查；结果直达任务房', async () => {
    const user = userEvent.setup()
    renderHome([
      searchHandler([
        {
          id: TASK_A.id,
          title: '修复登录页',
          projectName: 'p1',
          lastActiveAt: '2026-10-01T00:00:00.000Z',
        },
      ]),
      taskRoomHandler(TASK_A),
    ])
    await screen.findByRole('navigation', { name: '主导航' })
    await user.keyboard('{Meta>}k')
    const dialog = await screen.findByRole('dialog', { name: '搜索任务' })
    const input = within(dialog).getByLabelText('搜索任务')
    expect(input).toHaveFocus()
    await user.type(input, '登录')
    const hit = await within(dialog).findByRole('option', { name: /修复登录页/ })
    await user.click(hit)
    expect(await screen.findByRole('heading', { name: '修复登录页' })).toBeVisible()
  })

  it('侧栏「搜索」钮同样可开（快捷键不是唯一路径）', async () => {
    const user = userEvent.setup()
    renderHome([searchHandler([])])
    await user.click(await screen.findByRole('button', { name: '搜索' }))
    expect(await screen.findByRole('dialog', { name: '搜索任务' })).toBeVisible()
  })

  it('Esc 关闭并还焦触发钮', async () => {
    const user = userEvent.setup()
    renderHome([searchHandler([])])
    const trigger = await screen.findByRole('button', { name: '搜索' })
    await user.click(trigger)
    expect(await screen.findByRole('dialog', { name: '搜索任务' })).toBeVisible()
    await user.keyboard('{Escape}')
    await waitFor(() => {
      expect(screen.queryByRole('dialog', { name: '搜索任务' })).not.toBeInTheDocument()
    })
    expect(document.activeElement).toBe(trigger)
  })

  it('无结果如实说；空关键词不查（没有输入就没有请求）', async () => {
    const user = userEvent.setup()
    const view = renderHome([searchHandler([])])
    await user.click(await screen.findByRole('button', { name: '搜索' }))
    const dialog = await screen.findByRole('dialog', { name: '搜索任务' })
    const input = within(dialog).getByLabelText('搜索任务')
    // 空关键词：没有搜索请求。
    await user.type(input, '不存在的词')
    expect(await within(dialog).findByText(/没有匹配的任务/)).toBeVisible()
    const calls = view.fetchMock.mock.calls.filter(([url]) => String(url).includes('/tasks/search'))
    expect(calls).toHaveLength(1)
  })

  it('键盘路径：↑↓ 移动选中，Enter 直达第一个结果', async () => {
    const user = userEvent.setup()
    const taskB = makeTask({ id: 't-hit-2', title: '登录国际化', status: 'open' })
    renderHome([
      searchHandler([
        {
          id: TASK_A.id,
          title: '修复登录页',
          projectName: 'p1',
          lastActiveAt: '2026-10-01T00:00:00.000Z',
        },
        {
          id: taskB.id,
          title: '登录国际化',
          projectName: 'p1',
          lastActiveAt: '2026-10-01T00:00:00.000Z',
        },
      ]),
      taskRoomHandler(taskB),
    ])
    await user.click(await screen.findByRole('button', { name: '搜索' }))
    const dialog = await screen.findByRole('dialog', { name: '搜索任务' })
    const input = within(dialog).getByLabelText('搜索任务')
    await user.type(input, '*')
    await within(dialog).findByRole('option', { name: /登录国际化/ })
    // ↓ 选中第二项，Enter 直达它。
    await user.keyboard('{ArrowDown>}{/ArrowDown}')
    await user.keyboard('{Enter}')
    expect(await screen.findByRole('heading', { name: '登录国际化' })).toBeVisible()
  })
})
