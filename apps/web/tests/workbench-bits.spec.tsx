import { screen, within } from '@testing-library/react'
import { userEvent } from '@testing-library/user-event'
import { describe, expect, it } from 'vitest'
import { renderApp } from './render.jsx'
import {
  ALICE,
  loggedInHandlers,
  projectsHandler,
  recentTasksEmptyHandler,
  teamMembersHandler,
} from './fixtures.js'

function home() {
  return renderApp('/', [
    ...loggedInHandlers(ALICE, [
      projectsHandler([]),
      recentTasksEmptyHandler(),
      {
        method: 'GET',
        url: /\/api\/v1\/tasks\/search\?q=/,
        respond: () => new Response(JSON.stringify({ ok: true, data: [] }), { status: 200 }),
      },
    ]),
    teamMembersHandler([]),
  ])
}

describe('P1-423 workbench interactions', () => {
  it('search has an explicit close action and restores the invoking focus', async () => {
    const user = userEvent.setup()
    home()
    const trigger = await screen.findByRole('button', { name: '搜索' })
    await user.click(trigger)
    const dialog = await screen.findByRole('dialog', { name: '全局搜索' })
    expect(within(dialog).getByLabelText('搜索关键词')).toHaveFocus()
    await user.click(within(dialog).getByRole('button', { name: '关闭搜索' }))
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(trigger).toHaveFocus()
  })

  it('no-result clear returns to the input without submitting a business mutation', async () => {
    const user = userEvent.setup()
    const view = home()
    await user.click(await screen.findByRole('button', { name: '搜索' }))
    const dialog = await screen.findByRole('dialog', { name: '全局搜索' })
    const input = within(dialog).getByLabelText('搜索关键词')
    await user.type(input, '不存在')
    await within(dialog).findByText(/没有匹配的任务/)
    await user.click(within(dialog).getByRole('button', { name: '清空搜索' }))
    expect(input).toHaveValue('')
    expect(input).toHaveFocus()
    expect(
      view.fetchMock.mock.calls.filter(([, options]) => options?.method === 'POST'),
    ).toHaveLength(0)
  })

  it('first-project empty state opens the existing form without creating anything', async () => {
    const user = userEvent.setup()
    const view = home()
    await user.click(await screen.findByRole('button', { name: '创建项目', exact: true }))
    expect(await screen.findByLabelText('项目名称')).toBeVisible()
    expect(
      view.fetchMock.mock.calls.filter(([, options]) => options?.method === 'POST'),
    ).toHaveLength(0)
  })
})
