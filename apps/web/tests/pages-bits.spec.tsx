import { screen, within } from '@testing-library/react'
import { userEvent } from '@testing-library/user-event'
import { describe, expect, it } from 'vitest'
import { renderApp } from './render.js'
import {
  ALICE,
  agentsHandler,
  loggedInHandlers,
  makeTask,
  ok,
  packsHandler,
  projectsHandler,
  recentTasksEmptyHandler,
  teamMembersHandler,
} from './fixtures.js'

const project = {
  id: '11111111-0000-4000-8000-000000000001',
  name: '团队交付',
  description: '整理验收材料',
  createdBy: ALICE.userId,
  archivedAt: null,
  createdAt: '2026-10-01T00:00:00Z',
  updatedAt: '2026-10-01T00:00:00Z',
}

describe('P1-425 page interactions', () => {
  it('task disclosure exposes its region and removes closed controls from interaction', async () => {
    const task = makeTask({ projectId: project.id, title: '验收清单' })
    const user = userEvent.setup()
    renderApp(
      '/',
      loggedInHandlers(ALICE, [
        projectsHandler([project]),
        teamMembersHandler(),
        recentTasksEmptyHandler(),
        { method: 'GET', url: /\/projects\/[^/]+\/tasks$/, respond: () => ok([task]) },
      ]),
    )
    await user.click(await screen.findByRole('button', { name: '任务列表' }))
    const region = await screen.findByRole('region', { name: '任务列表：团队交付' })
    expect(await within(region).findByRole('button', { name: '验收清单' })).toBeVisible()
    await user.click(screen.getByRole('button', { name: '收起任务列表' }))
    expect(region).toHaveAttribute('inert')
    expect(region).toHaveAttribute('aria-hidden', 'true')
  })

  it('advanced Agent settings are explicit, retain edits across collapse and do not submit', async () => {
    const user = userEvent.setup()
    const view = renderApp(
      '/agents',
      loggedInHandlers(ALICE, [agentsHandler([]), packsHandler([])]),
    )
    await user.click(await screen.findByRole('button', { name: '新建 Agent' }))
    const field = screen.getByLabelText('凭据槽（Credential Slot）')
    expect(field).not.toBeVisible()
    await user.click(screen.getByText('高级选项', { selector: 'summary' }))
    await user.clear(field)
    await user.type(field, 'team-local')
    await user.click(screen.getByText('高级选项', { selector: 'summary' }))
    await user.click(screen.getByText('高级选项', { selector: 'summary' }))
    expect(field).toHaveValue('team-local')
    expect(view.fetchMock.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(0)
  })

  it('inbox filters only the visible server projection and preserves original deep links', async () => {
    const user = userEvent.setup()
    const task = makeTask({ title: '等待批准的工作' })
    const view = renderApp(
      '/',
      loggedInHandlers(ALICE, [
        projectsHandler([]),
        recentTasksEmptyHandler(),
        {
          method: 'GET',
          url: /\/tasks\/attention$/,
          respond: () =>
            ok({
              items: [
                {
                  kind: 'decide_approval',
                  taskId: task.id,
                  taskTitle: task.title,
                  projectName: '团队项目',
                  objectId: 'cccccccc-1234-4000-8000-000000000001',
                  runId: 'eeeeeeee-1234-4000-8000-000000000001',
                  createdAt: task.createdAt,
                },
                {
                  kind: 'accept_assignment',
                  taskId: task.id,
                  taskTitle: '待接手工作',
                  projectName: '团队项目',
                  objectId: task.id,
                  runId: null,
                  createdAt: task.createdAt,
                },
              ],
              hasMore: false,
            }),
        },
      ]),
    )
    await screen.findByRole('link', { name: /待接手工作/ })
    const filters = await screen.findByRole('group', { name: '待办筛选' })
    await user.click(within(filters).getByRole('button', { name: '审批' }))
    expect(screen.queryByRole('link', { name: /待接手工作/ })).toBeNull()
    expect(screen.getByRole('link', { name: /等待批准的工作/ })).toHaveAttribute(
      'href',
      `/tasks/${task.id}#approval-cccccccc-1234-4000-8000-000000000001`,
    )
    expect(view.fetchMock.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(0)
  })
})
