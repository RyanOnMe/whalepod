/**
 * Comment 时间线与发送（02 Task 7 Step 4/6）：
 * - 发送成功后输入清空、精确失效后展示新留言；
 * - pending 期间发送按钮禁用；
 * - 失败时保留输入内容并显示 message + requestId（失败不乐观更新）。
 */
import { screen, waitFor } from '@testing-library/react'
import { userEvent } from '@testing-library/user-event'
import { describe, expect, it } from 'vitest'
import {
  ALICE,
  BOB,
  deferredResponse,
  loggedInHandlers,
  makeComment,
  makeTask,
  statefulTaskRoom,
} from './fixtures.js'
import type { MockHandler } from './fixtures.js'
import { renderApp } from './render.jsx'

describe('comment', () => {
  it('发送留言：提交 → 清空输入 → 时间线出现新留言', async () => {
    const task = makeTask({ assigneeUserId: BOB.userId })
    const room = statefulTaskRoom(task)
    const comment = makeComment({
      taskId: task.id,
      authorUserId: BOB.userId,
      body: '我来负责这次运行',
    })
    const user = userEvent.setup()
    renderApp(`/tasks/${task.id}`, [
      ...loggedInHandlers(BOB, room.handlers),
      {
        method: 'POST',
        url: new RegExp(`/api/v1/tasks/${task.id}/comments$`),
        respond: () => {
          room.addComment(comment)
          return { status: 201, body: { ok: true, data: comment } }
        },
      },
    ])
    await screen.findByLabelText('留言')
    await user.type(screen.getByLabelText('留言'), '我来负责这次运行')
    await user.click(screen.getByRole('button', { name: '发送留言' }))
    expect(await screen.findByText('我来负责这次运行')).toBeVisible()
    // 成功的可见反馈：输入框清空
    await waitFor(() => {
      expect(screen.getByLabelText('留言')).toHaveValue('')
    })
  })

  it('列表渲染历史留言（自己显示“你”，他人显示短 id）', async () => {
    const task = makeTask({ assigneeUserId: BOB.userId })
    const comments = [
      makeComment({ taskId: task.id, authorUserId: BOB.userId, body: '已经跑完了第一轮' }),
      makeComment({ taskId: task.id, authorUserId: ALICE.userId, body: '请补充验收说明' }),
    ]
    renderApp(`/tasks/${task.id}`, loggedInHandlers(BOB, [roomHandler(task, comments)]))
    expect(await screen.findByText('已经跑完了第一轮')).toBeVisible()
    expect(screen.getByText('请补充验收说明')).toBeVisible()
    expect(screen.getAllByText('你')).not.toHaveLength(0)
  })

  it('发送期间按钮禁用，且只发出一条请求', async () => {
    const task = makeTask({ assigneeUserId: BOB.userId })
    const slow = deferredResponse()
    const user = userEvent.setup()
    const { fetchMock } = renderApp(`/tasks/${task.id}`, [
      ...loggedInHandlers(BOB, [roomHandler(task)]),
      {
        method: 'POST',
        url: new RegExp(`/api/v1/tasks/${task.id}/comments$`),
        respond: () => slow.promise,
      },
    ])
    await screen.findByLabelText('留言')
    await user.type(screen.getByLabelText('留言'), '慢请求留言')
    await user.click(screen.getByRole('button', { name: '发送留言' }))
    await waitFor(() => {
      expect(screen.getByRole('button', { name: '发送中…' })).toBeDisabled()
    })
    const commentCalls = fetchMock.mock.calls.filter(([input]) =>
      String(input).endsWith('/comments'),
    )
    expect(commentCalls).toHaveLength(1)
    const comment = makeComment({ taskId: task.id, authorUserId: BOB.userId, body: '慢请求留言' })
    slow.resolve({ status: 201, body: { ok: true, data: comment } })
    expect(await screen.findByText('慢请求留言')).toBeVisible()
  })

  it('发送失败：保留输入内容并显示 message + requestId', async () => {
    const task = makeTask({ assigneeUserId: BOB.userId })
    const user = userEvent.setup()
    renderApp(`/tasks/${task.id}`, [
      ...loggedInHandlers(BOB, [roomHandler(task)]),
      {
        method: 'POST',
        url: new RegExp(`/api/v1/tasks/${task.id}/comments$`),
        respond: () => ({
          status: 409,
          body: {
            ok: false,
            error: {
              code: 'CONFLICT',
              message: 'comment slot locked',
              requestId: 'req-comment-409',
            },
          },
        }),
      },
    ])
    await screen.findByLabelText('留言')
    await user.type(screen.getByLabelText('留言'), '这条不能丢')
    await user.click(screen.getByRole('button', { name: '发送留言' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('comment slot locked')
    expect(screen.getByRole('alert')).toHaveTextContent('req-comment-409')
    // 失败恢复输入：内容保留，便于重试
    expect(screen.getByLabelText('留言')).toHaveValue('这条不能丢')
  })

  it('空输入不发送', async () => {
    const task = makeTask({ assigneeUserId: BOB.userId })
    const user = userEvent.setup()
    const { fetchMock } = renderApp(`/tasks/${task.id}`, loggedInHandlers(BOB, [roomHandler(task)]))
    await screen.findByLabelText('留言')
    await user.click(screen.getByRole('button', { name: '发送留言' }))
    expect(screen.getByText('先输入留言内容')).toBeVisible()
    const commentCalls = fetchMock.mock.calls.filter(([input]) =>
      String(input).endsWith('/comments'),
    )
    expect(commentCalls).toHaveLength(0)
  })
})

/** 只读 room handler（不修改状态）。 */
function roomHandler(
  task: ReturnType<typeof makeTask>,
  comments: Parameters<typeof makeComment>[0][] = [],
): MockHandler {
  return {
    method: 'GET',
    url: new RegExp(`/api/v1/tasks/${task.id}$`),
    respond: () => ({
      status: 200,
      body: { ok: true, data: { task, comments, runs: [], artifacts: [] } },
    }),
  }
}
