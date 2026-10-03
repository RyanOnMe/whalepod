/**
 * #275 直播产出区的连续性：流式光标、跟随滚动可被用户接管、每帧重渲染收窄。
 *
 * 三件事各自的判据：
 *   1. 光标：运行中且有输出才画，终态不画（它是"还在写"的信息，不是装饰）；
 *   2. 跟随：**用户滚上去就交出控制权**——新的 delta 不得再改 scrollTop，并出现
 *      「回到最新」；点它恢复跟随。jsdom 没有布局（三个度量恒为 0），所以度量要**注入**：
 *      纯函数 `isNearBottom` 单独判，组件侧用一个带 getter/setter 的 scrollTop 桩来验
 *      "有没有真的去写滚动位置"——否则这条判据永远只走在"在底部"那一支上。
 *   3. 重渲染收窄：把 `RunActions` 换成计数桩，断言**一个 delta 不会让它重渲染**
 *      （订阅还挂在面板上时，这个数字会跟着 token 涨——这正是原先每帧整棵子树
 *      reconcile 的证据）。
 */
import { act, screen } from '@testing-library/react'
import { userEvent } from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { BOB, loggedInHandlers, makeRun, makeTask, ok, taskRoomHandler } from './fixtures.js'
import type { MockHandler } from './fixtures.js'
import { renderApp } from './render.js'
import { appendLiveDelta, resetRunLiveBuffers } from '../src/shared/realtime/run-buffer.js'
import { isNearBottom, NEAR_BOTTOM_PX } from '../src/shared/useStickToBottom.js'
import type { RunView } from '../src/shared/api/types.js'

/** 面板里的动作区：只数渲染次数，不渲染任何东西（有意的空壳）。 */
const counters = vi.hoisted(() => ({ runActions: 0 }))
vi.mock('../src/features/run/RunActions.js', () => ({
  RunActions: (): null => {
    counters.runActions += 1
    return null
  },
}))

const RUN_ID = 'b0b0b0b0-0000-4000-8000-000000000001'

/**
 * `GET /runs/:id` 返回的是 **RunView**（带 `ownerUserId`），不是 `makeRun` 给的
 * TaskRoom 投影行——直播区只看 owner 的 Run，所以这里必须真的把 owner 写对
 * （写错时面板照常渲染、只是没有直播区，判据会以"找不到 run-live-text"报出来）。
 */
function liveHandlers(runId: string, status: 'running' | 'completed'): MockHandler[] {
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
      respond: () => ok({ events: [] }),
    },
  ]
}

async function openLivePanel(status: 'running' | 'completed', runId = RUN_ID): Promise<void> {
  const user = userEvent.setup()
  const task = makeTask({ assigneeUserId: BOB.userId, assignmentStatus: 'accepted' })
  const run = makeRun({ id: runId, status })
  renderApp(
    `/tasks/${task.id}`,
    loggedInHandlers(BOB, [taskRoomHandler(task, { runs: [run] }), ...liveHandlers(runId, status)]),
  )
  await user.click(await screen.findByRole('button', { name: /第 1 次运行/ }))
  await screen.findByTestId('run-live-panel')
  // 直播区只在 owner 视角出现：没出现就说明载荷的 ownerUserId 不对，
  // 让判据以"找不到 run-live-stream"报出来，而不是后面一串莫名其妙的断言失败。
  await screen.findByText('实时输出')
}

/** 给 `<pre>` 装上"内容比容器高"的度量（jsdom 里全是 0，注入才能验两条分支）。 */
function stubScrollBox(pre: HTMLElement, scrollHeight = 1000, clientHeight = 300): () => number {
  let scrollTop = 0
  Object.defineProperty(pre, 'scrollHeight', { value: scrollHeight, configurable: true })
  Object.defineProperty(pre, 'clientHeight', { value: clientHeight, configurable: true })
  Object.defineProperty(pre, 'scrollTop', {
    configurable: true,
    get: () => scrollTop,
    set: (value: number) => {
      scrollTop = value
    },
  })
  return () => scrollTop
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

describe('#275 流式光标', () => {
  it('运行中且有输出 → 画光标；终态 → 不画', async () => {
    await openLivePanel('running')
    act(() => {
      appendLiveDelta(RUN_ID, 1, '正在输出')
    })
    const pre = screen.getByTestId('run-live-text')
    expect(pre.querySelector('.run-live-caret')).not.toBeNull()
    // 光标是纯装饰：不进可访问树（读屏不该念它）。
    expect(pre.querySelector('.run-live-caret')).toHaveAttribute('aria-hidden', 'true')
    // 文本内容不受影响（既有按文本断言的用例口径）。
    expect(pre).toHaveTextContent('正在输出')
  })

  it('终态 Run 不画光标（"还在写"是撒谎）', async () => {
    await openLivePanel('completed', 'b0b0b0b0-0000-4000-8000-000000000002')
    act(() => {
      appendLiveDelta('b0b0b0b0-0000-4000-8000-000000000002', 1, '已完成的输出')
    })
    const pre = screen.getByTestId('run-live-text')
    expect(pre.querySelector('.run-live-caret')).toBeNull()
  })
})

describe('#275 跟随滚动可被用户接管', () => {
  it('跟随态滚到底；用户滚上去后新 delta 不拽人，并给出「回到最新」；点了恢复', async () => {
    await openLivePanel('running', 'b0b0b0b0-0000-4000-8000-000000000003')
    const runId = 'b0b0b0b0-0000-4000-8000-000000000003'
    act(() => {
      appendLiveDelta(runId, 1, '第一段')
    })
    const pre = screen.getByTestId('run-live-text')
    const scrollTopOf = stubScrollBox(pre)

    // ① 跟随态：新内容到了就滚到底。
    act(() => {
      appendLiveDelta(runId, 2, '第二段')
    })
    expect(scrollTopOf()).toBe(1000)
    expect(screen.queryByTestId('run-live-jump')).toBeNull()

    // ② 用户往上翻：跟随停止，出现入口。
    pre.scrollTop = 100
    act(() => {
      pre.dispatchEvent(new Event('scroll'))
    })
    expect(await screen.findByTestId('run-live-jump')).toBeInTheDocument()

    // ③ 关键判据：此刻再来内容**不许**动滚动位置（原来无条件拽到底）。
    act(() => {
      appendLiveDelta(runId, 3, '第三段')
    })
    expect(scrollTopOf()).toBe(100)

    // ④ 回到最新：恢复跟随并立刻到底。
    await userEvent.setup().click(screen.getByTestId('run-live-jump'))
    expect(scrollTopOf()).toBe(1000)
    expect(screen.queryByTestId('run-live-jump')).toBeNull()
  })
})

describe('#275 每帧重渲染收窄', () => {
  it('一个 delta 不引起面板动作区重渲染（订阅只在下沉的子组件里）', async () => {
    resetRunLiveBuffers()
    await openLivePanel('running', 'b0b0b0b0-0000-4000-8000-000000000004')
    const runId = 'b0b0b0b0-0000-4000-8000-000000000004'
    act(() => {
      appendLiveDelta(runId, 1, 'a')
    })
    const before = counters.runActions
    // 判据不许空转：动作区**确实渲染过**（否则"没涨"是因为压根没画，而不是因为订阅下沉）。
    expect(before).toBeGreaterThan(0)
    act(() => {
      appendLiveDelta(runId, 2, 'b')
      appendLiveDelta(runId, 3, 'c')
    })
    // 订阅若回到面板上，这里会涨 2（每个 delta 一次）——这正是本判据要钉住的回归。
    expect(counters.runActions).toBe(before)
  })
})
