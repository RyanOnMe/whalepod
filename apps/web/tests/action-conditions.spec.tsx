import { act, screen, waitFor } from '@testing-library/react'
import { userEvent } from '@testing-library/user-event'
import { queryKeys } from '../src/app/query-client.js'
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
import { renderApp } from './render.jsx'

const task = makeTask({
  assigneeUserId: BOB.userId,
  assignmentStatus: 'accepted',
  status: 'in_progress',
})
function room(reviewEligibility?: { allowed: boolean; reason: string | null }) {
  const base = taskRoomHandler(task)
  return {
    ...base,
    respond: () =>
      ok({
        task,
        comments: [],
        instructions: [],
        runs: [],
        artifacts: [],
        nextRunApprovalPolicy: null,
        ...(reviewEligibility === undefined ? {} : { reviewEligibility }),
      }),
  }
}
describe('操作前说明（#319）', () => {
  it.each([
    ['active_run', '执行仍在进行'],
    ['no_published_artifact', '发布至少一个交付物'],
  ])('服务端条件 %s 阻止提交并说明下一步', async (reason, message) => {
    renderApp(`/tasks/${task.id}`, loggedInHandlers(BOB, [room({ allowed: false, reason })]))
    expect(await screen.findByRole('button', { name: '提交验收' })).toBeDisabled()
    expect(screen.getByTestId('review-condition')).toHaveTextContent(message)
  })
  it('条件字段缺失不能冒充可提交', async () => {
    renderApp(`/tasks/${task.id}`, loggedInHandlers(BOB, [room()]))
    expect(await screen.findByRole('button', { name: '提交验收' })).toBeDisabled()
    expect(screen.getByTestId('review-condition')).toHaveTextContent('无法确认')
  })
  it('确认期间条件失效关闭旧确认，不发提交请求', async () => {
    const user = userEvent.setup()
    const view = renderApp(
      `/tasks/${task.id}`,
      loggedInHandlers(BOB, [room({ allowed: true, reason: null })]),
    )
    await user.click(await screen.findByRole('button', { name: '提交验收' }))
    expect(await screen.findByRole('dialog')).toBeVisible()
    act(() => {
      view.queryClient.setQueryData(queryKeys.taskRoom(task.id), {
        task,
        comments: [],
        instructions: [],
        runs: [],
        artifacts: [],
        reviewEligibility: { allowed: false, reason: 'active_run' },
      })
    })
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    expect(screen.getByRole('button', { name: '提交验收' })).toBeDisabled()
    expect(
      view.fetchMock.mock.calls.filter(([url]) => String(url).endsWith('/submit-review')),
    ).toHaveLength(0)
  })
  it('自相矛盾的条件不能冒充可提交', async () => {
    renderApp(
      `/tasks/${task.id}`,
      loggedInHandlers(BOB, [room({ allowed: true, reason: 'active_run' })]),
    )
    expect(await screen.findByRole('button', { name: '提交验收' })).toBeDisabled()
    expect(screen.getByTestId('review-condition')).toHaveTextContent('无法确认')
  })
  it('明确可提交仍允许真人操作', async () => {
    renderApp(`/tasks/${task.id}`, loggedInHandlers(BOB, [room({ allowed: true, reason: null })]))
    expect(await screen.findByRole('button', { name: '提交验收' })).toBeEnabled()
  })
  it('无授权成员看到具体处理人，可定位到讨论，不读取私有现场', async () => {
    const view = renderApp(
      `/tasks/${task.id}`,
      loggedInHandlers(ALICE, [
        room(),
        teamMembersHandler(),
        {
          method: 'GET',
          url: /instruction-grants$/,
          respond: () => ok([{ userId: BOB.userId, reason: 'assignee' }]),
        },
      ]),
    )
    await waitFor(() =>
      expect(screen.getByTestId('execution-responsibility')).toHaveTextContent('Bob'),
    )
    expect(screen.getByTestId('execution-responsibility')).toHaveTextContent('审批')
    expect(screen.getByRole('link', { name: '前往讨论' })).toHaveAttribute(
      'href',
      '#comments-heading',
    )
    expect(
      view.fetchMock.mock.calls.filter(([url]) => /\/(devices|workspaces)$/.test(String(url))),
    ).toHaveLength(0)
  })
})
