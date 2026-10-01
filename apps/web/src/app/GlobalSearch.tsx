/**
 * ⌘K 全局搜索（#254；#243 第 5 条刀二）。
 *
 * 「那个叫什么来着」的解法：任意已登录页 ⌘K/Ctrl+K 呼出（侧栏「搜索」钮是鼠标路径
 * ——快捷键不是唯一入口），输入即查任务标题，Enter/点击直达任务房。dialog 语义照
 * ConfirmDialog/RunConsole 的口径（S2/S3/S4）：Esc 关闭、还焦触发元素、Tab 留在框内。
 * 对照 ChatGPT 的 ⌘K：一处输入、纯键盘可走（上下选、Enter 进）。
 */
import { useQuery } from '@tanstack/react-query'
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { useNavigate } from 'react-router'
import { Modal } from '../vendor/dsh-ui/index.js'
import { api } from '../shared/api/client.js'
import { TASK_STATUS_LABEL } from '../shared/format.js'
import { RelativeTime } from '../shared/RelativeTime.js'
import { queryKeys } from './query-client.js'
import type { RecentTaskView } from '../shared/api/types.js'

/** 结果上限与服务端一致（UI 侧再截一次，防御未来服务端放宽）。 */
const RESULT_LIMIT = 8
const DEBOUNCE_MS = 300

export function GlobalSearch(): ReactNode {
  const navigate = useNavigate()
  const [open, setOpen] = useState(false)
  const [q, setQ] = useState('')
  const [debouncedQ, setDebouncedQ] = useState('')
  const [active, setActive] = useState(0)
  // 还焦目标在打开那一刻定格（按钮或当时焦点）；Esc/选中后还回去。
  const triggerRef = useRef<HTMLElement | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const panelRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== 'k' || !(event.metaKey || event.ctrlKey)) return
      // ⌘K 默认是浏览器的地址栏搜索——搜索任务是我们的领域动作，接管之
      //（ChatGPT/Linear 同款行为）。
      event.preventDefault()
      triggerRef.current =
        document.activeElement instanceof HTMLElement ? document.activeElement : null
      setOpen(true)
      setQ('')
      setDebouncedQ('')
      setActive(0)
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [])

  // 输入防抖：300ms 内的连续击键只发一次请求（每个停顿一个 queryKey，react-query 缓存兜住回退）。
  useEffect(() => {
    const timer = window.setTimeout(() => {
      setDebouncedQ(q)
      setActive(0)
    }, DEBOUNCE_MS)
    return () => window.clearTimeout(timer)
  }, [q])

  const trimmed = debouncedQ.trim()
  const query = useQuery({
    queryKey: queryKeys.taskSearch(trimmed),
    queryFn: () => api.get<RecentTaskView[]>(`/tasks/search?q=${encodeURIComponent(trimmed)}`),
    enabled: open && trimmed !== '',
  })
  const results = (query.data ?? []).slice(0, RESULT_LIMIT)

  const close = (): void => {
    setOpen(false)
    setQ('')
    setDebouncedQ('')
    triggerRef.current?.focus()
  }

  // 选中一条：直达任务房。导航后再关（close 会还焦触发元素，导航换页后无感）。
  const go = (taskId: string): void => {
    close()
    navigate(`/tasks/${taskId}`)
  }

  return (
    <>
      <button
        type="button"
        className="app-sidebar-search"
        onClick={(event) => {
          triggerRef.current = event.currentTarget
          setOpen(true)
          setQ('')
          setDebouncedQ('')
          setActive(0)
        }}
      >
        搜索
        <span className="kbd-hint" aria-hidden="true">
          ⌘K
        </span>
      </button>
      {open ? (
        <Modal open onClose={close} title="搜索任务" headless>
          <div
            className="global-search"
            ref={panelRef}
            onKeyDown={(event) => {
              // Tab 陷阱（ConfirmDialog 同款）：aria-modal 说了模态，Tab 就得留在里面。
              if (event.key === 'Tab') {
                const focusables = panelRef.current?.querySelectorAll<HTMLElement>(
                  'button, input, [href], [tabindex]:not([tabindex="-1"])',
                )
                if (focusables === undefined || focusables.length === 0) return
                const first = focusables[0]!
                const last = focusables[focusables.length - 1]!
                if (event.shiftKey && document.activeElement === first) {
                  event.preventDefault()
                  last.focus()
                } else if (!event.shiftKey && document.activeElement === last) {
                  event.preventDefault()
                  first.focus()
                }
                return
              }
              if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
                event.preventDefault()
                setActive((current) => {
                  if (results.length === 0) return 0
                  const delta = event.key === 'ArrowDown' ? 1 : -1
                  return (current + delta + results.length) % results.length
                })
                return
              }
              if (event.key === 'Enter') {
                event.preventDefault()
                const hit = results[active]
                if (hit !== undefined) go(hit.id)
              }
            }}
          >
            <input
              ref={inputRef}
              type="text"
              aria-label="搜索任务"
              placeholder="按标题搜索任务…"
              value={q}
              autoFocus
              onChange={(event) => setQ(event.target.value)}
            />
            {trimmed === '' ? (
              <p className="global-search-hint">输入关键词搜索任务标题。</p>
            ) : query.isPending ? (
              <p className="global-search-hint">搜索中…</p>
            ) : query.isError ? (
              <p className="global-search-hint" role="alert">
                搜索失败，请稍后重试。
              </p>
            ) : results.length === 0 ? (
              <p className="global-search-hint">没有匹配的任务。</p>
            ) : (
              <ul role="listbox" aria-label="搜索结果">
                {results.map((task, index) => (
                  <li key={task.id}>
                    <button
                      type="button"
                      role="option"
                      aria-selected={index === active}
                      className={`global-search-item${index === active ? ' active' : ''}`}
                      onMouseEnter={() => setActive(index)}
                      onClick={() => go(task.id)}
                    >
                      <span className="global-search-title">{task.title}</span>
                      <span className="global-search-meta">
                        {TASK_STATUS_LABEL[task.status]} · {task.projectName ?? '未知项目'} ·{' '}
                        <RelativeTime iso={task.lastActiveAt} />
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </Modal>
      ) : null}
    </>
  )
}
