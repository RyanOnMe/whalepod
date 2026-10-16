import { act, screen, waitFor } from '@testing-library/react'
import { userEvent } from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
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
function agentHandlers(archived: () => boolean = () => false): MockHandler[] {
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
          archivedAt: archived() ? '2026-08-25T00:00:00.000Z' : null,
          currentRevisionId: NEW_REVISION,
          revisions: [
            {
              id: REVISION,
              revision: 1,
              approvalPolicy: 'approval_required',
              provider: 'replay',
              credentialSlot: 'default',
              model: 'replay',
            },
            {
              id: NEW_REVISION,
              revision: 2,
              approvalPolicy: 'full_access',
              provider: 'replay',
              credentialSlot: 'default',
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

function draftNavigationFixture(active = false, history = false, delegated = false) {
  const task = makeTask({
    title: '准备工作甲',
    assigneeUserId: delegated ? ALICE.userId : BOB.userId,
    assignmentStatus: 'accepted',
    approvalPolicy: 'approval_required',
  })
  const other = makeTask({
    title: '准备工作乙',
    assignmentStatus: 'accepted',
    approvalPolicy: 'approval_required',
  })
  const run = makeRun({ status: active ? 'running' : 'completed' })
  const device = makeDevice()
  const workspaceId = '00000000-0000-4000-8000-000000000021'
  const state = {
    task,
    roomGate: undefined as Promise<void> | undefined,
    grantsGate: undefined as Promise<void> | undefined,
    grantError: false,
    roomFail: false,
    granted: delegated,
    archived: false,
    running: active,
    history,
    session: BOB as typeof BOB | null,
    nextSession: BOB,
    request: undefined as ReturnType<typeof deferredResponse> | undefined,
    fail: false,
  }
  const handlers: MockHandler[] = [
    {
      method: 'GET',
      url: /\/auth\/session$/,
      respond: () =>
        state.session
          ? ok(state.session)
          : {
              status: 401,
              body: {
                ok: false,
                error: { code: 'AUTH_REQUIRED', message: '请登录', requestId: 'draft-session' },
              },
            },
    },
    {
      method: 'POST',
      url: /\/auth\/logout$/,
      respond: () => {
        state.session = null
        return ok({})
      },
    },
    {
      method: 'POST',
      url: /\/auth\/login$/,
      respond: () => {
        state.session = state.nextSession
        return ok({ userId: state.nextSession.userId })
      },
    },
    ...loggedInHandlers(BOB, [
      {
        method: 'GET',
        url: new RegExp(`/tasks/${task.id}$`),
        respond: async () => {
          await state.roomGate
          if (state.roomFail)
            return {
              status: 503,
              body: {
                ok: false,
                error: {
                  code: 'INTERNAL_ERROR',
                  message: '任务暂不可读',
                  requestId: 'task-recheck',
                },
              },
            }
          return state.session === null
            ? {
                status: 401,
                body: {
                  ok: false,
                  error: {
                    code: 'AUTH_REQUIRED',
                    message: '登录已过期',
                    requestId: 'draft-expired',
                  },
                },
              }
            : taskRoomHandler(state.task, {
                runs: state.running
                  ? [{ ...run, status: 'running' }]
                  : state.history
                    ? [{ ...run, status: 'completed' }]
                    : [],
              }).respond({})
        },
      },
      taskRoomHandler(other),
      sourceHandler(task, run),
      {
        method: 'GET',
        url: /\/agents$/,
        respond: () =>
          ok([
            {
              id: AGENT,
              name: 'Builder',
              archivedAt: state.archived ? task.createdAt : null,
              currentRevisionId: NEW_REVISION,
            },
          ]),
      },
      ...agentHandlers(() => state.archived),
      teamMembersHandler(),
      devicesHandler([device]),
      workspacesHandler([
        { workspaceId, deviceId: device.id, name: 'repo', kind: 'directory', available: true },
      ]),
      { method: 'GET', url: /\/projects$/, respond: () => ok([]) },
      {
        method: 'GET',
        url: /\/tasks\/recent$/,
        respond: () =>
          ok(
            [task, other].map((t) => ({
              id: t.id,
              title: t.title,
              status: t.status,
              projectName: '项目甲',
              lastActiveAt: t.updatedAt,
            })),
          ),
      },
      { method: 'GET', url: /\/events(?:\?.*)?$/, respond: () => ok({ events: [] }) },
      {
        method: 'GET',
        url: /\/instruction-grants$/,
        respond: async () => {
          await state.grantsGate
          return state.grantError
            ? {
                status: 503,
                body: {
                  ok: false,
                  error: {
                    code: 'INTERNAL_ERROR',
                    message: '授权暂不可读',
                    requestId: 'grant-recheck',
                  },
                },
              }
            : ok(state.granted ? [{ userId: BOB.userId, reason: 'granted' }] : [])
        },
      },
      {
        method: 'POST',
        url: /\/preparation-check$/,
        respond: () =>
          ok({
            checkedAt: new Date().toISOString(),
            profileRevisionId: NEW_REVISION,
            deviceId: device.id,
            workspaceId,
            deviceName: device.name,
            workspaceName: 'repo',
            workspace: 'available',
            credential: 'configured',
            modelCall: 'not_tested',
          }),
      },
      {
        method: 'POST',
        url: /\/instructions$/,
        respond: () =>
          state.request
            ? state.request.promise
            : state.fail
              ? {
                  status: 503,
                  body: {
                    ok: false,
                    error: {
                      code: 'INTERNAL_ERROR',
                      message: '暂时无法确认受理',
                      requestId: 'draft-request',
                    },
                  },
                }
              : ok({ outcome: 'started_run', runId: run.id, instructionState: 'pending' }),
      },
    ]),
  ]
  const view = renderApp(`/tasks/${task.id}`, handlers)
  return { ...view, handlers, task, other, run, device, workspaceId, state }
}
async function selectDraftAgent(user: ReturnType<typeof userEvent.setup>) {
  await user.click(await screen.findByLabelText('选择 Agent'))
  await user.click(await screen.findByRole('menuitem', { name: 'Builder' }))
  await waitFor(() => expect(screen.getByLabelText('选择 Revision')).toHaveTextContent('r2'))
}
async function leaveForDevices(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole('link', { name: '设备' }))
  await screen.findByRole('heading', { name: '设备', level: 1 })
}
async function returnToDraft(user: ReturnType<typeof userEvent.setup>, title: string) {
  await user.click(screen.getByRole('link', { name: new RegExp(`^${title}`) }))
  await screen.findByRole('heading', { name: title, level: 1 })
}
describe('#337 当前会话中的执行草稿', () => {
  it('去设备页再回任务保留草稿和固定Agent版本，不发指令', async () => {
    const user = userEvent.setup()
    const f = draftNavigationFixture()
    await selectDraftAgent(user)
    await user.click(screen.getByText('执行设置（配置版本与环境）'))
    await user.click(screen.getByLabelText('选择 Revision'))
    await user.click(screen.getByRole('menuitem', { name: /^r1 / }))
    await user.click(screen.getByLabelText('选择设备'))
    await user.click(screen.getByRole('menuitem', { name: new RegExp(f.device.name) }))
    await user.click(screen.getByLabelText('选择 Workspace'))
    await user.click(screen.getByRole('menuitem', { name: 'repo' }))
    await user.type(screen.getByLabelText('指令'), '离开准备页也不能丢失的正文')
    await leaveForDevices(user)
    await returnToDraft(user, f.task.title)
    expect(screen.getByLabelText('指令')).toHaveValue('离开准备页也不能丢失的正文')
    expect(screen.getByLabelText('选择 Agent')).toHaveTextContent('Builder')
    expect(screen.getByLabelText('选择 Revision')).toHaveTextContent('r1')
    expect(screen.getByLabelText('选择设备')).toHaveTextContent(f.device.name)
    expect(screen.getByLabelText('选择 Workspace')).toHaveTextContent('repo')
    expect(
      f.fetchMock.mock.calls.some(
        ([url, init]) => String(url).endsWith('/instructions') && init?.method === 'POST',
      ),
    ).toBe(false)
  })
  it('两个任务分别保留自己的草稿，显式清除不发请求', async () => {
    const user = userEvent.setup()
    const f = draftNavigationFixture()
    await user.type(await screen.findByLabelText('指令'), '甲的草稿')
    await returnToDraft(user, f.other.title)
    expect(screen.getByLabelText('指令')).toHaveValue('')
    await user.type(screen.getByLabelText('指令'), '乙的草稿')
    await returnToDraft(user, f.task.title)
    expect(screen.getByLabelText('指令')).toHaveValue('甲的草稿')
    await user.click(screen.getByRole('button', { name: '清除当前执行草稿' }))
    expect(screen.getByLabelText('指令')).toHaveValue('')
    await returnToDraft(user, f.other.title)
    expect(screen.getByLabelText('指令')).toHaveValue('乙的草稿')
  })
  it('待发请求跨页仍锁定，返回不重发，确认受理后才清理正文', async () => {
    const user = userEvent.setup()
    const f = draftNavigationFixture()
    f.state.request = deferredResponse()
    await selectDraftAgent(user)
    await user.type(screen.getByLabelText('指令'), '等待确认受理的正文')
    await user.click(screen.getByRole('button', { name: '开始执行' }))
    await waitFor(() => expect(screen.getByLabelText('执行方式')).toBeDisabled())
    await leaveForDevices(user)
    await returnToDraft(user, f.task.title)
    expect(screen.getByLabelText('执行方式')).toBeDisabled()
    expect(screen.getByLabelText('指令')).toHaveValue('等待确认受理的正文')
    expect(
      f.fetchMock.mock.calls.filter(
        ([url, init]) => String(url).endsWith('/instructions') && init?.method === 'POST',
      ),
    ).toHaveLength(1)
    await act(async () => {
      f.state.running = true
      f.state.request!.resolve(
        ok({ outcome: 'started_run', runId: f.run.id, instructionState: 'pending' }),
      )
    })
    await waitFor(() => expect(screen.getByLabelText('执行方式')).toBeEnabled())
    expect(screen.getByLabelText('指令')).toHaveValue('')
    await leaveForDevices(user)
    await returnToDraft(user, f.task.title)
    expect(screen.getByLabelText('指令')).toHaveValue('')
  })
  it('未确认受理的相同正文返回重试沿用幂等键', async () => {
    const user = userEvent.setup()
    const f = draftNavigationFixture()
    f.state.fail = true
    await selectDraftAgent(user)
    await user.type(screen.getByLabelText('指令'), '失败后不应变成另一次指令')
    await user.click(screen.getByRole('button', { name: '开始执行' }))
    await screen.findByText(/暂时无法确认受理/)
    const calls = () =>
      f.fetchMock.mock.calls.filter(
        ([url, init]) => String(url).endsWith('/instructions') && init?.method === 'POST',
      )
    const first = new Headers(calls()[0]?.[1]?.headers).get('idempotency-key')
    await leaveForDevices(user)
    await returnToDraft(user, f.task.title)
    expect(screen.getByLabelText('指令')).toHaveValue('失败后不应变成另一次指令')
    await user.click(screen.getByRole('button', { name: '开始执行' }))
    await waitFor(() => expect(calls()).toHaveLength(2))
    expect(new Headers(calls()[1]?.[1]?.headers).get('idempotency-key')).toBe(first)
  })
  it('责任人改变后保留正文但不沿旧安排发送', async () => {
    const user = userEvent.setup()
    const f = draftNavigationFixture()
    await selectDraftAgent(user)
    await user.type(screen.getByLabelText('指令'), '只针对原责任人环境的安排')
    await leaveForDevices(user)
    f.state.task = { ...f.task, assigneeUserId: ALICE.userId }
    await f.queryClient.invalidateQueries({ queryKey: queryKeys.taskRoom(f.task.id) })
    await returnToDraft(user, f.task.title)
    expect(screen.getByLabelText('指令')).toHaveValue('只针对原责任人环境的安排')
    expect(screen.getByTestId('execution-blocker')).toHaveTextContent('责任人已变化')
    expect(screen.getByRole('button', { name: '开始执行' })).toBeDisabled()
  })
})

describe('#337 草稿身份与来源边界', () => {
  it('来源执行在离开期间结束后保留追问意图，不转成新执行', async () => {
    const user = userEvent.setup()
    const f = draftNavigationFixture(true)
    const box = await screen.findByLabelText('指令')
    await waitFor(() => expect(box).toBeEnabled())
    await user.type(box, '仅发往原活跃执行')
    expect(box).toHaveValue('仅发往原活跃执行')
    await leaveForDevices(user)
    f.state.running = false
    await f.queryClient.invalidateQueries({ queryKey: queryKeys.taskRoom(f.task.id) })
    await returnToDraft(user, f.task.title)
    expect(screen.getByLabelText('指令')).toHaveValue('仅发往原活跃执行')
    expect(screen.getByLabelText('执行方式')).toHaveTextContent('发送追问')
    expect(screen.getByTestId('execution-blocker')).toHaveTextContent('所选执行已结束')
    expect(
      f.fetchMock.mock.calls.some(
        ([url, init]) => String(url).endsWith('/instructions') && init?.method === 'POST',
      ),
    ).toBe(false)
  })
  it('返回仍使用指定续跑来源与不可变版本，不选最新Agent配置', async () => {
    const user = userEvent.setup()
    const f = draftNavigationFixture(false, true)
    await screen.findByLabelText('执行方式')
    await mode(user, /继续会话/)
    await user.type(await screen.findByLabelText('指令'), '接着明确选择的来源继续')
    await leaveForDevices(user)
    await returnToDraft(user, f.task.title)
    expect(screen.getByLabelText('执行方式')).toHaveTextContent('继续会话')
    expect(screen.getByLabelText('指令')).toHaveValue('接着明确选择的来源继续')
    expect(screen.getByLabelText('来源执行')).toHaveTextContent('第 1 次运行')
    await waitFor(() => expect(screen.getByTestId('execution-context')).toHaveTextContent('r1'))
  })
  it.each(['same', 'other'] as const)('退出再登录清空草稿：%s actor', async (actor) => {
    const user = userEvent.setup()
    const f = draftNavigationFixture()
    await user.type(await screen.findByLabelText('指令'), '只属于旧登录会话的文字')
    await user.click(screen.getByRole('button', { name: '退出登录' }))
    await screen.findByRole('heading', { name: '登录', level: 1 })
    f.state.nextSession = actor === 'same' ? BOB : ALICE
    await user.type(screen.getByLabelText('用户名'), 'fixture-member')
    await user.type(screen.getByLabelText('密码'), 'correct horse battery staple')
    await user.click(screen.getByRole('button', { name: '登录' }))
    await screen.findByRole('button', { name: '退出登录' })
    await returnToDraft(user, f.task.title)
    if (actor === 'same') expect(screen.getByLabelText('指令')).toHaveValue('')
    else expect(screen.queryByLabelText('指令')).toBeNull()
    expect(screen.queryByDisplayValue('只属于旧登录会话的文字')).toBeNull()
  })
  it('刷新式重挂不恢复草稿，不向浏览器持久存储写正文', async () => {
    const user = userEvent.setup()
    const f = draftNavigationFixture()
    const storage = vi.spyOn(Storage.prototype, 'setItem')
    await user.type(await screen.findByLabelText('指令'), '只允许当前页面内存保存')
    await leaveForDevices(user)
    await returnToDraft(user, f.task.title)
    expect(screen.getByLabelText('指令')).toHaveValue('只允许当前页面内存保存')
    expect(storage.mock.calls.some(([, value]) => value.includes('只允许当前页面内存保存'))).toBe(
      false,
    )
    storage.mockRestore()
    f.unmount()
    renderApp(`/tasks/${f.task.id}`, f.handlers)
    expect(await screen.findByLabelText('指令')).toHaveValue('')
  })
})

it('#337 会话过期后重新登录不恢复旧正文', async () => {
  const user = userEvent.setup()
  const f = draftNavigationFixture()
  await user.type(await screen.findByLabelText('指令'), '会话过期应丢弃的正文')
  f.state.session = null
  await act(async () => {
    await f.queryClient.invalidateQueries({ queryKey: queryKeys.taskRoom(f.task.id) })
  })
  await screen.findByRole('button', { name: '登录' })
  await user.type(screen.getByLabelText('用户名'), 'fixture-member')
  await user.type(screen.getByLabelText('密码'), 'correct horse battery staple')
  await user.click(screen.getByRole('button', { name: '登录' }))
  await screen.findByRole('heading', { name: f.task.title, level: 1 })
  expect(await screen.findByLabelText('指令')).toHaveValue('')
})

describe('#338 首次准备往返与当前条件', () => {
  it('从准备入口进入设备页，有明确返回原任务并聚焦的动作', async () => {
    const user = userEvent.setup()
    const f = draftNavigationFixture()
    await selectDraftAgent(user)
    await user.type(screen.getByLabelText('指令'), '返回原任务的正文')
    const setup = screen.getByRole('link', { name: '安装并配对执行服务' })
    expect(setup).toHaveAttribute('href', `/devices?preparationTask=${f.task.id}`)
    await user.click(setup)
    const back = await screen.findByRole('link', { name: '返回任务继续准备' })
    expect(back).toHaveAttribute('href', `/tasks/${f.task.id}#task-execution`)
    await user.click(back)
    await waitFor(() => expect(document.getElementById('task-execution')).toHaveFocus())
    expect(screen.getByLabelText('指令')).toHaveValue('返回原任务的正文')
    expect(f.fetchMock.mock.calls.some(([, init]) => init?.method === 'POST')).toBe(false)
  })
  it('成功旧缓存返回先确认当前任务，响应到达前不能发送', async () => {
    const user = userEvent.setup()
    const f = draftNavigationFixture()
    await selectDraftAgent(user)
    await user.type(screen.getByLabelText('指令'), '等当前任务确认后再发送')
    await leaveForDevices(user)
    let release!: () => void
    f.state.roomGate = new Promise<void>((resolve) => {
      release = resolve
    })
    await returnToDraft(user, f.task.title)
    expect(screen.getByTestId('execution-blocker')).toHaveTextContent('重新确认任务')
    expect(screen.getByRole('button', { name: '开始执行' })).toBeDisabled()
    expect(screen.getByLabelText('指令')).toHaveValue('等当前任务确认后再发送')
    await act(async () => release())
    await waitFor(() => expect(screen.getByRole('button', { name: '开始执行' })).toBeEnabled())
  })
  it('离开期间设备离线后，返回重读而不改选其他目标', async () => {
    const user = userEvent.setup()
    const f = draftNavigationFixture()
    await selectDraftAgent(user)
    await user.type(screen.getByLabelText('指令'), '固定本人执行现场')
    await user.click(screen.getByText('执行设置（配置版本与环境）'))
    await user.click(screen.getByLabelText('选择设备'))
    await user.click(screen.getByRole('menuitem', { name: new RegExp(f.device.name) }))
    await user.click(screen.getByLabelText('选择 Workspace'))
    await user.click(screen.getByRole('menuitem', { name: 'repo' }))
    await leaveForDevices(user)
    f.device.status = 'offline'
    await returnToDraft(user, f.task.title)
    await waitFor(() =>
      expect(screen.getByTestId('execution-target-blocker')).toHaveTextContent('离线'),
    )
    expect(screen.getByRole('button', { name: '开始执行' })).toBeDisabled()
    expect(screen.getByTestId('execution-target-summary')).toHaveTextContent(
      `显式指定：${f.device.name}`,
    )
    expect(screen.getByLabelText('指令')).toHaveValue('固定本人执行现场')
  })
  it.each(['revoked', 'error'] as const)('返回重新确认协作权限：%s', async (result) => {
    const user = userEvent.setup()
    const f = draftNavigationFixture(false, false, true)
    await selectDraftAgent(user)
    await user.type(screen.getByLabelText('指令'), '协作者的原草稿')
    await leaveForDevices(user)
    f.state.granted = false
    f.state.grantError = result === 'error'
    await returnToDraft(user, f.task.title)
    await waitFor(() =>
      expect(screen.getByTestId('execution-blocker')).toHaveTextContent(
        result === 'error' ? '暂时无法确认权限' : '只有责任人和已授权成员',
      ),
    )
    expect(screen.getByLabelText('指令')).toHaveValue('协作者的原草稿')
    expect(screen.getByRole('button', { name: '开始执行' })).toBeDisabled()
    expect(screen.queryByRole('button', { name: '检查本次准备条件' })).toBeNull()
  })
  it('返回重新读取Agent归档状态，不用旧成功配置继续发送', async () => {
    const user = userEvent.setup()
    const f = draftNavigationFixture()
    await selectDraftAgent(user)
    await user.type(screen.getByLabelText('指令'), '原先选择的执行者')
    await leaveForDevices(user)
    f.state.archived = true
    await returnToDraft(user, f.task.title)
    await waitFor(() =>
      expect(screen.getByTestId('execution-configuration-blocker')).toHaveTextContent('不可用'),
    )
    expect(screen.getByRole('button', { name: '开始执行' })).toBeDisabled()
    expect(screen.getByLabelText('指令')).toHaveValue('原先选择的执行者')
  })
  it('离开再返回不复用准备检查成功，也不自动重查Node', async () => {
    const user = userEvent.setup()
    const f = draftNavigationFixture()
    await selectDraftAgent(user)
    await user.click(screen.getByRole('button', { name: '检查本次准备条件' }))
    await waitFor(() =>
      expect(screen.getByTestId('preparation-status')).toHaveTextContent('已确认可用'),
    )
    await user.click(screen.getByRole('link', { name: '安装并配对执行服务' }))
    await user.click(await screen.findByRole('link', { name: '返回任务继续准备' }))
    await waitFor(() =>
      expect(screen.getByTestId('preparation-status')).toHaveTextContent('尚未确认'),
    )
    expect(
      f.fetchMock.mock.calls.filter(
        ([url, init]) => String(url).endsWith('/preparation-check') && init?.method === 'POST',
      ),
    ).toHaveLength(1)
  })
})

describe('#338 返回边界与读取恢复', () => {
  it.each(['https://example.invalid/task', '00000000-0000-4000-8000-000000000099'])(
    '设备页不从外部或其他会话参数制造返回上下文：%s',
    async (value) => {
      const f = renderApp(
        `/devices?preparationTask=${encodeURIComponent(value)}`,
        loggedInHandlers(BOB, [
          devicesHandler([]),
          { method: 'GET', url: /\/tasks\/recent$/, respond: () => ok([]) },
        ]),
      )
      await screen.findByRole('heading', { name: '设备', level: 1 })
      expect(screen.queryByRole('link', { name: '返回任务继续准备' })).toBeNull()
      expect(
        f.fetchMock.mock.calls.some(([url]) =>
          /\/tasks\/[0-9a-f-]{36}(?:$|[/?#])/.test(String(url)),
        ),
      ).toBe(false)
    },
  )
  it('缓存授权仍在时等待新读数，不把未知权限当作已允许', async () => {
    const user = userEvent.setup()
    const f = draftNavigationFixture(false, false, true)
    await selectDraftAgent(user)
    await user.type(screen.getByLabelText('指令'), '等待当前授权确认')
    await leaveForDevices(user)
    let release!: () => void
    f.state.grantsGate = new Promise<void>((resolve) => {
      release = resolve
    })
    await returnToDraft(user, f.task.title)
    await waitFor(() =>
      expect(screen.getByTestId('execution-blocker')).toHaveTextContent('正在确认操作权限'),
    )
    expect(screen.getByRole('button', { name: '开始执行' })).toBeDisabled()
    f.state.granted = false
    await act(async () => release())
    await waitFor(() =>
      expect(screen.getByTestId('execution-blocker')).toHaveTextContent('只有责任人和已授权成员'),
    )
    expect(screen.getByLabelText('指令')).toHaveValue('等待当前授权确认')
  })
  it('权限读取失败可重试恢复，正文不丢且不触发执行', async () => {
    const user = userEvent.setup()
    const f = draftNavigationFixture(false, false, true)
    await selectDraftAgent(user)
    await user.type(screen.getByLabelText('指令'), '读取失败也保留正文')
    await leaveForDevices(user)
    f.state.grantError = true
    await returnToDraft(user, f.task.title)
    await waitFor(() =>
      expect(screen.getByTestId('execution-blocker')).toHaveTextContent('暂时无法确认权限'),
    )
    f.state.grantError = false
    await user.click(screen.getByRole('button', { name: '重新确认' }))
    await waitFor(() => expect(screen.getByRole('button', { name: '开始执行' })).toBeEnabled())
    expect(screen.getByLabelText('指令')).toHaveValue('读取失败也保留正文')
    expect(
      f.fetchMock.mock.calls.some(
        ([url, init]) => String(url).endsWith('/instructions') && init?.method === 'POST',
      ),
    ).toBe(false)
  })
  it('来源Agent归档后不静默开新执行', async () => {
    const user = userEvent.setup()
    const f = draftNavigationFixture(false, true)
    await screen.findByLabelText('执行方式')
    await mode(user, /继续会话/)
    const box = await screen.findByLabelText('指令')
    await waitFor(() => expect(box).toBeEnabled())
    await user.type(box, '只继续这个来源会话')
    await leaveForDevices(user)
    f.state.archived = true
    await returnToDraft(user, f.task.title)
    await waitFor(() =>
      expect(screen.getByTestId('execution-blocker')).toHaveTextContent('来源 Agent 已归档'),
    )
    expect(screen.getByLabelText('执行方式')).toHaveTextContent('继续会话')
    expect(screen.getByLabelText('指令')).toHaveValue('只继续这个来源会话')
  })
  it('返回任务读取失败后可重试找回草稿', async () => {
    const user = userEvent.setup()
    const f = draftNavigationFixture()
    await user.type(await screen.findByLabelText('指令'), '暂时断网仍可恢复的正文')
    await leaveForDevices(user)
    f.state.roomFail = true
    await user.click(screen.getByRole('link', { name: new RegExp(`^${f.task.title}`) }))
    await screen.findByText(/任务暂不可读/)
    expect(screen.queryByLabelText('指令')).toBeNull()
    f.state.roomFail = false
    await user.click(screen.getByRole('button', { name: '重试' }))
    expect(await screen.findByLabelText('指令')).toHaveValue('暂时断网仍可恢复的正文')
  })
})
