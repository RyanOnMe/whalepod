/**
 * 路由与根 loader 流程（02 Task 7 Step 3）。
 *
 * Root loader：先 GET /api/v1/setup/status，未初始化 → /setup；已初始化再
 * GET /api/v1/auth/session，未登录 → /login；已登录进入 App 布局。
 * 重定向只指向站内固定 path（/setup、/login、/），不接受服务器下发或查询串
 * 携带的跳转目标，拒绝外部 URL。
 *
 * 路由用 react-router 8 的 data mode：loader 在渲染前完成引导，组件内
 * useLoaderData 取 session。测试用 createMemoryRouter 走同一份 routes。
 */
import type { QueryClient } from '@tanstack/react-query'
import type { ReactNode } from 'react'
import {
  createBrowserRouter,
  createMemoryRouter,
  isRouteErrorResponse,
  redirect,
  useLoaderData,
  useRouteError,
} from 'react-router'
import type { RouteObject } from 'react-router'
import { api } from '../shared/api/client.js'
import { isApiError, isSessionError } from '../shared/api/errors.js'
import type { Session, SetupStatus } from '../shared/api/types.js'
import { queryKeys } from './query-client.js'
import { AppShell } from './session.js'
import { DevicesPage } from '../routes/DevicesPage.js'
import { InvitePage } from '../routes/InvitePage.js'
import { LoginPage } from '../routes/LoginPage.js'
import { MembersPage } from '../routes/MembersPage.js'
import { ProjectsPage } from '../routes/ProjectsPage.js'
import { SetupPage } from '../routes/SetupPage.js'
import { TaskRoomPage } from '../routes/TaskRoomPage.js'
import { AgentsPage } from '../routes/AgentsPage.js'
import { PluginsPage } from '../routes/PluginsPage.js'

function RootErrorPage(): ReactNode {
  const error = useRouteError()
  const message = isRouteErrorResponse(error)
    ? `${error.status} ${error.statusText}`
    : error instanceof Error
      ? error.message
      : String(error)
  return (
    <div className="card error-state" role="alert">
      <h1>页面加载失败</h1>
      <p>{message}</p>
      <button type="button" className="button" onClick={() => window.location.reload()}>
        重新加载
      </button>
    </div>
  )
}

/** 已登录子路由的统一引导 loader（由 createAppRoutes 注入 QueryClient）。 */
function makeRootLoader(queryClient: QueryClient) {
  return async (): Promise<{ session: Session } | Response> => {
    const setupStatus = await queryClient.fetchQuery({
      queryKey: queryKeys.setupStatus,
      queryFn: () => api.get<SetupStatus>('/setup/status'),
      staleTime: Infinity,
    })
    if (!setupStatus.initialized) return redirect('/setup')
    try {
      const session = await queryClient.fetchQuery({
        queryKey: queryKeys.session,
        queryFn: () => api.get<Session>('/auth/session'),
        staleTime: 60_000,
      })
      // 防御：缓存里可能残留 null/undefined（正常路径不会发生），视为未登录。
      if (session === null || session === undefined) return redirect('/login')
      return { session }
    } catch (error) {
      // 401/会话过期 → 登录页；其他错误（断网等）抛给 errorElement。
      if (isSessionError(error)) {
        return redirect('/login')
      }
      throw error
    }
  }
}

function makeSetupLoader(queryClient: QueryClient) {
  return async (): Promise<null | Response> => {
    const setupStatus = await queryClient.fetchQuery({
      queryKey: queryKeys.setupStatus,
      queryFn: () => api.get<SetupStatus>('/setup/status'),
      staleTime: Infinity,
    })
    return setupStatus.initialized ? redirect('/login') : null
  }
}

function makeLoginLoader(queryClient: QueryClient) {
  return async (): Promise<null | Response> => {
    try {
      await queryClient.fetchQuery({
        queryKey: queryKeys.session,
        queryFn: () => api.get<Session>('/auth/session'),
        staleTime: 60_000,
      })
      return redirect('/')
    } catch (error) {
      if (isSessionError(error)) return null
      throw error
    }
  }
}

/**
 * #141 接受页的引导 loader：/setup/status + /auth/session。
 *
 * 与 root loader 的**唯一**差别：未登录**不跳** /login——被邀请人打开链接时
 * 还没有账号，跳走会丢掉 URL 里的 Token（登录页不接受外部跳转目标，这是既定的
 * 防开放重定向纪律）。未登录时把 session=null 交给页面，由页面在原 URL 上引导登录。
 *
 * 预检失败（404/409）不在 loader 抛错：页面要按「不存在 / 已过期 / 已被使用」
 * 给人话，抛给 errorElement 只会显示裸错误码。
 */
function makeInviteLoader(queryClient: QueryClient) {
  return async (): Promise<{ session: Session | null; initialized: boolean }> => {
    const setupStatus = await queryClient.fetchQuery({
      queryKey: queryKeys.setupStatus,
      queryFn: () => api.get<SetupStatus>('/setup/status'),
      staleTime: Infinity,
    })
    if (!setupStatus.initialized) return { session: null, initialized: false }
    try {
      const session = await queryClient.fetchQuery({
        queryKey: queryKeys.session,
        queryFn: () => api.get<Session>('/auth/session'),
        staleTime: 60_000,
      })
      return { session: session ?? null, initialized: true }
    } catch (error) {
      if (isSessionError(error)) return { session: null, initialized: true }
      throw error
    }
  }
}

/** 完整路由表；测试与生产共用，保证 loader 行为一致。 */
export function createAppRoutes(queryClient: QueryClient): RouteObject[] {
  return [
    { path: '/setup', loader: makeSetupLoader(queryClient), element: <SetupPage /> },
    { path: '/login', loader: makeLoginLoader(queryClient), element: <LoginPage /> },
    {
      path: '/invites/:token',
      loader: makeInviteLoader(queryClient),
      element: <InviteRoute />,
    },
    {
      path: '/',
      loader: makeRootLoader(queryClient),
      element: <AppShell />,
      errorElement: <RootErrorPage />,
      children: [
        { index: true, element: <ProjectsPage /> },
        { path: 'tasks/:taskId', element: <TaskRoomPage /> },
        { path: 'agents', element: <AgentsPage /> },
        { path: 'plugins', element: <PluginsPage /> },
        { path: 'devices', element: <DevicesPage /> },
        { path: 'members', element: <MembersPage /> },
      ],
    },
  ]
}

/** 把 loader 结果喂给接受页（页面按 session 决定「登录后加入」还是「一键加入」）。 */
function InviteRoute(): ReactNode {
  const { session, initialized } = useLoaderData() as {
    session: Session | null
    initialized: boolean
  }
  return <InvitePage session={session} initialized={initialized} />
}

export function createAppRouter(queryClient: QueryClient) {
  return createBrowserRouter(createAppRoutes(queryClient))
}

export function createTestRouter(queryClient: QueryClient, initialEntries: string[]) {
  return createMemoryRouter(createAppRoutes(queryClient), { initialEntries })
}
