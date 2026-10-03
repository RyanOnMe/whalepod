/**
 * 在场（presence，#273）：把「这玩意该不该在屏幕上」与「要不要卸载」分开。
 *
 * 问题：组件的挂载/卸载此前与"该不该显示"是同一件事——`consoleRunId` 一变整棵覆盖层
 * 就没了，toast 到点直接从数组里消失，断线横幅 `return null` 把整页内容瞬间弹回来。
 * 中间没有一个留给退场的时间窗，所以退场永远做不出来。
 *
 * 这个 hook 给的就是那个时间窗：值变 `null` 之后**仍返回上一次的值**，同时把
 * `leaving` 置真，让调用方把退场演完；退场时长到点才真的卸载。
 *
 * 两条语义是判据（都有单测钉住）：
 *   1. **退场可打断**：退场途中值重新变非空 → 立刻回到在场态，且**取消**那次卸载
 *      （不会出现"新开的面板被上一次的定时器摘掉"）。这也是为什么它用过渡/状态
 *      而不是关键帧：CSS 过渡能从中途重定向，关键帧只会从头播。
 *   2. **不在渲染期写外部状态**：值变化在渲染期**派生**出来（同一次提交里 `leaving`
 *      就是真的，不会先渲染一帧"什么都没有"再补上），状态收敛与计时器都在 effect 里。
 *
 * 为什么不写成 `useState` + `useEffect` 的朴素版：那样值变 `null` 的那一帧会先渲染
 * 成"不在场"，退场动画根本没起点（先消失再补动画）。
 */
import { useEffect, useState } from 'react'

export interface Presence<T> {
  /** 当前该渲染的值。退场期间仍是**上一次**的值；`null` = 真的该卸载了。 */
  value: T | null
  /** true = 正在退场（调用方据此挂 `leaving` 类，把退场演完）。 */
  leaving: boolean
}

interface PresenceState<T> {
  value: T | null
  leaving: boolean
}

export function usePresence<T>(value: T | null, exitMs: number): Presence<T> {
  const [state, setState] = useState<PresenceState<T>>(() => ({ value, leaving: false }))

  // 渲染期派生：只在真的变了才造新对象（否则 effect 里 `next !== state` 会每轮都成立，
  // 变成"setState → 重渲染 → 再 setState"的死循环）。三个分支都要能返回 `state` 本身：
  // 尤其是"已经在退场"这一支——它每轮都造新对象就会死循环（本文件写出来第一版就是这么
  // 挂掉的，测试以 worker 崩溃报出来）。
  const next: PresenceState<T> =
    value !== null
      ? state.value === value && !state.leaving
        ? state
        : { value, leaving: false }
      : state.value === null || state.leaving
        ? state
        : { value: state.value, leaving: true }

  // 收敛状态（渲染期不写 state）。
  useEffect(() => {
    if (next !== state) setState(next)
  }, [next, state])

  // 退场计时：`leaving` 一变假（被打断、或已经收敛）就清掉，不会留下"过期卸载"。
  useEffect(() => {
    if (!next.leaving) return
    const timer = setTimeout(() => {
      setState({ value: null, leaving: false })
    }, exitMs)
    return () => {
      clearTimeout(timer)
    }
  }, [next.leaving, exitMs])

  return next
}
