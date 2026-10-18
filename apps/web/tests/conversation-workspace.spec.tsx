/**
 * 连续对话工作区（P1-393；ADR-0019）。判据覆盖六组场景的页面级接线：
 *
 * 1. 多次执行/续聊/重跑/追问/拒绝指令连续呈现；查看历史不改变发送目标；
 * 2. 事件分页读到末尾（>500 条也能读到末尾回复）、重复帧、受众空隙、失败保留 + 重试、失效重拉；
 * 3. 默认续聊（最近一次业务运行）+ 简短目标标签、不可续聊的说明、草稿不改投/不重复发送；
 * 4. 空态/执行中/待审批/完成/失败/取消/丢失/读取不完整；
 * 5. 双成员权限（候选隐私、待审批卡只给责任人）；
 * 6. 20 段窗口与更早加载、加载更早不抢滚动（布局读数由 Q5 生产装配判）。
 */
import { act, screen, waitFor, within } from '@testing-library/react'
import { userEvent } from '@testing-library/user-event'
import { describe, expect, it } from 'vitest'
import {
  ALICE,
  BOB,
  apiFailure,
  loggedInHandlers,
  makeArtifact,
  makeInstruction,
  makeRun,
  makeTask,
  ok,
  taskRoomHandler,
  teamMembersHandler,
} from './fixtures.js'
import type { MockHandler } from './fixtures.js'
import { renderApp } from './render.js'
import { showExecutionOptions, showWorkspace, workspaceDetails } from './workspace.js'
import { queryKeys } from '../src/app/query-client.js'
import { RUN_EVENT_PAGE_LIMIT } from '../src/shared/realtime/run-event-pages.js'
import type {
  InstructionView,
  RunEventItem,
  TaskRoomRun,
  TaskView,
} from '../src/shared/api/types.js'

const AGENT = '00000000-0000-4000-8000-0000000000a1'
const REVISION = '00000000-0000-4000-8000-0000000000a2'

const R1 = '11111111-1111-4111-8111-111111111111'
const R2 = '22222222-2222-4222-8222-222222222222'
const R3 = '33333333-3333-4333-8333-333333333333'
const R4 = '44444444-4444-4444-8444-444444444444'

function event(runId: string, seq: number, body: Record<string, unknown>): RunEventItem {
  return {
    runId,
    seq,
    audience: 'project',
    type: String(body['type']),
    event: body,
    occurredAt: `2026-08-25T0${Math.min(9, 1 + (seq % 9))}:00:00.000Z`,
    receivedAt: `2026-08-25T0${Math.min(9, 1 + (seq % 9))}:00:00.000Z`,
  }
}

const completed = (runId: string, seq: number, finalText: string) =>
  event(runId, seq, { type: 'run.completed', finalText })

/** 运行详情（RunView）：owner 判定与事件读取都取它。 */
function runDetail(
  task: TaskView,
  run: TaskRoomRun,
  over: Partial<{
    ownerUserId: string
    dshSessionId: string | null
    failureCode: string | null
    resumeFromRunId: string | null
    rerunOfRunId: string | null
  }> = {},
): MockHandler {
  return {
    method: 'GET',
    url: new RegExp(`/api/v1/runs/${run.id}$`),
    respond: () =>
      ok({
        ...run,
        taskId: task.id,
        ownerUserId: over.ownerUserId ?? task.assigneeUserId,
        agentId: AGENT,
        profileRevisionId: REVISION,
        deviceId: '00000000-0000-4000-8000-0000000000d1',
        workspaceId: '00000000-0000-4000-8000-0000000000d2',
        dshSessionId: over.dshSessionId === undefined ? 'session-1' : over.dshSessionId,
        failureCode: over.failureCode ?? null,
        failureSummary: null,
        resumeFromRunId: over.resumeFromRunId ?? run.resumeFromRunId,
        rerunOfRunId: over.rerunOfRunId ?? run.rerunOfRunId,
        profileDigest: 'b'.repeat(64),
      }),
  }
}

/** 分页事件读取的状态化桩：按调用次序给页；`failAt` 指定第几次调用返回 5xx。 */
function pagedEvents(runId: string, pages: RunEventItem[][]) {
  const state = { calls: 0, failAt: undefined as number | undefined }
  const handler: MockHandler = {
    method: 'GET',
    url: new RegExp(`/api/v1/runs/${runId}/events`),
    respond: () => {
      state.calls += 1
      if (state.failAt !== undefined && state.calls === state.failAt)
        return apiFailure('INTERNAL_ERROR', '事件读取失败')
      return ok({ events: pages[state.calls - 1] ?? [] })
    },
  }
  return { handler, state }
}

function agentHandlers(): MockHandler[] {
  return [
    {
      method: 'GET',
      url: /\/api\/v1\/agents$/,
      respond: () =>
        ok([{ id: AGENT, name: 'Builder', archivedAt: null, currentRevisionId: REVISION }]),
    },
    {
      method: 'GET',
      url: new RegExp(`/api/v1/agents/${AGENT}$`),
      respond: () =>
        ok({
          id: AGENT,
          name: 'Builder',
          archivedAt: null,
          currentRevisionId: REVISION,
          revisions: [
            {
              id: REVISION,
              revision: 1,
              approvalPolicy: 'approval_required',
              provider: 'replay',
              credentialSlot: 'default',
              model: 'replay-model',
            },
          ],
        }),
    },
  ]
}

function task(over: Partial<TaskView> = {}): TaskView {
  return makeTask({
    assigneeUserId: ALICE.userId,
    assignmentStatus: 'accepted',
    status: 'in_progress',
    ...over,
  })
}

function segmentOf(runId: string): HTMLElement {
  const segment = screen
    .getAllByTestId('run-segment')
    .find((item) => item.getAttribute('data-run-id') === runId)
  if (segment === undefined) throw new Error(`segment ${runId} not found`)
  return segment
}

describe('连续对话：段序与历史阅读（判据 1）', () => {
  it('多次执行/续聊/重跑/追问/拒绝指令连续呈现；历史回复不因查看另一运行而消失', async () => {
    const user = userEvent.setup()
    const room = task()
    const runs = [
      makeRun({ id: R1, status: 'completed', createdAt: '2026-08-25T01:00:00.000Z' }),
      makeRun({
        id: R2,
        status: 'completed',
        resumeFromRunId: R1,
        createdAt: '2026-08-25T02:00:00.000Z',
      }),
      makeRun({
        id: R3,
        status: 'completed',
        rerunOfRunId: R1,
        createdAt: '2026-08-25T03:00:00.000Z',
      }),
      makeRun({ id: R4, status: 'running', createdAt: '2026-08-25T04:00:00.000Z' }),
    ]
    const instructions: InstructionView[] = [
      makeInstruction({
        id: 'i1',
        runId: R1,
        body: '起草初稿',
        createdAt: '2026-08-25T01:00:10.000Z',
      }),
      makeInstruction({
        id: 'i2',
        runId: R1,
        kind: 'followup',
        body: '补一段验收标准',
        createdAt: '2026-08-25T01:30:00.000Z',
      }),
      makeInstruction({
        id: 'rejected',
        runId: R1,
        kind: 'followup',
        body: '这句被拒了',
        createdAt: '2026-08-25T01:40:00.000Z',
        instructionState: 'rejected',
        instructionErrorCode: 'RUN_TERMINAL',
        instructionErrorMessage: '运行已结束',
      }),
      makeInstruction({
        id: 'i3',
        runId: R2,
        body: '接着写第二节',
        createdAt: '2026-08-25T02:00:10.000Z',
      }),
      makeInstruction({
        id: 'i4',
        runId: R3,
        body: '重跑一遍',
        createdAt: '2026-08-25T03:00:10.000Z',
      }),
      makeInstruction({
        id: 'i5',
        runId: R4,
        body: '最后检查',
        createdAt: '2026-08-25T04:00:10.000Z',
      }),
      // 无所属运行的拒绝指令：按时间留在主对话里。
      makeInstruction({
        id: 'orphan',
        runId: null,
        body: '没有所属运行的拒绝指令',
        createdAt: '2026-08-25T03:30:00.000Z',
        instructionState: 'rejected',
        instructionErrorCode: 'RUN_TERMINAL',
        instructionErrorMessage: '没有可投递的运行',
      }),
    ]
    const pages = [
      pagedEvents(R1, [
        [
          event(R1, 1, { type: 'assistant.message', text: '第一版写好了' }),
          completed(R1, 2, '第一版写好了'),
        ],
      ]),
      pagedEvents(R2, [[completed(R2, 1, '第二节写好了')]]),
      pagedEvents(R3, [[completed(R3, 1, '重跑完成')]]),
      pagedEvents(R4, [[event(R4, 1, { type: 'run.phase', phase: 'thinking' })]]),
    ]
    renderApp(
      `/tasks/${room.id}`,
      loggedInHandlers(ALICE, [
        taskRoomHandler(room, { runs, instructions }),
        ...runs.map((run) => runDetail(room, run)),
        ...pages.map((page) => page.handler),
        ...agentHandlers(),
        teamMembersHandler(),
      ]),
    )

    // 四段按服务端顺序连续出现，段内指令/回复按时间序。
    await waitFor(() => expect(screen.getAllByTestId('run-segment')).toHaveLength(4))
    expect(segmentOf(R1)).toHaveTextContent('第一版写好了')
    expect(segmentOf(R1)).toHaveTextContent('起草初稿')
    expect(segmentOf(R1)).toHaveTextContent('这句被拒了')
    expect(segmentOf(R1)).toHaveTextContent('运行已结束')
    expect(segmentOf(R2)).toHaveTextContent('第二节写好了')
    expect(segmentOf(R2)).toHaveTextContent('接着写第二节')
    expect(segmentOf(R3)).toHaveTextContent('重跑完成')
    // 无所属运行的拒绝指令仍按时间保留。
    const list = screen.getByTestId('conversation-list')
    expect(list).toHaveTextContent('没有所属运行的拒绝指令')

    // 打开第 1 段的运行详情（查看历史）：别的段的回复不消失，发送目标不变。
    await user.click(within(segmentOf(R1)).getByRole('button', { name: /第 1 次运行/ }))
    const detail = workspaceDetails()
    expect(await detail.findByTestId('run-detail-meta')).toBeVisible()
    expect(segmentOf(R2)).toHaveTextContent('第二节写好了')
    expect(segmentOf(R3)).toHaveTextContent('重跑完成')
    // 血缘说人话：续跑自/重跑自第 N 次运行。
    await user.click(detail.getByLabelText('切换运行'))
    await user.click(await screen.findByRole('menuitem', { name: '第 2 次运行' }))
    expect(await detail.findByText('续跑自第 1 次运行')).toBeVisible()
    await user.keyboard('{Escape}')
    await user.click(within(segmentOf(R3)).getByRole('button', { name: /第 3 次运行/ }))
    expect(await workspaceDetails().findByText('重跑自第 1 次运行')).toBeVisible()
  })

  it('首屏 20 段；顶部加载更早 20 次；加载更早不把正在读的人拽到底部（判据 6 的组件面）', async () => {
    const user = userEvent.setup()
    const room = task()
    const runs = Array.from({ length: 25 }, (_, index) =>
      makeRun({
        id: `run-${String(index + 1).padStart(2, '0')}`,
        status: 'completed',
        createdAt: `2026-08-25T0${Math.floor(index / 10)}:${String(index % 10).padStart(2, '0')}:00.000Z`,
      }),
    )
    renderApp(
      `/tasks/${room.id}`,
      loggedInHandlers(ALICE, [
        taskRoomHandler(room, { runs }),
        ...runs.map((run) => runDetail(room, run)),
        ...runs.map((run) => pagedEvents(run.id, [[]]).handler),
        ...agentHandlers(),
        teamMembersHandler(),
      ]),
    )
    await waitFor(() => expect(screen.getAllByTestId('run-segment')).toHaveLength(20))
    const earlier = screen.getByTestId('load-earlier')
    expect(earlier).toHaveTextContent('加载更早记录')
    expect(earlier).toHaveTextContent('还有 5 次运行')
    // 段的序号按服务端全序（第 6 次运行 = 窗口里最早的一段）。
    expect(segmentOf('run-06').querySelector('.run-label')).toHaveTextContent('第 6 次运行')

    // 用户上翻后加载更早：content 变多但滚动位置不被抢（stub 度量）。
    const scroller = screen.getByTestId('conversation-scroll')
    let scrollTop = 0
    Object.defineProperty(scroller, 'scrollHeight', { value: 2000, configurable: true })
    Object.defineProperty(scroller, 'clientHeight', { value: 400, configurable: true })
    Object.defineProperty(scroller, 'scrollTop', {
      configurable: true,
      get: () => scrollTop,
      set: (value: number) => {
        scrollTop = value
      },
    })
    scrollTop = 100
    act(() => {
      scroller.dispatchEvent(new Event('scroll'))
    })
    await screen.findByTestId('conversation-jump')
    await user.click(earlier)
    await waitFor(() => expect(screen.getAllByTestId('run-segment')).toHaveLength(25))
    expect(screen.queryByTestId('load-earlier')).toBeNull()
    expect(scrollTop).toBe(100)
  })
})

describe('连续对话：事件读取（判据 2）', () => {
  it('超过 500 条事件仍读到末尾回复（分页续读到最后）', async () => {
    const room = task()
    const run = makeRun({ id: R1, status: 'completed' })
    const firstPage = Array.from({ length: RUN_EVENT_PAGE_LIMIT }, (_, index) =>
      event(R1, index + 1, { type: 'run.phase', phase: 'thinking' }),
    )
    const pages = pagedEvents(R1, [
      firstPage,
      [completed(R1, RUN_EVENT_PAGE_LIMIT + 1, '末尾回复')],
    ])
    renderApp(
      `/tasks/${room.id}`,
      loggedInHandlers(ALICE, [
        taskRoomHandler(room, { runs: [run] }),
        runDetail(room, run),
        pages.handler,
        ...agentHandlers(),
        teamMembersHandler(),
      ]),
    )
    await waitFor(() => expect(segmentOf(R1)).toHaveTextContent('末尾回复'))
    expect(pages.state.calls).toBe(2)
    expect(screen.queryByTestId('run-events-incomplete')).toBeNull()
  })

  it('重复帧按身份去重、受众序号空隙不视为丢帧', async () => {
    const room = task()
    const run = makeRun({ id: R1, status: 'completed' })
    const pages = pagedEvents(R1, [
      [
        event(R1, 3, { type: 'run.phase', phase: 'thinking' }),
        event(R1, 3, { type: 'run.phase', phase: 'thinking' }),
        event(R1, 9, { type: 'run.phase', phase: 'tool' }),
        completed(R1, 12, '缝隙之后仍有回复'),
      ],
    ])
    renderApp(
      `/tasks/${room.id}`,
      loggedInHandlers(ALICE, [
        taskRoomHandler(room, { runs: [run] }),
        runDetail(room, run),
        pages.handler,
        ...agentHandlers(),
        teamMembersHandler(),
      ]),
    )
    await waitFor(() => expect(segmentOf(R1)).toHaveTextContent('缝隙之后仍有回复'))
    expect(screen.queryByTestId('run-events-incomplete')).toBeNull()
    const user = userEvent.setup()
    await user.click(within(segmentOf(R1)).getByText('工具与运行记录'))
    expect(within(segmentOf(R1)).getAllByText(/#3/)).toHaveLength(1)
  })

  it('分页失败保留已读内容 + 重试；实时失效（重连）后重新读到末尾', async () => {
    const user = userEvent.setup()
    const room = task()
    const run = makeRun({ id: R1, status: 'completed' })
    const firstPage = Array.from({ length: RUN_EVENT_PAGE_LIMIT }, (_, index) =>
      event(R1, index + 1, { type: 'run.phase', phase: 'thinking' }),
    )
    const pages = pagedEvents(R1, [
      firstPage,
      [completed(R1, RUN_EVENT_PAGE_LIMIT + 1, '末尾回复')],
    ])
    pages.state.failAt = 2
    const view = renderApp(
      `/tasks/${room.id}`,
      loggedInHandlers(ALICE, [
        taskRoomHandler(room, { runs: [run] }),
        runDetail(room, run),
        pages.handler,
        ...agentHandlers(),
        teamMembersHandler(),
      ]),
    )
    // 失败：已读到的内容还在，「不完整」与重试入口都在（不误报为空记录）。
    await screen.findByTestId('run-events-incomplete')
    const segment = segmentOf(R1)
    await user.click(within(segment).getByText('工具与运行记录'))
    expect(within(segment).getAllByText(/#1/).length).toBeGreaterThan(0)
    expect(within(segment).queryByText('还没有事件。')).toBeNull()

    // 网络恢复后重试：重试是一次**从头读**（after 游标重置），桩也从头给页。
    pages.state.failAt = undefined
    pages.state.calls = 0
    await user.click(within(segment).getByTestId('retry-run-events'))
    await waitFor(() => expect(segmentOf(R1)).toHaveTextContent('末尾回复'))

    // 重连（WS 的 ['run'] 前缀失效后重拉）走同一条读取：缓存清掉后重读仍能到末尾。
    pages.state.calls = 0
    await act(async () => {
      view.queryClient.removeQueries({ queryKey: queryKeys.runEventPages(R1) })
    })
    await act(async () => {
      await view.queryClient.invalidateQueries({ queryKey: queryKeys.run(R1) })
    })
    await waitFor(() => expect(segmentOf(R1)).toHaveTextContent('末尾回复'))
  })
})

describe('连续对话：默认续聊与草稿（判据 3）', () => {
  it('运行结束后默认续聊最近一次业务运行，并显示简短目标标签', async () => {
    const room = task()
    const run = makeRun({ id: R1, status: 'completed' })
    renderApp(
      `/tasks/${room.id}`,
      loggedInHandlers(ALICE, [
        taskRoomHandler(room, { runs: [run] }),
        runDetail(room, run),
        pagedEvents(R1, [[completed(R1, 1, '写完了')]]).handler,
        ...agentHandlers(),
        teamMembersHandler(),
      ]),
    )
    await screen.findByTestId('run-segment')
    expect(await screen.findByText('Builder · 续聊第 1 次运行')).toBeVisible()
    const user = userEvent.setup()
    await showExecutionOptions(user)
    expect(await screen.findByTestId('instruction-routing-hint')).toHaveTextContent('续接指定会话')
    expect(screen.getByLabelText('来源执行')).toHaveTextContent('第 1 次运行')
  })

  it('辅助运行不冒充续聊来源；没有可续会话时保留草稿并说明原因（不自动改投）', async () => {
    const room = task()
    const run = makeRun({ id: R1, status: 'completed', purpose: 'business' })
    const draft = makeRun({ id: R2, status: 'completed', purpose: 'agreement_draft' })
    renderApp(
      `/tasks/${room.id}`,
      loggedInHandlers(ALICE, [
        taskRoomHandler(room, { runs: [run, draft] }),
        runDetail(room, run),
        runDetail(room, draft, { dshSessionId: null }),
        pagedEvents(R1, [[completed(R1, 1, '业务回复')]]).handler,
        pagedEvents(R2, [[]]).handler,
        ...agentHandlers(),
        teamMembersHandler(),
      ]),
    )
    // 默认来源仍是最近一次**业务**运行（辅助运行不冒充）。
    expect(await screen.findByText('Builder · 续聊第 1 次运行')).toBeVisible()
    // 来源没有可续接的会话：明确说明并保留草稿。
    const user = userEvent.setup()
    await showExecutionOptions(user)
    await user.click(screen.getByLabelText('来源执行'))
    await user.click(await screen.findByRole('menuitem', { name: '第 2 次运行' }))
    expect(await screen.findByTestId('execution-blocker')).toHaveTextContent(
      '这次执行没有可续接的会话，请开始新执行。',
    )
    expect(screen.getByLabelText('指令')).toHaveValue('')
    expect(screen.getByRole('button', { name: '继续会话' })).toBeDisabled()
  })

  it('用户明确改选后默认规则不再改写；「继续此会话」保留已有文字且不自动发送', async () => {
    const room = task()
    const runs = [
      makeRun({ id: R1, status: 'completed', createdAt: '2026-08-25T01:00:00.000Z' }),
      makeRun({ id: R2, status: 'completed', createdAt: '2026-08-25T02:00:00.000Z' }),
    ]
    const view = renderApp(
      `/tasks/${room.id}`,
      loggedInHandlers(ALICE, [
        taskRoomHandler(room, { runs }),
        ...runs.map((run) => runDetail(room, run)),
        ...runs.map((run) => pagedEvents(run.id, [[]]).handler),
        ...agentHandlers(),
        teamMembersHandler(),
      ]),
    )
    await screen.findAllByTestId('run-segment')
    const user = userEvent.setup()
    // 用户明确选「开始新执行」：输入一句草稿。
    await showExecutionOptions(user)
    await user.click(screen.getByLabelText('执行方式'))
    await user.click(await screen.findByRole('menuitem', { name: /开始新执行/ }))
    await user.type(screen.getByLabelText('指令'), '我要全新跑一遍')

    // 「继续此会话」把历史运行设为来源，但保留已有文字、也不自动发送。
    await user.click(within(segmentOf(R1)).getByTestId('continue-session-button'))
    await waitFor(() => expect(screen.getByText(/续聊第 1 次运行/)).toBeVisible())
    expect(screen.getByLabelText('指令')).toHaveValue('我要全新跑一遍')
    expect(
      view.fetchMock.mock.calls.filter(([url]) => String(url).endsWith('/instructions')),
    ).toHaveLength(0)
    // 草稿里的文字仍在：默认规则不得把它清掉或改投。
    await act(async () => {
      await view.queryClient.invalidateQueries({ queryKey: queryKeys.taskRoom(room.id) })
    })
    expect(screen.getByLabelText('指令')).toHaveValue('我要全新跑一遍')
    expect(screen.getByText(/续聊第 1 次运行/)).toBeVisible()
  })
})

describe('连续对话：状态（判据 4）', () => {
  it('空态只邀请说第一句；没有运行时不画段', async () => {
    const room = task()
    renderApp(
      `/tasks/${room.id}`,
      loggedInHandlers(ALICE, [
        taskRoomHandler(room, { runs: [] }),
        ...agentHandlers(),
        teamMembersHandler(),
      ]),
    )
    expect(await screen.findByRole('heading', { name: '我们要完成什么？' })).toBeVisible()
    expect(screen.queryAllByTestId('run-segment')).toHaveLength(0)
    expect(screen.queryByTestId('load-earlier')).toBeNull()
  })

  it.each([
    ['running', /等待活动更新/],
    ['completed', '本次运行已完成'],
    ['failed', '本次运行失败'],
    ['cancelled', '本次运行已取消'],
    ['lost', '运行已丢失，结果未知'],
  ] as const)('%s 的段给出简短状态', async (status, label) => {
    const room = task()
    const run = makeRun({ id: R1, status })
    renderApp(
      `/tasks/${room.id}`,
      loggedInHandlers(ALICE, [
        taskRoomHandler(room, { runs: [run] }),
        runDetail(room, run, { failureCode: status === 'failed' ? 'RUNTIME_LOST' : null }),
        pagedEvents(R1, [[event(R1, 1, { type: 'run.phase', phase: 'tool' })]]).handler,
        ...agentHandlers(),
        teamMembersHandler(),
      ]),
    )
    await waitFor(() => expect(segmentOf(R1)).toHaveTextContent(label))
    if (status === 'failed' || status === 'lost') {
      expect(within(segmentOf(R1)).getByTestId('run-failure-notice')).toBeVisible()
    }
  })

  it('待审批的段直接在段内给审批卡；审批不是「没有事件」', async () => {
    const room = task()
    const run = makeRun({ id: R1, status: 'waiting_approval' })
    renderApp(
      `/tasks/${room.id}`,
      loggedInHandlers(ALICE, [
        taskRoomHandler(room, { runs: [run] }),
        runDetail(room, run),
        pagedEvents(R1, [
          [
            event(R1, 1, {
              type: 'approval.requested',
              approval: {
                approvalId: 'ap-1',
                runId: R1,
                callId: 'call-1',
                toolName: 'publish_artifact',
                status: 'pending',
                requestedAt: '2026-08-25T04:00:00.000Z',
                expiresAt: '2026-08-25T04:10:00.000Z',
                reason: '要发布交付物',
                preview: { category: 'artifact' },
              },
            }),
          ],
        ]).handler,
        ...agentHandlers(),
        teamMembersHandler(),
      ]),
    )
    const card = await screen.findByTestId('approval-card')
    expect(card).toBeVisible()
    // 卡在等待审批的那一段里（不是别的地方）。
    expect(segmentOf(R1).contains(card)).toBe(true)
    expect(within(segmentOf(R1)).getByTestId('approve-button')).toBeVisible()
  })

  it('读取不完整时段的记录里明确说「不完整」，不冒充成没有记录', async () => {
    const room = task()
    const run = makeRun({ id: R1, status: 'completed' })
    const pages = pagedEvents(R1, [[]])
    pages.state.failAt = 1
    renderApp(
      `/tasks/${room.id}`,
      loggedInHandlers(ALICE, [
        taskRoomHandler(room, { runs: [run] }),
        runDetail(room, run),
        pages.handler,
        ...agentHandlers(),
        teamMembersHandler(),
      ]),
    )
    const user = userEvent.setup()
    await screen.findByTestId('run-events-incomplete')
    await user.click(within(segmentOf(R1)).getByText('工具与运行记录'))
    expect(within(segmentOf(R1)).getByTestId('run-events-incomplete')).toHaveTextContent(
      '还没读到任何事件',
    )
  })
})

describe('连续对话：权限与隐私（判据 5）', () => {
  it('member 只见等待态、看不到候选文件卡；owner 的候选卡只在对应段', async () => {
    const room = task()
    const run = makeRun({ id: R1, status: 'waiting_approval' })
    const candidate = makeArtifact({
      id: 'a-candidate',
      runId: R1,
      ownerUserId: ALICE.userId,
      title: '草稿.md',
      status: 'candidate',
      publishedAt: null,
    })
    const published = makeArtifact({
      id: 'a-published',
      runId: R1,
      title: '已发布.md',
      status: 'published',
    })
    const handlers = (session: typeof ALICE): MockHandler[] =>
      loggedInHandlers(session, [
        taskRoomHandler(room, { runs: [run], artifacts: [candidate, published] }),
        runDetail(room, run, { ownerUserId: ALICE.userId }),
        pagedEvents(R1, [
          [
            event(R1, 1, {
              type: 'approval.requested',
              approval: {
                approvalId: 'ap-1',
                runId: R1,
                callId: 'call-1',
                toolName: 'publish_artifact',
                status: 'pending',
                requestedAt: '2026-08-25T04:00:00.000Z',
                expiresAt: '2026-08-25T04:10:00.000Z',
                reason: '要发布交付物',
                preview: { category: 'artifact' },
              },
            }),
          ],
        ]).handler,
        ...agentHandlers(),
        teamMembersHandler(),
      ])

    const ownerView = renderApp(`/tasks/${room.id}`, handlers(ALICE))
    await screen.findAllByTestId('run-segment')
    expect(await screen.findByRole('button', { name: '查看交付物 草稿.md' })).toBeVisible()
    expect(segmentOf(R1).contains(screen.getByRole('button', { name: '查看交付物 草稿.md' }))).toBe(
      true,
    )
    expect(screen.getByTestId('approval-card')).toBeVisible()
    ownerView.unmount()

    renderApp(`/tasks/${room.id}`, handlers(BOB))
    await screen.findAllByTestId('run-segment')
    expect(await screen.findByRole('button', { name: '查看交付物 已发布.md' })).toBeVisible()
    expect(screen.queryByRole('button', { name: '查看交付物 草稿.md' })).toBeNull()
    expect(await screen.findByTestId('approval-waiting')).toBeVisible()
    expect(screen.queryByTestId('approval-card')).toBeNull()
  })
})
