/**
 * ⌘K 全局搜索（#254 起；#263 扩到三类实体；#243 第 5 条刀二 + P1-UX 三期刀三）。
 *
 * 「那个叫什么来着」的解法：任意已登录页 ⌘K/Ctrl+K 呼出（侧栏「搜索」钮是鼠标路径
 * ——快捷键不是唯一入口），一条输入搜三类实体：
 *   - **任务**：服务端 `GET /tasks/search?q=`（标题 ILIKE，≤8 条）；
 *   - **项目 / Agent**：客户端过滤**已有缓存列表**（`queryKeys.projects`/`queryKeys.agents`，
 *     浮层打开时才取）——团队规模下这两组是个位数量级，为它们新建搜索端点是把简单
 *     问题复杂化，也是两份要养的 ILIKE/索引。
 * Enter/点击直达：任务 → 任务房；项目 → 项目页 + hash 锚点高亮（`/#project-<id>`）；
 * Agent → Agents 页 + 锚点（`/agents#agent-<id>`，见 shared/useHashFocus.ts）。
 * dialog 语义照 ConfirmDialog/RunConsole 的口径（S2/S3/S4）：Esc 关闭、还焦触发元素、
 * Tab 留在框内。对照 ChatGPT 的 ⌘K：一处输入、纯键盘可走（上下选、Enter 进）。
 */
import { useQuery } from '@tanstack/react-query'
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { useNavigate } from 'react-router'
import { Modal } from '../vendor/dsh-ui/index.js'
import { api } from '../shared/api/client.js'
import { TASK_STATUS_LABEL } from '../shared/format.js'
import { RelativeTime } from '../shared/RelativeTime.js'
import { queryKeys } from './query-client.js'
import type { AgentView, ProjectView, RecentTaskView } from '../shared/api/types.js'

/** 任务结果上限与服务端一致（UI 侧再截一次，防御未来服务端放宽）。 */
const TASK_LIMIT = 8
/** 本地过滤（项目/Agent）每段上限：搜索浮层给的是「找到那个」，不是完整清单。 */
const LOCAL_LIMIT = 5
const DEBOUNCE_MS = 300

interface SearchHit {
  key: string
  label: string
  meta: ReactNode
  go: () => void
}

/** 子串匹配、大小写不敏感（不做模糊匹配：可预测比"聪明"重要）。 */
function filterByName<T extends { name: string }>(
  items: readonly T[],
  needle: string,
  limit: number,
): T[] {
  const lower = needle.toLowerCase()
  return items.filter((item) => item.name.toLowerCase().includes(lower)).slice(0, limit)
}

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
      // ⌘K 默认是浏览器的地址栏搜索——搜索是我们的领域动作，接管之
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
  const taskQuery = useQuery({
    queryKey: queryKeys.taskSearch(trimmed),
    queryFn: () => api.get<RecentTaskView[]>(`/tasks/search?q=${encodeURIComponent(trimmed)}`),
    enabled: open && trimmed !== '',
  })
  // #263：项目/Agent 走本地过滤——列表与各页面共用同一 queryKey（缓存复用，不重复请求）。
  const projectsQuery = useQuery({
    queryKey: queryKeys.projects,
    queryFn: () => api.get<ProjectView[]>('/projects'),
    enabled: open,
  })
  const agentsQuery = useQuery({
    queryKey: queryKeys.agents,
    queryFn: () => api.get<AgentView[]>('/agents'),
    enabled: open,
  })

  const close = (): void => {
    setOpen(false)
    setQ('')
    setDebouncedQ('')
    triggerRef.current?.focus()
  }

  /** 选中一条：先关（还焦触发元素）再导航——导航换页后还焦无感。 */
  const go = (path: string): void => {
    close()
    navigate(path)
  }

  const taskHits: SearchHit[] = (taskQuery.data ?? []).slice(0, TASK_LIMIT).map((task) => ({
    key: `task-${task.id}`,
    label: task.title,
    meta: (
      <>
        {TASK_STATUS_LABEL[task.status]} · {task.projectName ?? '未知项目'} ·{' '}
        <RelativeTime iso={task.lastActiveAt} />
      </>
    ),
    go: () => go(`/tasks/${task.id}`),
  }))
  const projectHits: SearchHit[] = filterByName(projectsQuery.data ?? [], trimmed, LOCAL_LIMIT).map(
    (project) => ({
      key: `project-${project.id}`,
      label: project.name,
      meta: (
        <>
          {project.archivedAt === null ? null : '已归档 · '}
          创建于 <RelativeTime iso={project.createdAt} />
        </>
      ),
      go: () => go(`/#project-${project.id}`),
    }),
  )
  const agentHits: SearchHit[] = filterByName(agentsQuery.data ?? [], trimmed, LOCAL_LIMIT).map(
    (agent) => ({
      key: `agent-${agent.id}`,
      label: agent.name,
      meta:
        agent.archivedAt === null
          ? agent.description || null
          : `已归档${agent.description === '' ? '' : ` · ${agent.description}`}`,
      go: () => go(`/agents#agent-${agent.id}`),
    }),
  )
  const sections: { label: string; hits: SearchHit[] }[] = [
    { label: '任务', hits: taskHits },
    { label: '项目', hits: projectHits },
    { label: 'Agent', hits: agentHits },
  ].filter((section) => section.hits.length > 0)
  /** 扁平结果序列（段头不是可选项）：↑↓ 跨段连续，Enter 落到当前项。 */
  const hits: SearchHit[] = sections.flatMap((section) => section.hits)
  const localPending = projectsQuery.isPending || agentsQuery.isPending
  const localError = projectsQuery.isError || agentsQuery.isError

  let body: ReactNode
  if (trimmed === '') {
    body = <p className="global-search-hint">输入关键词搜索任务、项目或 Agent。</p>
  } else if (taskQuery.isPending || localPending) {
    body = <p className="global-search-hint">搜索中…</p>
  } else if (taskQuery.isError) {
    body = (
      <p className="global-search-hint" role="alert">
        搜索失败，请稍后重试。
      </p>
    )
  } else if (hits.length === 0) {
    body = (
      <p className="global-search-hint">
        没有匹配的任务、项目或 Agent
        {/* 本地列表没读到就不能替它说「没有」——如实标出这一段的缺口。 */}
        {localError ? '（项目/Agent 列表读取失败）' : ''}。
      </p>
    )
  } else {
    let flatIndex = 0
    body = (
      <ul role="listbox" aria-label="搜索结果">
        {sections.map((section) => (
          <li key={section.label} role="presentation">
            <p className="global-search-section">{section.label}</p>
            <ul role="presentation">
              {section.hits.map((hit) => {
                const index = flatIndex
                flatIndex += 1
                return (
                  <li key={hit.key} role="presentation">
                    <button
                      type="button"
                      role="option"
                      aria-selected={index === active}
                      className={`global-search-item${index === active ? ' active' : ''}`}
                      onMouseEnter={() => setActive(index)}
                      onClick={() => hit.go()}
                    >
                      <span className="global-search-title">{hit.label}</span>
                      {hit.meta === null ? null : (
                        <span className="global-search-meta">{hit.meta}</span>
                      )}
                    </button>
                  </li>
                )
              })}
            </ul>
          </li>
        ))}
      </ul>
    )
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
        <Modal open onClose={close} title="全局搜索" headless>
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
                  if (hits.length === 0) return 0
                  const delta = event.key === 'ArrowDown' ? 1 : -1
                  return (current + delta + hits.length) % hits.length
                })
                return
              }
              if (event.key === 'Enter') {
                event.preventDefault()
                hits[active]?.go()
              }
            }}
          >
            <input
              ref={inputRef}
              type="text"
              aria-label="搜索关键词"
              placeholder="搜索任务、项目或 Agent…"
              value={q}
              autoFocus
              onChange={(event) => setQ(event.target.value)}
            />
            {body}
          </div>
        </Modal>
      ) : null}
    </>
  )
}
