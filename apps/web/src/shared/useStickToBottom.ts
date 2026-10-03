/**
 * 跟随滚动（#275）：直播区"粘"在底部，但**用户一往上翻就交出控制权**。
 *
 * 原来的写法是每来一个 delta 就无条件 `el.scrollTop = el.scrollHeight`——用户正在读
 * 前面的输出，下一个 token 就把他拽回底部（ChatGPT/Claude 不是这么干的：你往上翻，
 * 它就不再跟随，并给一个「回到最新」的入口）。
 *
 * 两条语义是判据：
 *   1. **只在"已经在底部"时跟随**：用户滚上去后，新的 delta 不得改动 scrollTop；
 *   2. **可恢复**：点「回到最新」回到跟随态（并立刻到底）。
 *
 * 为什么把判定拆成纯函数：jsdom 没有布局（`scrollHeight`/`clientHeight` 恒为 0），
 * 只有把"度量 → 是否在底部"这一步独立出来，才能把两条分支都真正钉住——
 * 否则测试永远走在"在底部"那一支上，另一支是空的。
 * 也正因为 jsdom 恒为 0，判定必须在**取不到度量时按"在底部"处理**：首帧与无布局环境
 * 都不该被误判成"用户滚上去了"（那会让跟随一次都不发生）。
 */
import { useCallback, useEffect, useState } from 'react'

/** "接近底部"的容差：小于这个距离就算还在底部（不做惯性/速度判断）。 */
export const NEAR_BOTTOM_PX = 24

export interface ScrollMetrics {
  scrollTop: number
  scrollHeight: number
  clientHeight: number
}

export function isNearBottom(metrics: ScrollMetrics, tolerance = NEAR_BOTTOM_PX): boolean {
  const distance = metrics.scrollHeight - metrics.scrollTop - metrics.clientHeight
  return distance <= tolerance
}

function metricsOf(el: HTMLElement): ScrollMetrics {
  return { scrollTop: el.scrollTop, scrollHeight: el.scrollHeight, clientHeight: el.clientHeight }
}

export interface StickToBottom {
  /** true = 还在跟随（新的内容会滚到底）；false = 用户接管了滚动位置。 */
  following: boolean
  /** 回到跟随态并立刻到底（「回到最新」按钮的动作）。 */
  resume: () => void
}

/**
 * @param el 滚动容器（内容不在时传 `null`——回调 ref 的形态，容器挂上来/卸下去都会重跑）
 * @param dep 触发"跟到底"的变化（这里是文本本身）
 * @param enabled 是否该跟随（Run 到终态后就没有"最新"可言了，不再动滚动位置）
 */
export function useStickToBottom(
  el: HTMLElement | null,
  dep: unknown,
  enabled: boolean,
): StickToBottom {
  const [following, setFollowing] = useState(true)

  useEffect(() => {
    if (el === null || !enabled || !following) return
    el.scrollTop = el.scrollHeight
  }, [el, dep, enabled, following])

  // 用户自己的滚动：滚上去就停止跟随，滚回底部就自然恢复（不必等按钮）。
  useEffect(() => {
    if (el === null) return
    const onScroll = (): void => {
      setFollowing(isNearBottom(metricsOf(el)))
    }
    el.addEventListener('scroll', onScroll)
    return () => {
      el.removeEventListener('scroll', onScroll)
    }
  }, [el])

  const resume = useCallback(() => {
    setFollowing(true)
    if (el !== null) el.scrollTop = el.scrollHeight
  }, [el])

  return { following, resume }
}
