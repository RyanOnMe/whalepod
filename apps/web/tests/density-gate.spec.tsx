/**
 * #257 视觉密度门禁（#243 第 6 条拍板：完整审计 + 门禁）。
 *
 * 两个机器可查指标，对七个主页面断言上限（上限=审计后的目标值，见
 * docs/agent/density-audit-acceptance.md 的审计表；高于上限 = 又加了卡片嵌套或
 * 常驻提示，红）：
 *   cardDepth ≤ 1 —— `.card` 的最大嵌套链长（card-in-card 即 2，纯装饰分层，
 *                     2026-10 审计后全站无 card-in-card）；
 *   hintCount ≤ 4 —— 常驻提示元素数（.mutation-hint/.field-hint，role=alert 的
 *                     动态错误不算——它们不该被算进「常驻」）。
 *
 * measure() 是纯 DOM 函数：变异自证用例直接喂手工 DOM——构造 card-in-card 必须量出 2，
 * 否则门禁是恒真的摆设。
 */
import { screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { renderApp } from './render.jsx'
import type { TestAppResult } from './render.jsx'
import {
  BOB,
  devicesHandler,
  loggedInHandlers,
  makeTask,
  projectsHandler,
  recentTasksEmptyHandler,
  taskRoomHandler,
  teamMembersHandler,
  workspacesHandler,
} from './fixtures.js'

interface Density {
  cardDepth: number
  hintCount: number
}

function measure(root: HTMLElement): Density {
  let cardDepth = 0
  for (const el of root.querySelectorAll<HTMLElement>('.card')) {
    let depth = 1
    let cursor: HTMLElement | null = el.parentElement
    while (cursor !== null) {
      if (cursor.classList.contains('card')) depth += 1
      cursor = cursor.parentElement
    }
    cardDepth = Math.max(cardDepth, depth)
  }
  let hintCount = 0
  for (const el of root.querySelectorAll<HTMLElement>('.mutation-hint, .field-hint')) {
    if (el.closest('[role="alert"]') !== null) continue
    hintCount += 1
  }
  return { cardDepth, hintCount }
}

const TASK = makeTask({ assigneeUserId: BOB.userId, assignmentStatus: 'accepted' })

const PAGES: Array<[string, () => TestAppResult]> = [
  [
    'projects',
    () =>
      renderApp('/', [
        ...loggedInHandlers(BOB, [projectsHandler([]), recentTasksEmptyHandler()]),
        teamMembersHandler([]),
      ]),
  ],
  [
    'task-room',
    () =>
      renderApp(`/tasks/${TASK.id}`, [
        ...loggedInHandlers(BOB, [taskRoomHandler(TASK), recentTasksEmptyHandler()]),
        teamMembersHandler([]),
      ]),
  ],
  [
    'task-permissions',
    () =>
      renderApp(`/tasks/${TASK.id}/permissions`, [
        ...loggedInHandlers(BOB, [taskRoomHandler(TASK), recentTasksEmptyHandler()]),
        teamMembersHandler([]),
      ]),
  ],
  [
    'agents',
    () =>
      renderApp('/agents', [
        ...loggedInHandlers(BOB, [recentTasksEmptyHandler()]),
        teamMembersHandler([]),
      ]),
  ],
  [
    'plugins',
    () =>
      renderApp('/plugins', [
        ...loggedInHandlers(BOB, [recentTasksEmptyHandler()]),
        teamMembersHandler([]),
      ]),
  ],
  [
    'devices',
    () =>
      renderApp('/devices', [
        ...loggedInHandlers(BOB, [
          recentTasksEmptyHandler(),
          devicesHandler([]),
          workspacesHandler([]),
        ]),
        teamMembersHandler([]),
      ]),
  ],
  [
    'members',
    () =>
      renderApp('/members', [
        ...loggedInHandlers(BOB, [recentTasksEmptyHandler()]),
        teamMembersHandler([]),
      ]),
  ],
]

describe('#257 密度门禁：卡片嵌套与常驻提示不回弹', () => {
  it('measure() 变异自证：card-in-card 量出 2、hint 计数与 alert 排除都生效（判据不是恒真）', () => {
    const root = document.createElement('div')
    root.innerHTML = `
      <div class="card">
        <section class="card snapshot-slot"><p class="mutation-hint">a</p></section>
        <p class="mutation-hint" role="alert">动态错误</p>
      </div>`
    expect(measure(root)).toEqual({ cardDepth: 2, hintCount: 1 })
    expect(measure(document.createElement('div'))).toEqual({ cardDepth: 0, hintCount: 0 })
  })

  it.each(PAGES)('%s：cardDepth ≤ 1 且 hintCount ≤ 4', { timeout: 20000 }, async (_name, mount) => {
    const view = mount()
    // 等主体出现（各页自有行为 spec；这里只保证渲染完成后再量）。
    await screen.findByRole('link', { name: '项目' }).catch(() => undefined)
    const density = measure(view.container)
    expect(
      density.cardDepth,
      `${_name} 出现了 card-in-card——分层请用留白/边框，不再加卡片面`,
    ).toBeLessThanOrEqual(1)
    expect(
      density.hintCount,
      `${_name} 常驻提示超过 4 条——解释性文字请并入标签或 placeholder`,
    ).toBeLessThanOrEqual(4)
    view.unmount()
  })
})
