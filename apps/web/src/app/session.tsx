/**
 * App 布局与会话上下文（02 Task 7 Step 3 之后的主布局）。
 *
 * 根 loader（app/router.tsx）成功返回 `{ session }` 后才会渲染本组件，
 * 因此 useLoaderData 里的 session 一定存在；子组件经 useSession() 读取。
 * 退出登录：撤销会话后回 /login（root loader 的 session 查询会再次 401 并重定向，
 * 这里直接导航更即时）。
 * #152：页头身份行的角色走 ROLE_LABEL（此前直接印 `owner` 这个内部枚举值）。
 * #173：壳迁移到真实 DSH Web 形态——宽屏（≥1024px）左侧栏（品牌 / 胶囊导航 /
 * 用户卡置底），窄屏回落顶栏 + 折叠菜单；导航链接从 Link 换成 NavLink，
 * aria-current="page" 由路由真实给出（此前 CSS 里那条 [aria-current] 从未命中过）。
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from 'react'
import { Link, NavLink, Outlet, useLoaderData, useLocation, useNavigate } from 'react-router'
import { api } from '../shared/api/client.js'
import { isApiError } from '../shared/api/errors.js'
import { ROLE_LABEL, TASK_STATUS_LABEL } from '../shared/format.js'
import { RelativeTime } from '../shared/RelativeTime.js'
import { setFlash } from '../shared/flash.js'
import { subscribeSessionExpired } from '../shared/session-expiry.js'
import type { RecentTaskView, Session } from '../shared/api/types.js'
import { queryKeys } from './query-client.js'
import { ConnectionBanner } from './ConnectionBanner.js'
import { FlashBanner } from './FlashBanner.js'
import { ToastHost } from './toast.js'
import { RealtimeBridge } from './realtime.js'
import { GlobalSearch } from './GlobalSearch.js'
import { NotificationBell, RunNotifications } from './RunNotifications.js'
import { ShortcutHelp } from './ShortcutHelp.js'

const SessionContext = createContext<Session | null>(null)

/** 已登录会话；仅在 root loader 之后的子树里非空。 */
export function useSession(): Session | null {
  return useContext(SessionContext)
}

/** 导航项只有这一份清单：侧栏（宽屏）与折叠面板（窄屏）共用，但同一时刻只渲染一处。 */
const NAV_ITEMS = [
  { to: '/', label: '项目', end: true },
  { to: '/members', label: '成员', end: false },
  { to: '/agents', label: 'Agents', end: false },
  { to: '/plugins', label: '插件', end: false },
  { to: '/devices', label: '设备', end: false },
] as const

/** 上游布局约定（dsh-client-ui-layout 的 SIDEBAR_AUTO_COLLAPSE）：1024px 是侧栏收放断点。 */
const WIDE_QUERY = '(min-width: 1024px)'

/**
 * #252 侧栏「最近任务」：按「最近活动」排序的直达入口——登录后 ≤1 击回到现场。
 * 错误**不遮挡主导航**（小字 + 重试）；空态如实说没有。窄屏顶栏不渲染（空间受限）。
 */
function RecentTasksNav(): ReactNode {
  const query = useQuery({
    queryKey: queryKeys.recentTasks,
    queryFn: () => api.get<RecentTaskView[]>('/tasks/recent'),
    staleTime: 60_000,
  })
  let body: ReactNode
  if (query.isError) {
    body = (
      <p className="sidebar-recent-error" role="status">
        最近任务读取失败。
        <button type="button" className="link-button" onClick={() => void query.refetch()}>
          重试
        </button>
      </p>
    )
  } else if (query.isPending) {
    // 加载中不占视觉重量（首屏主导航先出，最近任务迟到半拍没关系）。
    body = null
  } else if (query.data.length === 0) {
    body = <p className="sidebar-recent-empty">最近还没有任务</p>
  } else {
    body = (
      <ul role="list">
        {query.data.slice(0, 6).map((task) => (
          <li key={task.id}>
            <Link to={`/tasks/${task.id}`} className="sidebar-recent-link">
              <span className="sidebar-recent-title">{task.title}</span>
              <span className="sidebar-recent-meta">
                {TASK_STATUS_LABEL[task.status]} · {task.projectName ?? '未知项目'} ·{' '}
                <RelativeTime iso={task.lastActiveAt} />
              </span>
            </Link>
          </li>
        ))}
      </ul>
    )
  }
  return (
    <nav className="app-sidebar-recent" aria-label="最近任务">
      {/* 小节标签不是标题元素（ChatGPT 侧栏同款处理）：不进文档大纲，也不会把
          各页「只有一个 h2」的层级判据打红。导航的可达名由 nav 的 aria-label 提供。 */}
      <p className="app-sidebar-heading">最近任务</p>
      {body}
    </nav>
  )
}

/**
 * 宽屏（侧栏 chrome）↔ 窄屏（顶栏 + 折叠菜单）的**互斥渲染**开关。
 *
 * 为什么是 matchMedia 而不是「两份都渲染、CSS 藏一份」：两份并存时导航地标与
 * 「退出登录」在 DOM 里成双（无障碍树出现两个同名导航/按钮；jsdom 不吃外部
 * 样式表，单测的 getByRole 直接抓到两个）。互斥渲染后 DOM 里永远只有一套 chrome。
 * jsdom 没有 matchMedia —— 回落到宽屏档（单测看到的就是桌面侧栏形态）；
 * 窄屏形态由 390px 的 Q5 覆盖（pairing-ui.spec.ts 的折叠菜单用例）。
 */
function useWideLayout(): boolean {
  const [wide, setWide] = useState<boolean>(
    // jsdom 没有 matchMedia：回落**宽屏**（桌面侧栏是单测默认看到的形态）。
    () => typeof window.matchMedia !== 'function' || window.matchMedia(WIDE_QUERY).matches,
  )
  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return
    const mql = window.matchMedia(WIDE_QUERY)
    const onChange = (event: MediaQueryListEvent) => setWide(event.matches)
    mql.addEventListener('change', onChange)
    return () => mql.removeEventListener('change', onChange)
  }, [])
  return wide
}

export function AppShell(): ReactNode {
  const { session } = useLoaderData() as { session: Session }
  const queryClient = useQueryClient()
  const navigate = useNavigate()
  const location = useLocation()
  const navMenu = useRef<HTMLDetailsElement>(null)
  const wide = useWideLayout()
  /**
   * #152：窄屏的导航面板是绝对定位浮层（盖在内容之上），换页必须收起。
   *
   * 不收起的话：390px 下点「设备」落地后面板仍开着，覆盖首屏主体按钮——
   * `elementFromPoint` 命中的是浮层而不是按钮，Playwright click 直接超时
   * （真人读数就是「点了没反应」）。
   *
   * 用 ref 直接关而不是受控 `open`：`<details>` 的原生 toggle 不经过 React，受控写法
   * 还得回接 `onToggle` 同步状态，否则用户原生展开后 React 状态仍是 false，换页时
   * 「setState(false) 无变化」不会重写 DOM，面板照样开着。这里只需在换页时关掉，
   * 也不必重挂载（`key` 换 key 会让导航链接重建、键盘焦点掉回 body）。
   */
  useEffect(() => {
    if (navMenu.current !== null) navMenu.current.open = false
  }, [location.pathname])

  /**
   * #229：窄屏导航面板打开时 Esc 收起并还焦菜单钮——面板是绝对定位浮层，
   * 此前只能换页或再点一次才收（键盘用户被浮层困住）。
   */
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return
      const details = navMenu.current
      if (details === null || !details.open) return
      details.open = false
      details.querySelector('summary')?.focus()
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [])
  /**
   * #227：页面内 query/mutation 的会话类失败 → 自动跳登录（带 from 回跳）。
   * 此前只在 ErrorBanner 里给「重新登录」链接，用户停在原页反复撞同一堵墙。
   */
  useEffect(() => {
    /**
     * #227：页面内 query/mutation 的会话类失败 → 自动跳登录（带 from 回跳）。
     * 此前只在 ErrorBanner 里给「重新登录」链接，用户停在原页反复撞同一堵墙。
     *
     * 跳转前先退订：loader 的 fetchQuery 失败同样会触发 cache onError——若订阅
     * 还活着，login loader 的 401 会再发一次事件 → 再 navigate → loader 再跑
     * 的死循环（loader revalidation 期间旧 UI 仍挂载，退订时机必须先于 navigate）。
     */
    const unsubscribe = subscribeSessionExpired(() => {
      unsubscribe()
      // 会话缓存一并清掉：login loader 会重新探测会话，stale 的缓存会让它
      // 误判「已登录」弹回首页（logout 流同款处理）。
      queryClient.removeQueries({ queryKey: queryKeys.session })
      setFlash('登录已过期，请重新登录')
      const from = encodeURIComponent(location.pathname + location.search)
      navigate(`/login?from=${from}`, { replace: true })
    })
    return unsubscribe
  }, [navigate, location, queryClient])
  const logout = useMutation({
    mutationFn: () => api.mutate<Record<string, never>>('/auth/logout', { body: {} }),
    onSuccess: () => {
      // 移除（而非写入 null）会话缓存：/login 的 loader 会重新请求并得到 401，
      // 不会被 stale 的缓存数据误判为已登录。
      queryClient.removeQueries({ queryKey: queryKeys.session })
      navigate('/login', { replace: true })
    },
  })
  const logoutError =
    logout.isError && isApiError(logout.error)
      ? `${logout.error.message}（${logout.error.requestId}）`
      : null
  const logoutLabel = logout.isPending ? '退出中…' : '退出登录'
  const userTitle = `${session.displayName}（${ROLE_LABEL[session.role]}）`

  return (
    <SessionContext.Provider value={session}>
      {/* 登录会话存活期持有 Browser WS：持久事件→query 失效，live→run 缓冲（P1-13）。 */}
      <RealtimeBridge />
      {/* #259：tab 标题徽标 + 进任务房间即已读（无头；窄屏没有侧栏也要有徽标）。 */}
      <RunNotifications />
      {/* #265：`?` 开快捷键速查（无头；说明书只列已实现的键）。 */}
      <ShortcutHelp />
      {/*
        #173 壳结构：灰平台（body 底）上放一张白色应用卡（.app-frame，圆角 20 + 软投影），
        卡里左侧栏（品牌 / 胶囊导航 / 用户卡置底）+ 右内容列；窄屏（<1024px）应用卡
        全幅直角，侧栏换成顶栏 + 折叠菜单。侧栏与顶栏由 useWideLayout **互斥渲染**
        （DOM 里同一时刻只有一套 chrome），断点判定见该 hook 的注释。
      */}
      <div className="app-shell">
        <div className="app-frame">
          {wide ? (
            <aside className="app-sidebar">
              <div className="app-brand-row">
                <Link to="/" className="app-brand">
                  WhalePod
                </Link>
              </div>
              {/* #254：搜索入口（鼠标路径；⌘K 是键盘路径，都在 GlobalSearch 里）。 */}
              <GlobalSearch />
              {/* #259：完成提醒开关（宽屏侧栏；权限只在点击时请求）。 */}
              <NotificationBell />
              <nav className="app-nav" aria-label="主导航">
                {NAV_ITEMS.map((item) => (
                  <NavLink key={item.to} to={item.to} end={item.end}>
                    {item.label}
                  </NavLink>
                ))}
              </nav>
              <RecentTasksNav />
              <div className="app-sidebar-user">
                <span className="app-sidebar-user-name" title={userTitle}>
                  {session.displayName}
                </span>
                <span className="app-sidebar-user-role">{ROLE_LABEL[session.role]}</span>
                <button
                  type="button"
                  className="button button-quiet app-sidebar-logout"
                  disabled={logout.isPending}
                  onClick={() => logout.mutate()}
                >
                  {logoutLabel}
                </button>
              </div>
            </aside>
          ) : null}
          <div className="app-body">
            {wide ? null : (
              <header className="app-topbar">
                <details className="app-nav-menu" ref={navMenu}>
                  <summary className="app-nav-toggle" aria-label="主导航菜单">
                    菜单
                  </summary>
                  <nav className="app-nav app-nav-overlay" aria-label="主导航">
                    {NAV_ITEMS.map((item) => (
                      <NavLink key={item.to} to={item.to} end={item.end}>
                        {item.label}
                      </NavLink>
                    ))}
                  </nav>
                </details>
                <Link to="/" className="app-brand">
                  WhalePod
                </Link>
                <div className="app-topbar-user">
                  <span className="app-topbar-user-name" title={userTitle}>
                    {session.displayName}
                  </span>
                  <button
                    type="button"
                    className="button button-quiet"
                    disabled={logout.isPending}
                    onClick={() => logout.mutate()}
                  >
                    {logoutLabel}
                  </button>
                </div>
              </header>
            )}
            {logoutError !== null ? (
              <div className="app-logout-error" role="alert">
                退出失败：{logoutError}
              </div>
            ) : null}
            <FlashBanner />
            {/* #229：短暂成败反馈（plugin/artifact 等就地动作）。 */}
            <ToastHost />
            {/* #227：断线重连中的可见横幅（在线与首次连接保持安静）。 */}
            <ConnectionBanner />
            <main className="app-main">
              <Outlet />
            </main>
          </div>
        </div>
      </div>
    </SessionContext.Provider>
  )
}
