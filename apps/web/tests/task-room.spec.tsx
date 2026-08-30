/**
 * Task Room 四区与状态呈现（02 Task 7 Step 4）：
 * 顶部属性/行动、左侧 Assignment、中间讨论+Run+审批插槽、右侧 Artifacts+Reviewer。
 * 加载与错误必须显式呈现，不能伪装成空数据；空态说明下一步。
 */
import { screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import {
  BOB,
  loggedInHandlers,
  makeArtifact,
  makeComment,
  makeRun,
  makeTask,
  pendingHandler,
  taskRoomHandler,
} from './fixtures.js'
import { renderApp } from './render.jsx'

describe('task-room', () => {
  it('渲染顶部区域：目标、状态与当前责任人', async () => {
    const task = makeTask({ assigneeUserId: BOB.userId, status: 'in_progress' })
    renderApp(`/tasks/${task.id}`, loggedInHandlers(BOB, [taskRoomHandler(task)]))
    expect(await screen.findByRole('heading', { name: task.title })).toBeVisible()
    expect(screen.getByText('进行中')).toBeVisible()
    expect(screen.getByText('当前责任人')).toBeVisible()
    expect(screen.getByText('你')).toBeVisible()
  })

  it('渲染左侧 Assignment 与 Agent 快照插槽的空态', async () => {
    const task = makeTask({ assigneeUserId: BOB.userId })
    renderApp(`/tasks/${task.id}`, loggedInHandlers(BOB, [taskRoomHandler(task)]))
    expect(await screen.findByRole('button', { name: '接受任务' })).toBeVisible()
    expect(screen.getByRole('button', { name: '拒绝任务' })).toBeVisible()
  })

  it('渲染中间讨论区：留言输入与空态', async () => {
    const task = makeTask({ assigneeUserId: BOB.userId })
    renderApp(`/tasks/${task.id}`, loggedInHandlers(BOB, [taskRoomHandler(task)]))
    expect(await screen.findByRole('heading', { name: '讨论' })).toBeVisible()
    expect(screen.getByLabelText('留言')).toBeVisible()
    expect(screen.getByText('还没有留言——向责任人说明下一步吧。')).toBeVisible()
  })

  it('渲染中间 Run 区与审批插槽；有 Run 时展示状态文本', async () => {
    const task = makeTask({ assigneeUserId: BOB.userId })
    renderApp(
      `/tasks/${task.id}`,
      loggedInHandlers(BOB, [
        taskRoomHandler(task, {
          runs: [
            makeRun({ status: 'running' }),
            makeRun({ status: 'completed', finishedAt: '2026-08-25T03:00:00.000Z' }),
          ],
        }),
      ]),
    )
    expect(await screen.findByRole('heading', { name: 'Run' })).toBeVisible()
    expect(await screen.findByText('运行中')).toBeVisible()
    expect(screen.getByText('已完成')).toBeVisible()
    expect(screen.getByRole('heading', { name: '审批' })).toBeVisible()
    // P1-14：无等待审批的 Run 时，审批插槽呈现空态说明。
    expect(screen.getByText('当前没有等待审批的操作。')).toBeVisible()
  })

  it('渲染右侧 Artifact 列表与 Reviewer 插槽', async () => {
    const task = makeTask({ assigneeUserId: BOB.userId })
    renderApp(
      `/tasks/${task.id}`,
      loggedInHandlers(BOB, [taskRoomHandler(task, { artifacts: [makeArtifact()] })]),
    )
    expect(await screen.findByRole('heading', { name: 'Artifacts' })).toBeVisible()
    expect(await screen.findByText('security-review.md')).toBeVisible()
    expect(screen.getByText('text/markdown')).toBeVisible()
    expect(screen.getByRole('heading', { name: 'Reviewer' })).toBeVisible()
    expect(screen.getByText(/Reviewer Agent 运行链随后续版本接入/)).toBeVisible()
  })

  it('空态说明下一步，而不是静默空白', async () => {
    const task = makeTask({ assigneeUserId: BOB.userId })
    renderApp(`/tasks/${task.id}`, loggedInHandlers(BOB, [taskRoomHandler(task)]))
    expect(await screen.findByText(/还没有 Run。/)).toBeVisible()
    expect(screen.getByText(/还没有已发布的 Artifact。/)).toBeVisible()
  })

  it('加载态不伪装成空数据', async () => {
    const task = makeTask({ assigneeUserId: BOB.userId })
    renderApp(
      `/tasks/${task.id}`,
      loggedInHandlers(BOB, [pendingHandler('GET', new RegExp(`/api/v1/tasks/${task.id}$`))]),
    )
    expect(await screen.findByText('正在加载任务…')).toBeVisible()
    expect(screen.queryByText('还没有 Run。')).not.toBeInTheDocument()
  })

  it('错误态展示 message 与 requestId，且不伪装成空数据', async () => {
    const task = makeTask({ assigneeUserId: BOB.userId })
    renderApp(
      `/tasks/${task.id}`,
      loggedInHandlers(BOB, [
        {
          method: 'GET',
          url: new RegExp(`/api/v1/tasks/${task.id}$`),
          respond: () => ({
            status: 500,
            body: {
              ok: false,
              error: {
                code: 'INTERNAL_ERROR',
                message: 'internal error',
                requestId: 'req-task-500',
              },
            },
          }),
        },
      ]),
    )
    expect(await screen.findByRole('alert')).toHaveTextContent('internal error')
    expect(screen.getByRole('alert')).toHaveTextContent('req-task-500')
    expect(screen.getByRole('button', { name: '重试' })).toBeVisible()
    expect(screen.queryByText('还没有 Run。')).not.toBeInTheDocument()
  })

  it('任务不存在（404）时展示明确错误而非空列表', async () => {
    const task = makeTask({ assigneeUserId: BOB.userId })
    renderApp(
      `/tasks/${task.id}`,
      loggedInHandlers(BOB, [
        {
          method: 'GET',
          url: new RegExp(`/api/v1/tasks/${task.id}$`),
          respond: () => ({
            status: 404,
            body: {
              ok: false,
              error: { code: 'NOT_FOUND', message: 'task not found', requestId: 'req-task-404' },
            },
          }),
        },
      ]),
    )
    expect(await screen.findByRole('alert')).toHaveTextContent('task not found')
    expect(screen.queryByRole('heading', { name: task.title })).not.toBeInTheDocument()
  })

  it('未接受任务时顶部不显示责任人的验收行动', async () => {
    const task = makeTask({ assigneeUserId: BOB.userId, assignmentStatus: 'pending' })
    renderApp(`/tasks/${task.id}`, loggedInHandlers(BOB, [taskRoomHandler(task)]))
    await screen.findByRole('heading', { name: task.title })
    expect(screen.queryByRole('button', { name: '提交验收' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: '完成任务' })).not.toBeInTheDocument()
  })
})
