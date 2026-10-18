import { screen, within } from '@testing-library/react'
import { userEvent } from '@testing-library/user-event'
import { describe, expect, it } from 'vitest'
import {
  BOB,
  loggedInHandlers,
  makeTask,
  taskRoomHandler,
  devicesHandler,
  workspacesHandler,
  ok,
} from './fixtures.js'
import { renderApp } from './render.js'

function room() {
  const task = makeTask({
    title: '整理验收报告',
    assignmentStatus: 'accepted',
    assigneeUserId: BOB.userId,
  })
  return renderApp(
    `/tasks/${task.id}`,
    loggedInHandlers(BOB, [
      taskRoomHandler(task),
      devicesHandler([]),
      workspacesHandler([]),
      { method: 'GET', url: /\/agents$/, respond: () => ok([]) },
    ]),
  )
}

describe('工作区信息层级', () => {
  it('默认页头只呈现任务和单一状态，低频信息与取消收进任务详情', async () => {
    const user = userEvent.setup()
    room()
    await screen.findByRole('heading', { name: '整理验收报告' })
    expect(screen.getByTestId('task-back-link').querySelector('svg')).not.toBeNull()
    expect(screen.getByRole('button', { name: '取消任务' })).not.toBeVisible()
    expect(screen.queryByText('当前责任人')).toBeNull()
    await user.click(screen.getByLabelText('任务详情'))
    expect(screen.getByRole('button', { name: '取消任务' })).toBeVisible()
    expect(screen.getByTestId('task-assignee')).toHaveTextContent('你')
    await user.keyboard('{Escape}')
    expect(screen.getByRole('button', { name: '取消任务' })).not.toBeVisible()
    expect(screen.getByLabelText('任务详情')).toHaveFocus()
  })

  it('空态不重复公告已接受，不绘制空审批和常驻准备说明', async () => {
    room()
    await screen.findByRole('heading', { name: '我们要完成什么？' })
    expect(screen.queryByText('你已接受此任务。')).toBeNull()
    expect(screen.queryByRole('region', { name: '审批' })).toBeNull()
    expect(screen.queryByText('当前没有等待审批的操作。')).toBeNull()
    expect(screen.queryByText('准备开始 · 执行由你确认')).toBeNull()
    expect(screen.queryByText(/还没有人驱动过这个任务/)).toBeNull()
  })

  it('只有一个执行设置入口，位于输入栏；模式与版本按需展示，不触发提交', async () => {
    const user = userEvent.setup()
    const app = room()
    const bar = await screen.findByTestId('prompt-bar')
    expect(screen.queryByText('执行方式与草稿')).toBeNull()
    expect(screen.queryByRole('button', { name: '执行方式' })).toBeNull()
    const settings = within(bar).getByLabelText('执行设置')
    expect(screen.getAllByLabelText('执行设置')).toHaveLength(1)
    await user.click(settings)
    expect(screen.getByRole('button', { name: '执行方式' })).toBeVisible()
    expect(screen.getByRole('button', { name: '选择 Revision' })).toBeVisible()
    await user.keyboard('{Escape}')
    expect(settings).toHaveFocus()
    expect(screen.queryByRole('button', { name: '执行方式' })).toBeNull()
    expect(app.fetchMock.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(0)
  })
})
