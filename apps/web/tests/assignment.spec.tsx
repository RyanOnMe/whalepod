/**
 * Assignment 接受/拒绝（02 Task 7 Step 4/6）：
 * - pending 展示接受/拒绝按钮；成功后 invalidate → 重新拉取快照显示已接受。
 * - pending 中按钮禁用；失败展示 message + requestId 并恢复可操作状态。
 * - 非责任人看不到决策按钮；已接受显示 Agent 快照插槽空态。
 */
import { screen, waitFor } from '@testing-library/react'
import { userEvent } from '@testing-library/user-event'
import { describe, expect, it } from 'vitest'
import {
  ALICE,
  BOB,
  deferredResponse,
  loggedInHandlers,
  makeTask,
  statefulTaskRoom,
} from './fixtures.js'
import type { MockHandler } from './fixtures.js'
import { renderApp } from './render.jsx'

describe('assignment', () => {
  it('责任人接受任务：按钮 → 接受 → 显示已接受与 Agent 快照插槽', async () => {
    const task = makeTask({ assigneeUserId: BOB.userId })
    const room = statefulTaskRoom(task)
    const user = userEvent.setup()
    renderApp(`/tasks/${task.id}`, [
      ...loggedInHandlers(BOB, room.handlers),
      {
        method: 'POST',
        url: new RegExp(`/api/v1/tasks/${task.id}/accept$`),
        respond: () => {
          const accepted = {
            ...task,
            assignmentStatus: 'accepted',
            acceptedAt: '2026-08-26T00:00:00.000Z',
          } as typeof task
          room.setTask(accepted)
          return { status: 200, body: { ok: true, data: accepted } }
        },
      },
    ])
    await user.click(await screen.findByRole('button', { name: '接受任务' }))
    expect(await screen.findByText('你已接受此任务。')).toBeVisible()
    expect(await screen.findByRole('heading', { name: 'Agent 快照' })).toBeVisible()
    expect(screen.queryByRole('button', { name: '接受任务' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: '拒绝任务' })).not.toBeInTheDocument()
  })

  it('pending 期间提交按钮禁用，且仍在同一条 HTTP 重建（真实 fetch 不重放）', async () => {
    const task = makeTask({ assigneeUserId: BOB.userId })
    const room = statefulTaskRoom(task)
    const slow = deferredResponse()
    const user = userEvent.setup()
    const { fetchMock } = renderApp(`/tasks/${task.id}`, [
      ...loggedInHandlers(BOB, room.handlers),
      {
        method: 'POST',
        url: new RegExp(`/api/v1/tasks/${task.id}/accept$`),
        respond: () => slow.promise,
      },
      {
        method: 'POST',
        url: new RegExp(`/api/v1/tasks/${task.id}/reject$`),
        respond: () => slow.promise,
      },
    ])
    const acceptButton = await screen.findByRole('button', { name: '接受任务' })
    await user.click(acceptButton)
    // pending：接受/拒绝同时禁用
    await waitFor(() => {
      expect(screen.getByRole('button', { name: '接受任务' })).toBeDisabled()
      expect(screen.getByRole('button', { name: '拒绝任务' })).toBeDisabled()
    })
    const acceptCalls = fetchMock.mock.calls.filter(([input]) => String(input).endsWith('/accept'))
    expect(acceptCalls).toHaveLength(1)
    const accepted = {
      ...task,
      assignmentStatus: 'accepted',
      acceptedAt: '2026-08-26T00:00:00.000Z',
    } as typeof task
    room.setTask(accepted)
    slow.resolve({ status: 200, body: { ok: true, data: accepted } })
    expect(await screen.findByText('你已接受此任务。')).toBeVisible()
  })

  it('非责任人视角：已接受任务显示第三方陈述（责任人已接受）', async () => {
    const task = makeTask({
      assigneeUserId: BOB.userId,
      assignmentStatus: 'accepted',
      acceptedAt: '2026-08-26T00:00:00.000Z',
    })
    renderApp(`/tasks/${task.id}`, loggedInHandlers(ALICE, [roomHandler(task)]))
    expect(await screen.findByText('责任人已接受此任务。')).toBeVisible()
    expect(screen.queryByText('你已接受此任务。')).not.toBeInTheDocument()
    // 非责任人看不到接受/拒绝按钮。
    expect(screen.queryByRole('button', { name: '接受任务' })).not.toBeInTheDocument()
  })

  it('接受失败：展示 message 与 requestId，按钮恢复可用（失败不乐观更新）', async () => {
    const task = makeTask({ assigneeUserId: BOB.userId })
    const user = userEvent.setup()
    renderApp(`/tasks/${task.id}`, [
      ...loggedInHandlers(BOB, [roomHandler(task)]),
      {
        method: 'POST',
        url: new RegExp(`/api/v1/tasks/${task.id}/accept$`),
        respond: () => ({
          status: 403,
          body: {
            ok: false,
            error: {
              code: 'FORBIDDEN',
              message: 'assignment already decided',
              requestId: 'req-assign-403',
            },
          },
        }),
      },
    ])
    await user.click(await screen.findByRole('button', { name: '接受任务' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('assignment already decided')
    expect(screen.getByRole('alert')).toHaveTextContent('req-assign-403')
    // 失败后按钮恢复（可重试），页面不显示「已接受」
    await waitFor(() => {
      expect(screen.getByRole('button', { name: '接受任务' })).toBeEnabled()
    })
    expect(screen.queryByText('你已接受此任务。')).not.toBeInTheDocument()
  })

  it('责任人拒绝任务：显示已拒绝说明，不再显示决策按钮', async () => {
    const task = makeTask({ assigneeUserId: BOB.userId })
    const room = statefulTaskRoom(task)
    const user = userEvent.setup()
    renderApp(`/tasks/${task.id}`, [
      ...loggedInHandlers(BOB, room.handlers),
      {
        method: 'POST',
        url: new RegExp(`/api/v1/tasks/${task.id}/reject$`),
        respond: () => {
          const rejected = { ...task, assignmentStatus: 'rejected' } as typeof task
          room.setTask(rejected)
          return { status: 200, body: { ok: true, data: rejected } }
        },
      },
    ])
    await user.click(await screen.findByRole('button', { name: '拒绝任务' }))
    expect(await screen.findByText(/此任务已被拒绝/)).toBeVisible()
    expect(screen.queryByRole('button', { name: '接受任务' })).not.toBeInTheDocument()
  })

  it('非责任人不显示决策按钮，只显示等待说明', async () => {
    // Alice 登录但任务分配给 Bob
    const task = makeTask({ assigneeUserId: BOB.userId })
    renderApp(`/tasks/${task.id}`, loggedInHandlers(ALICE, [roomHandler(task)]))
    await screen.findByRole('heading', { name: task.title })
    expect(screen.queryByRole('button', { name: '接受任务' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: '拒绝任务' })).not.toBeInTheDocument()
    expect(screen.getByText(/等待其接受/)).toBeVisible()
  })

  it('已接受状态：不显示决策按钮，显示 Agent 快照插槽空态', async () => {
    const task = makeTask({
      assigneeUserId: BOB.userId,
      assignmentStatus: 'accepted',
      acceptedAt: '2026-08-26T00:00:00.000Z',
    })
    renderApp(`/tasks/${task.id}`, loggedInHandlers(BOB, [roomHandler(task)]))
    expect(await screen.findByText('你已接受此任务。')).toBeVisible()
    expect(screen.queryByRole('button', { name: '接受任务' })).not.toBeInTheDocument()
    expect(screen.getByRole('heading', { name: 'Agent 快照' })).toBeVisible()
    expect(screen.getByText(/Run 创建后/)).toBeVisible()
  })
})

/** 简单只读 room handler（不修改状态）。 */
function roomHandler(task: ReturnType<typeof makeTask>): MockHandler {
  return {
    method: 'GET',
    url: new RegExp(`/api/v1/tasks/${task.id}$`),
    respond: () => ({
      status: 200,
      body: { ok: true, data: { task, comments: [], runs: [], artifacts: [] } },
    }),
  }
}
