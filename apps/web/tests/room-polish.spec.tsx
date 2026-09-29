/**
 * #231 批次④：信息真空与打磨。
 *
 * - 执行活动提示（ADR-0010 决策 6 的信息真空债）：只盯讨论栏的用户要能知道
 *   执行区来了新动静；首屏数据是基线不算「新」；
 * - 加载骨架：任务房间与项目页 pending 态渲染骨架行（预告布局），
 *   prefers-reduced-motion 下不动效（CSS 源码判据）；
 * - 「上方」方位词清理：两栏/两列布局下方位词会说谎（#167 登记）。
 */
import { screen, waitFor } from '@testing-library/react'
import { userEvent } from '@testing-library/user-event'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  BOB,
  loggedInHandlers,
  makeInstruction,
  makeRun,
  makeTask,
  ok,
  teamMembersHandler,
} from './fixtures.js'
import type { MockHandler } from './fixtures.js'
import { renderApp } from './render.js'

// vite 转译后 import.meta.url 非文件 URL，直接按 cwd（仓库根）取源文件。
const globalCssPath = resolve(process.cwd(), 'apps/web/src/styles/global.css')

describe('执行活动提示（#231 / ADR-0010 决策 6）', () => {
  it('执行区新增活动后讨论栏出现提示；点击消失并聚焦执行栏；首屏不算新活动', async () => {
    const task = makeTask({ assigneeUserId: BOB.userId })
    let instructionCount = 1
    const handlers: MockHandler[] = [
      ...loggedInHandlers(BOB, [
        {
          method: 'GET',
          url: new RegExp(`/api/v1/tasks/${task.id}$`),
          respond: () =>
            ok({
              task,
              comments: [],
              instructions: Array.from({ length: instructionCount }, (_, i) =>
                makeInstruction({
                  id: `i-${i}`,
                  instructionState: 'accepted',
                  authorUserId: BOB.userId,
                }),
              ),
              runs: [],
              artifacts: [],
            }),
        },
        teamMembersHandler([]),
      ]),
    ]
    const user = userEvent.setup()
    const view = renderApp(`/tasks/${task.id}`, handlers)
    // 首屏：基线，不提示。
    await screen.findByRole('heading', { name: task.title })
    expect(screen.queryByTestId('execution-activity-hint')).toBeNull()
    // 执行区来了新活动（refetch 后指令 1→2）。
    instructionCount = 2
    void view.queryClient.invalidateQueries()
    const hint = await screen.findByTestId('execution-activity-hint')
    expect(hint).toHaveTextContent('执行区有新活动')
    // 点击：提示消失、焦点到执行栏标题。
    await user.click(hint)
    await waitFor(() => expect(screen.queryByTestId('execution-activity-hint')).toBeNull())
    expect(document.activeElement?.id).toBe('instructions-heading')
    view.unmount()
  })

  it('运行数增加同样触发提示（指令没变但 Run 多了）', async () => {
    const task = makeTask({ assigneeUserId: BOB.userId })
    let runCount = 1
    const view = renderApp(`/tasks/${task.id}`, [
      ...loggedInHandlers(BOB, [
        {
          method: 'GET',
          url: new RegExp(`/api/v1/tasks/${task.id}$`),
          respond: () =>
            ok({
              task,
              comments: [],
              instructions: [],
              runs: Array.from({ length: runCount }, (_, i) =>
                makeRun({ id: `r-${i}`, status: 'completed' }),
              ),
              artifacts: [],
            }),
        },
        teamMembersHandler([]),
      ]),
    ])
    await screen.findByRole('heading', { name: task.title })
    expect(screen.queryByTestId('execution-activity-hint')).toBeNull()
    runCount = 2
    void view.queryClient.invalidateQueries()
    expect(await screen.findByTestId('execution-activity-hint')).toBeVisible()
    view.unmount()
  })
})

describe('加载骨架（#231）', () => {
  it('任务房间 pending 态渲染骨架行（不是一行纯文本）', async () => {
    const task = makeTask({ assigneeUserId: BOB.userId })
    const view = renderApp(`/tasks/${task.id}`, [
      ...loggedInHandlers(BOB, [
        {
          method: 'GET',
          url: new RegExp(`/api/v1/tasks/${task.id}$`),
          respond: () => new Promise(() => undefined),
        },
      ]),
    ])
    // pending：骨架行存在（容器 aria-busy）。
    const busy = await screen.findByTestId('room-skeleton')
    expect(busy).toHaveAttribute('aria-busy', 'true')
    expect(busy.querySelectorAll('.skeleton-line').length).toBeGreaterThanOrEqual(4)
    view.unmount()
  })

  it('骨架动效尊重 prefers-reduced-motion（CSS 源码判据，照 focus-ring 门的口径）', () => {
    const css = readFileSync(globalCssPath, 'utf8')
    expect(css).toMatch(/\.skeleton-line[\s\S]*?animation/)
    expect(css).toMatch(
      /@media\s*\(prefers-reduced-motion:\s*reduce\)[\s\S]*?\.skeleton-line[\s\S]*?animation:\s*none/,
    )
  })
})

describe('「上方」方位词清理（#231 / #167 登记）', () => {
  it('RunTimeline 空态与设备页空态不再出现「上方」', async () => {
    const task = makeTask({ assigneeUserId: BOB.userId })
    const view = renderApp(`/tasks/${task.id}`, [
      ...loggedInHandlers(BOB, [
        {
          method: 'GET',
          url: new RegExp(`/api/v1/tasks/${task.id}$`),
          respond: () => ok({ task, comments: [], instructions: [], runs: [], artifacts: [] }),
        },
        teamMembersHandler([]),
      ]),
    ])
    await screen.findByRole('heading', { name: task.title })
    const roomText = document.body.textContent ?? ''
    expect(roomText).toContain('还没有 Run')
    expect(roomText).not.toContain('上方')
    view.unmount()

    const view2 = renderApp('/devices', [
      ...loggedInHandlers(BOB, [
        { method: 'GET', url: /\/api\/v1\/devices$/, respond: () => ok([]) },
      ]),
    ])
    await screen.findByText(/还没有设备/)
    expect(document.body.textContent ?? '').not.toContain('上方')
    view2.unmount()
  })
})
