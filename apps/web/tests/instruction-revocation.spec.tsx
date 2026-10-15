import { act, screen, waitFor } from '@testing-library/react'
import { userEvent } from '@testing-library/user-event'
import { describe, expect, it } from 'vitest'
import {
  ALICE,
  BOB,
  loggedInHandlers,
  makeTask,
  ok,
  taskRoomHandler,
  teamMembersHandler,
} from './fixtures.js'
import { renderApp } from './render.js'
import { installFrameSink } from './socket-drive.js'
import { persistentFrame } from './frames.js'
describe('撤销后的旧页面（#321）', () => {
  it('真实task.changed失效权限并保留草稿，不能再发送或读取责任人私有现场', async () => {
    let revoked = false
    const task = makeTask({
      assigneeUserId: ALICE.userId,
      assignmentStatus: 'accepted',
      status: 'in_progress',
    })
    const sink = installFrameSink()
    const user = userEvent.setup()
    const view = renderApp(
      `/tasks/${task.id}`,
      loggedInHandlers(BOB, [
        taskRoomHandler(task),
        teamMembersHandler(),
        {
          method: 'GET',
          url: /instruction-grants$/,
          respond: () =>
            ok([
              { userId: ALICE.userId, reason: 'assignee' },
              ...(!revoked ? [{ userId: BOB.userId, reason: 'granted' }] : []),
            ]),
        },
      ]),
    )
    const draft = await screen.findByLabelText('指令')
    await user.type(draft, '保留授权撤销前的工作草稿')
    revoked = true
    act(() =>
      sink.onFrame(
        persistentFrame(
          'task.changed',
          {
            taskId: task.id,
            change: 'instruction_revoked',
            userId: BOB.userId,
            grantedBy: ALICE.userId,
          },
          '123',
        ),
      ),
    )
    await waitFor(() => expect(draft).toBeDisabled())
    expect(draft).toHaveValue('保留授权撤销前的工作草稿')
    expect(screen.getByTestId('execution-blocker')).toHaveTextContent('只有责任人和已授权成员')
    expect(
      view.fetchMock.mock.calls.filter(([url]) =>
        /\/(devices|workspaces|instructions)$/.test(String(url)),
      ),
    ).toHaveLength(0)
  })
  it('权限页明确派发尝试与取消/交接边界', async () => {
    const task = makeTask({ assigneeUserId: ALICE.userId, assignmentStatus: 'accepted' })
    renderApp(
      `/tasks/${task.id}/permissions`,
      loggedInHandlers(ALICE, [
        taskRoomHandler(task),
        teamMembersHandler(),
        {
          method: 'GET',
          url: /instruction-grants$/,
          respond: () => ok([{ userId: ALICE.userId, reason: 'assignee' }]),
        },
      ]),
    )
    expect(await screen.findByTestId('instruction-revocation-rule')).toHaveTextContent(
      '尚未开始派发的追问会被拒绝',
    )
    expect(screen.getByTestId('instruction-revocation-rule')).toHaveTextContent('不代表已撤回')
    expect(screen.getByText(/责任交接需先结束活跃运行/)).toBeVisible()
  })
})
