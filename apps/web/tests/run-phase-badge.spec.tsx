/**
 * 运行卡「正在做什么」阶段徽标 + 任务房间实时失效（#261；P1-UX 三期刀二）。
 *
 * 判据：
 * 1. `status='running'` 且投影带阶段 → 卡片画阶段徽标（中文标签与 Run Console 同源）；
 * 2. 终态 Run 即使带着末次阶段也不画——「收尾中」挂在已完成的 Run 上就是撒谎；
 * 3. running 但投影里没有阶段（null）不画；waiting_approval 有阶段也不画（人在等，不是它在跑）；
 * 4. **不刷新页面**：run.changed 帧到达 → 任务房间重拉（补的实时缺口：此前只失效
 *    `['run', runId]`，房间卡要等刷新）；run.phase 帧同样重拉；其他 run.event
 *    （tool.started/assistant.message 等）不重拉——事件频率不该变成房间重拉频率。
 */
import { act, screen, waitFor } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import {
  BOB,
  loggedInHandlers,
  makeRun,
  makeTask,
  ok,
  recentTasksEmptyHandler,
  taskRoomHandler,
  teamMembersHandler,
} from './fixtures.js'
import type { MockHandler } from './fixtures.js'
import { renderApp } from './render.jsx'
import { persistentFrame } from './frames.js'
import { installFrameSink } from './socket-drive.js'

const RUN_ID = '33333333-3333-4333-8333-333333333333'

const TASK = makeTask({ assigneeUserId: BOB.userId, assignmentStatus: 'accepted' })

describe('运行卡阶段徽标（#261）', () => {
  it('只在 running 且投影带阶段时画；终态/等待审批/无阶段都不画', async () => {
    const runs = [
      makeRun({
        status: 'running',
        lastPhase: { phase: 'tool', at: '2026-10-01T02:10:00.000Z' },
      }),
      // running 但没有阶段事件（还没开始思考/投影没到）：不画，不编造。
      makeRun({ status: 'running', lastPhase: null }),
      // 等待审批：人在等，不是它在跑——状态徽标已经说了「等待审批」。
      makeRun({
        status: 'waiting_approval',
        lastPhase: { phase: 'tool', at: '2026-10-01T02:20:00.000Z' },
      }),
      // 终态带着末次阶段：不画（「收尾中」挂在已完成的 Run 上就是撒谎）。
      makeRun({
        status: 'completed',
        finishedAt: '2026-10-01T02:30:00.000Z',
        lastPhase: { phase: 'finalizing', at: '2026-10-01T02:29:00.000Z' },
      }),
    ]
    renderApp(`/tasks/${TASK.id}`, [
      ...loggedInHandlers(BOB, [taskRoomHandler(TASK, { runs }), recentTasksEmptyHandler()]),
      teamMembersHandler([]),
    ])
    await screen.findByRole('heading', { name: TASK.title })
    const chips = await screen.findAllByTestId('run-phase')
    expect(chips).toHaveLength(1)
    expect(chips[0]).toHaveTextContent('工具执行中')
  })

  it('残缺形状不白屏：running 的 Run 整块没有 lastPhase 字段时照常渲染（不画徽标）', async () => {
    // 复刻 target-picker.spec.tsx 那种手工拼的最小载荷（只有 8 个字段）——#261 实测：
    // 判据写成 `lastPhase !== null` 时 undefined 会漏过去，`undefined.phase` 直接把
    // 整个任务房间白屏（被既有 spec 当场抓红）。取标签前先判形状。
    const partialRun = {
      id: RUN_ID,
      status: 'running',
      createdAt: '2026-10-01T02:00:00.000Z',
      startedAt: '2026-10-01T02:00:05.000Z',
      finishedAt: null,
      rerunOfRunId: null,
      resumeFromRunId: null,
    }
    const roomHandler: MockHandler = {
      method: 'GET',
      url: new RegExp(`/api/v1/tasks/${TASK.id}$`),
      respond: () =>
        ok({ task: TASK, comments: [], instructions: [], runs: [partialRun], artifacts: [] }),
    }
    renderApp(`/tasks/${TASK.id}`, [
      ...loggedInHandlers(BOB, [roomHandler, recentTasksEmptyHandler()]),
      teamMembersHandler([]),
    ])
    expect(await screen.findByRole('heading', { name: TASK.title })).toBeVisible()
    expect(screen.queryByTestId('run-phase')).toBeNull()
  })

  it('不刷新页面：run.changed / run.phase 帧到达即重拉房间；其他 run 事件不重拉', async () => {
    let roomGets = 0
    const roomHandler: MockHandler = {
      method: 'GET',
      url: new RegExp(`/api/v1/tasks/${TASK.id}$`),
      respond: () => {
        roomGets += 1
        return ok({ task: TASK, comments: [], instructions: [], runs: [], artifacts: [] })
      },
    }
    const sink = installFrameSink()
    renderApp(`/tasks/${TASK.id}`, [
      ...loggedInHandlers(BOB, [roomHandler, recentTasksEmptyHandler()]),
      teamMembersHandler([]),
    ])
    await screen.findByRole('heading', { name: TASK.title })
    const before = roomGets

    // run.changed（带 taskId）→ 房间重拉：运行卡状态不再等刷新。
    act(() =>
      sink.onFrame(
        persistentFrame('run.changed', { runId: RUN_ID, taskId: TASK.id, status: 'completed' }),
      ),
    )
    await waitFor(() => expect(roomGets).toBeGreaterThan(before))
    const afterChanged = roomGets

    // 非 run.phase 的 run.event（工具/消息每条都来）→ 不动房间。
    act(() =>
      sink.onFrame(
        persistentFrame('run.event', {
          runId: RUN_ID,
          event: { type: 'tool.started', toolName: 'bash' },
        }),
      ),
    )
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(roomGets).toBe(afterChanged)

    // run.phase → 房间重拉：阶段徽标跟着动。
    act(() =>
      sink.onFrame(
        persistentFrame('run.event', {
          runId: RUN_ID,
          event: { type: 'run.phase', phase: 'finalizing' },
        }),
      ),
    )
    await waitFor(() => expect(roomGets).toBeGreaterThan(afterChanged))
  })
})
