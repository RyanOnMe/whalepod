import { act, screen, waitFor, within } from '@testing-library/react'
import { userEvent } from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import type { AttentionItem } from '@whalepod/protocol'
import { renderApp } from './render.js'
import {
  ALICE,
  BOB,
  apiFailure,
  loggedInHandlers,
  makeArtifact,
  makeRun,
  makeTask,
  ok,
  taskRoomHandler,
  teamMembersHandler,
  type MockHandler,
} from './fixtures.js'
import { applyClientFrame, keysForPersistentEvent } from '../src/shared/realtime/event-router.js'
import { persistentFrame } from './frames.js'
const CARD = 'cccccccc-1234-4000-8000-000000000001'
const labels = {
  accept_assignment: '接受任务',
  reassign_task: '重新指派',
  decide_approval: '处理审批',
  confirm_handoff: '确认接收交接',
  inspect_candidate: '检查候选',
  complete_task: '确认完成',
} as const
function fixture(
  kind: AttentionItem['kind'] = 'accept_assignment',
  gate?: Promise<void>,
  eventsGate?: Promise<void>,
) {
  const task = makeTask({
    title: '待我处理的工作',
    assignmentStatus:
      kind === 'accept_assignment' ? 'pending' : kind === 'reassign_task' ? 'rejected' : 'accepted',
    status: kind === 'complete_task' ? 'in_review' : 'in_progress',
  })
  const run = makeRun({ status: kind === 'decide_approval' ? 'waiting_approval' : 'completed' })
  const artifact = makeArtifact({ runId: run.id, status: 'candidate', title: '仅自己可见的候选' })
  const item: AttentionItem = {
    kind,
    taskId: task.id,
    taskTitle: task.title,
    projectName: '项目甲',
    objectId:
      kind === 'inspect_candidate'
        ? artifact.id
        : kind === 'decide_approval' || kind === 'confirm_handoff'
          ? CARD
          : task.id,
    runId: kind === 'inspect_candidate' || kind === 'decide_approval' ? run.id : null,
    createdAt: task.createdAt,
  }
  const state = {
    items: [item] as unknown[],
    hasMore: false,
    fail: false,
    accepted: false,
    refreshGate: undefined as Promise<void> | undefined,
    roomGate: undefined as Promise<void> | undefined,
    waitingRun: false,
    approvalToolName: 'bash',
  }
  let eventReads = 0
  const handlers: MockHandler[] = [
    { method: 'GET', url: /\/projects$/, respond: () => ok([]) },
    { method: 'GET', url: /\/tasks\/recent$/, respond: () => ok([]) },
    {
      method: 'GET',
      url: /\/tasks\/attention$/,
      respond: async () => {
        await gate
        await state.refreshGate
        return state.fail
          ? apiFailure('INTERNAL_ERROR', '读取失败')
          : ok({ items: state.items, hasMore: state.hasMore })
      },
    },
    {
      method: 'GET',
      url: new RegExp(`/tasks/${task.id}$`),
      respond: async () => {
        await state.roomGate
        return taskRoomHandler(
          { ...task, assignmentStatus: state.accepted ? 'accepted' : task.assignmentStatus },
          {
            runs:
              kind === 'decide_approval' || state.waitingRun
                ? [{ ...run, status: 'waiting_approval' }]
                : [],
            artifacts: kind === 'inspect_candidate' ? [artifact] : [],
          },
        ).respond({}, `/api/v1/tasks/${task.id}`)
      },
    },
    {
      method: 'GET',
      url: /\/events(?:\?.*)?$/,
      respond: async () => {
        eventReads++
        await eventsGate
        return ok({
          events: [
            {
              runId: run.id,
              seq: 1,
              type: 'approval.requested',
              audience: 'owner',
              occurredAt: task.createdAt,
              receivedAt: task.createdAt,
              event: {
                type: 'approval.requested',
                approval: {
                  approvalId: CARD,
                  toolName: state.approvalToolName,
                  preview: {},
                  status: 'pending',
                  requestedAt: task.createdAt,
                  expiresAt: '2099-01-01T00:00:00.000Z',
                },
              },
            },
          ],
        })
      },
    },
    {
      method: 'GET',
      url: new RegExp(`/runs/${run.id}$`),
      respond: () => ok({ ...run, taskId: task.id }),
    },
    { method: 'GET', url: /\/agents$/, respond: () => ok([]) },
    { method: 'GET', url: /\/handoff-receipts$/, respond: () => ok([]) },
    { method: 'GET', url: /\/(devices|workspaces)$/, respond: () => ok([]) },
    { method: 'GET', url: /\/instruction-grants$/, respond: () => ok([]) },
    {
      method: 'POST',
      url: /\/accept$/,
      respond: () => {
        state.items = []
        state.accepted = true
        return ok({ ...task, assignmentStatus: 'accepted' })
      },
    },
    teamMembersHandler(),
  ]
  const view = renderApp('/', loggedInHandlers(kind === 'reassign_task' ? ALICE : BOB, handlers))
  return { ...view, task, run, artifact, item, state, eventReads: () => eventReads }
}
function region() {
  return screen.getByRole('region', { name: '需要我处理' })
}
describe('首页个人行动入口 (#332)', () => {
  it('读取与导航不发命令；上限提示不伪装全量', async () => {
    const f = fixture()
    f.state.hasMore = true
    expect(await screen.findByRole('link', { name: `接受任务 · ${f.task.title}` })).toHaveAttribute(
      'href',
      `/tasks/${f.task.id}#task-assignment`,
    )
    expect(region()).toHaveTextContent('后续事项')
    expect(f.fetchMock.mock.calls.some(([, init]) => init?.method === 'POST')).toBe(false)
  })
  it('读取中、错误与确实为空分开，错误不保留可行动的旧项', async () => {
    let release!: () => void
    const gate = new Promise<void>((r) => {
      release = r
    })
    const f = fixture('accept_assignment', gate)
    expect(await screen.findByText('正在确认需处理事项…')).toBeVisible()
    await act(async () => release())
    await screen.findByRole('link', { name: `接受任务 · ${f.task.title}` })
    f.state.fail = true
    await act(async () => {
      await f.queryClient.invalidateQueries({ queryKey: ['attention'] })
    })
    expect(await within(region()).findByRole('button', { name: '重新读取待办' })).toBeVisible()
    expect(within(region()).queryByRole('link')).not.toBeInTheDocument()
    f.state.fail = false
    f.state.items = []
    await userEvent.setup().click(within(region()).getByRole('button', { name: '重新读取待办' }))
    expect(await screen.findByText('暂无待办。')).toBeVisible()
  })
  it.each([
    'accept_assignment',
    'reassign_task',
    'inspect_candidate',
    'complete_task',
    'confirm_handoff',
  ] as const)('一次任务定位到实际行动并聚焦：%s', async (kind) => {
    const user = userEvent.setup()
    const f = fixture(kind)
    await user.click(await screen.findByRole('link', { name: `${labels[kind]} · ${f.task.title}` }))
    const id =
      kind === 'inspect_candidate'
        ? `artifact-${f.artifact.id}`
        : kind === 'complete_task'
          ? 'task-actions'
          : kind === 'confirm_handoff'
            ? 'handoff-receipt'
            : 'task-assignment'
    await waitFor(() => expect(document.getElementById(id)).toHaveFocus())
    expect(f.fetchMock.mock.calls.some(([, init]) => init?.method === 'POST')).toBe(false)
  })
  it('异步审批卡准备好后定位具体审批，不自动批准', async () => {
    const user = userEvent.setup()
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const f = fixture('decide_approval', undefined, gate)
    await user.click(await screen.findByRole('link', { name: `处理审批 · ${f.task.title}` }))
    expect(document.getElementById(`approval-${CARD}`)).toBeNull()
    await act(async () => release())
    await waitFor(() => expect(document.getElementById(`approval-${CARD}`)).toHaveFocus())
    expect(f.eventReads()).toBeGreaterThan(0)
    expect(f.fetchMock.mock.calls.some(([, init]) => init?.method === 'POST')).toBe(false)
  })
  it.each(['inspect_candidate', 'decide_approval'] as const)(
    '成功旧缓存补入新对象后仍定位，后续刷新不抢焦点：%s',
    async (kind) => {
      const user = userEvent.setup()
      let release!: () => void
      const gate = new Promise<void>((resolve) => {
        release = resolve
      })
      const f = fixture(kind, undefined, kind === 'decide_approval' ? gate : undefined)
      if (kind === 'inspect_candidate') {
        f.state.roomGate = gate
        f.state.waitingRun = true
      }
      await screen.findByRole('link', { name: `${labels[kind]} · ${f.task.title}` })
      const cached = {
        task: f.task,
        comments: [],
        instructions: [],
        artifacts: [],
        runs: [{ ...f.run, status: 'waiting_approval' }],
        nextRunApprovalPolicy: null,
      }
      f.queryClient.setQueryData(['task-room', f.task.id], cached, { updatedAt: 1 })
      if (kind === 'decide_approval') {
        // P1-393：审批卡与对话共用分页事件缓存键（['run', runId] 前缀下）。
        f.queryClient.setQueryData(
          ['run', f.run.id, 'event-pages'],
          { events: [], complete: true },
          { updatedAt: 1 },
        )
      }
      await user.click(screen.getByRole('link', { name: `${labels[kind]} · ${f.task.title}` }))
      await screen.findByTestId('task-back-link')
      const id = kind === 'inspect_candidate' ? `artifact-${f.artifact.id}` : `approval-${CARD}`
      expect(document.getElementById(id)).toBeNull()
      expect(f.queryClient.getQueryState(['task-room', f.task.id])?.status).toBe('success')
      if (kind === 'decide_approval')
        expect(f.queryClient.getQueryState(['run', f.run.id, 'event-pages'])?.status).toBe(
          'success',
        )
      await act(async () => release())
      await waitFor(() => expect(document.getElementById(id)).toHaveFocus())
      expect(f.fetchMock.mock.calls.some(([, init]) => init?.method === 'POST')).toBe(false)
      const back = screen.getByTestId('task-back-link')
      back.focus()
      await act(async () => {
        f.queryClient.setQueryData(['task-room', f.task.id], {
          ...cached,
          artifacts: kind === 'inspect_candidate' ? [f.artifact] : [],
          task: { ...f.task, title: '后台更新标题' },
        })
      })
      await screen.findByRole('heading', { name: '后台更新标题' })
      expect(back).toHaveFocus()
      f.state.approvalToolName = '审批工具更新'
      await act(async () => {
        // 实时失效走 run 族前缀（run.changed/run.event 的口径），不是某个具体子键。
        await f.queryClient.invalidateQueries({ queryKey: ['run', f.run.id] })
      })
      await screen.findByText('审批工具更新', { exact: true })
      expect(back).toHaveFocus()
    },
  )
  it('本人接受后回到缓存首页，旧事项消失，无需WS补偿', async () => {
    const user = userEvent.setup()
    const f = fixture()
    await user.click(await screen.findByRole('link', { name: `接受任务 · ${f.task.title}` }))
    await user.click(await screen.findByRole('button', { name: '接受任务' }))
    await waitFor(() => expect(f.state.accepted).toBe(true))
    expect(f.queryClient.getQueryState(['attention', BOB.userId])?.isInvalidated).toBe(true)
    await user.click(screen.getByTestId('task-back-link'))
    expect(await screen.findByText('暂无待办。')).toBeVisible()
    expect(within(region()).queryByRole('link')).not.toBeInTheDocument()
  })
  it('真实事件路由使远端变更刷新已打开的首页与最近任务', async () => {
    const f = fixture()
    await screen.findByRole('link', { name: `接受任务 · ${f.task.title}` })
    f.state.items = []
    const before = f.fetchMock.mock.calls.filter(([url]) =>
      String(url).endsWith('/tasks/recent'),
    ).length
    await act(async () =>
      applyClientFrame(f.queryClient, persistentFrame('task.changed', { taskId: f.task.id }), {
        cursorStore: { commit: () => {} },
        resync: () => {},
      }),
    )
    expect(await screen.findByText('暂无待办。')).toBeVisible()
    expect(
      f.fetchMock.mock.calls.filter(([url]) => String(url).endsWith('/tasks/recent')).length,
    ).toBeGreaterThan(before)
  })
  it('非法或包含多余私有字段的响应不渲染成待办', async () => {
    const f = fixture()
    f.state.items = [{ ...f.item, preview: { command: 'private' } }]
    await screen.findByRole('region', { name: '需要我处理' })
    await waitFor(() =>
      expect(within(region()).getByRole('button', { name: '重新读取待办' })).toBeVisible(),
    )
    expect(within(region()).queryByRole('link')).not.toBeInTheDocument()
  })
  it('后台刷新保留链接与键盘焦点，错误仍撤下失效列表', async () => {
    const f = fixture()
    const link = await screen.findByRole('link', { name: `接受任务 · ${f.task.title}` })
    link.focus()
    let release!: () => void
    f.state.refreshGate = new Promise<void>((resolve) => {
      release = resolve
    })
    let pending!: Promise<void>
    await act(async () => {
      pending = f.queryClient.invalidateQueries({ queryKey: ['attention'] })
    })
    expect(link).toHaveFocus()
    expect(link).toBeVisible()
    await act(async () => {
      release()
      await pending
    })
    expect(screen.getByRole('link', { name: `接受任务 · ${f.task.title}` })).toHaveFocus()
  })
  it('没有全员候选事件时，可见首页仍定期重新读取', async () => {
    vi.useFakeTimers()
    try {
      const f = fixture()
      for (
        let i = 0;
        i < 10 && screen.queryByRole('link', { name: `接受任务 · ${f.task.title}` }) === null;
        i++
      ) {
        await act(async () => {
          await vi.advanceTimersByTimeAsync(50)
        })
      }
      expect(screen.getByRole('link', { name: `接受任务 · ${f.task.title}` })).toBeVisible()
      f.state.items = []
      await act(async () => {
        await vi.advanceTimersByTimeAsync(15050)
      })
      expect(screen.getByText('暂无待办。')).toBeVisible()
    } finally {
      vi.useRealTimers()
    }
  })
  it('各类动作与权限变化均失效个人队列；普通流式事件不放大请求', () => {
    for (const type of [
      'task.changed',
      'run.changed',
      'approval.changed',
      'artifact.changed',
      'member.changed',
      'project.changed',
    ])
      expect(keysForPersistentEvent(persistentFrame(type, {}).event)).toContainEqual(['attention'])
    expect(
      keysForPersistentEvent(
        persistentFrame('run.event', { event: { type: 'assistant.message' } }).event,
      ),
    ).not.toContainEqual(['attention'])
  })
})
