/**
 * #348：创建任务失败的候选失效——**人话与引导**（竞态残窗的兜底）。
 *
 * 背景：提交前阻塞（`selection-unavailable-hint`）覆盖正常时序（`member.changed` 重拉后拦），
 * 但名册还没刷新完用户已点提交时，只有一个 400 与英文分类消息到达页面
 * （`assignee is not an active team member（requestId: req-4m）`）——用户看不出下一步。
 *
 * 判据：
 * - 纯函数：两类已知失效各给中文引导；其余失败返回 null（不编造原因）；
 * - jsdom（真人路径）：创建 POST 返回真实形状的 400 → 主位是中文引导、错误码可见、
 *   原英文分类消息退到「细节（排障用）」；之后**再提交先被拦住**（把一次性兜底变成
 *   持续的提交前阻塞，零新请求）；重选责任人后阻塞解除。
 */
import { screen, waitFor, within } from '@testing-library/react'
import { userEvent } from '@testing-library/user-event'
import { describe, expect, it } from 'vitest'
import { createTaskFailureCopy } from '../src/features/task/createTaskFailure.js'
import { ApiError } from '../src/shared/api/errors.js'
import type { ProjectView } from '../src/shared/api/types.js'
import {
  ALICE,
  BOB,
  agentsHandler,
  loggedInHandlers,
  makeTask,
  projectsHandler,
  teamMembersHandler,
} from './fixtures.js'
import type { AgentView } from '../src/shared/api/types.js'
import { renderApp } from './render.jsx'
import { selectOption } from './select-menu.js'

const AGENT: AgentView = {
  id: '22222222-0000-4000-8000-00000000000a',
  name: 'report-writer',
  description: '写报告',
  createdBy: ALICE.userId,
  archivedAt: null,
  currentRevisionId: '33333333-0000-4000-8000-00000000000r',
}

const PROJECT_VIEW: ProjectView = {
  id: '11111111-0000-4000-8000-000000000001',
  name: '潮汐观测站',
  description: '',
  createdBy: ALICE.userId,
  archivedAt: null,
  createdAt: '2026-08-24T00:00:00.000Z',
  updatedAt: '2026-08-24T00:00:00.000Z',
}

/** Hub 的真实拒绝形状（apps/hub/src/modules/task/commands.ts 的 wire 面）。 */
function assigneeUnavailable400(): { status: number; body: unknown } {
  return {
    status: 400,
    body: {
      ok: false,
      error: {
        code: 'VALIDATION_FAILED',
        message: 'assignee is not an active team member',
        requestId: 'req-4m',
      },
    },
  }
}

describe('#348 创建任务失败：候选失效翻成人话 + 引导', () => {
  it('纯函数：两类已知失效给中文引导；其余失败不编造（null）', () => {
    const assignee = new ApiError(
      'VALIDATION_FAILED',
      'assignee is not an active team member',
      'req-4m',
      400,
    )
    const assigneeFailure = createTaskFailureCopy(assignee)
    expect(assigneeFailure?.field).toBe('assignee')
    expect(assigneeFailure?.guidance).toContain('重新选择责任人')
    expect(assigneeFailure?.guidance).toContain('不会自动换人')

    const agent = new ApiError(
      'VALIDATION_FAILED',
      'assignee agent not found or archived',
      'req-4n',
      400,
    )
    const agentFailure = createTaskFailureCopy(agent)
    expect(agentFailure?.field).toBe('agent')
    expect(agentFailure?.guidance).toContain('重新选择 Agent')

    // 不编造：别的码/别的消息/非 ApiError 一律 null（走通用横幅原样展示）。
    expect(
      createTaskFailureCopy(new ApiError('CONFLICT', 'project is archived', 'r', 409)),
    ).toBeNull()
    expect(createTaskFailureCopy(new Error('boom'))).toBeNull()
    expect(createTaskFailureCopy(null)).toBeNull()
  })

  it('400 到达后：主位是中文引导、错误码可见、之后提交先拦；重选后解除', async () => {
    const user = userEvent.setup()
    let posts = 0
    renderApp(
      '/',
      loggedInHandlers(ALICE, [
        projectsHandler([PROJECT_VIEW]),
        teamMembersHandler(),
        agentsHandler([]),
        {
          method: 'POST',
          url: /\/api\/v1\/projects\/[^/]+\/tasks$/,
          respond: () => {
            posts += 1
            return assigneeUnavailable400()
          },
        },
      ]),
    )
    await user.click(await screen.findByRole('button', { name: '创建任务' }))
    await user.type(await screen.findByLabelText('任务标题'), '把登录页改成深色')
    await selectOption(user, '责任人', /Alice/)
    // 名册里 Alice 在、没有 stale——提交前阻塞这条**不**成立：走的就是竞态残窗，
    // 直接提交、由服务端拒绝。
    await user.click(screen.getByRole('button', { name: '创建任务' }))

    const guidance = await screen.findByTestId('error-guidance')
    expect(guidance.textContent).toContain('请重新选择责任人')
    expect(guidance.textContent).toContain('不会自动换人')
    // 错误码可见（#348 的第二半：此前码只在响应里）；英文分类消息降级为排障细节。
    const diagnostics = screen.getByTestId('error-diagnostics')
    expect(diagnostics.textContent).toContain('VALIDATION_FAILED')
    expect(diagnostics.textContent).toContain('assignee is not an active team member')
    expect(diagnostics.textContent).toContain('requestId: req-4m')
    expect(posts).toBe(1)

    // 之后再提交：先被拦住（提示可见 + 按钮禁用 + 零新请求），不必等名册重拉。
    await waitFor(() =>
      expect(screen.getByTestId('selection-unavailable-hint')).toBeInTheDocument(),
    )
    const submit = screen.getByRole('button', { name: '创建任务' })
    expect(submit).toBeDisabled()
    await user.click(submit)
    expect(posts).toBe(1)

    // 重选（真人路径：菜单里换一个）→ 阻塞解除、可再次提交。
    await selectOption(user, '责任人', /Bob/)
    await waitFor(() =>
      expect(screen.queryByTestId('selection-unavailable-hint')).not.toBeInTheDocument(),
    )
    expect(screen.getByRole('button', { name: '创建任务' })).toBeEnabled()
  })

  it('Agent 变体：归档拒绝 → Agent 支的引导与提示（DOM 面，不只在纯函数里）', async () => {
    const user = userEvent.setup()
    renderApp(
      '/',
      loggedInHandlers(ALICE, [
        projectsHandler([PROJECT_VIEW]),
        teamMembersHandler(),
        agentsHandler([AGENT]),
        {
          method: 'POST',
          url: /\/api\/v1\/projects\/[^/]+\/tasks$/,
          respond: () => ({
            status: 400,
            body: {
              ok: false,
              error: {
                code: 'VALIDATION_FAILED',
                message: 'assignee agent not found or archived',
                requestId: 'req-4g',
              },
            },
          }),
        },
      ]),
    )
    await user.click(await screen.findByRole('button', { name: '创建任务' }))
    await user.type(await screen.findByLabelText('任务标题'), '让 Agent 写发布说明')
    // 开执行、选 Agent（自己是责任人 → 开关可用）。
    const form = within(screen.getByRole('form', { name: '创建任务' }))
    await user.click(form.getByRole('switch', { name: '创建后立即执行' }))
    await selectOption(user, '执行 Agent', /report-writer/)
    await user.click(form.getByRole('button', { name: /创建(任务|并开始执行)/ }))

    expect((await screen.findByTestId('error-guidance')).textContent).toContain('请重新选择 Agent')
    // 提示走 Agent 支（按被拒字段说人话）。
    await waitFor(() =>
      expect(screen.getByTestId('selection-unavailable-hint')).toHaveTextContent(
        '所选执行 Agent 当前不可用',
      ),
    )
  })

  it('评审 P1：Agent 被拒后关掉「创建后立即执行」→ 阻塞立即解除（该字段已退出请求）', async () => {
    const user = userEvent.setup()
    let posts = 0
    renderApp(
      '/',
      loggedInHandlers(ALICE, [
        projectsHandler([PROJECT_VIEW]),
        teamMembersHandler(),
        agentsHandler([AGENT]),
        {
          method: 'POST',
          url: /\/api\/v1\/projects\/[^/]+\/tasks$/,
          respond: () => {
            posts += 1
            return {
              status: 400,
              body: {
                ok: false,
                error: {
                  code: 'VALIDATION_FAILED',
                  message: 'assignee agent not found or archived',
                  requestId: 'req-4g',
                },
              },
            }
          },
        },
      ]),
    )
    await user.click(await screen.findByRole('button', { name: '创建任务' }))
    await user.type(await screen.findByLabelText('任务标题'), '先建任务，不执行')
    const form = within(screen.getByRole('form', { name: '创建任务' }))
    const toggle = form.getByRole('switch', { name: '创建后立即执行' })
    await user.click(toggle)
    await selectOption(user, '执行 Agent', /report-writer/)
    await user.click(form.getByRole('button', { name: /创建(任务|并开始执行)/ }))
    await waitFor(() =>
      expect(screen.getByTestId('selection-unavailable-hint')).toBeInTheDocument(),
    )

    // 关掉开关 → Agent 不再参与请求 → 阻塞与旧横幅都撤，按钮恢复。
    await user.click(toggle)
    await waitFor(() =>
      expect(screen.queryByTestId('selection-unavailable-hint')).not.toBeInTheDocument(),
    )
    expect(form.getByRole('button', { name: /创建(任务|并开始执行)/ })).toBeEnabled()
    expect(screen.queryByTestId('error-guidance')).not.toBeInTheDocument()
    expect(posts).toBe(1)
  })
})
