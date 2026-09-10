/**
 * App 布局与会话上下文（02 Task 7 Step 3 之后的主布局）。
 *
 * 根 loader（app/router.tsx）成功返回 `{ session }` 后才会渲染本组件，
 * 因此 useLoaderData 里的 session 一定存在；子组件经 useSession() 读取。
 * 退出登录：撤销会话后回 /login（root loader 的 session 查询会再次 401 并重定向，
 * 这里直接导航更即时）。
 * #152：页头身份行的角色走 ROLE_LABEL（此前直接印 `owner` 这个内部枚举值）。
 */
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { createContext, useContext, useEffect, useRef, type ReactNode } from 'react'
import { Link, Outlet, useLoaderData, useLocation, useNavigate } from 'react-router'
import { api } from '../shared/api/client.js'
import { isApiError } from '../shared/api/errors.js'
import { ROLE_LABEL } from '../shared/format.js'
import type { Session } from '../shared/api/types.js'
import { queryKeys } from './query-client.js'
import { FlashBanner } from './FlashBanner.js'
import { RealtimeBridge } from './realtime.js'

const SessionContext = createContext<Session | null>(null)

/** 已登录会话；仅在 root loader 之后的子树里非空。 */
export function useSession(): Session | null {
  return useContext(SessionContext)
}

export function AppShell(): ReactNode {
  const { session } = useLoaderData() as { session: Session }
  const queryClient = useQueryClient()
  const navigate = useNavigate()
  const location = useLocation()
  const navMenu = useRef<HTMLDetailsElement>(null)
  /**
   * #152：窄屏的导航面板是绝对定位浮层（盖在内容之上），换页必须收起。
   *
   * 不收起的话：390px 下点「设备」落地后面板仍开着，覆盖 y=64..284 且背景不透明，
   * 首屏主体按钮被它挡住——`elementFromPoint` 命中的是 `nav.app-nav` 而不是按钮，
   * Playwright click 直接超时（真人读数就是「点了没反应」）。
   *
   * 用 ref 直接关而不是受控 `open`：`<details>` 的原生 toggle 不经过 React，受控写法
   * 还得回接 `onToggle` 同步状态，否则用户原生展开后 React 状态仍是 false，换页时
   * 「setState(false) 无变化」不会重写 DOM，面板照样开着。这里只需在换页时关掉，
   * 也不必重挂载（`key` 换 key 会让导航链接重建、键盘焦点掉回 body）。
   */
  useEffect(() => {
    if (navMenu.current !== null) navMenu.current.open = false
  }, [location.pathname])
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

  return (
    <SessionContext.Provider value={session}>
      {/* 登录会话存活期持有 Browser WS：持久事件→query 失效，live→run 缓冲（P1-13）。 */}
      <RealtimeBridge />
      <div className="app-shell">
        {/*
          #152：顶栏恒为单行（390px 下也不折行）——品牌 + 折叠导航入口 + 用户信息。
          <details>/<summary> 是原生折叠：无 JS、Tab 可达、Enter/Space 开关；窄屏由
          CSS 用绝对定位面板下拉（顶栏高度不随展开变化），宽屏（≥760px）隐藏 summary
          并让面板常显（::details-content 放开 content-visibility），始终只有这一份链接。
        */}
        <header className="app-header">
          <Link to="/" className="app-brand">
            WhalePod
          </Link>
          <details className="app-nav-menu" ref={navMenu}>
            <summary className="app-nav-toggle" aria-label="主导航菜单">
              菜单
            </summary>
            <nav className="app-nav" aria-label="主导航">
              <Link to="/">项目</Link>
              <Link to="/members">成员</Link>
              <Link to="/agents">Agents</Link>
              <Link to="/plugins">插件</Link>
              <Link to="/devices">设备</Link>
            </nav>
          </details>
          <div className="app-header-user">
            {/* 布局取 main（省略号 + title 承载全名），文案取术语切片（角色走中文标签表，
                不上屏 owner/admin 这类内部枚举）。两边改动落在同一处，故合并保留二者。 */}
            <span
              className="app-header-user-name"
              title={`${session.displayName}（${ROLE_LABEL[session.role]}）`}
            >
              {session.displayName}（{ROLE_LABEL[session.role]}）
            </span>
            <button
              type="button"
              className="button button-quiet"
              disabled={logout.isPending}
              onClick={() => logout.mutate()}
            >
              {logout.isPending ? '退出中…' : '退出登录'}
            </button>
          </div>
        </header>
        {logoutError !== null ? (
          <div className="app-logout-error" role="alert">
            退出失败：{logoutError}
          </div>
        ) : null}
        <FlashBanner />
        <main className="app-main">
          <Outlet />
        </main>
      </div>
    </SessionContext.Provider>
  )
}
