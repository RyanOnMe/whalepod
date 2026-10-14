import { screen, waitFor } from '@testing-library/react'
import { userEvent } from '@testing-library/user-event'
import { describe, expect, it } from 'vitest'
import { queryKeys } from '../src/app/query-client.js'
import {
  ALICE,
  BOB,
  deferredResponse,
  devicesHandler,
  loggedInHandlers,
  makeRun,
  makeDevice,
  makeTask,
  ok,
  taskRoomHandler,
  teamMembersHandler,
  workspacesHandler,
} from './fixtures.js'
import type { MockHandler } from './fixtures.js'
import { renderApp } from './render.jsx'
const AGENT = '00000000-0000-4000-8000-000000000010'
const REVISION = '00000000-0000-4000-8000-000000000011'
const NEW_REVISION = '00000000-0000-4000-8000-000000000012'
function agentHandlers(): MockHandler[] {
  return [
    {
      method: 'GET',
      url: /\/agents$/,
      respond: () =>
        ok([{ id: AGENT, name: 'Builder', archivedAt: null, currentRevisionId: NEW_REVISION }]),
    },
    {
      method: 'GET',
      url: new RegExp(`/agents/${AGENT}$`),
      respond: () =>
        ok({
          id: AGENT,
          name: 'Builder',
          currentRevisionId: NEW_REVISION,
          revisions: [
            {
              id: REVISION,
              revision: 1,
              approvalPolicy: 'approval_required',
              provider: 'replay',
              model: 'replay',
            },
            {
              id: NEW_REVISION,
              revision: 2,
              approvalPolicy: 'full_access',
              provider: 'replay',
              model: 'replay',
            },
          ],
        }),
    },
  ]
}
function sourceHandler(
  task: ReturnType<typeof makeTask>,
  run: ReturnType<typeof makeRun>,
  sessionId: string | null = 'context-id',
): MockHandler {
  return {
    method: 'GET',
    url: new RegExp(`/runs/${run.id}$`),
    respond: () =>
      ok({
        ...run,
        taskId: task.id,
        ownerUserId: task.assigneeUserId,
        agentId: AGENT,
        profileRevisionId: REVISION,
        dshSessionId: sessionId,
        approvalPolicy: run.approvalPolicy,
      }),
  }
}
async function mode(user: ReturnType<typeof userEvent.setup>, label: RegExp): Promise<void> {
  await user.click(screen.getByLabelText('执行方式'))
  await user.click(screen.getByRole('menuitem', { name: label }))
}
describe('#315 统一执行入口的真人页面', () => {
  it.each(['success', 'failure'] as const)(
    '首次执行请求 %s 返回前锁定方式与草稿，返回后恢复操作',
    async (result) => {
      const task = makeTask({ assignmentStatus: 'accepted', approvalPolicy: 'approval_required' })
      const history = makeRun({ status: 'completed' })
      const device = makeDevice()
      const request = deferredResponse()
      const user = userEvent.setup()
      const view = renderApp(
        `/tasks/${task.id}`,
        loggedInHandlers(BOB, [
          taskRoomHandler(task, { runs: [history] }),
          sourceHandler(task, history),
          ...agentHandlers(),
          teamMembersHandler(),
          devicesHandler([device]),
          workspacesHandler([
            {
              workspaceId: '00000000-0000-4000-8000-000000000021',
              deviceId: device.id,
              name: 'repo',
              kind: 'directory',
              available: true,
            },
          ]),
          { method: 'POST', url: /\/instructions$/, respond: () => request.promise },
        ]),
      )
      await user.click(await screen.findByLabelText('选择 Agent'))
      await user.click(await screen.findByRole('menuitem', { name: 'Builder' }))
      const box = await screen.findByLabelText('指令')
      await user.type(box, '这次先提交的草稿')
      const send = screen.getByRole('button', { name: '开始执行' })
      await waitFor(() => expect(send).toBeEnabled())
      await user.click(send)
      await waitFor(() => expect(send).toHaveAttribute('data-feedback', 'pending'))
      const chooser = screen.getByLabelText('执行方式')
      expect(chooser).toBeDisabled()
      await user.click(chooser)
      expect(screen.queryByRole('menu')).toBeNull()
      expect(box).toBeDisabled()
      expect(box).toHaveValue('这次先提交的草稿')
      expect(
        view.fetchMock.mock.calls.filter(([url]) => String(url).endsWith('/instructions')),
      ).toHaveLength(1)
      request.resolve(
        result === 'success'
          ? ok({ outcome: 'started_run', runId: history.id, instructionState: 'pending' })
          : {
              status: 503,
              body: {
                ok: false,
                error: { code: 'INTERNAL_ERROR', message: '稍后重试', requestId: 'pending-new' },
              },
            },
      )
      await waitFor(() => expect(chooser).toBeEnabled())
      if (result === 'failure') {
        expect(box).toHaveValue('这次先提交的草稿')
        expect(await screen.findByText(/稍后重试/)).toBeVisible()
      }
      await mode(user, /继续会话/)
      const continued = await screen.findByLabelText('指令')
      await waitFor(() => expect(continued).toBeEnabled())
      await user.clear(continued)
      await user.type(continued, '返回后继续编辑的新草稿')
      expect(continued).toHaveValue('返回后继续编辑的新草稿')
      expect(screen.getByLabelText('来源执行')).toBeEnabled()
    },
  )

  it('续跑请求未返回时，锁定来源、执行方式及草稿；失败后保留原意图', async () => {
    const task = makeTask({ assignmentStatus: 'accepted' })
    const first = makeRun({ status: 'completed' })
    const second = makeRun({ status: 'completed' })
    const request = deferredResponse()
    const user = userEvent.setup()
    renderApp(
      `/tasks/${task.id}`,
      loggedInHandlers(BOB, [
        taskRoomHandler(task, { runs: [first, second] }),
        sourceHandler(task, first),
        sourceHandler(task, second),
        ...agentHandlers(),
        teamMembersHandler(),
        devicesHandler([]),
        workspacesHandler([]),
        { method: 'POST', url: /\/instructions$/, respond: () => request.promise },
      ]),
    )
    await screen.findByLabelText('执行方式')
    await mode(user, /继续会话/)
    const source = screen.getByLabelText('来源执行')
    const chosenLabel = source.textContent
    const box = await screen.findByLabelText('指令')
    await waitFor(() => expect(box).toBeEnabled())
    await user.type(box, '继续原会话的草稿')
    await user.click(screen.getByRole('button', { name: '继续会话' }))
    await waitFor(() => expect(source).toBeDisabled())
    expect(screen.getByLabelText('执行方式')).toBeDisabled()
    expect(box).toBeDisabled()
    await user.click(source)
    expect(screen.queryByRole('menu')).toBeNull()
    request.resolve({
      status: 503,
      body: {
        ok: false,
        error: { code: 'INTERNAL_ERROR', message: '发送失败', requestId: 'pending-resume' },
      },
    })
    await waitFor(() => expect(source).toBeEnabled())
    expect(source).toHaveTextContent(chosenLabel!)
    expect(box).toBeEnabled()
    expect(box).toHaveValue('继续原会话的草稿')
  })

  it('追问钉住接收者、来源和运行固化审批档', async () => {
    const task = makeTask({ assignmentStatus: 'accepted' })
    const run = makeRun({ status: 'running' })
    const user = userEvent.setup()
    const view = renderApp(
      `/tasks/${task.id}`,
      loggedInHandlers(BOB, [
        taskRoomHandler(task, { runs: [run] }),
        sourceHandler(task, run),
        ...agentHandlers(),
        teamMembersHandler(),
        {
          method: 'POST',
          url: /\/instructions$/,
          respond: () => ok({ outcome: 'followup', runId: run.id, instructionState: 'accepted' }),
        },
      ]),
    )
    const box = await screen.findByLabelText('指令')
    await waitFor(() => expect(box).toBeEnabled())
    expect(screen.getByTestId('execution-context')).toHaveTextContent('Builder')
    expect(screen.getByTestId('instruction-approval-pill')).toHaveTextContent('当前运行')
    await user.type(box, '检查上文')
    await user.click(screen.getByRole('button', { name: '发送追问' }))
    await waitFor(() =>
      expect(view.fetchMock.mock.calls.some(([url]) => String(url).endsWith('/instructions'))).toBe(
        true,
      ),
    )
    const post = view.fetchMock.mock.calls.find(([url]) => String(url).endsWith('/instructions'))!
    expect(JSON.parse(String(post[1]!.body))).toEqual({
      text: '检查上文',
      intent: { kind: 'followup', runId: run.id },
      expectedApprovalPolicy: 'approval_required',
    })
  })

  it('后台终态阻塞原追问，切换新执行仍保留同一草稿', async () => {
    const task = makeTask({ assignmentStatus: 'accepted' })
    const run = makeRun({ status: 'running' })
    const user = userEvent.setup()
    const view = renderApp(
      `/tasks/${task.id}`,
      loggedInHandlers(BOB, [
        taskRoomHandler(task, { runs: [run] }),
        sourceHandler(task, run),
        ...agentHandlers(),
        teamMembersHandler(),
        devicesHandler([]),
        workspacesHandler([]),
      ]),
    )
    const box = await screen.findByLabelText('指令')
    await waitFor(() => expect(box).toBeEnabled())
    await user.type(box, '不要丢这段话')
    view.queryClient.setQueryData(queryKeys.taskRoom(task.id), {
      task,
      comments: [],
      instructions: [],
      artifacts: [],
      runs: [{ ...run, status: 'completed' }],
      nextRunApprovalPolicy: null,
    })
    expect(await screen.findByTestId('execution-blocker')).toHaveTextContent('草稿仍保留')
    expect(box).toHaveValue('不要丢这段话')
    expect(screen.getByRole('button', { name: '发送追问' })).toBeDisabled()
    await mode(user, /开始新执行/)
    expect(await screen.findByLabelText('指令')).toHaveValue('不要丢这段话')
    expect(
      view.fetchMock.mock.calls.filter(([url]) => String(url).endsWith('/instructions')),
    ).toHaveLength(0)
  })

  it('续跑使用来源版本审批默认，不继承 Agent 后来升级的完全权限', async () => {
    const task = makeTask({ assignmentStatus: 'accepted' })
    const run = makeRun({ status: 'completed' })
    const user = userEvent.setup()
    const view = renderApp(
      `/tasks/${task.id}`,
      loggedInHandlers(BOB, [
        taskRoomHandler(task, { runs: [run] }),
        sourceHandler(task, run),
        ...agentHandlers(),
        teamMembersHandler(),
        devicesHandler([]),
        workspacesHandler([]),
        {
          method: 'POST',
          url: /\/instructions$/,
          respond: () => ok({ outcome: 'started_run', runId: null, instructionState: 'pending' }),
        },
      ]),
    )
    await screen.findByLabelText('执行方式')
    await mode(user, /继续会话/)
    const box = await screen.findByLabelText('指令')
    await waitFor(() => expect(box).toBeEnabled())
    expect(screen.getByTestId('instruction-approval-pill')).toHaveTextContent('需要逐次批准')
    expect(screen.getByTestId('execution-context')).toHaveTextContent('沿用来源配置版本')
    await user.type(box, '接着上文')
    await user.click(screen.getByRole('button', { name: '继续会话' }))
    await waitFor(() =>
      expect(view.fetchMock.mock.calls.some(([url]) => String(url).endsWith('/instructions'))).toBe(
        true,
      ),
    )
    const post = view.fetchMock.mock.calls.find(([url]) => String(url).endsWith('/instructions'))!
    expect(JSON.parse(String(post[1]!.body))).toEqual({
      text: '接着上文',
      intent: { kind: 'resume', runId: run.id },
      expectedApprovalPolicy: 'approval_required',
    })
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('无会话来源不假装可续跑', async () => {
    const task = makeTask({ assignmentStatus: 'accepted' })
    const run = makeRun({ status: 'failed' })
    const user = userEvent.setup()
    renderApp(
      `/tasks/${task.id}`,
      loggedInHandlers(BOB, [
        taskRoomHandler(task, { runs: [run] }),
        sourceHandler(task, run, null),
        ...agentHandlers(),
        teamMembersHandler(),
        devicesHandler([]),
        workspacesHandler([]),
      ]),
    )
    await screen.findByLabelText('执行方式')
    await mode(user, /继续会话/)
    expect(await screen.findByText('这次执行没有可续接的会话，请开始新执行。')).toBeVisible()
    expect(screen.getByRole('button', { name: '继续会话' })).toBeDisabled()
  })

  it('无指令权显示可协作说明，无发送输入', async () => {
    const task = makeTask({ assignmentStatus: 'accepted', assigneeUserId: ALICE.userId })
    renderApp(
      `/tasks/${task.id}`,
      loggedInHandlers(BOB, [
        taskRoomHandler(task),
        teamMembersHandler(),
        {
          method: 'GET',
          url: /instruction-grants$/,
          respond: () => ok([{ userId: ALICE.userId, reason: 'assignee' }]),
        },
      ]),
    )
    expect(await screen.findByText(/只有责任人和已授权成员可以发送指令/)).toBeVisible()
    expect(screen.queryByLabelText('指令')).toBeNull()
    expect(screen.getByLabelText('留言')).toBeEnabled()
  })

  it('确认权限失败不同于无权，不开放发送', async () => {
    const task = makeTask({ assignmentStatus: 'accepted', assigneeUserId: ALICE.userId })
    renderApp(
      `/tasks/${task.id}`,
      loggedInHandlers(BOB, [
        taskRoomHandler(task),
        teamMembersHandler(),
        {
          method: 'GET',
          url: /instruction-grants$/,
          respond: () => ({
            status: 500,
            body: {
              ok: false,
              error: { code: 'INTERNAL_ERROR', message: 'unavailable', requestId: 'req-grants' },
            },
          }),
        },
      ]),
    )
    expect(await screen.findByText('暂时无法确认权限，请重试。')).toBeVisible()
    expect(screen.queryByLabelText('指令')).toBeNull()
    expect(screen.getByRole('button', { name: '重新确认' })).toBeEnabled()
  })

  it('授权加载中不开放输入，成功后不读取责任人私有环境清单', async () => {
    const task = makeTask({ assignmentStatus: 'accepted', assigneeUserId: ALICE.userId })
    const slow = deferredResponse()
    const view = renderApp(
      `/tasks/${task.id}`,
      loggedInHandlers(BOB, [
        taskRoomHandler(task),
        ...agentHandlers(),
        teamMembersHandler(),
        { method: 'GET', url: /instruction-grants$/, respond: () => slow.promise },
      ]),
    )
    expect(await screen.findByText('正在确认操作权限…')).toBeVisible()
    expect(screen.queryByLabelText('指令')).toBeNull()
    slow.resolve(ok([{ userId: BOB.userId, reason: 'granted' }]))
    expect(await screen.findByTestId('target-readonly')).toHaveTextContent('执行会在')
    expect(
      view.fetchMock.mock.calls.some(([url]) => /\/(devices|workspaces)$/.test(String(url))),
    ).toBe(false)
  })
})
