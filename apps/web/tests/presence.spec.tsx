/**
 * #273 在场原语（`usePresence`）的语义判据。
 *
 * 这个 hook 的全部价值在两条语义上，所以判据也只钉这两条（外加一条防死循环）：
 *   1. 值变 null 之后**仍返回上一次的值**，同一次提交里 `leaving` 就是真的
 *      （先渲染成"不在场"再补动画 = 退场没有起点）；
 *   2. 退场**可打断**：中途值回来就取消卸载，过期定时器不许把新内容摘掉。
 *
 * 另外钉一条渲染次数：渲染期派生 + 引用比较写错就会变成
 * "setState → 重渲染 → 再 setState" 的死循环（测试会以"超出渲染上限"炸掉，
 * 也算一种机器证据）。
 */
import { act, render, screen, waitFor } from '@testing-library/react'
import { userEvent } from '@testing-library/user-event'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import type { ReactElement } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { EXIT_PRESENCE_MS } from '../src/shared/motion.js'
import { usePresence } from '../src/shared/usePresence.js'
import { BOB, loggedInHandlers, makeRun, makeTask, ok, teamMembersHandler } from './fixtures.js'
import { renderApp } from './render.js'

/** 渲染探针：把 hook 的两个输出拼成一行文本，断言只看这一行。 */
let renders = 0
function Probe({ value }: { value: string | null }): ReactElement {
  renders += 1
  const presence = usePresence(value, 160)
  return (
    <p data-testid="out">{`${presence.value ?? '-'}|${presence.leaving ? 'leaving' : 'here'}`}</p>
  )
}

const out = (): string => screen.getByTestId('out').textContent ?? ''

describe('#273 在场原语 usePresence', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    renders = 0
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('在场：值非空时原样返回，不挂退场标记', () => {
    render(<Probe value="a" />)
    expect(out()).toBe('a|here')
  })

  it('退场：值变 null 的**同一次提交**里就带着上一次的值与 leaving（不是先消失）', () => {
    const view = render(<Probe value="a" />)
    view.rerender(<Probe value={null} />)
    // 关键：这一帧必须还在场——先渲染成 "-" 就说明退场动画没有起点。
    expect(out()).toBe('a|leaving')
    act(() => {
      vi.advanceTimersByTime(160)
    })
    expect(out()).toBe('-|here')
  })

  it('退场可打断：中途值回来 → 立刻在场，且过期定时器不会把它摘掉', () => {
    const view = render(<Probe value="a" />)
    view.rerender(<Probe value={null} />)
    expect(out()).toBe('a|leaving')
    act(() => {
      vi.advanceTimersByTime(100)
    })
    // 退场演到一半，新的 run 打开了 console。
    view.rerender(<Probe value="b" />)
    expect(out()).toBe('b|here')
    // 上一次退场的定时器此刻到期：它必须已经被清掉（否则 b 会被摘成 "-"）。
    act(() => {
      vi.advanceTimersByTime(500)
    })
    expect(out()).toBe('b|here')
  })

  it('非空到非空：直接换值，不经过退场', () => {
    const view = render(<Probe value="a" />)
    view.rerender(<Probe value="b" />)
    expect(out()).toBe('b|here')
  })

  it('值没变时不来回 setState（引用比较写错会死循环）', () => {
    const view = render(<Probe value="a" />)
    view.rerender(<Probe value="a" />)
    view.rerender(<Probe value="a" />)
    // 首次挂载 1 次 + 两次 rerender 各 1 次；effect 里的收敛不应再触发额外渲染。
    expect(renders).toBe(3)
  })
})

const stylesDir = resolve(process.cwd(), 'apps/web/src/styles')
const globalCss = readFileSync(resolve(stylesDir, 'global.css'), 'utf8')
const tokensCss = readFileSync(resolve(stylesDir, 'tokens.css'), 'utf8')

describe('#273 退场时长两端一致（JS 计时器 vs CSS 过渡）', () => {
  it('EXIT_PRESENCE_MS 等于 tokens.css 里现场解析出的 --duration-base', () => {
    // 不硬编码 160：CSS 改了就跟着改，两边对不上这条会红——
    // 对不上的后果正是本切片要修的毛病（动画没演完就被摘掉，或演完还挂着）。
    const match = /--duration-base:\s*(\d+)ms/.exec(tokensCss)
    expect(match, 'tokens.css 里找不到 --duration-base').not.toBeNull()
    expect(EXIT_PRESENCE_MS).toBe(Number(match![1]))
  })

  it('三处浮层/提示都有进出（@starting-style 进场 + .leaving 退场）', () => {
    for (const selector of [
      '.console-backdrop',
      '.console',
      '.toast-item',
      '.connection-banner-slot',
    ]) {
      const escaped = selector.replaceAll('.', '\\.')
      expect(globalCss, `${selector} 缺进场`).toMatch(
        new RegExp(`@starting-style\\s*\\{\\s*${escaped}\\s*\\{`),
      )
      expect(globalCss, `${selector} 缺退场`).toMatch(
        new RegExp(`\\.leaving[^{]*${escaped}|${escaped}[^{]*\\.leaving`),
      )
    }
  })

  it('reduced-motion 关掉位移与展开（淡入淡出保留：减少不是清零）', () => {
    const reduced =
      /@media \(prefers-reduced-motion: reduce\)[\s\S]*?\n\}/.exec(tokensCss)?.[0] ?? ''
    expect(reduced).toMatch(/--presence-transform:\s*none/)
    expect(reduced).toMatch(/--expand-duration:\s*0s/)
    // 反面：不许顺手把 duration 也清零——那样退场就没了，`leaving` 窗口会白等。
    expect(reduced).not.toMatch(/--duration-base:\s*0s/)
  })
})

describe('#273 页面级：Console 关闭是两段式', () => {
  it('点关闭 → 仍在 DOM 且带 data-leaving → 退场后才真的卸载', async () => {
    const user = userEvent.setup()
    const task = makeTask({ assigneeUserId: BOB.userId })
    const run = makeRun({ id: 'run-presence-1', status: 'running' })
    renderApp(
      `/tasks/${task.id}`,
      loggedInHandlers(BOB, [
        {
          method: 'GET',
          url: new RegExp(`/api/v1/tasks/${task.id}$`),
          respond: () => ok({ task, comments: [], instructions: [], runs: [run], artifacts: [] }),
        },
        {
          method: 'GET',
          url: new RegExp(`/api/v1/runs/${run.id}$`),
          respond: () => ok({ ...run, projectId: task.projectId, rerunOfRunId: null }),
        },
        { method: 'GET', url: /\/events$/, respond: () => ok({ events: [] }) },
        teamMembersHandler([]),
      ]),
    )
    await user.click(await screen.findByRole('button', { name: /第 1 次运行/ }))
    await user.click(await screen.findByTestId('open-run-console'))
    expect(await screen.findByTestId('run-console')).toBeVisible()
    await user.click(screen.getByTestId('console-close'))
    // 关键：**这一帧**它还在，而且明确标了退场——直接卸载就没有退场动画可言。
    // 类名与 data 属性都要断言：只断言其中一个时删掉另一个门会照样绿（实测：只断言
    // data-leaving 时，删掉 className 里的 leaving 变异存活，而 CSS 正是靠类名触发的
    // ——动画没了，门却看不见）。
    const closing = screen.getByTestId('run-console')
    expect(closing).toHaveAttribute('data-leaving', 'true')
    expect(closing).toHaveClass('leaving')
    await waitFor(() => expect(screen.queryByTestId('run-console')).toBeNull())
  })
})
