/**
 * 快捷键速查（#265；P1-UX 三期刀四）。
 *
 * 判据：
 * 1. `?` 打开面板，四条都是**已实现**的键（实现侧 SHORTCUTS 与既有 spec 的可按性
 *    判据一一对应：⌘K → global-search.spec；⌘↵ → comment.spec / instruction-composer.spec；
 *    Esc → global-search.spec / feedback-consistency.spec；? → 本文件）；
 * 2. 输入焦点里打 `?` 不触发（问号是正常输入）；
 * 3. Esc 关闭并还焦触发元素（#229/#254 的 dialog 口径）。
 */
import { screen, waitFor, within } from '@testing-library/react'
import { userEvent } from '@testing-library/user-event'
import { describe, expect, it } from 'vitest'
import { renderApp } from './render.jsx'
import {
  BOB,
  loggedInHandlers,
  projectsHandler,
  recentTasksEmptyHandler,
  teamMembersHandler,
} from './fixtures.js'

function renderHome(): ReturnType<typeof renderApp> {
  return renderApp('/', [
    ...loggedInHandlers(BOB, [projectsHandler([]), recentTasksEmptyHandler()]),
    teamMembersHandler([]),
  ])
}

describe('快捷键速查（#265）', () => {
  it('? 打开面板，列出已实现的快捷键（⌘K / ⌘↵ / Esc）', async () => {
    const user = userEvent.setup()
    renderHome()
    await screen.findByRole('navigation', { name: '主导航' })
    await user.keyboard('?')
    const dialog = await screen.findByRole('dialog', { name: '键盘快捷键' })
    expect(dialog).toHaveTextContent('⌘K')
    expect(dialog).toHaveTextContent('全局搜索')
    expect(dialog).toHaveTextContent('⌘↵')
    expect(dialog).toHaveTextContent('提交指令或留言')
    expect(dialog).toHaveTextContent('Esc')
    expect(dialog).toHaveTextContent('关闭浮层')
  })

  it('输入焦点里打 ? 不触发（问号是正常输入）', async () => {
    const user = userEvent.setup()
    renderHome()
    await user.click(await screen.findByRole('button', { name: '搜索' }))
    // 搜索框自动聚焦：用 role 取框（不绑可访问名，改名不影响本判据）。
    const input = await screen.findByRole('textbox')
    await user.keyboard('?')
    expect(input).toHaveValue('?')
    expect(screen.queryByRole('dialog', { name: '键盘快捷键' })).toBeNull()
    // 搜索浮层还开着（问号只是被输入进去了）。
    expect(screen.getByRole('dialog')).toBeVisible()
  })

  it('搜索浮层空态教一次快捷键（发现路径不只靠「记住 ?」）', async () => {
    const user = userEvent.setup()
    renderHome()
    await user.click(await screen.findByRole('button', { name: '搜索' }))
    const dialog = await screen.findByRole('dialog')
    expect(within(dialog).getByText(/⌘K/)).toBeVisible()
    expect(within(dialog).getByText(/快捷键/)).toBeVisible()
  })

  it('Esc 关闭面板并还焦触发元素', async () => {
    const user = userEvent.setup()
    renderHome()
    const trigger = await screen.findByRole('button', { name: '搜索' })
    trigger.focus()
    await user.keyboard('?')
    expect(await screen.findByRole('dialog', { name: '键盘快捷键' })).toBeVisible()
    await user.keyboard('{Escape}')
    await waitFor(() => {
      expect(screen.queryByRole('dialog', { name: '键盘快捷键' })).not.toBeInTheDocument()
    })
    expect(document.activeElement).toBe(trigger)
  })
})
