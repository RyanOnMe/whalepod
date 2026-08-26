/**
 * App 布局与会话上下文（02 Task 7 Step 3 之后的主布局）。
 *
 * 根 loader（app/router.tsx）成功返回 `{ session }` 后才会渲染本组件，
 * 因此 useLoaderData 里的 session 一定存在；子组件经 useSession() 读取。
 * 退出登录：撤销会话后回 /login（root loader 的 session 查询会再次 401 并重定向，
 * 这里直接导航更即时）。
 */
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { createContext, useContext, type ReactNode } from 'react'
import { Link, Outlet, useLoaderData, useNavigate } from 'react-router'
import { api } from '../shared/api/client.js'
import { isApiError } from '../shared/api/errors.js'
import type { Session } from '../shared/api/types.js'
import { queryKeys } from './query-client.js'

const SessionContext = createContext<Session | null>(null)

/** 已登录会话；仅在 root loader 之后的子树里非空。 */
export function useSession(): Session | null {
  return useContext(SessionContext)
}

export function AppShell(): ReactNode {
  const { session } = useLoaderData() as { session: Session }
  const queryClient = useQueryClient()
  const navigate = useNavigate()
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
      <div className="app-shell">
        <header className="app-header">
          <Link to="/" className="app-brand">
            project311
          </Link>
          <nav className="app-nav" aria-label="主导航">
            <Link to="/">项目</Link>
            <Link to="/agents">Agents</Link>
            <Link to="/devices">设备</Link>
          </nav>
          <div className="app-header-user">
            <span>
              {session.displayName}（{session.role}）
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
        <main className="app-main">
          <Outlet />
        </main>
      </div>
    </SessionContext.Provider>
  )
}
