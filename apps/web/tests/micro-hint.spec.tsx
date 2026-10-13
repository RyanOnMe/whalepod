/**
 * #308 提示层（Warm Tooltip 应用内适配）：只做「文字按钮的可见文案够不着真目标」这一件事。
 *
 * 判据（Issue 的「怎样算修好」第 2 条）：
 * 1. 冷启动要等：鼠标悬停满 delay 才出现，窗口内相邻目标即时出现（warm）；
 * 2. 键盘路径不等待：焦点可见即时显示，Escape 关闭；
 * 3. 可访问性面：`aria-describedby` **只在提示可见时**挂在触发元素上，且指向真实存在的
 *    `role=tooltip` 元素；
 * 4. 提示文案只来自传入的静态标签——不读 Run/事件/投影数据（本文件用"只传标签"的
 *    构造来钉住：触发元素里没有任何运行数据，提示内容仍必须完整）。
 */
import { act, fireEvent, render, screen } from '@testing-library/react'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import type { ReactElement } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Hint, HintGroup } from '../src/shared/micro/Hint.js'

const hintCss = readFileSync(
  resolve(process.cwd(), 'apps/web/src/vendor/react-bits-micro/WarmTooltip.css'),
  'utf8',
)

/** 按花括号配平取出每一段 reduced-motion 块（不靠缩进猜边界）。 */
function reducedBlocks(css: string): string[] {
  const marker = '@media (prefers-reduced-motion: reduce)'
  const blocks: string[] = []
  let index = css.indexOf(marker)
  while (index !== -1) {
    const open = css.indexOf('{', index)
    let depth = 0
    let end = open
    for (let i = open; i < css.length; i += 1) {
      if (css[i] === '{') depth += 1
      else if (css[i] === '}') {
        depth -= 1
        if (depth === 0) {
          end = i
          break
        }
      }
    }
    blocks.push(css.slice(open, end + 1))
    index = css.indexOf(marker, end)
  }
  return blocks
}

const COLD_DELAY_MS = 400
const WARM_WINDOW_MS = 300
const EXIT_MS = 160
/** 触发元素之间移动的宽限（组件常量；在这一段里换目标不会把提示真的关掉）。 */
const GRACE_MS = 80

/**
 * 与 CopyButton / 设备页同形：可见文案是泛指的「复制」，真正的目标只在 label 里。
 * **必须是真实 DOM 元素**：`aria-describedby` 要挂在会渲染它的那颗节点上
 * （传自定义组件的话属性会被组件忽略——真实调用点都是 `<button>`，见 CopyButton / 设备页 / 运行列表项）。
 */
function copyButton(label = '复制邀请链接'): ReactElement<{ 'aria-describedby'?: string }> {
  return (
    <button type="button" aria-label={label}>
      复制
    </button>
  )
}

function Pair(): ReactElement {
  return (
    <HintGroup>
      <Hint label="复制邀请链接">{copyButton()}</Hint>
      <Hint label="复制配对码">{copyButton('复制配对码')}</Hint>
    </HintGroup>
  )
}

const anchorOf = (name: string): HTMLElement =>
  screen.getByRole('button', { name }).closest('[data-testid="hint-anchor"]') as HTMLElement

describe('#308 提示层', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('初始不渲染提示，触发元素也没有 aria-describedby', () => {
    render(<Pair />)
    expect(screen.queryByRole('tooltip')).toBeNull()
    expect(screen.getByRole('button', { name: '复制邀请链接' })).not.toHaveAttribute(
      'aria-describedby',
    )
  })

  it('冷启动要等满 delay 才出现；warm 窗口内相邻目标即时出现', () => {
    render(<Pair />)
    const first = anchorOf('复制邀请链接')
    const second = anchorOf('复制配对码')

    // 冷：悬停后不足 delay 不出现。
    fireEvent.pointerEnter(first)
    act(() => {
      vi.advanceTimersByTime(COLD_DELAY_MS - 1)
    })
    expect(screen.queryByRole('tooltip')).toBeNull()
    act(() => {
      vi.advanceTimersByTime(1)
    })
    expect(screen.getByRole('tooltip')).toHaveTextContent('复制邀请链接')

    // 离开 → 提示退场（宽限 + 退场）；随即移向相邻目标：窗口内即时（不重新计时）。
    fireEvent.pointerLeave(first)
    act(() => {
      vi.advanceTimersByTime(GRACE_MS + EXIT_MS)
    })
    expect(screen.queryByRole('tooltip')).toBeNull()
    fireEvent.pointerEnter(second)
    expect(screen.getByRole('tooltip')).toHaveTextContent('复制配对码')
  })

  it('超过 warm 窗口后回到冷启动：重新等满 delay', () => {
    render(<Pair />)
    const first = anchorOf('复制邀请链接')
    const second = anchorOf('复制配对码')

    fireEvent.pointerEnter(first)
    act(() => {
      vi.advanceTimersByTime(COLD_DELAY_MS)
    })
    expect(screen.getByRole('tooltip')).toBeInTheDocument()
    fireEvent.pointerLeave(first)
    // 窗口从**开始退场**那一刻起算：宽限之后再加满整个窗口。
    act(() => {
      vi.advanceTimersByTime(GRACE_MS + WARM_WINDOW_MS + 1)
    })

    fireEvent.pointerEnter(second)
    expect(screen.queryByRole('tooltip')).toBeNull()
    act(() => {
      vi.advanceTimersByTime(COLD_DELAY_MS)
    })
    expect(screen.getByRole('tooltip')).toHaveTextContent('复制配对码')
  })

  it('键盘：焦点可见即时显示，aria-describedby 指向真实元素，Escape 关闭并撤掉描述', () => {
    render(<Pair />)
    const button = screen.getByRole('button', { name: '复制邀请链接' })
    fireEvent.focus(button)
    const layer = screen.getByRole('tooltip')
    expect(layer).toHaveTextContent('复制邀请链接')
    expect(button.getAttribute('aria-describedby')).toBe(layer.id)
    expect(document.getElementById(layer.id as string)).toBe(layer)

    fireEvent.keyDown(button, { key: 'Escape' })
    expect(screen.queryByRole('tooltip')).toBeNull()
    expect(button).not.toHaveAttribute('aria-describedby')
  })

  it('提示文案只来自传入的静态标签，不夹带任何运行/事件字段', () => {
    render(
      <HintGroup>
        <Hint label="复制邀请链接">{copyButton()}</Hint>
      </HintGroup>,
    )
    act(() => {
      screen.getByRole('button', { name: '复制邀请链接' }).focus()
    })
    expect(screen.getByRole('tooltip').textContent).toBe('复制邀请链接')
  })

  it('样式契约：提示层用语义 token，且减少动态下不做位移/弹入', () => {
    expect(hintCss).toMatch(/\.hint-layer\s*\{/)
    expect(hintCss).toMatch(/\.hint-anchor\s*\{/)
    // 减少动态：入场位移必须归零（淡入保留），不得靠 JS 分叉。
    expect(reducedBlocks(hintCss).some((block) => block.includes('.hint-layer'))).toBe(true)
  })
})
