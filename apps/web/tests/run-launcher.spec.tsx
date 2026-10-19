/**
 * P1-13 Run 启动器与直播面板（用户视角：role/label/text 断言，mock 仅在 HTTP 层）。
 *
 * - Launcher：可见性守卫（仅已接受指派的责任人、非终态、无活跃 Run）；
 *   Agent→Revision（快照语义）→设备→Workspace 级联；提交体形状与幂等键。
 * - LivePanel：owner 见直播区与完整事件；member 无直播区（服务端已过滤，
 *   客户端呈现层也不伪造入口）；直播 delta 经 run-buffer 实时上屏。
 */
import { describe, expect, it } from 'vitest'
import { act, screen, waitFor, within } from '@testing-library/react'
import { userEvent } from '@testing-library/user-event'
import { renderApp } from './render.js'
import { openSelect, selectOption } from './select-menu.js'
import {
  ALICE,
  BOB,
  created,
  loggedInHandlers,
  makeRun,
  makeTask,
  ok,
  taskRoomHandler,
  type MockHandler,
} from './fixtures.js'
import { appendLiveDelta } from '../src/shared/realtime/run-buffer.js'
import { queryKeys } from '../src/app/query-client.js'
import type { RunView } from '../src/shared/api/types.js'

const AGENT_ID = 'a1a1a1a1-0000-4000-8000-00000000000a'
const REVISION_ID = 'a2a2a2a2-0000-4000-8000-00000000000b'
const DEVICE_ID = 'd1d1d1d1-0000-4000-8000-00000000000c'
const WORKSPACE_ID = 'e5e5e5e5-0000-4000-8000-00000000000d'
const RUN_ID = 'f6f6f6f6-0000-4000-8000-00000000000e'

it('#396 责任人从约定面显式选择 Agent 和自己的现场发起辅助 Run', async () => {
  const user = userEvent.setup()
  const capture: { body?: unknown } = {}
  const task = makeTask({ assignmentStatus: 'accepted', assigneeUserId: BOB.userId })
  renderApp(
    `/tasks/${task.id}`,
    loggedInHandlers(BOB, [taskRoomHandler(task), ...launcherHandlers(capture)]),
  )
  await user.click(await screen.findByRole('button', { name: '任务约定' }))
  await user.click(screen.getByRole('button', { name: '用 Agent 起草约定' }))
  const panel = await screen.findByTestId('agreement-agent-draft')
  await user.click(within(panel).getByLabelText('选择 Agent'))
  await user.click(await screen.findByRole('menuitem', { name: 'Fixer' }))
  await user.click(within(panel).getByRole('button', { name: '执行设置' }))
  await user.click(await screen.findByRole('button', { name: '选择设备' }))
  await user.click(await screen.findByRole('menuitem', { name: 'm4-mini（在线）' }))
  await user.click(await screen.findByRole('button', { name: '选择 Workspace' }))
  await user.click(await screen.findByRole('menuitem', { name: 'whalepod' }))
  await user.keyboard('{Escape}')
  await user.click(within(panel).getByRole('button', { name: '启动约定起草' }))
  await waitFor(() =>
    expect(capture.body).toMatchObject({
      purpose: 'agreement_draft',
      agentId: AGENT_ID,
      deviceId: DEVICE_ID,
      workspaceId: WORKSPACE_ID,
      intent: { kind: 'new' },
    }),
  )
})

function launcherHandlers(
  capture?: { body?: unknown; key?: unknown },
  options: { failPost?: { message: string; requestId: string }; rejectPost?: boolean } = {},
): MockHandler[] {
  return [
    {
      method: 'GET',
      url: /\/api\/v1\/agents$/,
      respond: () =>
        ok([
          {
            id: AGENT_ID,
            name: 'Fixer',
            description: '',
            createdBy: BOB.userId,
            archivedAt: null,
            currentRevisionId: REVISION_ID,
          },
        ]),
    },
    {
      method: 'GET',
      url: new RegExp(`/api/v1/agents/${AGENT_ID}$`),
      respond: () =>
        ok({
          id: AGENT_ID,
          name: 'Fixer',
          description: '',
          createdBy: BOB.userId,
          archivedAt: null,
          currentRevisionId: REVISION_ID,
          currentRevision: null,
          revisions: [
            {
              id: REVISION_ID,
              agentId: AGENT_ID,
              revision: 3,
              persona: 'p',
              provider: 'deepseek',
              model: 'deepseek-chat',
              credentialSlot: 'default',
              maxTokens: null,
              pluginPackId: 'p1',
              profileDigest: 'b'.repeat(64),
              createdBy: BOB.userId,
              createdAt: '2026-08-25T00:00:00.000Z',
            },
          ],
        }),
    },
    {
      method: 'GET',
      url: /\/api\/v1\/devices$/,
      respond: () =>
        ok([
          {
            id: DEVICE_ID,
            name: 'm4-mini',
            platform: 'darwin',
            status: 'online',
            dshDistributionVersion: '0.1.0-rc.8',
            lastSeenAt: '2026-08-25T00:00:00.000Z',
          },
        ]),
    },
    {
      method: 'GET',
      url: /\/api\/v1\/workspaces$/,
      respond: () =>
        ok([
          {
            workspaceId: WORKSPACE_ID,
            deviceId: DEVICE_ID,
            name: 'whalepod',
            kind: 'directory',
            available: true,
          },
        ]),
    },
    {
      method: 'POST',
      url: /\/api\/v1\/tasks\/[^/]+\/instructions$/,
      respond: (init) => {
        if (capture !== undefined) {
          capture.body = JSON.parse(String(init.body))
          capture.key = (init.headers as Record<string, string>)['idempotency-key']
        }
        if (options.rejectPost)
          return created({
            outcome: 'rejected',
            runId: RUN_ID,
            instructionState: 'rejected',
            instructionErrorCode: 'WORKSPACE_UNAVAILABLE',
            instructionErrorMessage: '工作目录不可用',
          })
        if (options.failPost !== undefined) {
          return {
            status: 500,
            body: {
              ok: false,
              error: {
                code: 'INTERNAL_ERROR',
                message: options.failPost.message,
                requestId: options.failPost.requestId,
              },
            },
          }
        }
        return created({ outcome: 'started_run', runId: RUN_ID })
      },
    },
  ]
}

function runDetailHandlers(ownerUserId: string, events: unknown[]): MockHandler[] {
  const run: RunView = {
    id: RUN_ID,
    taskId: 'task-1',
    ownerUserId,
    agentId: AGENT_ID,
    profileRevisionId: REVISION_ID,
    deviceId: DEVICE_ID,
    workspaceId: WORKSPACE_ID,
    status: 'running',
    dshSessionId: null,
    failureCode: null,
    failureSummary: null,
    resumeFromRunId: null,
    approvalPolicy: 'approval_required',
    // #378：约定绑定与用途（新必填字段）。
    specRevisionId: null,
    purpose: 'business',
    rerunOfRunId: null,
    profileDigest: 'b'.repeat(64),
    createdAt: '2026-08-25T00:00:00.000Z',
    startedAt: '2026-08-25T00:01:00.000Z',
    finishedAt: null,
  }
  return [
    { method: 'GET', url: new RegExp(`/api/v1/runs/${RUN_ID}$`), respond: () => ok(run) },
    {
      method: 'GET',
      url: new RegExp(`/api/v1/runs/${RUN_ID}/events`),
      respond: () => ok({ events }),
    },
  ]
}

describe('RunLauncher', () => {
  it('已接受指派的责任人可见启动器；级联选择后提交正确载荷与幂等键', async () => {
    const task = makeTask({
      assigneeUserId: BOB.userId,
      assignmentStatus: 'accepted',
      status: 'in_progress',
    })
    const capture: { body?: unknown; key?: unknown } = {}
    const user = userEvent.setup()
    renderApp(
      `/tasks/${task.id}`,
      loggedInHandlers(BOB, [taskRoomHandler(task), ...launcherHandlers(capture)]),
    )

    // 级联：选 Agent → Revision 缺省钉住当前 Revision → 设备 → Workspace。
    // #158：四处控件已从原生 <select> 迁移到 vendored Menu，所以这里走真人路径
    // （点开 → 点选项）而不是 selectOptions 那条只有原生 select 才有的近道。
    const agentTrigger = await screen.findByLabelText('选择 Agent')
    expect(agentTrigger.tagName).toBe('BUTTON') // 反面钉：这一处不再是 <select>
    await openSelect(user, '选择 Agent')
    await user.click(screen.getByRole('menuitem', { name: 'Fixer' }))
    await waitFor(() => expect(screen.getByLabelText('选择 Revision')).toHaveTextContent('r3'))
    await selectOption(user, '选择设备', 'm4-mini（在线）')
    await selectOption(user, '选择 Workspace', 'whalepod')
    await user.type(screen.getByLabelText('指令'), '把登录页修好')

    expect(
      document
        .querySelector('[aria-labelledby="instructions-heading"]')
        ?.querySelectorAll('textarea'),
    ).toHaveLength(1)
    const submit = screen.getByRole('button', { name: '开始执行' })
    expect(submit).toBeEnabled()
    await user.click(submit)

    await waitFor(() => expect(capture.body).toBeDefined())
    expect(capture.body).toEqual({
      agentId: AGENT_ID,
      profileRevisionId: REVISION_ID,
      deviceId: DEVICE_ID,
      workspaceId: WORKSPACE_ID,
      text: '把登录页修好',
      intent: { kind: 'new' },
      expectedApprovalPolicy: 'approval_required',
    })
    expect(typeof capture.key).toBe('string')
  })

  it('非责任人不见启动器；有活跃 Run 时责任人也不见（一任务一活跃）', async () => {
    const task = makeTask({
      assigneeUserId: ALICE.userId,
      assignmentStatus: 'accepted',
      status: 'in_progress',
    })
    renderApp(`/tasks/${task.id}`, loggedInHandlers(BOB, [taskRoomHandler(task)]))
    // ADR-0019：执行区是连续对话（没有运行列表），启动器只对责任人出现。
    expect(await screen.findByTestId('execution-composer')).toBeVisible()
    expect(screen.queryByRole('heading', { name: '开始执行' })).not.toBeInTheDocument()

    // 责任人自己有活跃 Run 时同样不可见。
    const task2 = makeTask({
      assigneeUserId: BOB.userId,
      assignmentStatus: 'accepted',
      status: 'in_progress',
    })
    renderApp(
      `/tasks/${task2.id}`,
      loggedInHandlers(BOB, [
        taskRoomHandler(task2, { runs: [makeRun({ status: 'running' })] }),
        ...launcherHandlers(),
      ]),
    )
    expect(await screen.findByText('运行中')).toBeVisible()
    expect(screen.queryByRole('heading', { name: '开始执行' })).not.toBeInTheDocument()
  })
  it('评审：Node 已拒收的首次启动保留草稿，不假装进入追问', async () => {
    const task = makeTask({ assignmentStatus: 'accepted', assigneeUserId: BOB.userId })
    const user = userEvent.setup()
    renderApp(
      `/tasks/${task.id}`,
      loggedInHandlers(BOB, [
        taskRoomHandler(task),
        ...launcherHandlers(undefined, { rejectPost: true }),
      ]),
    )
    await selectOption(user, '选择 Agent', 'Fixer')
    await user.type(screen.getByLabelText('指令'), '保留被拒收的原文')
    await user.click(screen.getByRole('button', { name: '开始执行' }))
    expect(await screen.findByTestId('execution-start-refusal')).toHaveTextContent('工作目录不可用')
    expect(screen.getByLabelText('指令')).toHaveValue('保留被拒收的原文')
    expect(screen.getByLabelText('执行方式')).toHaveTextContent('开始新执行')
    expect(screen.getByRole('button', { name: '开始执行' })).toHaveAttribute(
      'data-feedback',
      'rejected',
    )
  })

  it('评审：收起设置后仍如实展示显式设备与工作区', async () => {
    const task = makeTask({ assignmentStatus: 'accepted', assigneeUserId: BOB.userId })
    const user = userEvent.setup()
    renderApp(
      `/tasks/${task.id}`,
      loggedInHandlers(BOB, [taskRoomHandler(task), ...launcherHandlers()]),
    )
    await selectOption(user, '选择 Agent', 'Fixer')
    await selectOption(user, '选择设备', 'm4-mini（在线）')
    await selectOption(user, '选择 Workspace', 'whalepod')
    const settings = screen.getByLabelText('执行设置')
    await user.click(settings)
    expect(settings.closest('details')).not.toHaveAttribute('open')
    expect(screen.getByTestId('execution-target-summary')).toBeVisible()
    expect(screen.getByTestId('execution-target-summary')).toHaveTextContent('m4-mini · whalepod')
    expect(screen.getByTestId('execution-target-summary')).not.toHaveTextContent(
      '自动选择你的可用环境',
    )
  })

  it.each(['device', 'workspace'] as const)(
    '评审：显式选择的 %s 失效时保留草稿，不改投其他可用现场',
    async (kind) => {
      const task = makeTask({ assignmentStatus: 'accepted', assigneeUserId: BOB.userId })
      const user = userEvent.setup()
      const view = renderApp(
        `/tasks/${task.id}`,
        loggedInHandlers(BOB, [taskRoomHandler(task), ...launcherHandlers()]),
      )
      await selectOption(user, '选择 Agent', 'Fixer')
      await selectOption(user, '选择设备', 'm4-mini（在线）')
      await selectOption(user, '选择 Workspace', 'whalepod')
      await user.type(screen.getByLabelText('指令'), '保留这段草稿')
      expect(screen.getByRole('button', { name: '开始执行' })).toBeEnabled()
      act(() => {
        if (kind === 'device') {
          const devices = view.queryClient.getQueryData<
            import('../src/shared/api/types.js').DeviceView[]
          >(queryKeys.devices)!
          view.queryClient.setQueryData(
            queryKeys.devices,
            devices.map((row) => ({ ...row, status: 'offline' })),
          )
        } else {
          const workspaces = view.queryClient.getQueryData<
            import('../src/shared/api/types.js').WorkspaceView[]
          >(queryKeys.workspaces)!
          view.queryClient.setQueryData(queryKeys.workspaces, [
            ...workspaces.map((row) => ({ ...row, available: false })),
            {
              ...workspaces[0]!,
              workspaceId: 'e5e5e5e5-0000-4000-8000-00000000000e',
              name: 'other',
              available: true,
            },
          ])
        }
      })
      await waitFor(() => expect(screen.getByRole('button', { name: '开始执行' })).toBeDisabled())
      expect(screen.getByTestId('execution-target-blocker')).toBeVisible()
      expect(screen.getByLabelText('指令')).toHaveValue('保留这段草稿')
      expect(
        view.fetchMock.mock.calls.filter(([url]) => String(url).endsWith('/instructions')),
      ).toHaveLength(0)
    },
  )

  it('#315 编辑草稿时 Agent 更新不替换已展示的版本', async () => {
    const task = makeTask({ assignmentStatus: 'accepted', assigneeUserId: BOB.userId })
    const capture: { body?: unknown } = {}
    const user = userEvent.setup()
    const view = renderApp(
      `/tasks/${task.id}`,
      loggedInHandlers(BOB, [taskRoomHandler(task, { runs: [] }), ...launcherHandlers(capture)]),
    )
    await selectOption(user, '选择 Agent', 'Fixer')
    await waitFor(() => expect(screen.getByTestId('execution-revision')).toHaveTextContent('r3'))
    const original = view.queryClient.getQueryData<
      import('../src/shared/api/types.js').AgentDetailView
    >(queryKeys.agentDetail(AGENT_ID))
    const nextId = 'a2a2a2a2-0000-4000-8000-00000000000c'
    act(() =>
      view.queryClient.setQueryData(queryKeys.agentDetail(AGENT_ID), {
        ...original,
        currentRevisionId: nextId,
        revisions: [
          ...original!.revisions,
          { ...original!.revisions[0], id: nextId, revision: 4, approvalPolicy: 'full_access' },
        ],
      }),
    )
    expect(screen.getByTestId('execution-revision')).toHaveTextContent('r3')
    await user.type(screen.getByLabelText('指令'), '使用已确认的版本')
    await user.click(screen.getByRole('button', { name: '开始执行' }))
    await waitFor(() =>
      expect(capture.body).toMatchObject({
        profileRevisionId: REVISION_ID,
        expectedApprovalPolicy: 'approval_required',
      }),
    )
    expect(screen.queryByRole('dialog')).toBeNull()
  })
})

describe('RunLivePanel', () => {
  it('owner：选中 Run 后出现直播区与事件列表；live delta 实时上屏', async () => {
    const task = makeTask({ assigneeUserId: BOB.userId, assignmentStatus: 'accepted' })
    const run = makeRun({ id: RUN_ID, status: 'running' })
    const user = userEvent.setup()
    renderApp(
      `/tasks/${task.id}`,
      loggedInHandlers(BOB, [
        taskRoomHandler(task, { runs: [run] }),
        ...runDetailHandlers(BOB.userId, [
          {
            runId: RUN_ID,
            seq: 1,
            type: 'run.phase',
            audience: 'project',
            event: { type: 'run.phase', phase: 'thinking' },
            occurredAt: '2026-08-25T02:00:01.000Z',
            receivedAt: '2026-08-25T02:00:01.100Z',
          },
        ]),
      ]),
    )

    await user.click(await screen.findByRole('button', { name: /第 1 次运行/ }))
    expect(await screen.findByText('实时输出')).toBeVisible()
    await user.click(screen.getByText('工具与运行记录'))
    expect(await screen.findByText('阶段：思考中')).toBeVisible()

    // live delta 经缓冲实时上屏（不落库）。
    act(() => {
      appendLiveDelta(RUN_ID, 1, 'Hello, ')
      appendLiveDelta(RUN_ID, 2, 'world')
    })
    expect(screen.getByTestId('run-live-text')).toHaveTextContent('Hello, world')
  })

  it('member：无直播区；事件列表呈现服务端过滤后的 project 行', async () => {
    const task = makeTask({ assigneeUserId: BOB.userId, assignmentStatus: 'accepted' })
    const run = makeRun({ id: RUN_ID, status: 'running' })
    const user = userEvent.setup()
    renderApp(
      `/tasks/${task.id}`,
      loggedInHandlers(ALICE, [
        taskRoomHandler(task, { runs: [run] }),
        ...runDetailHandlers(BOB.userId, [
          {
            runId: RUN_ID,
            seq: 1,
            type: 'run.phase',
            audience: 'project',
            event: { type: 'run.phase', phase: 'tool' },
            occurredAt: '2026-08-25T02:00:01.000Z',
            receivedAt: '2026-08-25T02:00:01.100Z',
          },
          {
            runId: RUN_ID,
            seq: 2,
            type: 'approval.requested',
            audience: 'project',
            event: {
              type: 'approval.requested',
              approval: { reason: '', preview: { category: 'shell' } },
            },
            occurredAt: '2026-08-25T02:00:02.000Z',
            receivedAt: '2026-08-25T02:00:02.100Z',
          },
        ]),
      ]),
    )

    await user.click(await screen.findByRole('button', { name: /第 1 次运行/ }))
    await user.click(await screen.findByText('工具与运行记录'))
    expect(await screen.findByText('阶段：工具执行中')).toBeVisible()
    // project 缩水卡：reason 恒空 → 固定文案，不显示空框（03 §8）。
    expect(screen.getByText('等待责任人批准')).toBeVisible()
    // member 视角无直播区入口（Hub 扇出已保证收不到，呈现层同样不出现）。
    expect(screen.queryByText('实时输出')).not.toBeInTheDocument()
    // live delta 即使意外进入缓冲也不呈现给非 owner（无订阅者）。
    act(() => {
      appendLiveDelta(RUN_ID, 1, 'should-not-render')
    })
    expect(screen.queryByText('should-not-render')).not.toBeInTheDocument()
  })
})

describe('#225 批次①：启动失败走统一错误口径', () => {
  it('POST /runs 失败：ErrorBanner 呈现 message 与 requestId（与同页其它组件同口径）', async () => {
    const task = makeTask({
      assigneeUserId: BOB.userId,
      assignmentStatus: 'accepted',
      status: 'in_progress',
    })
    const user = userEvent.setup()
    renderApp(
      `/tasks/${task.id}`,
      loggedInHandlers(BOB, [
        taskRoomHandler(task),
        ...launcherHandlers(undefined, {
          failPost: { message: 'agent not ready', requestId: 'req-run-500' },
        }),
      ]),
    )
    await openSelect(user, '选择 Agent')
    await user.click(screen.getByRole('menuitem', { name: 'Fixer' }))
    await waitFor(() => expect(screen.getByLabelText('选择 Revision')).toHaveTextContent('r3'))
    await selectOption(user, '选择设备', 'm4-mini（在线）')
    await selectOption(user, '选择 Workspace', 'whalepod')
    await user.type(screen.getByLabelText('指令'), '把登录页修好')
    await user.click(screen.getByRole('button', { name: '开始执行' }))

    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent('agent not ready')
    expect(alert).toHaveTextContent('req-run-500')
    // 失败保留输入：重试不需要重打一遍 prompt。
    expect(screen.getByLabelText('指令')).toHaveValue('把登录页修好')
  })
})
