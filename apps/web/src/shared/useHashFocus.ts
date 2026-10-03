/**
 * ⌘K 结果落点高亮（#263）。
 *
 * 项目/Agent 的搜索结果落在「列表页」上——不像任务有 `/tasks/:id` 那样的直达路由，
 * 所以用 hash 锚点把目标卡片标出来（滚进视口 + 短暂描边），否则 Enter 之后看到的
 * 是一整页列表，「找到了」的体感就断了。
 *
 * 为什么是 hash 而不是 router state：可复制、可分享、刷新不丢，且不需要给这两个页面
 * 立「选中项」的 URL 契约（那是更大的事）。
 *
 * 两个陷阱：
 * - 数据未就绪时元素还不存在——所以 `ready` 进依赖，列表落地后再找一次；
 * - jsdom 没有 `scrollIntoView`（同 window.focus）：没有就只标亮不滚动，不抛。
 */
import { useEffect } from 'react'
import { useLocation } from 'react-router'

const HIGHLIGHT_MS = 2000

export function useHashFocus(ready = true): void {
  const { hash } = useLocation()
  useEffect(() => {
    const id = hash.replace(/^#/, '')
    if (id === '' || !ready) return
    const target = document.getElementById(id)
    if (target === null) return
    if (typeof target.scrollIntoView === 'function') target.scrollIntoView({ block: 'center' })
    target.classList.add('hash-focus')
    const timer = window.setTimeout(() => target.classList.remove('hash-focus'), HIGHLIGHT_MS)
    return () => {
      window.clearTimeout(timer)
      target.classList.remove('hash-focus')
    }
  }, [hash, ready])
}
