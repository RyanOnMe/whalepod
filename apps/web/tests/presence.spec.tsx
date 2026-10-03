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
import { act, render, screen } from '@testing-library/react'
import type { ReactElement } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { usePresence } from '../src/shared/usePresence.js'

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
