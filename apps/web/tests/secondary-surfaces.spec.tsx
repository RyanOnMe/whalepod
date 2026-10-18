import { screen, within } from '@testing-library/react'
import { userEvent } from '@testing-library/user-event'
import { describe, expect, it } from 'vitest'
import {
  ALICE,
  agentsHandler,
  loggedInHandlers,
  makeRun,
  makeTask,
  makeArtifact,
  ok,
  projectsHandler,
  taskRoomHandler,
} from './fixtures.js'
import { renderApp } from './render.js'

const task = makeTask({ assigneeUserId: ALICE.userId, assignmentStatus: 'accepted' })
const SURFACE_RUN = 'cdcdcdcd-0000-4000-8000-00000000000f'
const surfaceRun = makeRun({ id: SURFACE_RUN, status: 'completed' })

const agent = {
  id: 'f0000000-0000-4000-8000-000000000001',
  name: 'Builder',
  description: '',
  createdBy: ALICE.userId,
  archivedAt: null,
  currentRevisionId: null,
}

describe('抽屉与二级页面的统一层级', () => {
  it('内层确认框拥有 Escape，即使焦点暂留触发器也不关闭抽屉', async () => {
    const user = userEvent.setup()
    const artifact = makeArtifact({
      status: 'candidate',
      ownerUserId: ALICE.userId,
      runId: SURFACE_RUN,
    })
    const app = renderApp(
      `/tasks/${task.id}`,
      loggedInHandlers(ALICE, [
        taskRoomHandler(task, { runs: [surfaceRun], artifacts: [artifact] }),
        {
          method: 'GET',
          url: new RegExp(`/api/v1/runs/${SURFACE_RUN}/events`),
          respond: () => ok({ events: [] }),
        },
      ]),
    )
    await user.click(await screen.findByRole('button', { name: `查看交付物 ${artifact.title}` }))
    const publish = screen.getByTestId('artifact-publish-button')
    await user.click(publish)
    expect(screen.getByRole('dialog')).toBeVisible()
    publish.focus()
    await user.keyboard('{Escape}')
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(screen.getByRole('region', { name: '工作区详情' })).toBeVisible()
    expect(publish).toHaveFocus()
    expect(app.fetchMock.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(0)
  })
  it.each(['/', '/members', '/agents', '/plugins', '/devices', `/tasks/${task.id}/permissions`])(
    '%s 使用同一页面标题区',
    async (path) => {
      renderApp(
        path,
        loggedInHandlers(ALICE, [projectsHandler([]), agentsHandler([]), taskRoomHandler(task)]),
      )
      const heading = await screen.findByRole('heading', { level: 1 })
      expect(heading.closest('.page-header')).not.toBeNull()
    },
  )

  it('约定抽屉只显示一个同名标题，阻断状态仍默认可见', async () => {
    renderApp(
      `/tasks/${task.id}`,
      loggedInHandlers(ALICE, [
        taskRoomHandler(task),
        {
          method: 'GET',
          url: /\/agreement$/,
          respond: () =>
            ok({ enabled: true, draft: null, confirmed: null, history: [], confirmedCount: 0 }),
        },
      ]),
    )
    await userEvent.setup().click(await screen.findByRole('button', { name: '任务约定' }))
    const panel = within(screen.getByRole('region', { name: '工作区详情' }))
    expect(panel.getAllByRole('heading', { name: '任务约定' })).toHaveLength(1)
    expect(await panel.findByTestId('agreement-enabled-unconfirmed')).toBeVisible()
    expect(
      panel.getByRole('button', { name: '关闭工作区详情' }).querySelector('svg'),
    ).not.toBeNull()
  })

  it('Agent 创建按需展开，收起重开保留字段，不触发提交', async () => {
    const app = renderApp('/agents', loggedInHandlers(ALICE, [agentsHandler([agent])]))
    await screen.findByRole('button', { name: /Builder/ })
    expect(screen.getByLabelText('名称')).not.toBeVisible()
    const user = userEvent.setup()
    const create = screen.getByRole('button', { name: '新建 Agent' })
    await user.click(create)
    await user.type(screen.getByLabelText('名称'), 'Researcher')
    await user.click(create)
    expect(screen.getByLabelText('名称')).not.toBeVisible()
    await user.click(create)
    expect(screen.getByLabelText('名称')).toHaveValue('Researcher')
    expect(app.fetchMock.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(0)
  })
})
