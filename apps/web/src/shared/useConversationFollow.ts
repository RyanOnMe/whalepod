/**
 * 对话跟随滚动（P1-393；ADR-0019 决定 6）。
 *
 * 与 #275 的直播区同一套语义，但作用在**对话的唯一主滚动容器**上：
 *   1. **只在"已经在底部"时跟随**：用户上翻后，新内容（含流式 token）不得改动 scrollTop；
 *   2. **可恢复**：点「回到最新」回到跟随态并立刻到底；
 *   3. **加载更早不打扰**：跟随的触发值（dep）必须是"对话底部"的签名——加载更早只改上方内容，
 *      不改变签名，因此不会把正在读历史的人拽回底部。
 *
 * jsdom 没有布局（滚动度量恒为 0），所以"是否在底部"的判定用 `isNearBottom` 的纯函数
 * 表达（取不到度量时按"在底部"处理）；真实浏览器里的行为由 Q5 判据断言。
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { isNearBottom } from './useStickToBottom.js'

export interface ConversationFollow {
  /** true = 还在跟随（新内容会滚到底）；false = 用户接管了滚动位置。 */
  following: boolean
  /** 回到跟随态并立刻到底（「回到最新」的动作）。 */
  resume: () => void
  /** 立即跟随（流式组件在文本增长时调用；不在跟随态则什么都不做）。 */
  followNow: () => void
  /** 用容器的当前度量重算 following（阅读锚点修正后调用）。 */
  refreshFollowing: () => void
}

export function useConversationFollow(el: HTMLElement | null, dep: unknown): ConversationFollow {
  const [following, setFollowing] = useState(true)
  const followingRef = useRef(true)
  followingRef.current = following

  const scrollToBottom = useCallback(() => {
    if (el !== null) el.scrollTop = el.scrollHeight
  }, [el])

  // 底部签名变化（新段/新回复/新指令）时跟随；加载更早不改变签名。
  useEffect(() => {
    if (el === null || !following) return
    scrollToBottom()
  }, [el, dep, following, scrollToBottom])

  const followNow = useCallback(() => {
    if (el === null || !followingRef.current) return
    scrollToBottom()
  }, [el, scrollToBottom])

  // 用户自己的滚动：滚上去就停止跟随，滚回底部就自然恢复（不必等按钮）。
  useEffect(() => {
    if (el === null) return
    const onScroll = (): void => {
      setFollowing(
        isNearBottom({
          scrollTop: el.scrollTop,
          scrollHeight: el.scrollHeight,
          clientHeight: el.clientHeight,
        }),
      )
    }
    el.addEventListener('scroll', onScroll)
    return () => {
      el.removeEventListener('scroll', onScroll)
    }
  }, [el])

  const resume = useCallback(() => {
    setFollowing(true)
    scrollToBottom()
  }, [scrollToBottom])

  const refreshFollowing = useCallback(() => {
    if (el === null) return
    setFollowing(
      isNearBottom({
        scrollTop: el.scrollTop,
        scrollHeight: el.scrollHeight,
        clientHeight: el.clientHeight,
      }),
    )
  }, [el])

  return { following, resume, followNow, refreshFollowing }
}
