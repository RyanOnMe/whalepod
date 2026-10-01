/**
 * 侧栏「最近任务」（#252；#243 第 5 条刀一）。
 *
 * 判据：登录后 ≤1 击回到最近活跃任务——侧栏条目存在、可点、点了进任务房；
 * 空态/错误态不装死；错误不遮挡主导航。
 */
import { screen, waitFor } from '@testing-library/react'
import { userEvent } from '@testing-library/user-event'
import { describe, expect, it } from 'vitest'
import { renderApp } from './render.jsx'
import {
  BOB,
  loggedInHandlers,
  makeTask,
  projectsHandler,
  taskRoomHandler,
  teamMembersHandler,
} from './fixtures.js'
import type { MockHandler, RecentTaskView } from './fixtures.js'

function recentItem(over: Partial<RecentTaskView> = {}): RecentTaskView {
  return {
    id: 't-recent-1',
    projectId: 'p-1',
    projectName: 'proj-one',
    title: '修登录页',
    status: 'in_progress',
    lastActiveAt: '2026-10-01T02:00:00.000Z',
    ...over,
  }
}

function recentHandler(items: RecentTaskView[], status = 200): MockHandler {
  return {
    method: 'GET',
    url: /\/api\/v1\/tasks\/recent$/,
    respond: () =>
      status === 200
        ? new Response(JSON.stringify({ ok: true, data: items }), {
            status,
            headers: { 'content-type': 'application/json' },
          })
        : new Response(
            JSON.stringify({
              ok: false,
              error: { code: 'INTERNAL_ERROR', message: '读取失败', requestId: 'req-9' },
            }),
            { status, headers: { 'content-type': 'application/json' } },
          ),
  }
}

describe('侧栏最近任务（#252）', () => {
  it('条目渲染（标题+状态中文+项目名），点击直达任务房', async () => {
    const user = userEvent.setup()
    const task = makeTask({ id: 't-recent-1', title: '修登录页', status: 'in_progress' })
    renderApp('/', [
      ...loggedInHandlers(BOB, [
        projectsHandler([]),
        recentHandler([recentItem()]),
        taskRoomHandler(task),
      ]),
      teamMembersHandler([]),
    ])
    // 先等数据落地（nav 本身首帧就渲染，body 要等 query 解析）。
    const link = await screen.findByRole('link', { name: /修登录页/ })
    const nav = screen.getByRole('navigation', { name: '最近任务' })
    // 标题与状态中文都在条目里（项目名辅助区分同名任务）。
    expect(nav.textContent).toContain('修登录页')
    expect(nav.textContent).toContain('进行中')
    expect(nav.textContent).toContain('proj-one')
    // ≤1 击回到现场：点条目 → 任务房。
    await user.click(link)
    expect(await screen.findByRole('heading', { name: '修登录页' })).toBeVisible()
  })

  it('空态：最近还没有任务（不装死也不编造）', async () => {
    renderApp('/', [
      ...loggedInHandlers(BOB, [projectsHandler([]), recentHandler([])]),
      teamMembersHandler([]),
    ])
    expect(await screen.findByText('最近还没有任务')).toBeVisible()
  })

  it('错误态：说读取失败可重试，且不遮挡主导航', async () => {
    const user = userEvent.setup()
    let calls = 0
    const failing: MockHandler = {
      method: 'GET',
      url: /\/api\/v1\/tasks\/recent$/,
      respond: () => {
        calls += 1
        return new Response(
          JSON.stringify({
            ok: false,
            error: { code: 'INTERNAL_ERROR', message: '读取失败', requestId: 'req-9' },
          }),
          { status: 500, headers: { 'content-type': 'application/json' } },
        )
      },
    }
    renderApp('/', [
      ...loggedInHandlers(BOB, [projectsHandler([]), failing]),
      teamMembersHandler([]),
    ])
    expect(await screen.findByText(/最近任务读取失败/)).toBeVisible()
    // 主导航不受影响。
    expect(screen.getByRole('navigation', { name: '主导航' })).toBeVisible()
    // 重试再打一次接口（重试是真实 refetch，不是刷新页面）。
    await user.click(screen.getByRole('button', { name: '重试' }))
    await waitFor(() => expect(calls).toBe(2))
  })
})
