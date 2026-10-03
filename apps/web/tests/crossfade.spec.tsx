/**
 * #277 内容形态切换的连续性：骨架 → 内容的交叉淡入、空态/列表的入场、状态徽标换色。
 *
 * 最要紧的一条是**交叉**的可证伪判据：内容出现的那一帧，骨架**必须还在 DOM 里**
 * （退场中）。硬切时两者不可能同时存在——所以"两者同时在场"就是这一刀的核心判据，
 * 而不是"看起来柔和了"。
 *
 * 其余几条是 CSS 源文本口径（与 #231 骨架门、#271 动效门同款）：`@starting-style`
 * 入场块、列表/空态的 opacity 过渡、徽标的颜色过渡、提示按钮的 hover/按压。
 */
import { screen, waitFor } from '@testing-library/react'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { BOB, loggedInHandlers, makeTask, ok } from './fixtures.js'
import type { MockHandler } from './fixtures.js'
import { renderApp } from './render.js'

const globalCss = readFileSync(resolve(process.cwd(), 'apps/web/src/styles/global.css'), 'utf8')

/**
 * 取某**顶层**选择器的规则体。
 *
 * 行首锚定是必须的：`indexOf('.room-skeleton {')` 会命中 `.crossfade-stack > .room-skeleton {`
 * 里的那一段（本文件第一版就是这么误报"命中 2 条"的）。带缩进的是 @media/@starting-style
 * 里的嵌套规则，不算顶层。
 */
function blockOf(css: string, selector: string): string {
  const escaped = selector.replaceAll(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const matches = [...css.matchAll(new RegExp(`(?:^|\\n)${escaped} \\{([^}]*)\\}`, 'g'))]
  if (matches.length !== 1) {
    throw new Error(`${selector} 命中 ${matches.length} 条规则，判据定位不唯一`)
  }
  return matches[0]![0]!
}

/** 任务房的取数应答由测试控制：先挂住，再放行——这样能看到"骨架还在"的那一帧。 */
function deferredRoomHandlers(task: TaskView, gate: Promise<void>): MockHandler[] {
  return [
    {
      method: 'GET',
      url: new RegExp(`/api/v1/tasks/${task.id}$`),
      respond: async () => {
        await gate
        return ok({
          task,
          comments: [],
          instructions: [],
          runs: [],
          artifacts: [],
          nextRunApprovalPolicy: null,
        })
      },
    },
  ]
}

type TaskView = ReturnType<typeof makeTask>

describe('#277 骨架 → 内容的交叉淡入（可证伪判据：两者同时在 DOM）', () => {
  it('数据到达那一帧骨架仍在（退场中），退场演完才卸载', async () => {
    const task = makeTask({ assigneeUserId: BOB.userId })
    let release = (): void => {}
    const gate = new Promise<void>((res) => {
      release = res
    })
    renderApp(`/tasks/${task.id}`, loggedInHandlers(BOB, deferredRoomHandlers(task, gate)))

    // pending：骨架在场（形状与真内容对齐）。
    const skeleton = await screen.findByTestId('room-skeleton')
    expect(skeleton).toHaveAttribute('aria-busy', 'true')

    release()
    // 内容到了——但骨架**不许**在这一帧消失：它还要演完退场（这就是"交叉"）。
    await screen.findByRole('heading', { name: task.title })
    const leavingSkeleton = screen.getByTestId('room-skeleton')
    expect(leavingSkeleton).toHaveClass('leaving')
    // 内容挂上了入场类（只在"从骨架过来"时挂）。
    expect(document.querySelector('.task-room')).toHaveClass('crossfade-in')

    // 退场演完才真的卸载。
    await waitFor(() => expect(screen.queryByTestId('room-skeleton')).toBeNull())
  })

  it('项目页同一处理：骨架与列表也有一段共存窗口', async () => {
    let release = (): void => {}
    const gate = new Promise<void>((res) => {
      release = res
    })
    const handlers: MockHandler[] = [
      {
        method: 'GET',
        url: /\/api\/v1\/projects$/,
        respond: async () => {
          await gate
          return ok([])
        },
      },
    ]
    renderApp('/', loggedInHandlers(BOB, handlers))
    expect(await screen.findByTestId('projects-skeleton')).toBeInTheDocument()
    release()
    // 空态到了，骨架仍在退场（空态自身由全局 @starting-style 淡入）。
    await screen.findByText(/还没有项目/)
    expect(screen.getByTestId('projects-skeleton')).toHaveClass('leaving')
    await waitFor(() => expect(screen.queryByTestId('projects-skeleton')).toBeNull())
  })
})

describe('#277 形态切换的 CSS 口径', () => {
  it('骨架叠在内容之上淡出（绝对定位 + leaving），任务房用同一对类名', () => {
    expect(globalCss).toMatch(/\.crossfade-stack\s*\{[^}]*position:\s*relative/)
    expect(globalCss).toMatch(
      /\.crossfade-stack\s*>\s*\.room-skeleton\s*\{[^}]*position:\s*absolute/,
    )
    const skeleton = blockOf(globalCss, '.room-skeleton')
    expect(skeleton).toMatch(/transition:\s*opacity/)
    expect(blockOf(globalCss, '.room-skeleton.leaving')).toMatch(/opacity:\s*0/)
  })

  it('内容入场只在"从骨架过来"时挂（crossfade-in 有 @starting-style，不是无差别路由过渡）', () => {
    expect(globalCss).toMatch(/@starting-style\s*\{\s*\.crossfade-in\s*\{/)
    expect(blockOf(globalCss, '.crossfade-in')).toMatch(/transition:\s*opacity/)
  })

  it('空态/列表容器挂载时淡入一次（实时插入的行不逐行动画）', () => {
    expect(globalCss).toMatch(
      /@starting-style\s*\{[\s\S]*?\.empty-state,[\s\S]*?\.run-list[\s\S]*?opacity:\s*0/,
    )
    const empty = blockOf(globalCss, '.empty-state')
    expect(empty).toMatch(/transition:\s*opacity/)
    // 列表容器那条分组规则里也要有过渡（入场才有可过渡的属性）。
    expect(globalCss).toMatch(
      /\.run-list,[\s\S]*?\.revision-history ul\s*\{[^}]*transition:\s*opacity/,
    )
  })

  it('状态徽标换色有过渡（就地换态不再整块跳）', () => {
    const badge = blockOf(globalCss, '.badge')
    expect(badge).toMatch(/transition:/)
    expect(badge).toMatch(/background-color var\(--duration-quick\)/)
  })

  it('执行活动提示是按钮，就得有 hover 与按下（此前两者都没有）', () => {
    expect(blockOf(globalCss, '.execution-activity-hint:hover')).toMatch(/background:/)
    expect(blockOf(globalCss, '.execution-activity-hint:active')).toMatch(
      /transform:\s*scale\(var\(--press-scale\)\)/,
    )
  })
})
