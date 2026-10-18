import { showTaskMenu } from './workspace.js'
/**
 * Agent 可被指派（#239；ADR-0009 决策 6）——Web 组件面。
 *
 * 判据：
 * - 创建任务的责任人下拉含**未归档** Agent（归档不进），选中 Agent 后出现
 *   「指派即执行」提示；提交体带 `assigneeAgentId` 且**不带** `assigneeUserId`
 *   （协议互斥的 UI 面）；驱动失败的结果走 toast 如实告知，不吞。
 * - #312：驱动结果在成功信封的**兄弟位**（`{ ok, data, drive }`，不在 `data` 里）；
 *   四种受理命运各说各话——排队/未受理绝不说成「已自动开始执行」，失败带错误码与恢复入口。
 * - TaskHeader：Agent-task 的「当前责任人」仍是真人（指派人），另出「执行 Agent」格。
 * - AssignmentPanel：Agent-task 不渲染接受/拒绝（端点对 Agent-task 恒 409），
 *   陈述「谁指派给了哪个 Agent、指派即驱动、责任人是谁」。
 * - 指令流：origin=auto_assignment 的消息标注「指派自动驱动」，与人发的「指令」区分。
 */
import { act, screen, waitFor } from '@testing-library/react'
import { userEvent } from '@testing-library/user-event'
import { beforeEach, describe, expect, it } from 'vitest'
import { resetToastsForTest } from '../src/app/toast.js'
import { persistentFrame } from './frames.js'
import { installFrameSink } from './socket-drive.js'
import type { AgentView, ProjectView, TaskView } from '../src/shared/api/types.js'
import {
  ALICE,
  BOB,
  agentsHandler,
  apiFailure,
  created,
  createdWithSiblings,
  loggedInHandlers,
  makeMember,
  makeRun,
  makeTask,
  projectsHandler,
  teamMembersHandler,
  taskRoomHandler,
  ok,
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

// toast 是模块级存储：上一条用例推的 toast 会漏进下一条（本轮新增的
// 「分给真人 → 不弹执行 toast」就是靠这条隔离才测得准）。
beforeEach(() => {
  resetToastsForTest()
})

describe('#344 创建任务：责任人与「创建后立即执行」拆开（承接 #239 指派即执行）', () => {
  /**
   * 创建任务的响应：驱动结果在成功信封的**兄弟位**（`{ ok, data, drive }`）。
   *
   * #312 的教训：把 `drive` 塞进 `data` 造 fixture，会让用例验一个前端自己编出来的
   * 假契约（页面按 `data.drive` 读时全绿，真实响应里那条 toast 从不出现）。
   * 这里一律走 `createdWithSiblings` 照真实 wire 造。
   */
  function createTaskHandlers(
    drive: Record<string, unknown> | null,
    agents: AgentView[] = [AGENT],
  ): MockHandler[] {
    return [
      projectsHandler([PROJECT_VIEW]),
      teamMembersHandler(),
      agentsHandler(agents),
      {
        method: 'POST',
        url: /\/api\/v1\/projects\/[^/]+\/tasks$/,
        respond: () =>
          drive === null
            ? created({ ...makeTask({ id: 'new-member-task' }) })
            : createdWithSiblings(
                {
                  ...makeTask({ id: 'new-agent-task' }),
                  assigneeAgentId: AGENT.id,
                  assignmentStatus: 'accepted',
                },
                { drive },
              ),
      },
    ]
  }

  /** 名册可变的 mock（#345 评审 F2）：表单开着时成员被停用是真实发生的事。 */
  function statefulMembers(initial: ReturnType<typeof makeMember>[]): {
    handler: MockHandler
    disable: (userId: string) => void
  } {
    let members = [...initial]
    return {
      handler: {
        method: 'GET',
        url: /\/api\/v1\/team\/members$/,
        respond: () => ok([...members]),
      },
      disable: (userId) => {
        members = members.map((m) => (m.userId === userId ? { ...m, enabled: false } : m))
      },
    }
  }

  /** 真人路径：开表单 → 填标题。 */
  async function openCreateForm(
    user: ReturnType<typeof userEvent.setup>,
    title = '把登录页改成深色',
  ): Promise<void> {
    await user.click(await screen.findByRole('button', { name: '创建任务' }))
    await user.type(await screen.findByLabelText('任务标题'), title)
  }

  /** 打开执行开关并选 Agent（#344：不再是「责任人下拉里选 Agent」）。 */
  async function enableExecution(
    user: ReturnType<typeof userEvent.setup>,
    agentName = /report-writer（Agent）/,
  ): Promise<void> {
    await user.click(screen.getByRole('switch', { name: '创建后立即执行' }))
    await selectOption(user, '执行 Agent', agentName)
  }

  it('默认：责任人是真人（默认自己），只创建不执行——提交体只带 assigneeUserId', async () => {
    const captures: { bodies: unknown[] } = { bodies: [] }
    const user = userEvent.setup()
    renderApp(
      '/',
      loggedInHandlers(BOB, [
        projectsHandler([PROJECT_VIEW]),
        teamMembersHandler(),
        agentsHandler([AGENT]),
        {
          method: 'POST',
          url: /\/api\/v1\/projects\/[^/]+\/tasks$/,
          respond: (init) => {
            captures.bodies.push(JSON.parse(String(init.body ?? '{}')))
            return created({ ...makeTask({ id: 'new-member-task' }) })
          },
        },
      ]),
    )
    await openCreateForm(user)

    // 责任人只列真人：Agent 从这一栏退出（#344 的拆分本体）。
    const list = await openSelect(user, '责任人')
    expect(list.queryByRole('menuitem', { name: /report-writer/ })).toBeNull()
    expect(list.getByRole('menuitem', { name: /Bob/ })).toBeVisible()
    await user.keyboard('{Escape}')

    // 开关默认关闭，按钮仍是「创建任务」。
    expect(screen.getByRole('switch', { name: '创建后立即执行' })).toHaveAttribute(
      'aria-checked',
      'false',
    )
    expect(screen.queryByLabelText('执行 Agent')).toBeNull()
    await user.click(screen.getByRole('button', { name: '创建任务' }))

    await waitFor(() => expect(captures.bodies).toHaveLength(1))
    expect(captures.bodies[0]).toMatchObject({ assigneeUserId: BOB.userId })
    expect(captures.bodies[0]).not.toHaveProperty('assigneeAgentId')
  })

  it('开启执行：出现 Agent 选择、按钮变「创建并开始执行」、未选 Agent 不可提交；提交体只带 assigneeAgentId', async () => {
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
            return createdWithSiblings(
              {
                ...makeTask({ id: 'new-agent-task' }),
                assigneeAgentId: AGENT.id,
                assignmentStatus: 'accepted',
              },
              { drive: { outcome: 'started_run', runId: '99999999-0000-4000-8000-0000000000r1' } },
            )
          },
        },
      ]),
    )
    await openCreateForm(user)
    await user.click(screen.getByRole('switch', { name: '创建后立即执行' }))

    // 开关打开：说明「用自己的环境、以标题与描述为指令」，按钮改名。
    expect(screen.getByRole('switch', { name: '创建后立即执行' })).toHaveAttribute(
      'aria-checked',
      'true',
    )
    expect(screen.getByTestId('execute-now-hint')).toHaveTextContent('用你自己的设备与工作目录')
    expect(screen.getByRole('button', { name: '创建并开始执行' })).toBeDisabled()

    // 归档 Agent 不进候选。
    const agentList = await openSelect(user, '执行 Agent')
    expect(agentList.queryByRole('menuitem', { name: /old-agent/ })).toBeNull()
    await user.click(agentList.getByRole('menuitem', { name: /report-writer（Agent）/ }))

    await user.click(screen.getByRole('button', { name: '创建并开始执行' }))
    await waitFor(() => expect(captures.bodies).toHaveLength(1))
    expect(captures.bodies[0]).toMatchObject({ assigneeAgentId: AGENT.id })
    // 互斥：带 Agent 就不带成员。
    expect(captures.bodies[0]).not.toHaveProperty('assigneeUserId')
  })

  it('命中区：点标签文本也能开关（label 包 Switch），且只翻一次', async () => {
    const user = userEvent.setup()
    renderApp('/', loggedInHandlers(BOB, createTaskHandlers(null)))
    await openCreateForm(user)
    const toggle = screen.getByRole('switch', { name: '创建后立即执行' })
    await user.click(screen.getByText('创建后立即执行'))
    expect(toggle).toHaveAttribute('aria-checked', 'true')
    await user.click(screen.getByText('创建后立即执行'))
    expect(toggle).toHaveAttribute('aria-checked', 'false')
  })

  it('分给别人：开关禁用并说明对方要先接受任务；执行中改选别人则显式关闭并清掉已选 Agent', async () => {
    const user = userEvent.setup()
    renderApp('/', loggedInHandlers(BOB, createTaskHandlers(null)))
    await openCreateForm(user)

    // 先给自己开上执行并选好 Agent。
    await enableExecution(user)
    expect(screen.getByRole('button', { name: '创建并开始执行' })).toBeEnabled()

    // 改选 Alice（不是自己）：开关被关掉、Agent 清空、按钮回到「创建任务」，
    // 提示浮出——不允许「以为在给自己执行，实际是给别人建任务」静默改投。
    await selectOption(user, '责任人', /Alice/)
    expect(screen.getByRole('switch', { name: '创建后立即执行' })).toBeDisabled()
    expect(screen.getByRole('switch', { name: '创建后立即执行' })).toHaveAttribute(
      'aria-checked',
      'false',
    )
    expect(screen.queryByLabelText('执行 Agent')).toBeNull()
    expect(screen.getByRole('button', { name: '创建任务' })).toBeEnabled()
    expect(screen.getByTestId('assignee-member-hint')).toHaveTextContent('接受任务并安排执行')
  })

  it('没有可用 Agent：开关禁用，且**可见提示**说明原因（不只挂在 title 上）', async () => {
    const user = userEvent.setup()
    renderApp('/', loggedInHandlers(BOB, createTaskHandlers(null, [])))
    await openCreateForm(user)
    const toggle = screen.getByRole('switch', { name: '创建后立即执行' })
    expect(toggle).toBeDisabled()
    await waitFor(() =>
      expect(screen.getByTestId('execute-now-reason')).toHaveTextContent('还没有可用的 Agent'),
    )
  })

  it('#345 所选责任人离开名册：提交前显式阻塞并要求重选（不发请求、不自动换人）', async () => {
    const membership = statefulMembers([makeMember(BOB), makeMember(ALICE)])
    const sink = installFrameSink() // 必须在 render 之前装
    const user = userEvent.setup()
    const view = renderApp(
      '/',
      loggedInHandlers(BOB, [
        projectsHandler([PROJECT_VIEW]),
        membership.handler,
        agentsHandler([AGENT]),
        {
          method: 'POST',
          url: /\/api\/v1\/projects\/[^/]+\/tasks$/,
          respond: () => created({ ...makeTask({ id: 'never-created' }) }),
        },
      ]),
    )
    await openCreateForm(user)
    await selectOption(user, '责任人', /Alice/)
    expect(screen.getByRole('button', { name: '创建任务' })).toBeEnabled()

    // 表单开着时名册变了：Alice 被停用 → member.changed → 名册重拉（真实事件路径）。
    membership.disable(ALICE.userId)
    await act(async () => {
      await sink.onFrame(
        persistentFrame('member.changed', { changedAt: '2026-10-16T00:00:00.000Z' }),
      )
    })

    await waitFor(() =>
      expect(screen.getByTestId('selection-unavailable-hint')).toBeInTheDocument(),
    )
    const submit = screen.getByRole('button', { name: '创建任务' })
    expect(submit).toBeDisabled()
    await user.click(submit)
    // 一个创建请求都没发出去（也没被悄悄换成别人）。
    const posted = view.fetchMock.mock.calls.filter(([, init]) => init?.method === 'POST')
    expect(posted).toHaveLength(0)
  })

  it('#345 重试同意图复用同一把幂等键（超时重试不建第二个任务）', async () => {
    const keys: string[] = []
    let firstAttempt = true
    const user = userEvent.setup()
    renderApp(
      '/',
      loggedInHandlers(BOB, [
        projectsHandler([PROJECT_VIEW]),
        teamMembersHandler(),
        agentsHandler([AGENT]),
        {
          method: 'POST',
          url: /\/api\/v1\/projects\/[^/]+\/tasks$/,
          respond: (init) => {
            keys.push(String(new Headers(init.headers).get('idempotency-key')))
            // 第一次当网络层失败（超时/断网），第二次放行。
            if (firstAttempt) {
              firstAttempt = false
              throw new Error('network down')
            }
            return created({ ...makeTask({ id: 'new-member-task' }) })
          },
        },
      ]),
    )
    await openCreateForm(user)
    await user.click(screen.getByRole('button', { name: '创建任务' }))
    await screen.findByRole('alert') // 失败如实上屏，表单不关
    await user.click(screen.getByRole('button', { name: '创建任务' }))
    await waitFor(() => expect(keys).toHaveLength(2))
    // 同一意图的重试 = 同一把键 → Hub 按 task.create:<key> 回放，不会建出第二个任务。
    expect(keys[0]).toBe(keys[1])
    expect(keys[0]).not.toBe('undefined')
  })

  it('#345 改了内容就是新意图：换一把新键（否则会拿旧任务的回执冒充新任务）', async () => {
    const keys: string[] = []
    const user = userEvent.setup()
    renderApp(
      '/',
      loggedInHandlers(BOB, [
        projectsHandler([PROJECT_VIEW]),
        teamMembersHandler(),
        agentsHandler([AGENT]),
        {
          method: 'POST',
          url: /\/api\/v1\/projects\/[^/]+\/tasks$/,
          respond: (init) => {
            keys.push(String(new Headers(init.headers).get('idempotency-key')))
            return apiFailure('CONFLICT', 'still failing')
          },
        },
      ]),
    )
    await openCreateForm(user)
    await user.click(screen.getByRole('button', { name: '创建任务' }))
    await waitFor(() => expect(keys).toHaveLength(1))
    await user.type(screen.getByLabelText('任务标题'), '（改成别的）')
    await user.click(screen.getByRole('button', { name: '创建任务' }))
    await waitFor(() => expect(keys).toHaveLength(2))
    expect(keys[1]).not.toBe(keys[0])
  })

  it('驱动失败（设备离线）→ toast 如实说「自动执行未开始」并给错误码与恢复入口，任务仍算创建成功', async () => {
    const user = userEvent.setup()
    const view = renderApp(
      '/',
      loggedInHandlers(
        BOB,
        createTaskHandlers({
          outcome: 'failed',
          error: { code: 'DEVICE_OFFLINE', message: 'no device' },
        }),
      ),
    )
    await openCreateForm(user)
    await enableExecution(user)
    await user.click(screen.getByRole('button', { name: '创建并开始执行' }))
    await waitFor(() =>
      expect(
        screen.getByText(/自动执行未开始（DEVICE_OFFLINE）/, { exact: false }),
      ).toBeInTheDocument(),
    )
    // 恢复入口说清去哪：任务已创建 → 在任务执行区手动发起（不重开一个任务）。
    expect(screen.getByText(/可在任务执行区手动发起/, { exact: false })).toBeInTheDocument()
    expect(view.fetchMock.mock.calls.length).toBeGreaterThan(0)
  })

  it('驱动成功（started_run）→ toast 说已自动开始执行', async () => {
    const user = userEvent.setup()
    renderApp(
      '/',
      loggedInHandlers(
        BOB,
        createTaskHandlers({
          outcome: 'started_run',
          runId: '99999999-0000-4000-8000-0000000000r1',
        }),
      ),
    )
    await openCreateForm(user)
    await enableExecution(user)
    await user.click(screen.getByRole('button', { name: '创建并开始执行' }))
    await waitFor(() =>
      expect(screen.getByText('任务已创建，Agent 已自动开始执行')).toBeInTheDocument(),
    )
  })

  it('排队（queued）→ 说受理排队，绝不谎称已开始执行', async () => {
    const user = userEvent.setup()
    renderApp(
      '/',
      loggedInHandlers(
        BOB,
        createTaskHandlers({
          outcome: 'queued',
          runId: '99999999-0000-4000-8000-0000000000r1',
        }),
      ),
    )
    await openCreateForm(user)
    await enableExecution(user)
    await user.click(screen.getByRole('button', { name: '创建并开始执行' }))
    await waitFor(() =>
      expect(screen.getByText(/执行已受理排队/, { exact: false })).toBeInTheDocument(),
    )
    // 「受理了」与「跑起来了」是两件事——这条判据就是 #312 的第二条要求。
    expect(screen.queryByText(/已自动开始执行/, { exact: false })).toBeNull()
  })

  it('当场拒绝（rejected）→ 说未受理，不谎报执行', async () => {
    const user = userEvent.setup()
    renderApp(
      '/',
      loggedInHandlers(
        BOB,
        createTaskHandlers({
          outcome: 'rejected',
          runId: '99999999-0000-4000-8000-0000000000r1',
        }),
      ),
    )
    await openCreateForm(user)
    await enableExecution(user)
    await user.click(screen.getByRole('button', { name: '创建并开始执行' }))
    await waitFor(() =>
      expect(screen.getByText(/但执行未受理/, { exact: false })).toBeInTheDocument(),
    )
    expect(screen.queryByText(/已自动开始执行/, { exact: false })).toBeNull()
  })

  it('分给真人（响应无 drive）→ 不弹执行 toast', async () => {
    const user = userEvent.setup()
    const view = renderApp('/', loggedInHandlers(BOB, createTaskHandlers(null)))
    await openCreateForm(user)
    await user.click(screen.getByRole('button', { name: '创建任务' }))
    await waitFor(() => expect(view.fetchMock.mock.calls.length).toBeGreaterThan(1))
    expect(screen.queryByTestId('toast-item')).toBeNull()
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
    await showTaskMenu()
    await waitFor(() => expect(screen.getByTestId('task-agent')).toHaveTextContent('report-writer'))
    expect(screen.queryByRole('button', { name: '接受任务' })).toBeNull()
    expect(screen.queryByRole('button', { name: '拒绝任务' })).toBeNull()
    expect(screen.getByTestId('task-assignee')).toHaveTextContent('Bob')
    expect(screen.getByTestId('task-assignment-state')).toHaveTextContent('已接受')
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
