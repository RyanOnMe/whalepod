/** #306：走生产展示入口，状态只能来自 Run/工具事件；缺失、串受众、断线均不能报成功。 */
import { QueryClientProvider } from '@tanstack/react-query'
import { act, render, screen, within } from '@testing-library/react'
import { userEvent } from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { makeQueryClient, queryKeys } from '../src/app/query-client.js'
import { RunConsole } from '../src/features/task/RunConsole.js'
import { RunLivePanel } from '../src/features/task/RunLivePanel.js'
import { RunTimeline } from '../src/features/task/RunTimeline.js'
import { RUN_STATUS_LABEL } from '../src/shared/format.js'
import type { RunEventItem, RunStatus, RunView } from '../src/shared/api/types.js'
import {
  resetConnectionStatusForTest,
  setConnectionStatus,
} from '../src/shared/realtime/connection-store.js'
import { BOB, apiFailure, installFetch, makeRun, ok } from './fixtures.js'

const RUN_ID = '33333333-3333-4333-8333-333333333333'
const states: RunStatus[] = [
  'queued',
  'dispatching',
  'running',
  'waiting_approval',
  'cancel_requested',
  'completed',
  'failed',
  'cancelled',
  'lost',
]
const markStates = [
  'pending',
  'pending',
  'running',
  'pending',
  'pending',
  'done',
  'failed',
  'cancelled',
  'failed',
]

function event(
  seq: number,
  body: Record<string, unknown>,
  audience: RunEventItem['audience'] = 'project',
  runId = RUN_ID,
): RunEventItem {
  return {
    runId,
    seq,
    audience,
    type: 'run.event',
    event: body,
    occurredAt: '2026-10-10T01:00:00.000Z',
    receivedAt: '2026-10-10T01:00:00.000Z',
  }
}
const started = (seq = 1, callId = 'call-1') =>
  event(seq, {
    type: 'tool.started',
    callId,
    toolName: 'read_file',
    preview: { privateArgument: 'must-not-render' },
  })
const finished = (seq = 2, outcome = 'succeeded', callId = 'call-1') =>
  event(seq, { type: 'tool.finished', callId, outcome })

function consoleView(events: RunEventItem[], runStatus: RunStatus = 'running') {
  return render(
    <RunConsole
      runId={RUN_ID}
      runLabel="第 1 次运行"
      runStatus={runStatus}
      events={events}
      eventsPending={false}
      onClose={() => {}}
    />,
  )
}

beforeEach(() => setConnectionStatus('open'))
afterEach(() => resetConnectionStatusForTest())

describe('#306 Run 状态图形', () => {
  it('九种状态保留中文标签；图形不额外朗读英文、完成不划掉文字', () => {
    render(<RunTimeline runs={states.map((status) => makeRun({ status }))} />)
    const buttons = screen.getAllByRole('button')
    states.forEach((status, index) => {
      const badge = buttons[index]!.querySelector('.badge-run')!
      expect(badge).toHaveTextContent(RUN_STATUS_LABEL[status])
      const mark = badge.querySelector('.status-mark')
      expect(mark).toHaveAttribute('data-status', markStates[index])
      expect(mark?.querySelector('svg')).toHaveAttribute('aria-hidden', 'true')
      expect(mark).not.toHaveAttribute('data-strike')
      expect(badge.textContent).toBe(RUN_STATUS_LABEL[status])
    })
  })

  it('连接丢失后立即停用活动图形；重新连接可恢复，审批/取消/终态都不活动', () => {
    const view = render(<RunTimeline runs={states.map((status) => makeRun({ status }))} />)
    expect(view.container.querySelectorAll('[data-indeterminate]')).toHaveLength(1)
    act(() => setConnectionStatus('reconnecting'))
    expect(view.container.querySelectorAll('[data-indeterminate]')).toHaveLength(0)
    expect(screen.getByText('运行中')).toBeVisible()
    act(() => setConnectionStatus('open'))
    expect(view.container.querySelectorAll('[data-indeterminate]')).toHaveLength(1)
  })
})

describe('#306 工具事实', () => {
  it.each([
    ['succeeded', 'done', '成功'],
    ['failed', 'error', '失败'],
    ['cancelled', 'cancelled', '已取消'],
  ])('%s 只由匹配的结束事件给出', (outcome, state, label) => {
    consoleView([started(), finished(2, outcome)])
    const chip = screen.getByTestId('tool-call-chip')
    expect(chip).toHaveAttribute('data-status', state)
    expect(chip).toHaveTextContent(label)
    expect(chip).toHaveTextContent('read_file')
    expect(chip).not.toHaveTextContent('must-not-render')
    expect(chip.querySelector('button')).toBeNull()
  })

  it('同名不同调用、受众或 Run 不串结果；缺少匹配结果不报成功', () => {
    consoleView([
      started(),
      started(3, 'call-2'),
      finished(4, 'failed', 'call-2'),
      { ...finished(5), audience: 'owner' },
      { ...finished(6), runId: 'another-run' },
    ])
    const chips = screen.getAllByTestId('tool-call-chip')
    expect(chips).toHaveLength(2)
    expect(chips[0]).toHaveAttribute('data-status', 'running')
    expect(chips[1]).toHaveAttribute('data-status', 'error')
  })

  it('按事件序号配对，重复行不重复展示；早于开始的结束不能用作结果', () => {
    consoleView([finished(4), started(3), started(3), finished(2, 'failed')])
    expect(screen.getAllByTestId('tool-call-chip')).toHaveLength(1)
    expect(screen.getByTestId('tool-call-chip')).toHaveAttribute('data-status', 'done')
  })

  it('终态缺失结束、未知 outcome、残缺 callId 都不能猜成成功或继续执行', () => {
    consoleView(
      [
        started(),
        started(3, 'call-2'),
        finished(4, 'brand-new-outcome', 'call-2'),
        event(5, { type: 'tool.started', toolName: 'legacy_tool' }),
      ],
      'completed',
    )
    const chips = screen.getAllByTestId('tool-call-chip')
    expect(chips).toHaveLength(3)
    for (const chip of chips) {
      expect(chip).toHaveAttribute('data-status', 'unknown')
      expect(chip).toHaveTextContent('结果未知')
    }
  })

  it('审批、取消中暂停；连接中断时未完成调用报连接状态，已确认结果保留', () => {
    const events = [started(), started(3, 'call-2'), finished(4, 'succeeded', 'call-2')]
    const view = consoleView(events, 'waiting_approval')
    expect(screen.getAllByTestId('tool-call-chip')[0]).toHaveTextContent('等待审批')
    view.rerender(
      <RunConsole
        runId={RUN_ID}
        runLabel="运行"
        runStatus="cancel_requested"
        events={events}
        eventsPending={false}
        onClose={() => {}}
      />,
    )
    expect(screen.getAllByTestId('tool-call-chip')[0]).toHaveTextContent('正在取消')
    act(() => setConnectionStatus('reconnecting'))
    expect(screen.getAllByTestId('tool-call-chip')[0]).toHaveTextContent('连接中断')
    expect(screen.getAllByTestId('tool-call-chip')[1]).toHaveAttribute('data-status', 'done')
  })

  it('Console 筛选仍按事件过滤，并保留全部事件中的配对结果与焦点', async () => {
    const user = userEvent.setup()
    consoleView([started(), finished(2, 'failed'), event(3, { type: 'approval.requested' })])
    await user.click(screen.getByTestId('console-filter-tool'))
    expect(screen.getAllByTestId('console-event')).toHaveLength(2)
    expect(screen.getByTestId('tool-call-chip')).toHaveAttribute('data-status', 'error')
    expect(screen.getByTestId('console-filter-tool')).toHaveFocus()
    await user.click(screen.getByTestId('console-filter-approval'))
    expect(screen.queryByTestId('tool-call-chip')).toBeNull()
    expect(screen.getAllByTestId('console-event')).toHaveLength(1)
  })

  it('直播面板真的接上图形/工具组件；事件加载失败不谎称没有事件', async () => {
    const run: RunView = {
      ...makeRun({ id: RUN_ID, status: 'running' }),
      taskId: 'task-1',
      ownerUserId: BOB.userId,
      agentId: 'agent-1',
      profileRevisionId: 'revision-1',
      deviceId: 'device-1',
      workspaceId: 'workspace-1',
      dshSessionId: null,
      failureCode: null,
      failureSummary: null,
      profileDigest: 'b'.repeat(64),
    }
    let fail = false
    installFetch([
      { method: 'GET', url: new RegExp(`/runs/${RUN_ID}$`), respond: () => ok(run) },
      {
        method: 'GET',
        url: new RegExp(`/runs/${RUN_ID}/events$`),
        respond: () =>
          fail
            ? apiFailure('TEST_EVENT_READ_FAILED', '事件读取失败')
            : ok({ events: [started(), finished()] }),
      },
    ])
    const client = makeQueryClient({ retry: false })
    render(
      <QueryClientProvider client={client}>
        <RunLivePanel runId={RUN_ID} runLabels={new Map()} session={BOB} />
      </QueryClientProvider>,
    )
    const panel = await screen.findByTestId('run-live-panel')
    expect(await within(panel).findByTestId('tool-call-chip')).toHaveAttribute(
      'data-status',
      'done',
    )
    expect(panel.querySelector('.status-mark')).not.toBeNull()
    fail = true
    await act(async () => {
      await client.invalidateQueries({ queryKey: queryKeys.runEvents(RUN_ID) })
    })
    expect(await within(panel).findByRole('alert')).toHaveTextContent('事件读取失败')
    expect(within(panel).queryByText('还没有事件。')).toBeNull()
  })
})
