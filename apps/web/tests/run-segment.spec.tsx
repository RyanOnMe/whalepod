/**
 * 运行段（P1-393；ADR-0019 决定 1/2/6/7）。
 *
 * 段把「这一段运行到现在发生了什么」一次讲清楚：短状态（活动行）、指令与回复的
 * 时间序、全量访问、完全权限标记、记录里的工具事实、读取不完整 + 重试、
 * 以及历史运行的「继续此会话 / 重跑」入口。这里用 props 直接喂读模型（页面级的
 * 取数接线在 conversation-workspace.spec.tsx 里用真实 fetch 驱动）。
 */
import { QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter } from 'react-router'
import { act, screen, within } from '@testing-library/react'
import { userEvent } from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { makeQueryClient } from '../src/app/query-client.js'
import { RunSegment } from '../src/features/task/RunSegment.js'
import type { RunSegmentRead } from '../src/features/task/RunSegment.js'
import { runReplies, segmentItems } from '../src/features/task/conversation.js'
import type { ConversationSegment } from '../src/features/task/conversation.js'
import { RUN_PHASE_LABEL, RUN_STATUS_LABEL } from '../src/shared/format.js'
import type { RunEventItem, RunStatus, RunView, Session } from '../src/shared/api/types.js'
import { appendLiveDelta, resetRunLiveBuffers } from '../src/shared/realtime/run-buffer.js'
import {
  resetConnectionStatusForTest,
  setConnectionStatus,
} from '../src/shared/realtime/connection-store.js'
import { BOB, makeInstruction, makeRun, makeTask } from './fixtures.js'
import { renderUi } from './render.js'

const RUN_ID = '33333333-3333-4333-8333-333333333333'
const OWNER: Session = { ...BOB, displayName: 'Bob' }

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
    type: String(body['type']),
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

function runView(status: RunStatus, over: Partial<RunView> = {}): RunView {
  const base = makeRun({ id: RUN_ID, status })
  return {
    ...base,
    taskId: 'task-1',
    ownerUserId: BOB.userId,
    agentId: 'agent-1',
    profileRevisionId: 'revision-1',
    deviceId: 'device-1',
    workspaceId: 'workspace-1',
    dshSessionId: null,
    failureCode: null,
    failureSummary: null,
    specRevisionId: null,
    purpose: 'business',
    profileDigest: 'b'.repeat(64),
    ...over,
  }
}

interface SegmentOptions {
  status?: RunStatus
  runOver?: Partial<ReturnType<typeof makeRun>>
  events?: RunEventItem[]
  eventsStatus?: RunSegmentRead['eventsStatus']
  detail?: RunView | undefined
  session?: Session | null
  instructions?: ReturnType<typeof makeInstruction>[]
  onContinueSession?: (runId: string) => void
  onOpenDetail?: (runId: string) => void
}

function segmentView({
  status = 'running',
  runOver = {},
  events = [],
  eventsStatus = 'complete',
  detail,
  session = OWNER,
  instructions = [],
  onContinueSession = () => {},
  onOpenDetail = () => {},
}: SegmentOptions = {}) {
  const run = makeRun({ id: RUN_ID, status, ...runOver })
  const replies = runReplies(events, RUN_ID)
  const segment: ConversationSegment = {
    run,
    label: '第 1 次运行',
    items: segmentItems(instructions, replies),
    replies,
    artifacts: [],
  }
  const read: RunSegmentRead = {
    detail: detail === undefined && session !== null ? runView(status) : detail,
    events,
    eventsStatus,
    retry: vi.fn(),
  }
  const view = renderUi(
    <QueryClientProvider client={makeQueryClient({ retry: false })}>
      <MemoryRouter>
        <ul>
          <RunSegment
            task={makeTask()}
            session={session}
            segment={segment}
            read={read}
            onOpenDetail={onOpenDetail}
            onOpenConsole={() => {}}
            onOpenArtifact={() => {}}
            onContinueSession={onContinueSession}
            onStreamGrowth={() => {}}
            approvalVisible
          />
        </ul>
      </MemoryRouter>
    </QueryClientProvider>,
  )
  return { ...view, read }
}

beforeEach(() => {
  setConnectionStatus('open')
  resetRunLiveBuffers()
})
afterEach(() => {
  resetConnectionStatusForTest()
  resetRunLiveBuffers()
})

describe('运行段：状态与入口', () => {
  it('段头是「运行详情」入口：标签 + 状态徽标，点击把这一段设为详情目标', async () => {
    const user = userEvent.setup()
    const onOpenDetail = vi.fn()
    segmentView({ status: 'completed', onOpenDetail })
    const entry = screen.getByRole('button', { name: /第 1 次运行/ })
    expect(entry).toHaveTextContent(RUN_STATUS_LABEL['completed'])
    expect(entry).toHaveTextContent('运行详情')
    expect(entry.querySelector('.status-mark')).not.toBeNull()
    await user.click(entry)
    expect(onOpenDetail).toHaveBeenCalledWith(RUN_ID)
  })

  it('完全权限直接在段上标记（不在详情里藏着）', () => {
    segmentView({ status: 'completed', runOver: { approvalPolicy: 'full_access' } })
    expect(screen.getByTestId('run-full-access')).toHaveTextContent('完全权限')
  })

  it('请假：无完全权限时不画标记', () => {
    segmentView({ status: 'completed' })
    expect(screen.queryByTestId('run-full-access')).toBeNull()
  })
})

describe('#306 当前活动与分段筛选（段内）', () => {
  it('事件尚未返回时只显示读取中，不依据等待时长猜活动阶段', () => {
    segmentView({ status: 'running', events: [], eventsStatus: 'pending' })
    const line = screen.getByTestId('run-activity')
    expect(line).toHaveTextContent('正在读取活动信息')
    expect(line).not.toHaveAttribute('data-working')
  })

  it.each(['thinking', 'tool', 'finalizing'] as const)(
    '%s 仅使用 project 阶段事实，不泄露思维/参数',
    (phase) => {
      segmentView({
        status: 'running',
        events: [
          event(3, { type: 'run.phase', phase }),
          event(1, { type: 'run.phase', phase: 'thinking' }),
          event(4, { type: 'assistant.message', text: 'private-thought-canary' }, 'owner'),
          { ...started(5), audience: 'owner' },
          event(6, { type: 'run.phase', phase: 'tool' }, 'owner'),
          event(9, { type: 'run.phase', phase: 'tool' }, 'project', 'another-run'),
        ],
      })
      const line = screen.getByTestId('run-activity')
      expect(line).toHaveTextContent(RUN_PHASE_LABEL[phase])
      expect(line).toHaveAttribute('data-working', '')
      expect(line).not.toHaveTextContent('private-thought-canary')
      expect(line.querySelector('button')).toBeNull()
    },
  )

  it.each(
    (
      [
        'queued',
        'dispatching',
        'waiting_approval',
        'cancel_requested',
        'completed',
        'failed',
        'cancelled',
        'lost',
      ] as RunStatus[]
    ).map((status) => [status] as const),
  )('%s 压过末次阶段，不假装还在执行', (status) => {
    segmentView({
      status,
      events: [event(1, { type: 'run.phase', phase: 'tool' })],
    })
    const line = screen.getByTestId('run-activity')
    expect(line).not.toHaveAttribute('data-working')
    expect(line).not.toHaveTextContent('工具执行中')
    expect(line).toHaveTextContent(
      status === 'waiting_approval'
        ? '等待责任人审批'
        : status === 'cancel_requested'
          ? '正在取消'
          : RUN_STATUS_LABEL[status],
    )
  })

  it.each([
    [],
    [event(1, { type: 'run.phase', phase: 'unknown' })],
    [event(1, { type: 'run.phase', phase: 'tool' }, 'owner')],
    [
      event(1, { type: 'run.phase', phase: 'thinking' }),
      event(2, { type: 'run.phase', phase: '__proto__' }),
    ],
  ])('缺失/未知/非 project 阶段只等待更新', (...events) => {
    segmentView({ status: 'running', events: events as RunEventItem[] })
    const line = screen.getByTestId('run-activity')
    expect(line).toHaveTextContent('等待活动更新')
    expect(line).not.toHaveAttribute('data-working')
  })

  it('事件读取不完整时说「活动信息读取失败」，不冒充还在跑', () => {
    segmentView({
      status: 'running',
      events: [event(1, { type: 'run.phase', phase: 'thinking' })],
      eventsStatus: 'incomplete',
    })
    expect(screen.getByTestId('run-activity')).toHaveTextContent('活动信息读取失败')
  })
})

describe('运行段：记录与工具事实', () => {
  it('记录里的工具 chip 只由匹配的结束事件给出，不泄露 preview 私有参数', () => {
    segmentView({ status: 'running', events: [started(), finished(2, 'failed')] })
    const chip = screen.getByTestId('tool-call-chip')
    expect(chip).toHaveAttribute('data-status', 'error')
    expect(chip).toHaveTextContent('失败')
    expect(chip).toHaveTextContent('read_file')
    expect(chip).not.toHaveTextContent('must-not-render')
  })

  it('读取不完整保留已读内容，给「不完整」与重试入口（不误报为空记录）', async () => {
    const user = userEvent.setup()
    const view = segmentView({
      status: 'completed',
      events: [event(1, { type: 'run.phase', phase: 'thinking' })],
      eventsStatus: 'incomplete',
    })
    await user.click(screen.getByText('工具与运行记录'))
    const notice = screen.getByTestId('run-events-incomplete')
    expect(notice).toBeVisible()
    expect(notice).toHaveTextContent('事件读取不完整')
    expect(screen.queryByText('还没有事件。')).toBeNull()
    // 已读内容照常列出（一行阶段事件）。
    expect(view.container.querySelectorAll('.run-event')).toHaveLength(1)
    await user.click(screen.getByTestId('retry-run-events'))
    expect(view.read.retry).toHaveBeenCalled()
  })

  it('读到末尾且没有事件时才说「还没有事件」', async () => {
    const user = userEvent.setup()
    segmentView({ status: 'completed', events: [], eventsStatus: 'complete' })
    await user.click(screen.getByText('工具与运行记录'))
    expect(screen.getByText('还没有事件。')).toBeVisible()
  })

  it('事件还在读时不画「还没有事件」', async () => {
    const user = userEvent.setup()
    segmentView({ status: 'running', events: [], eventsStatus: 'pending' })
    await user.click(screen.getByText('工具与运行记录'))
    expect(screen.queryByText('还没有事件。')).toBeNull()
    expect(screen.getByText('正在加载事件…')).toBeVisible()
  })
})

describe('运行段：直播与未持久化输出', () => {
  it('活跃运行收到 delta 后流式区显示文本（只订阅这一段）', () => {
    segmentView({ status: 'running' })
    act(() => appendLiveDelta(RUN_ID, 1, '正在写'))
    expect(screen.getByTestId('run-live-text')).toHaveTextContent('正在写')
    expect(screen.getByTestId('run-live-text').querySelector('.run-live-caret')).not.toBeNull()
  })

  it('非 owner 看不到流式区（Hub 不扇出，界面也不画空壳）', () => {
    segmentView({ status: 'running', session: { ...OWNER, userId: 'someone-else' } })
    act(() => appendLiveDelta(RUN_ID, 1, '不该出现在这里'))
    expect(screen.queryByTestId('run-live-text')).toBeNull()
  })

  it('运行结束后流式区被持久化回复替代；未收全的部分留在记录里', async () => {
    const user = userEvent.setup()
    // 先收到过直播（未持久化的部分），运行随后进入终态。
    appendLiveDelta(RUN_ID, 1, '最终')
    const view = segmentView({
      status: 'completed',
      events: [
        event(1, { type: 'assistant.message', text: '最终回复' }, 'owner'),
        event(2, { type: 'run.completed', finalText: '最终回复' }, 'owner'),
        event(3, { type: 'run.completed', finalText: '最终回复' }, 'project'),
      ],
    })
    // 终态没有流式区（免得与最终回复并排），但在记录里能看到未持久化的部分。
    expect(screen.queryByTestId('run-live-text')).toBeNull()
    // 三条持久化帧（owner 的 assistant.message + owner/project 两条 run.completed，
    // 文本相同）只合成一条回复——直播与最终内容不并排。
    const replies = view.container.querySelectorAll('.workspace-reply p')
    expect(replies).toHaveLength(1)
    expect(replies[0]).toHaveTextContent('最终回复')
    await user.click(screen.getByText('工具与运行记录'))
    const archived = screen.getByTestId('run-live-archived')
    expect(archived).toHaveTextContent('未持久化的直播输出')
    expect(archived).toHaveTextContent('最终')
  })

  it('直播内容与最终回复一致时不在记录里重复并排', () => {
    const events = [event(1, { type: 'run.completed', finalText: '一模一样' })]
    appendLiveDelta(RUN_ID, 1, '一模一样')
    segmentView({ status: 'completed', events })
    expect(screen.queryByTestId('run-live-archived')).toBeNull()
  })
})

describe('运行段：历史运行的动作', () => {
  it('终态 owner 有「继续此会话」（把来源交给底部输入框）与「重跑此 Run」（带自己的表单）', async () => {
    const user = userEvent.setup()
    const onContinueSession = vi.fn()
    segmentView({ status: 'completed', onContinueSession })
    await user.click(screen.getByTestId('continue-session-button'))
    expect(onContinueSession).toHaveBeenCalledWith(RUN_ID)
    await user.click(screen.getByTestId('rerun-button'))
    expect(screen.getByTestId('rerun-prompt')).toBeVisible()
    // 继续此会话不会替用户重跑：RunActions 里没有 resume 表单/提交路径。
    expect(screen.queryByText('确认续跑')).toBeNull()
  })

  it('member（非 owner）看不到取消/重跑/继续会话入口', () => {
    segmentView({ status: 'completed', session: { ...OWNER, userId: 'member-1', role: 'member' } })
    expect(screen.queryByTestId('continue-session-button')).toBeNull()
    expect(screen.queryByTestId('rerun-button')).toBeNull()
  })

  it('失败/丢失的段直接给未知副作用警示', () => {
    segmentView({
      status: 'failed',
      detail: runView('failed', { failureCode: 'RUNTIME_LOST' }),
    })
    expect(screen.getByTestId('run-failure-notice')).toHaveTextContent('RUNTIME_LOST')
  })
})
