/**
 * #548 任务页消息框（P1-07 产品切片）：
 * 底部固定输入、发给团队/请助手处理切换、两份独立草稿、发送受阻就地恢复与事实反馈。
 *
 * 判据只走真人页面路径（真实 router + 真实 HTTP mock），不驱动内部 store。
 */
import { screen, waitFor, within } from '@testing-library/react'
import { userEvent } from '@testing-library/user-event'
import { describe, expect, it } from 'vitest'
import {
  ALICE,
  BOB,
  apiFailure,
  deferredResponse,
  devicesHandler,
  initOf,
  loggedInHandlers,
  makeComment,
  makeDevice,
  makeRun,
  makeTask,
  ok,
  taskRoomHandler,
  teamMembersHandler,
  workspacesHandler,
} from './fixtures.js'
import type { MockHandler } from './fixtures.js'
import { renderApp as renderAppRoom } from './render.jsx'
/** #548：本文件判普通任务链接的默认视图与恢复，显式走团队默认。 */
function renderApp(path: string, handlers: Parameters<typeof renderAppRoom>[1]) {
  return renderAppRoom(path, handlers, { taskView: 'team' })
}
import type { RunView, TaskRoomRun } from '../src/shared/api/types.js'

const AGENT = '00000000-0000-4000-8000-000000000010'
const REVISION = '00000000-0000-4000-8000-000000000011'
const DEVICE = '00000000-0000-4000-8000-000000000021'
const WORKSPACE = '00000000-0000-4000-8000-000000000022'

function agentHandlers(name = 'Builder'): MockHandler[] {
  return [
    {
      method: 'GET',
      url: /\/agents$/,
      respond: () =>
        ok([
          {
            id: AGENT,
            name,
            description: '负责座席方案与无障碍复核',
            archivedAt: null,
            currentRevisionId: REVISION,
          },
        ]),
    },
    {
      method: 'GET',
      url: new RegExp(`/agents/${AGENT}$`),
      respond: () =>
        ok({
          id: AGENT,
          name,
          description: '负责座席方案与无障碍复核',
          archivedAt: null,
          currentRevisionId: REVISION,
          currentRevision: null,
          revisions: [
            {
              id: REVISION,
              agentId: AGENT,
              revision: 1,
              persona: '',
              approvalPolicy: 'approval_required',
              provider: 'replay',
              credentialSlot: 'default',
              model: 'replay',
              pluginPackId: 'pack',
              profileDigest: 'b'.repeat(64),
              createdBy: ALICE.userId,
              createdAt: '2026-08-25T00:00:00.000Z',
              maxTokens: null,
            },
          ],
        }),
    },
  ]
}

function sourceHandler(
  task: ReturnType<typeof makeTask>,
  run: TaskRoomRun,
  overrides: Partial<RunView> = {},
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
        deviceId: DEVICE,
        workspaceId: WORKSPACE,
        dshSessionId: 'context-id',
        purpose: 'business',
        ...overrides,
      }),
  }
}

function workspaceHandler(available = true): MockHandler {
  return workspacesHandler([
    { workspaceId: WORKSPACE, deviceId: DEVICE, name: 'repo', kind: 'directory', available },
  ])
}

function recipientGroup(): HTMLElement {
  return screen.getByRole('group', { name: '消息接收方' })
}

async function showRecipient(which: '发给团队' | '请助手处理'): Promise<void> {
  const user = userEvent.setup()
  const group = await screen.findByRole('group', { name: '消息接收方' })
  await user.click(within(group).getByRole('button', { name: which }))
}

function instructionPosts(fetchMock: ReturnType<typeof renderApp>['fetchMock']) {
  return fetchMock.mock.calls.filter(
    ([url, init]) => String(url).endsWith('/instructions') && init?.method === 'POST',
  )
}

function commentPosts(fetchMock: ReturnType<typeof renderApp>['fetchMock']) {
  return fetchMock.mock.calls.filter(
    ([url, init]) =>
      /\/api\/v1\/tasks\/[^/]+\/comments$/.test(String(url)) && init?.method === 'POST',
  )
}

describe('#548 任务页消息接收方与草稿', () => {
  it('普通任务链接默认发给团队，切换接收方不发送且两份草稿各自保留', async () => {
    const task = makeTask({ assignmentStatus: 'accepted' })
    const user = userEvent.setup()
    const view = renderApp(
      `/tasks/${task.id}`,
      loggedInHandlers(BOB, [
        taskRoomHandler(task),
        ...agentHandlers(),
        teamMembersHandler(),
        devicesHandler([makeDevice({ id: DEVICE })]),
        workspaceHandler(),
      ]),
    )

    // 默认落在「发给团队」：输入位置在页面底部，说明团队可见，不再宣称不触发 Agent。
    expect(await screen.findByText('团队成员可见')).toBeVisible()
    expect(within(recipientGroup()).getByRole('button', { name: '发给团队' })).toHaveAttribute(
      'aria-pressed',
      'true',
    )
    expect(screen.queryByText('团队成员之间 · 不触发 Agent')).toBeNull()
    expect(screen.getByRole('button', { name: '团队讨论' })).toHaveAttribute('aria-pressed', 'true')

    await user.type(screen.getByLabelText('留言'), '第二排可以留两个轮椅席位')
    await showRecipient('请助手处理')
    expect(within(recipientGroup()).getByRole('button', { name: '请助手处理' })).toHaveAttribute(
      'aria-pressed',
      'true',
    )
    expect(screen.getByTestId('assistant-receiver')).toHaveTextContent('还没为这项任务选助手')
    await user.type(screen.getByLabelText('指令'), '请把这两个席位补到方案草稿里')

    await showRecipient('发给团队')
    expect(screen.getByLabelText('留言')).toHaveValue('第二排可以留两个轮椅席位')
    expect(screen.getByLabelText('指令')).toHaveValue('请把这两个席位补到方案草稿里')
    expect(commentPosts(view.fetchMock)).toHaveLength(0)
    expect(instructionPosts(view.fetchMock)).toHaveLength(0)
  })

  it('发给团队成功只清团队草稿，并显示「已发给团队」', async () => {
    const task = makeTask({ assignmentStatus: 'accepted' })
    const comment = makeComment({ taskId: task.id, authorUserId: BOB.userId, body: '现场补充' })
    const user = userEvent.setup()
    const view = renderApp(
      `/tasks/${task.id}`,
      loggedInHandlers(BOB, [
        taskRoomHandler(task),
        ...agentHandlers(),
        teamMembersHandler(),
        {
          method: 'POST',
          url: /\/comments$/,
          respond: () => ({ status: 201, body: { ok: true, data: comment } }),
        },
        { method: 'POST', url: /\/instructions$/, respond: () => ok({}) },
      ]),
    )
    await user.type(await screen.findByLabelText('留言'), '第二排可以留两个轮椅席位')
    await showRecipient('请助手处理')
    await user.type(screen.getByLabelText('指令'), '这份助手草稿不能丢')
    await showRecipient('发给团队')
    const team = screen.getByTestId('team-composer')
    await user.click(within(team).getByRole('button', { name: '发给团队' }))

    expect(await screen.findByTestId('comment-sent-status')).toHaveTextContent('已发给团队')
    expect(screen.getByLabelText('留言')).toHaveValue('')
    expect(screen.getByLabelText('指令')).toHaveValue('这份助手草稿不能丢')
    expect(commentPosts(view.fetchMock)).toHaveLength(1)
    expect(instructionPosts(view.fetchMock)).toHaveLength(0)
  })

  it('助手模式显示真实接收者，追问沿用当前对话且正常发送', async () => {
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
    await showRecipient('请助手处理')
    await waitFor(() =>
      expect(screen.getByTestId('assistant-receiver')).toHaveTextContent('发给：Builder'),
    )
    const box = await screen.findByLabelText('指令')
    expect(box).toHaveAttribute('placeholder', '想请助手做什么？')
    await waitFor(() => expect(box).toBeEnabled())
    await user.type(box, '检查上文')
    await user.click(screen.getByRole('button', { name: '发给助手' }))
    await waitFor(() => expect(instructionPosts(view.fetchMock)).toHaveLength(1))
    expect(JSON.parse(String(instructionPosts(view.fetchMock)[0]![1]!.body))).toEqual({
      text: '检查上文',
      intent: { kind: 'followup', runId: run.id },
      expectedApprovalPolicy: 'approval_required',
    })
  })

  it('没有可沿用助手时说明「还没为这项任务选助手」，选择入口不发请求', async () => {
    const task = makeTask({ assignmentStatus: 'accepted' })
    const user = userEvent.setup()
    const view = renderApp(
      `/tasks/${task.id}`,
      loggedInHandlers(BOB, [
        taskRoomHandler(task),
        ...agentHandlers(),
        teamMembersHandler(),
        devicesHandler([makeDevice({ id: DEVICE })]),
        workspaceHandler(),
      ]),
    )
    await showRecipient('请助手处理')
    expect(await screen.findByTestId('assistant-receiver')).toHaveTextContent(
      '还没为这项任务选助手',
    )
    await user.click(screen.getByRole('button', { name: '选择本任务的助手' }))
    expect(screen.getByLabelText('选择 Agent')).toHaveFocus()
    expect(instructionPosts(view.fetchMock)).toHaveLength(0)
  })
})

describe('#548 发送受阻时就地继续编辑与恢复', () => {
  it('原电脑离线：草稿可继续编辑、团队留言照常，检查连接后只恢复发送不自动提交', async () => {
    const task = makeTask({ assignmentStatus: 'accepted' })
    const run = makeRun({ status: 'completed', finishedAt: '2026-08-25T03:00:00.000Z' })
    const offline = makeDevice({ id: DEVICE, status: 'offline' })
    let devices = [offline]
    const user = userEvent.setup()
    const view = renderApp(
      `/tasks/${task.id}`,
      loggedInHandlers(BOB, [
        taskRoomHandler(task, { runs: [run] }),
        sourceHandler(task, run),
        ...agentHandlers(),
        teamMembersHandler(),
        { method: 'GET', url: /\/devices$/, respond: () => ok(devices) },
        workspaceHandler(),
        {
          method: 'POST',
          url: /\/instructions$/,
          respond: () => ok({ outcome: 'queued', runId: run.id, instructionState: 'pending' }),
        },
      ]),
    )
    await showRecipient('请助手处理')
    expect(await screen.findByTestId('execution-blocker')).toHaveTextContent(
      '上次用的电脑没连上，消息还没发出。你可以继续编辑。',
    )
    const box = screen.getByLabelText('指令')
    expect(box).toBeEnabled()
    await user.type(box, '这台电脑的现场补充')
    expect(box).toHaveValue('这台电脑的现场补充')
    expect(screen.getByRole('button', { name: '发给助手' })).toBeDisabled()

    // 团队留言不受助手阻塞影响。
    await showRecipient('发给团队')
    await user.type(await screen.findByLabelText('留言'), '先发一条团队情况')
    await user.click(
      within(screen.getByTestId('team-composer')).getByRole('button', { name: '发给团队' }),
    )
    await waitFor(() => expect(commentPosts(view.fetchMock)).toHaveLength(1))

    // 设备上线后点「检查连接」：只恢复发送，不替用户提交。
    await showRecipient('请助手处理')
    devices = [{ ...offline, status: 'online' }]
    await user.click(screen.getByTestId('check-connection'))
    await waitFor(() => expect(screen.getByRole('button', { name: '发给助手' })).toBeEnabled())
    expect(instructionPosts(view.fetchMock)).toHaveLength(0)
    expect(screen.getByLabelText('指令')).toHaveValue('这台电脑的现场补充')
  })

  it('有合法备选时明确重新开始才可发送，请求不带旧对话来源', async () => {
    const task = makeTask({ assignmentStatus: 'accepted', assigneeAgentId: AGENT })
    const run = makeRun({ status: 'completed', finishedAt: '2026-08-25T03:00:00.000Z' })
    const sourceDevice = makeDevice({ id: DEVICE, status: 'offline' })
    const spareDevice = makeDevice({ name: '备用电脑', status: 'online' })
    const user = userEvent.setup()
    const view = renderApp(
      `/tasks/${task.id}`,
      loggedInHandlers(BOB, [
        taskRoomHandler(task, { runs: [run] }),
        sourceHandler(task, run),
        ...agentHandlers(),
        teamMembersHandler(),
        devicesHandler([sourceDevice, spareDevice]),
        workspacesHandler([
          {
            workspaceId: WORKSPACE,
            deviceId: DEVICE,
            name: 'repo',
            kind: 'directory',
            available: true,
          },
          {
            workspaceId: '00000000-0000-4000-8000-000000000031',
            deviceId: spareDevice.id,
            name: 'spare-repo',
            kind: 'directory',
            available: true,
          },
        ]),
        {
          method: 'POST',
          url: /\/instructions$/,
          respond: () =>
            ok({ outcome: 'started_run', runId: 'new-run', instructionState: 'accepted' }),
        },
      ]),
    )
    await showRecipient('请助手处理')
    const box = await screen.findByLabelText('指令')
    await user.type(box, '换台电脑继续这件事')
    expect(await screen.findByTestId('execution-blocker')).toHaveTextContent(
      '上次用的电脑没连上，消息还没发出。你可以继续编辑。',
    )
    expect(screen.getByTestId('restart-assistant')).toBeVisible()
    expect(screen.getByTestId('restart-hint')).toHaveTextContent('这次会用另一台已授权的电脑')
    await user.click(screen.getByTestId('restart-assistant'))
    expect(screen.getByLabelText('执行方式')).toHaveTextContent('开始新执行')
    expect(screen.getByLabelText('指令')).toHaveValue('换台电脑继续这件事')
    await waitFor(() => expect(screen.getByRole('button', { name: '发给助手' })).toBeEnabled())
    await user.click(screen.getByRole('button', { name: '发给助手' }))
    await waitFor(() => expect(instructionPosts(view.fetchMock)).toHaveLength(1))
    const payload = JSON.parse(String(instructionPosts(view.fetchMock)[0]![1]!.body))
    expect(payload.intent).toEqual({ kind: 'new' })
    expect(payload).not.toHaveProperty('runId')
  })

  it('原电脑离线且没有可用环境：不承诺立即重新开始，只给检查与设置入口', async () => {
    const task = makeTask({ assignmentStatus: 'accepted' })
    const run = makeRun({ status: 'completed', finishedAt: '2026-08-25T03:00:00.000Z' })
    const user = userEvent.setup()
    renderApp(
      `/tasks/${task.id}`,
      loggedInHandlers(BOB, [
        taskRoomHandler(task, { runs: [run] }),
        sourceHandler(task, run),
        ...agentHandlers(),
        teamMembersHandler(),
        devicesHandler([makeDevice({ id: DEVICE, status: 'offline' })]),
        workspaceHandler(),
      ]),
    )
    await showRecipient('请助手处理')
    expect(await screen.findByTestId('execution-blocker')).toHaveTextContent(
      '还没有可用的电脑来处理这条消息。',
    )
    expect(screen.queryByTestId('restart-assistant')).toBeNull()
    expect(screen.getByTestId('check-connection')).toBeVisible()
    expect(screen.getByRole('link', { name: '设置执行电脑' })).toBeVisible()
  })

  it('普通成员没有交办权限：说明负责人，只切到团队草稿且不复制助手草稿', async () => {
    const task = makeTask({ assignmentStatus: 'accepted', assigneeUserId: BOB.userId })
    const user = userEvent.setup()
    const view = renderApp(
      `/tasks/${task.id}`,
      loggedInHandlers(ALICE, [
        taskRoomHandler(task),
        teamMembersHandler(),
        { method: 'GET', url: /instruction-grants$/, respond: () => ok([]) },
        { method: 'POST', url: /\/instructions$/, respond: () => ok({}) },
      ]),
    )
    await showRecipient('请助手处理')
    expect(await screen.findByTestId('execution-blocker')).toHaveTextContent(
      /这项任务由.*Bob.*负责交办。你仍然可以给团队留言。/,
    )
    // 没权限的成员不获得交办输入；「发给团队」只切换去向，不伪造助手草稿。
    expect(screen.queryByLabelText('指令')).toBeNull()
    await user.click(screen.getByTestId('switch-to-team'))
    expect(screen.getByLabelText('留言')).toHaveValue('')
    expect(instructionPosts(view.fetchMock)).toHaveLength(0)
  })

  it('责任人尚未接受任务时就地说清下一步，接受入口在原位置', async () => {
    const task = makeTask({ assignmentStatus: 'pending', assigneeUserId: BOB.userId })
    const user = userEvent.setup()
    renderApp(
      `/tasks/${task.id}`,
      loggedInHandlers(BOB, [taskRoomHandler(task), teamMembersHandler()]),
    )
    await showRecipient('请助手处理')
    expect(await screen.findByTestId('execution-blocker')).toHaveTextContent(
      '请先接受这项任务，再请助手处理。',
    )
    expect(screen.getByRole('link', { name: '去接受任务' })).toBeVisible()
    // 未接受前不提供交办输入（先走原接受入口），也不伪造可发送状态。
    expect(screen.queryByLabelText('指令')).toBeNull()
  })

  it('编辑中旧对话结束：保留文字，重新开始后才按新执行发送', async () => {
    const task = makeTask({
      assignmentStatus: 'accepted',
      assigneeAgentId: AGENT,
    })
    const run = makeRun({ status: 'running' })
    const user = userEvent.setup()
    const view = renderApp(
      `/tasks/${task.id}`,
      loggedInHandlers(BOB, [
        taskRoomHandler(task, { runs: [run] }),
        sourceHandler(task, run),
        ...agentHandlers(),
        teamMembersHandler(),
        devicesHandler([makeDevice({ id: DEVICE, status: 'online' })]),
        workspaceHandler(),
      ]),
    )
    await showRecipient('请助手处理')
    const box = await screen.findByLabelText('指令')
    await waitFor(() => expect(box).toBeEnabled())
    await user.type(box, '这条不能改投')
    view.queryClient.setQueryData(['task-room', task.id], {
      task,
      comments: [],
      instructions: [],
      artifacts: [],
      runs: [{ ...run, status: 'completed', finishedAt: '2026-08-25T04:00:00.000Z' }],
      agreement: { enabled: false, latestConfirmedNumber: null, hasDraft: false },
      handoff: null,
      nextRunApprovalPolicy: null,
      reviewFeedback: { unresolvedCount: 0, artifactId: null },
    })
    expect(await screen.findByTestId('execution-blocker')).toHaveTextContent(
      '刚才的对话已经结束，这条消息没有发到新的对话。请确认要接着说还是重新开始。',
    )
    expect(screen.getByLabelText('指令')).toHaveValue('这条不能改投')
    expect(instructionPosts(view.fetchMock)).toHaveLength(0)
    await user.click(screen.getByTestId('restart-assistant'))
    expect(screen.getByLabelText('指令')).toHaveValue('这条不能改投')
    await waitFor(() => expect(screen.getByRole('button', { name: '发给助手' })).toBeEnabled())
  })

  it('请求超时未确认是否收到：保留文字，重试沿用同一请求身份', async () => {
    const task = makeTask({ assignmentStatus: 'accepted', assigneeAgentId: AGENT })
    const user = userEvent.setup()
    const view = renderApp(
      `/tasks/${task.id}`,
      loggedInHandlers(BOB, [
        taskRoomHandler(task),
        ...agentHandlers(),
        teamMembersHandler(),
        devicesHandler([makeDevice({ id: DEVICE, status: 'online' })]),
        workspaceHandler(),
        {
          method: 'POST',
          url: /\/instructions$/,
          respond: () => {
            throw new Error('network down')
          },
        },
      ]),
    )
    await showRecipient('请助手处理')
    const box = await screen.findByLabelText('指令')
    await waitFor(() => expect(box).toBeEnabled())
    await user.type(box, '这条是否收到还不知道')
    await user.click(screen.getByRole('button', { name: '发给助手' }))
    expect(await screen.findByTestId('assistant-uncertain')).toHaveTextContent(
      '暂时没确认助手是否收到。你写的内容还在。',
    )
    expect(screen.getByLabelText('指令')).toHaveValue('这条是否收到还不知道')
    const posts = instructionPosts(view.fetchMock)
    expect(posts).toHaveLength(1)
    const firstKey = new Headers(posts[0]![1]?.headers).get('idempotency-key')
    await user.click(screen.getByRole('button', { name: '重试发送' }))
    await waitFor(() => expect(instructionPosts(view.fetchMock)).toHaveLength(2))
    expect(
      new Headers(instructionPosts(view.fetchMock)[1]![1]?.headers).get('idempotency-key'),
    ).toBe(firstKey)
  })

  it('新请求已提交但尚未开始时说「已提交，等助手开始」，不说已读或已采用', async () => {
    const task = makeTask({ assignmentStatus: 'accepted', assigneeAgentId: AGENT })
    const user = userEvent.setup()
    renderApp(
      `/tasks/${task.id}`,
      loggedInHandlers(BOB, [
        taskRoomHandler(task),
        ...agentHandlers(),
        teamMembersHandler(),
        devicesHandler([makeDevice({ id: DEVICE, status: 'online' })]),
        workspaceHandler(),
        {
          method: 'POST',
          url: /\/instructions$/,
          respond: () =>
            ok({
              id: 'instruction-1',
              outcome: 'started_run',
              runId: 'new-run',
              instructionState: 'accepted',
            }),
        },
      ]),
    )
    await showRecipient('请助手处理')
    const box = await screen.findByLabelText('指令')
    await waitFor(() => expect(box).toBeEnabled())
    await user.type(box, '请开始处理')
    const send = screen.getByRole('button', { name: '发给助手' })
    await waitFor(() => expect(send).toBeEnabled())
    await user.click(send)
    expect(await screen.findByTestId('instruction-outcome')).toHaveTextContent('已提交，等助手开始')
    expect(screen.queryByText('助手已读')).toBeNull()
    expect(screen.queryByText('已采用')).toBeNull()
  })

  it('新执行被设备离线拒绝：保留文字并说「没发出」，不是静默失败', async () => {
    const task = makeTask({ assignmentStatus: 'accepted', assigneeAgentId: AGENT })
    const user = userEvent.setup()
    const view = renderApp(
      `/tasks/${task.id}`,
      loggedInHandlers(BOB, [
        taskRoomHandler(task),
        ...agentHandlers(),
        teamMembersHandler(),
        devicesHandler([makeDevice({ id: DEVICE, status: 'online' })]),
        workspaceHandler(),
        {
          method: 'POST',
          url: /\/instructions$/,
          respond: () => apiFailure('DEVICE_OFFLINE', 'device offline', 'req-offline'),
        },
      ]),
    )
    await showRecipient('请助手处理')
    const box = await screen.findByLabelText('指令')
    await waitFor(() => expect(box).toBeEnabled())
    await user.type(box, '这句要保留')
    const send = screen.getByRole('button', { name: '发给助手' })
    await waitFor(() => expect(send).toBeEnabled())
    await user.click(send)
    expect(await screen.findByTestId('instruction-offline-guidance')).toHaveTextContent(
      '上次用的电脑没连上，消息还没发出。你写的内容还在。',
    )
    expect(box).toHaveValue('这句要保留')
    expect(instructionPosts(view.fetchMock)).toHaveLength(1)
    expect(screen.queryByTestId('run-outcome')).toBeNull()
  })

  it('受限私有执行不当作可接续会话：只说不能续接并给重新开始', async () => {
    const task = makeTask({ assignmentStatus: 'accepted' })
    const run = makeRun({ status: 'completed', finishedAt: '2026-08-25T03:00:00.000Z' })
    const user = userEvent.setup()
    const view = renderApp(
      `/tasks/${task.id}`,
      loggedInHandlers(BOB, [
        taskRoomHandler(task, { runs: [run] }),
        sourceHandler(task, run, { resumeContext: 'blocked' }),
        ...agentHandlers(),
        teamMembersHandler(),
        devicesHandler([makeDevice({ id: DEVICE, status: 'online' })]),
        workspaceHandler(),
        { method: 'POST', url: /\/instructions$/, respond: () => ok({}) },
      ]),
    )
    await showRecipient('请助手处理')
    const blocker = await screen.findByTestId('execution-blocker')
    expect(blocker).toHaveTextContent('这次对话不能在这里重开或续接')
    expect(blocker).toHaveTextContent('请明确重新开始')
    expect(screen.getByTestId('restart-assistant')).toBeVisible()
    expect(screen.getByRole('button', { name: '发给助手' })).toBeDisabled()
    expect(instructionPosts(view.fetchMock)).toHaveLength(0)
  })

  it('活跃的受限私有执行在追问模式也不可发送', async () => {
    const task = makeTask({ assignmentStatus: 'accepted' })
    const run = makeRun({ status: 'running' })
    const user = userEvent.setup()
    const view = renderApp(
      `/tasks/${task.id}`,
      loggedInHandlers(BOB, [
        taskRoomHandler(task, { runs: [run] }),
        sourceHandler(task, run, { resumeContext: 'blocked' }),
        ...agentHandlers(),
        teamMembersHandler(),
        devicesHandler([makeDevice({ id: DEVICE, status: 'online' })]),
        workspaceHandler(),
        { method: 'POST', url: /\/instructions$/, respond: () => ok({}) },
      ]),
    )
    await showRecipient('请助手处理')
    const blocker = await screen.findByTestId('execution-blocker')
    expect(blocker).toHaveTextContent('这次对话不能在这里重开或续接')
    await user.type(screen.getByLabelText('指令'), '这句不能追到私有执行')
    expect(screen.getByRole('button', { name: '发给助手' })).toBeDisabled()
    expect(instructionPosts(view.fetchMock)).toHaveLength(0)
  })

  it('迟到的团队留言回执不清掉之后写的新草稿', async () => {
    const task = makeTask({ assignmentStatus: 'accepted' })
    const comment = makeComment({ taskId: task.id, authorUserId: BOB.userId, body: '旧留言' })
    const gate = deferredResponse()
    const user = userEvent.setup()
    renderApp(
      `/tasks/${task.id}`,
      loggedInHandlers(BOB, [
        taskRoomHandler(task),
        ...agentHandlers(),
        teamMembersHandler(),
        devicesHandler([makeDevice({ id: DEVICE })]),
        workspaceHandler(),
        { method: 'POST', url: /\/comments$/, respond: () => gate.promise },
      ]),
    )
    const box = await screen.findByLabelText('留言')
    await user.type(box, '旧留言')
    const team = screen.getByTestId('team-composer')
    await user.click(within(team).getByRole('button', { name: '发给团队' }))
    await waitFor(() => expect(within(team).getByRole('button', { name: '发送中…' })).toBeVisible())
    // 请求在途时继续写了一条新的：迟到的成功回执只能清旧请求，不能吞掉这条。
    await user.clear(box)
    await user.type(box, '新留言不能丢')
    gate.resolve({ status: 201, body: { ok: true, data: comment } })
    await waitFor(() => expect(screen.queryByTestId('comment-sent-status')).toBeNull())
    expect(box).toHaveValue('新留言不能丢')
  })

  it('团队留言网络失败后重试沿用同一幂等键，成功后只清团队草稿', async () => {
    const task = makeTask({ assignmentStatus: 'accepted' })
    const comment = makeComment({ taskId: task.id, authorUserId: BOB.userId, body: '现场补充' })
    let attempts = 0
    const user = userEvent.setup()
    const view = renderApp(
      `/tasks/${task.id}`,
      loggedInHandlers(BOB, [
        taskRoomHandler(task),
        ...agentHandlers(),
        teamMembersHandler(),
        devicesHandler([makeDevice({ id: DEVICE })]),
        workspaceHandler(),
        {
          method: 'POST',
          url: /\/comments$/,
          respond: () => {
            attempts += 1
            if (attempts === 1) throw new TypeError('offline')
            return { status: 201, body: { ok: true, data: comment } }
          },
        },
      ]),
    )
    await user.type(await screen.findByLabelText('留言'), '这条不能重复')
    const team = screen.getByTestId('team-composer')
    await user.click(within(team).getByRole('button', { name: '发给团队' }))
    expect(await screen.findByText(/无法连接服务器/)).toBeVisible()
    expect(screen.getByLabelText('留言')).toHaveValue('这条不能重复')

    await user.click(within(team).getByRole('button', { name: '发给团队' }))
    expect(await screen.findByTestId('comment-sent-status')).toHaveTextContent('已发给团队')
    const keys = commentPosts(view.fetchMock).map((call) =>
      new Headers(initOf(call as [RequestInfo | URL, RequestInit?]).headers).get('idempotency-key'),
    )
    expect(keys).toHaveLength(2)
    expect(keys[0]).toBe(keys[1])
    expect(keys[0]).toBeTruthy()
    expect(screen.getByLabelText('留言')).toHaveValue('')
  })

  it('去设备页再返回：团队草稿与上次选的接收方都还在', async () => {
    const task = makeTask({ assignmentStatus: 'accepted' })
    const user = userEvent.setup()
    const view = renderApp(
      `/tasks/${task.id}`,
      loggedInHandlers(BOB, [
        taskRoomHandler(task),
        ...agentHandlers(),
        teamMembersHandler(),
        devicesHandler([makeDevice({ id: DEVICE })]),
        workspaceHandler(),
      ]),
    )
    await user.type(await screen.findByLabelText('留言'), '离开页面也要留着')
    await showRecipient('请助手处理')
    await view.router.navigate('/devices')
    await view.router.navigate(`/tasks/${task.id}`)
    const group = await screen.findByRole('group', { name: '消息接收方' })
    await waitFor(() =>
      expect(within(group).getByRole('button', { name: '请助手处理' })).toHaveAttribute(
        'aria-pressed',
        'true',
      ),
    )
    await user.click(within(group).getByRole('button', { name: '发给团队' }))
    expect(screen.getByLabelText('留言')).toHaveValue('离开页面也要留着')
  })
})
