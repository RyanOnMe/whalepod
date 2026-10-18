/**
 * #275 + P1-393 直播与对话滚动：流式光标、跟随滚动可被用户接管、每帧重渲染收窄。
 *
 * ADR-0019 起滚动跟随作用在**对话的唯一主滚动容器**（`.conversation-transcript`）上：
 *   1. 光标：运行中且有输出才画，终态不画（它是"还在写"的信息，不是装饰）；
 *   2. 跟随：**用户滚上去就交出控制权**——新的 delta 不得再改 scrollTop，并出现
 *      「回到最新」；点它恢复跟随。jsdom 没有布局（三个度量恒为 0），所以度量要**注入**：
 *      纯函数 `isNearBottom` 单独判，组件侧用一个带 getter/setter 的 scrollTop 桩来验
 *      "有没有真的去写滚动位置"——否则这条判据永远只走在"在底部"那一支上。
 *   3. 终态：流式区被持久化回复替代，未收全的部分只在「工具与运行记录」里可查。
 *   4. 重渲染收窄：把 `RunActions` 换成计数桩，断言**一个 delta 不会让它重渲染**。
 */
import { act, screen } from '@testing-library/react'
import { userEvent } from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { BOB, loggedInHandlers, makeRun, makeTask, ok, taskRoomHandler } from './fixtures.js'
import type { MockHandler } from './fixtures.js'
import { renderApp } from './render.js'
import { appendLiveDelta, resetRunLiveBuffers } from '../src/shared/realtime/run-buffer.js'
import { isNearBottom, NEAR_BOTTOM_PX } from '../src/shared/useStickToBottom.js'
import type { RunEventItem, RunView } from '../src/shared/api/types.js'

/**
 * 段里的**非订阅**子树（活动行）：只数渲染次数，不渲染任何东西（有意的空壳）。
 * #393 起运行行动面搬到运行详情里，段上不再有 RunActions——探针换成活动行，
 * 要钉住的回归不变：订阅必须留在下沉的直播子组件里，段体不许每帧跟着重画。
 */
const counters = vi.hoisted(() => ({ activityLine: 0 }))
vi.mock('../src/features/task/RunActivityLine.js', () => ({
  RunActivityLine: (): null => {
    counters.activityLine += 1
    return null
  },
}))

const RUN_ID = 'b0b0b0b0-0000-4000-8000-000000000001'

/**
 * `GET /runs/:id` 返回的是 **RunView**（带 `ownerUserId`），不是 `makeRun` 给的
 * TaskRoom 投影行——直播区只看 owner 的 Run，所以这里必须真的把 owner 写对
 * （写错时段照常渲染、只是没有直播区，判据会以"找不到 run-live-text"报出来）。
 */
function liveHandlers(
  runId: string,
  status: RunView['status'],
  events: RunEventItem[] = [],
): MockHandler[] {
  const run: RunView = {
    id: runId,
    taskId: 'task-1',
    ownerUserId: BOB.userId,
    agentId: 'a1a1a1a1-0000-4000-8000-00000000000a',
    profileRevisionId: 'a2a2a2a2-0000-4000-8000-00000000000b',
    deviceId: 'd1d1d1d1-0000-4000-8000-00000000000c',
    workspaceId: 'e5e5e5e5-0000-4000-8000-00000000000d',
    status,
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
    finishedAt: status === 'completed' ? '2026-08-25T00:05:00.000Z' : null,
  }
  return [
    { method: 'GET', url: new RegExp(`/api/v1/runs/${runId}$`), respond: () => ok(run) },
    {
      method: 'GET',
      url: new RegExp(`/api/v1/runs/${runId}/events`),
      respond: () => ok({ events }),
    },
  ]
}

/** 打开任务房间：段本来就在主对话里（无需先选运行——ADR-0019 决定 1）。 */
async function openConversation(
  status: RunView['status'],
  runId = RUN_ID,
  events: RunEventItem[] = [],
): Promise<void> {
  const task = makeTask({ assigneeUserId: BOB.userId, assignmentStatus: 'accepted' })
  const run = makeRun({ id: runId, status })
  renderApp(
    `/tasks/${task.id}`,
    loggedInHandlers(BOB, [
      taskRoomHandler(task, { runs: [run] }),
      ...liveHandlers(runId, status, events),
    ]),
  )
  await screen.findByTestId('run-segment')
  // 活跃运行的段里有流式区（终态没有——它被持久化回复替代）。
  if (status === 'running') await screen.findByText('实时输出')
}

/** 给滚动容器装上"内容比容器高"的度量（jsdom 里全是 0，注入才能验两条分支）。 */
function stubScrollBox(el: HTMLElement, scrollHeight = 1000, clientHeight = 300): () => number {
  let scrollTop = 0
  Object.defineProperty(el, 'scrollHeight', { value: scrollHeight, configurable: true })
  Object.defineProperty(el, 'clientHeight', { value: clientHeight, configurable: true })
  Object.defineProperty(el, 'scrollTop', {
    configurable: true,
    get: () => scrollTop,
    set: (value: number) => {
      scrollTop = value
    },
  })
  return () => scrollTop
}

function completedEvents(finalText = '已完成的输出'): RunEventItem[] {
  return [
    {
      runId: RUN_ID,
      seq: 1,
      audience: 'project',
      type: 'run.completed',
      event: { type: 'run.completed', finalText },
      occurredAt: '2026-08-25T00:05:00.000Z',
      receivedAt: '2026-08-25T00:05:00.000Z',
    },
  ]
}

describe('#275 跟随滚动的判定（纯函数，两条分支都可注入）', () => {
  it('贴底 / 容差内算跟随，滚上去算不跟随；jsdom 全 0 必须算在底部', () => {
    expect(isNearBottom({ scrollTop: 700, scrollHeight: 1000, clientHeight: 300 })).toBe(true)
    expect(
      isNearBottom({ scrollTop: 700 - NEAR_BOTTOM_PX, scrollHeight: 1000, clientHeight: 300 }),
    ).toBe(true)
    expect(
      isNearBottom({ scrollTop: 699 - NEAR_BOTTOM_PX, scrollHeight: 1000, clientHeight: 300 }),
    ).toBe(false)
    // jsdom：三个值恒为 0。判成"不在底部"的话跟随一次都不会发生（首帧就交出控制权）。
    expect(isNearBottom({ scrollTop: 0, scrollHeight: 0, clientHeight: 0 })).toBe(true)
  })
})

describe('#275 流式光标与终态替代', () => {
  it('运行中且有输出 → 画光标；未持久化的输出只在记录里（记录折叠时不可见）', async () => {
    await openConversation('running')
    act(() => appendLiveDelta(RUN_ID, 1, '正在输出'))
    const pre = screen.getByTestId('run-live-text')
    expect(pre.querySelector('.run-live-caret')).not.toBeNull()
    expect(pre.querySelector('.run-live-caret')).toHaveAttribute('aria-hidden', 'true')
    expect(pre).toHaveTextContent('正在输出')
    expect(pre).toBeVisible()
  })

  it.each(['failed', 'lost', 'cancelled', 'completed'] as const)(
    '%s 的未持久化直播仍在「工具与运行记录」里可查，且不与最终回复并排',
    async (status) => {
      const runId = `b0b0b0b0-0000-4000-8000-00000000010${status.length}`
      await openConversation(
        status,
        runId,
        status === 'completed' ? completedEvents('正式回复') : [],
      )
      act(() => appendLiveDelta(runId, 1, '中断前尚未形成正式消息的输出'))
      const partial = screen.getByTestId('run-live-archived')
      expect(partial).not.toBeVisible()
      await userEvent.setup().click(screen.getAllByText('工具与运行记录')[0]!)
      expect(partial).toBeVisible()
      expect(partial).toHaveTextContent('中断前尚未形成正式消息的输出')
      // 没有流式区（终态不画"还在写"的位置）。
      expect(screen.queryByTestId('run-live-text')).toBeNull()
    },
  )

  it('终态 Run 不画光标（"还在写"是撒谎）', async () => {
    await openConversation('completed', 'b0b0b0b0-0000-4000-8000-000000000002', completedEvents())
    act(() => appendLiveDelta('b0b0b0b0-0000-4000-8000-000000000002', 1, '已完成的输出'))
    expect(screen.queryByTestId('run-live-text')).toBeNull()
    expect(screen.queryByTestId('run-live-caret')).toBeNull()
  })
})

describe('#275 对话的跟随滚动可被用户接管', () => {
  it('跟随态滚到底；用户滚上去后新内容不拽人，并给出「回到最新」；点了恢复', async () => {
    const runId = 'b0b0b0b0-0000-4000-8000-000000000003'
    await openConversation('running', runId)
    act(() => {
      appendLiveDelta(runId, 1, '第一段')
    })
    const scroller = screen.getByTestId('conversation-scroll')
    const scrollTopOf = stubScrollBox(scroller)

    // ① 跟随态：新内容到了就滚到底。
    act(() => {
      appendLiveDelta(runId, 2, '第二段')
    })
    expect(scrollTopOf()).toBe(1000)
    expect(screen.queryByTestId('conversation-jump')).toBeNull()

    // ② 用户往上翻：跟随停止，出现入口。
    scroller.scrollTop = 100
    act(() => {
      scroller.dispatchEvent(new Event('scroll'))
    })
    expect(await screen.findByTestId('conversation-jump')).toBeInTheDocument()

    // ③ 关键判据：此刻再来内容**不许**动滚动位置（原来无条件拽到底）。
    act(() => {
      appendLiveDelta(runId, 3, '第三段')
    })
    expect(scrollTopOf()).toBe(100)

    // ④ 回到最新：恢复跟随并立刻到底。
    await userEvent.setup().click(screen.getByTestId('conversation-jump'))
    expect(scrollTopOf()).toBe(1000)
    expect(screen.queryByTestId('conversation-jump')).toBeNull()
  })
})

describe('#275 每帧重渲染收窄', () => {
  it('一个 delta 只重画直播子树，段体（活动行）不跟着重画', async () => {
    resetRunLiveBuffers()
    const runId = 'b0b0b0b0-0000-4000-8000-000000000004'
    await openConversation('running', runId)
    act(() => {
      appendLiveDelta(runId, 1, 'a')
    })
    const before = counters.activityLine
    // 判据不许空转：活动行**确实渲染过**（否则"没涨"是因为压根没画，而不是因为订阅下沉）。
    expect(before).toBeGreaterThan(0)
    act(() => {
      appendLiveDelta(runId, 2, 'b')
      appendLiveDelta(runId, 3, 'c')
    })
    // 订阅若回到段组件（或页面）上，这里会涨 2（每个 delta 一次）——这正是本判据要钉住的回归。
    expect(counters.activityLine).toBe(before)
  })
})
