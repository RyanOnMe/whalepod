import { screen, waitFor } from '@testing-library/react'
import { userEvent } from '@testing-library/user-event'
import { describe, expect, it } from 'vitest'
import {
  ALICE,
  BOB,
  deferredResponse,
  loggedInHandlers,
  makeMember,
  makeRun,
  makeTask,
  ok,
  statefulTaskRoom,
  taskRoomHandler,
  teamMembersHandler,
} from './fixtures.js'
import { renderApp } from './render.jsx'

async function choose(user: ReturnType<typeof userEvent.setup>, name = 'Alice') {
  await user.click(await screen.findByRole('button', { name: '重新指派' }))
  await user.click(await screen.findByLabelText('新责任人'))
  await user.click(await screen.findByRole('menuitem', { name: new RegExp(name) }))
}

describe('#314 拒绝后的重新指派', () => {
  it('Owner 在任务房改派后等待新责任人接受，不自动接受', async () => {
    const user = userEvent.setup()
    const task = makeTask({ assignmentStatus: 'rejected' })
    const room = statefulTaskRoom(task)
    const next = { ...task, assigneeUserId: ALICE.userId, assignmentStatus: 'pending' as const }
    const view = renderApp(
      `/tasks/${task.id}`,
      loggedInHandlers(ALICE, [
        teamMembersHandler(),
        ...room.handlers,
        {
          method: 'POST',
          url: new RegExp(`/tasks/${task.id}/reassign$`),
          respond: () => {
            room.setTask(next)
            return ok(next)
          },
        },
      ]),
    )
    await choose(user)
    expect(screen.getByText(/现有指令授权名单会保留/)).toBeVisible()
    await user.click(screen.getByRole('button', { name: '确认重新指派' }))
    expect(await screen.findByRole('button', { name: '接受任务' })).toBeVisible()
    const calls = view.fetchMock.mock.calls.filter(([url]) => String(url).endsWith('/reassign'))
    expect(calls).toHaveLength(1)
    expect(JSON.parse(String((calls[0]![1] as RequestInit).body))).toEqual({
      assigneeUserId: ALICE.userId,
    })
  })

  it('成员无入口；终态任务无入口', async () => {
    const task = makeTask({ assignmentStatus: 'rejected' })
    const view = renderApp(`/tasks/${task.id}`, loggedInHandlers(BOB, [taskRoomHandler(task)]))
    await screen.findByRole('heading', { name: task.title })
    expect(screen.queryByRole('button', { name: '重新指派' })).toBeNull()
    view.unmount()
    const terminal = { ...task, status: 'cancelled' as const }
    renderApp(`/tasks/${task.id}`, loggedInHandlers(ALICE, [taskRoomHandler(terminal)]))
    await screen.findByRole('heading', { name: task.title })
    expect(screen.queryByRole('button', { name: '重新指派' })).toBeNull()
  })

  it('停用成员不进候选；提交期间不能重复发送', async () => {
    const user = userEvent.setup()
    const task = makeTask({ assignmentStatus: 'rejected' })
    const slow = deferredResponse()
    const view = renderApp(
      `/tasks/${task.id}`,
      loggedInHandlers(ALICE, [
        teamMembersHandler([makeMember(), makeMember({ ...BOB, enabled: false })]),
        taskRoomHandler(task),
        { method: 'POST', url: /reassign$/, respond: () => slow.promise },
      ]),
    )
    await user.click(await screen.findByRole('button', { name: '重新指派' }))
    await user.click(screen.getByLabelText('新责任人'))
    expect(screen.queryByRole('menuitem', { name: /Bob/ })).toBeNull()
    await user.click(screen.getByRole('menuitem', { name: /Alice/ }))
    const send = screen.getByRole('button', { name: '确认重新指派' })
    await user.click(send)
    await waitFor(() => expect(send).toBeDisabled())
    await user.click(send)
    expect(
      view.fetchMock.mock.calls.filter(([url]) => String(url).endsWith('/reassign')),
    ).toHaveLength(1)
    slow.resolve(ok(task))
  })

  it('并发运行冲突后保留所选成员，提示处理方法', async () => {
    const user = userEvent.setup()
    const task = makeTask({ assignmentStatus: 'rejected' })
    renderApp(
      `/tasks/${task.id}`,
      loggedInHandlers(ALICE, [
        teamMembersHandler(),
        taskRoomHandler(task),
        {
          method: 'POST',
          url: /reassign$/,
          respond: () => ({
            status: 409,
            body: {
              ok: false,
              error: {
                code: 'CONFLICT',
                message: 'cannot reassign a task with an active run',
                requestId: 'req-reassign-409',
              },
            },
          }),
        },
      ]),
    )
    await choose(user)
    await user.click(screen.getByRole('button', { name: '确认重新指派' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('req-reassign-409')
    expect(screen.getByLabelText('新责任人')).toHaveTextContent('Alice')
    expect(screen.getByText(/运行状态已变化/)).toBeVisible()
  })

  it('已有活跃执行时先说明阻塞', async () => {
    const task = makeTask({ assignmentStatus: 'rejected' })
    renderApp(
      `/tasks/${task.id}`,
      loggedInHandlers(ALICE, [taskRoomHandler(task, { runs: [makeRun({ status: 'running' })] })]),
    )
    expect(await screen.findByText('有运行进行中，结束后才能重新指派。')).toBeVisible()
    expect(screen.queryByRole('button', { name: '重新指派' })).toBeNull()
  })
})
