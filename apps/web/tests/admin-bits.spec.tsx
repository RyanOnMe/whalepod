import { screen, within } from '@testing-library/react'
import { userEvent } from '@testing-library/user-event'
import { describe, expect, it } from 'vitest'
import {
  ALICE,
  agentsHandler,
  devicesHandler,
  loggedInHandlers,
  ok,
  packsHandler,
  teamMembersHandler,
} from './fixtures.js'
import { renderApp } from './render.js'

const agent = {
  id: 'f0000000-0000-4000-8000-000000000001',
  name: '产品助理',
  description: '整理团队交付',
  createdBy: ALICE.userId,
  archivedAt: null,
  currentRevisionId: null,
}

describe('P1-432 management page interactions', () => {
  it('invitation opens explicitly, keeps role through collapse and never creates on toggle', async () => {
    const user = userEvent.setup()
    const view = renderApp('/members', loggedInHandlers(ALICE, [teamMembersHandler()]))
    await screen.findByRole('heading', { name: '团队成员' })
    expect(screen.getByLabelText('角色')).not.toBeVisible()
    const trigger = screen.getByRole('button', { name: '邀请成员', expanded: false })
    await user.click(trigger)
    await user.click(screen.getByLabelText('角色'))
    await user.click(screen.getByRole('menuitem', { name: '管理员（可管理插件与邀请）' }))
    await user.click(trigger)
    await user.click(trigger)
    expect(screen.getByLabelText('角色')).toHaveTextContent('管理员')
    expect(view.fetchMock.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(0)
  })
  it('pairing has one explicit primary action without a blank code panel', async () => {
    const view = renderApp('/devices', loggedInHandlers(ALICE, [devicesHandler([])]))
    await screen.findByRole('heading', { name: '设备', level: 1 })
    expect(screen.queryByRole('heading', { name: '配对码' })).toBeNull()
    expect(screen.getAllByRole('button', { name: '生成配对码' })).toHaveLength(1)
    expect(view.fetchMock.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(0)
  })
  it('closing Agent details restores the selected card focus without a mutation', async () => {
    const user = userEvent.setup()
    const view = renderApp(
      '/agents',
      loggedInHandlers(ALICE, [
        agentsHandler([agent]),
        packsHandler([]),
        {
          method: 'GET',
          url: new RegExp(`/agents/${agent.id}$`),
          respond: () => ok({ ...agent, currentRevision: null, revisions: [] }),
        },
      ]),
    )
    const trigger = await screen.findByRole('button', { name: /产品助理/ })
    await user.click(trigger)
    const detail = await screen.findByRole('region', { name: 'Agent 详情 产品助理' })
    await user.click(within(detail).getByRole('button', { name: '关闭 Agent 详情' }))
    expect(screen.queryByRole('region', { name: 'Agent 详情 产品助理' })).toBeNull()
    expect(trigger).toBeFocused()
    expect(view.fetchMock.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(0)
  })
})
