/**
 * #308 可关闭 toast（Swipe Toast 应用内适配）：把「4 秒自动消退」从看不见的
 * setTimeout 变成用户看得见、读得完、关得掉的东西。
 *
 * 判据（Issue 的「怎样算修好」第 4 条）：
 * 1. 消退窗口仍是真实剩余时间：fuse 只显示真实时长，且**消失行为不依赖动画**
 *    （动画被减少动态关掉时，计时器照常到期）；
 * 2. 悬停/聚焦/页面隐藏时暂停，离开后按剩余时间继续（读的时候不会被摘掉）；
 * 3. 三条真实关闭路径：关闭按钮、Escape（焦点在卡内）、下滑手势；关闭后不再自动消退；
 * 4. 既有契约不变：最多 3 条、`role=status` + `aria-live=polite` 只有一处、两段式退场
 *    （`.leaving` 先演完再移除）；不新增任何「猜系统状态」的计时器或进度。
 */
import { act, fireEvent, render, screen } from '@testing-library/react'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ToastHost, pushToast, resetToastsForTest } from '../src/app/toast.js'
import { EXIT_PRESENCE_MS } from '../src/shared/motion.js'

const toastCss = readFileSync(
  resolve(process.cwd(), 'apps/web/src/vendor/react-bits-micro/SwipeToast.css'),
  'utf8',
)
/** 与 app/toast.tsx 的公开语义一致：全可见 4 秒，其中最后 EXIT_PRESENCE_MS 用于退场。 */
const TOAST_TTL_MS = 4_000
const VISIBLE_WINDOW_MS = TOAST_TTL_MS - EXIT_PRESENCE_MS

function mount(message = '已保存插件设置'): HTMLElement {
  const view = render(<ToastHost />)
  act(() => pushToast(message))
  void view
  return screen.getByTestId('toast-item')
}

const itemOf = (): HTMLElement | null => screen.queryByTestId('toast-item')

describe('#308 可关闭 toast', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    resetToastsForTest()
  })
  afterEach(() => {
    vi.useRealTimers()
    resetToastsForTest()
  })

  it('fuse 只显示真实剩余时长，且不额外占用播报通道', () => {
    mount()
    const item = screen.getByTestId('toast-item')
    const fuse = item.querySelector('.toast-item__fuse')
    expect(fuse).not.toBeNull()
    expect(fuse).toHaveAttribute('aria-hidden', 'true')
    expect(item.style.getPropertyValue('--toast-fuse-ms')).toBe(`${VISIBLE_WINDOW_MS}ms`)
    // 唯一的活动区仍是栈本身：fuse 不能被做成第二个 role=status/timer。
    expect(screen.getAllByRole('status')).toHaveLength(1)
  })

  it('悬停暂停、离开按剩余时间继续：读的时候不会被摘掉', () => {
    const item = mount()
    fireEvent.pointerEnter(item)
    expect(item).toHaveAttribute('data-paused', 'true')
    // 悬停期间时间照走，但计时不推进：远超 TTL 也仍在。
    act(() => {
      vi.advanceTimersByTime(30_000)
    })
    expect(itemOf()).not.toBeNull()

    fireEvent.pointerLeave(item)
    expect(item).toHaveAttribute('data-paused', 'false')
    act(() => {
      vi.advanceTimersByTime(VISIBLE_WINDOW_MS - 1)
    })
    expect(itemOf()).not.toBeNull()
    act(() => {
      vi.advanceTimersByTime(1)
    })
    // 两段式退场：先标记 leaving（还在 DOM 里演退场），160ms 后才移除。
    expect(itemOf()).toHaveClass('leaving')
    act(() => {
      vi.advanceTimersByTime(EXIT_PRESENCE_MS)
    })
    expect(itemOf()).toBeNull()
  })

  it('焦点在卡内时同样暂停（键盘用户读提示不算暂停以外的特例）', () => {
    const item = mount()
    const close = screen.getByRole('button', { name: '关闭提示' })
    act(() => close.focus())
    expect(item).toHaveAttribute('data-paused', 'true')
    act(() => {
      vi.advanceTimersByTime(30_000)
    })
    expect(itemOf()).not.toBeNull()
    act(() => close.blur())
    expect(item).toHaveAttribute('data-paused', 'false')
  })

  it('关闭按钮：真实关闭，关闭后不再自动消退（也不重复移除）', () => {
    mount()
    fireEvent.click(screen.getByRole('button', { name: '关闭提示' }))
    expect(itemOf()).toHaveClass('leaving')
    act(() => {
      vi.advanceTimersByTime(EXIT_PRESENCE_MS)
    })
    expect(itemOf()).toBeNull()
    act(() => {
      vi.advanceTimersByTime(TOAST_TTL_MS)
    })
    expect(itemOf()).toBeNull()
  })

  it('Escape：焦点在卡内时可关闭', () => {
    mount()
    const close = screen.getByRole('button', { name: '关闭提示' })
    act(() => close.focus())
    fireEvent.keyDown(close, { key: 'Escape' })
    expect(itemOf()).toHaveClass('leaving')
    act(() => {
      vi.advanceTimersByTime(EXIT_PRESENCE_MS)
    })
    expect(itemOf()).toBeNull()
  })

  it('下滑超过阈值：关闭；位移不足或向上：回位不关', () => {
    const first = render(<ToastHost />)
    act(() => pushToast('一'))
    const one = screen.getByTestId('toast-item')
    // 上游语义：位移从**跨过死区那一刻**起算（第一次越过死区的移动本身位移为 0）。
    fireEvent.pointerDown(one, { pointerId: 1, clientY: 100, button: 0 })
    fireEvent.pointerMove(one, { pointerId: 1, clientY: 170 })
    fireEvent.pointerMove(one, { pointerId: 1, clientY: 240 })
    expect(one).toHaveAttribute('data-offset', '70')
    fireEvent.pointerUp(one, { pointerId: 1, clientY: 240 })
    expect(one).toHaveClass('leaving')
    first.unmount()

    resetToastsForTest()
    const second = render(<ToastHost />)
    act(() => pushToast('二'))
    const two = screen.getByTestId('toast-item')
    fireEvent.pointerDown(two, { pointerId: 2, clientY: 100, button: 0 })
    fireEvent.pointerMove(two, { pointerId: 2, clientY: 120 })
    // 让速度采样过期（>100ms 判 0）：不能靠「时钟没动」把 5px 算成高速甩动。
    act(() => {
      vi.advanceTimersByTime(150)
    })
    fireEvent.pointerMove(two, { pointerId: 2, clientY: 125 })
    fireEvent.pointerUp(two, { pointerId: 2, clientY: 125 })
    expect(two).not.toHaveClass('leaving')
    expect(two).toHaveAttribute('data-offset', '0')
    second.unmount()
  })

  it('样式契约：fuse 时长由内联变量驱动；减少动态下关掉动画但**保留**计时器语义', () => {
    expect(toastCss).toMatch(/\.toast-item__fuse\s*\{/)
    expect(toastCss).toMatch(/animation-duration:\s*var\(--toast-fuse-ms\)/)
    const reduced = toastCss.split('@media (prefers-reduced-motion: reduce)').slice(1).join('')
    expect(reduced).toContain('.toast-item__fuse')
    // 反面：不许把 TTL 也清零——那会让「读的时候暂停」变成「永远留着」。
    expect(toastCss).not.toMatch(/--toast-fuse-ms:\s*0/)
  })
})
