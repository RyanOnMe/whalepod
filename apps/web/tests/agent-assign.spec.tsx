/**
 * Agent 可被指派（#239；ADR-0009 决策 6）——Web 组件面。
 *
 * 判据：
 * - 创建任务的责任人下拉含**未归档** Agent（归档不进），选中 Agent 后出现
 *   「指派即执行」提示；提交体带 `assigneeAgentId` 且**不带** `assigneeUserId`
 *   （协议互斥的 UI 面）；驱动失败的结果走 toast 如实告知，不吞。
 * - TaskHeader：Agent-task 的「当前责任人」仍是真人（指派人），另出「执行 Agent」格。
 * - AssignmentPanel：Agent-task 不渲染接受/拒绝（端点对 Agent-task 恒 409），
 *   陈述「谁指派给了哪个 Agent、指派即驱动、责任人是谁」。
 * - 指令流：origin=auto_assignment 的消息标注「指派自动驱动」，与人发的「指令」区分。
 */
import { screen, waitFor } from '@testing-library/react'
import { userEvent } from '@testing-library/user-event'
import { describe, expect, it } from 'vitest'
import type { AgentView, ProjectView, TaskView } from '../src/shared/api/types.js'
import {
  ALICE,
  BOB,
  agentsHandler,
  loggedInHandlers,
  makeMember,
  makeRun,
  makeTask,
  ok,
  projectsHandler,
  teamMembersHandler,
  taskRoomHandler,
  type MockHandler,
} from './fixtures.js'
import { renderApp } from './render.jsx'
import { openSelect, selectOption } from './select-menu.js'

const PROJECT_VIEW: ProjectView = {
  id: '11111111-0000-4000-8000-000000000001',
  name: '潮汐观测站',
  description: '',
  createdBy: BOB.userId,
  archivedAt: null,
  createdAt: '2026-08-24T00:00:00.000Z',
  updatedAt: '2026-08-24T00:00:00.000Z',
}

const PROJECT: TaskView['projectId'] = PROJECT_VIEW.id

const AGENT: AgentView = {
  id: '22222222-0000-4000-8000-00000000000a',
  name: 'report-writer',
  description: '写报告',
  createdBy: ALICE.userId,
  archivedAt: null,
  currentRevisionId: '33333333-0000-4000-8000-00000000000r',
}

const ARCHIVED_AGENT: AgentView = {
  ...AGENT,
  id: '22222222-0000-4000-8000-00000000000b',
  name: 'old-agent',
  archivedAt: '2026-08-01T00:00:00.000Z',
}

describe('#239 创建任务：责任人可选 Agent（指派即执行）', () => {
  it('下拉含未归档 Agent（归档不进）；选中后出现提示；提交体带 assigneeAgentId 且不带 assigneeUserId', async () => {
    const captures: { bodies: unknown[] } = { bodies: [] }
    const user = userEvent.setup()
    renderApp(
      '/',
      loggedInHandlers(BOB, [
        projectsHandler([PROJECT_VIEW]),
        teamMembersHandler(),
        agentsHandler([AGENT, ARCHIVED_AGENT]),
        {
          method: 'POST',
          url: /\/api\/v1\/projects\/[^/]+\/tasks$/,
          respond: (init) => {
            captures.bodies.push(JSON.parse(String(init.body ?? '{}')))
            return ok({
              ...makeTask({ id: 'new-agent-task' }),
              assigneeAgentId: AGENT.id,
              assignmentStatus: 'accepted',
            })
          },
        },
      ]),
    )
    await user.click(await screen.findByRole('button', { name: '创建任务' }))
    await user.type(await screen.findByLabelText('任务标题'), '把登录页改成深色')

    const list = await openSelect(user, '责任人')
    // 归档 Agent 不进候选。
    expect(list.queryByRole('menuitem', { name: /old-agent/ })).toBeNull()
    await user.click(list.getByRole('menuitem', { name: /report-writer（Agent · 指派即执行）/ }))

    // 选中 Agent → 说清会发生什么的提示。
    expect(screen.getByTestId('agent-assign-hint')).toHaveTextContent('指派给 Agent')

    await user.click(screen.getByRole('button', { name: /创建任务/ }))
    await waitFor(() => expect(captures.bodies).toHaveLength(1))
    expect(captures.bodies[0]).toMatchObject({
      title: '把登录页改成深色',
      assigneeAgentId: AGENT.id,
    })
    // 互斥的 UI 面：带 Agent 就不带成员。
    expect(captures.bodies[0]).not.toHaveProperty('assigneeUserId')
  })

  it('驱动失败（设备离线）→ toast 如实说「自动执行未开始」，任务仍算创建成功', async () => {
    const user = userEvent.setup()
    const view = renderApp(
      '/',
      loggedInHandlers(BOB, [
        projectsHandler([PROJECT_VIEW]),
        teamMembersHandler(),
        agentsHandler([AGENT]),
        {
          method: 'POST',
          url: /\/api\/v1\/projects\/[^/]+\/tasks$/,
          respond: () =>
            ok({
              ...makeTask({ id: 'new-agent-task-2' }),
              assigneeAgentId: AGENT.id,
              drive: { outcome: 'failed', error: { code: 'DEVICE_OFFLINE', message: 'no device' } },
            }),
        },
      ]),
    )
    await user.click(await screen.findByRole('button', { name: '创建任务' }))
    await user.type(await screen.findByLabelText('任务标题'), '再一个任务')
    await selectOption(user, '责任人', /report-writer（Agent · 指派即执行）/)
    await user.click(screen.getByRole('button', { name: /创建任务/ }))
    await waitFor(() =>
      expect(
        screen.getByText(/自动执行未开始（DEVICE_OFFLINE）/, { exact: false }),
      ).toBeInTheDocument(),
    )
    expect(view.fetchMock.mock.calls.length).toBeGreaterThan(0)
  })
})

describe('#239 Task Room：Agent-task 的呈现', () => {
  const agentTask = (): TaskView =>
    makeTask({
      assigneeAgentId: AGENT.id,
      assigneeUserId: BOB.userId, // 责任人 = 指派人（真人）
      assignmentStatus: 'accepted',
    })

  function roomHandlers(task: TaskView, extras: MockHandler[] = []): MockHandler[] {
    return [
      taskRoomHandler(task),
      teamMembersHandler([makeMember(BOB), makeMember(ALICE)]),
      agentsHandler([AGENT]),
      ...extras,
    ]
  }

  it('TaskHeader：当前责任人仍是真人（BOB），另出「执行 Agent」格（名字，不是 id）', async () => {
    const task = agentTask()
    renderApp(`/tasks/${task.id}`, loggedInHandlers(BOB, roomHandlers(task)))
    // Agent 名字是异步解析的（agents 查询落地后才从「正在读取」变成名字）。
    await waitFor(() => expect(screen.getByTestId('task-agent')).toHaveTextContent('report-writer'))
    expect(screen.getByTestId('task-assignee')).toHaveTextContent('你') // BOB 视角
    // 不画 id。
    expect(screen.getByTestId('task-agent').textContent).not.toContain(AGENT.id)
  })

  it('AssignmentPanel：不渲染接受/拒绝；陈述指派关系与责任人', async () => {
    const task = agentTask()
    renderApp(`/tasks/${task.id}`, loggedInHandlers(ALICE, roomHandlers(task)))
    await screen.findByTestId('assignment-agent-note')
    await waitFor(() =>
      expect(screen.getByTestId('assignment-agent-note')).toHaveTextContent(
        '指派给 Agent「report-writer」执行',
      ),
    )
    expect(screen.queryByRole('button', { name: '接受任务' })).toBeNull()
    expect(screen.queryByRole('button', { name: '拒绝任务' })).toBeNull()
    const note = screen.getByTestId('assignment-agent-note')
    expect(note).toHaveTextContent('Bob') // 指派人（第三方视角用人名）
    expect(note).toHaveTextContent('验收与审批都在责任人手上')
  })

  it('指令流：auto_assignment 消息标注「指派自动驱动」', async () => {
    const task = agentTask()
    renderApp(
      `/tasks/${task.id}`,
      loggedInHandlers(BOB, [
        taskRoomHandler(task, {
          instructions: [
            {
              id: 'm1',
              taskId: task.id,
              authorUserId: BOB.userId,
              body: '把登录页改成深色\n\n优先跟随系统偏好',
              kind: 'instruction',
              origin: 'auto_assignment',
              targetAgentId: AGENT.id,
              runId: '99999999-0000-4000-8000-0000000000r1',
              instructionState: 'pending',
              instructionErrorCode: null,
              instructionErrorMessage: null,
              createdAt: '2026-09-30T00:00:00.000Z',
              editedAt: null,
            },
          ],
          runs: [makeRun({ id: '99999999-0000-4000-8000-0000000000r1', status: 'queued' })],
        }),
        teamMembersHandler([makeMember(BOB), makeMember(ALICE)]),
        agentsHandler([AGENT]),
      ]),
    )
    expect(await screen.findByTestId('instruction-item')).toBeInTheDocument()
    expect(screen.getByText('指派自动驱动')).toBeInTheDocument()
    expect(screen.queryByText('指令', { selector: '.instruction-kind' })).toBeNull()
  })
})
