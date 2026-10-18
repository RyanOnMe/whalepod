/**
 * 阅读锚点（P1-393；ADR-0019 决定 6）：加载更早记录时保留当前阅读位置。
 *
 * 做法不是"记住 scrollTop 再设回去"——上方内容（更早的段）会在事件到达时继续长高，
 * 一次性的补偿会被后续增长吃掉。这里记住**第一个可见条目的身份与它相对滚动容器的偏移**，
 * 并在锚点存在期间（直到新加载的运行都读完/读失败）持续把该条目拉回原偏移：
 * 每次修正都是幂等的（差值归零即停），所以事件陆续到达也不会让人跳走。
 *
 * 条目身份用 `data-conversation-entry`（段/独立指令的稳定键）。键只含 `[\w-]`，
 * 直接拼进属性选择器是安全的（不引入 CSS.escape 的兼容面）。
 */
import { useCallback, useLayoutEffect, useRef } from 'react'

export interface ReadingAnchor {
  /** 记录当前第一个可见条目（在触发"加载更早"之前调用）。 */
  capture: () => void
}

interface AnchorState {
  readonly key: string
  readonly top: number
}

const KEY_PATTERN = /^[\w-]+$/

function offsetTop(container: HTMLElement, element: HTMLElement): number {
  return element.getBoundingClientRect().top - container.getBoundingClientRect().top
}

/**
 * @param el 滚动容器
 * @param settled 新加载的内容是否都读完了（true 时锚点使命完成，清除）
 * @param onAdjusted 每次修正后调用（调用方据此重算"是否还在跟随"）
 */
export function useReadingAnchor(
  el: HTMLElement | null,
  settled: boolean,
  onAdjusted?: () => void,
): ReadingAnchor {
  const anchorRef = useRef<AnchorState | null>(null)

  const capture = useCallback(() => {
    if (el === null) return
    const first = el.querySelector<HTMLElement>('[data-conversation-entry]')
    if (first === null) return
    const key = first.dataset['conversationEntry'] ?? ''
    if (!KEY_PATTERN.test(key)) return
    anchorRef.current = { key, top: offsetTop(el, first) }
  }, [el])

  // 有锚点时每次渲染都修正一次：加载更早本身、以及随后到达的事件都会改上方高度。
  useLayoutEffect(() => {
    const anchor = anchorRef.current
    if (anchor === null || el === null) return
    const target = el.querySelector<HTMLElement>(`[data-conversation-entry="${anchor.key}"]`)
    if (target !== null) {
      const delta = offsetTop(el, target) - anchor.top
      if (delta !== 0) el.scrollTop += delta
      onAdjusted?.()
    }
    if (settled) anchorRef.current = null
  })

  return { capture }
}
