/**
 * 测试渲染助手：真实 router（createMemoryRouter 同一份 routes）+ 真实 QueryClient，
 * 仅替换全局 fetch。02 Task 7 Step 1：从用户视角驱动（role/label/text 断言）。
 * fetchMock 一并返回，供断言请求头（Idempotency-Key）与请求数。
 */
import type { RenderResult } from '@testing-library/react'
import { render } from '@testing-library/react'
import { QueryClientProvider } from '@tanstack/react-query'
import type { ReactElement } from 'react'
import { RouterProvider } from 'react-router'
import { makeQueryClient } from '../src/app/query-client.js'
import { createTestRouter } from '../src/app/router.js'
import { installFetch } from './fixtures.js'
import type { MockHandler } from './fixtures.js'

export interface TestAppResult extends RenderResult {
  queryClient: ReturnType<typeof makeQueryClient>
  fetchMock: ReturnType<typeof installFetch>
}

export interface RenderAppOptions {
  /**
   * 任务页初始视图（#548）。
   *
   * 生产默认是普通链接进入「发给团队」；既有执行侧用例判的是执行区，
   * 默认从显式 `#task-execution` 锚点进入（审批/交接/旧执行卡片在真实页面
   * 也走这个锚点）。断言普通链接默认视图的用例显式传 `'team'`。
   */
  taskView?: 'team' | 'assistant'
}

function resolveTaskRoomPath(initialPath: string, options: RenderAppOptions): string {
  if (options.taskView !== 'assistant') return initialPath
  // 只处理裸任务链接：带 hash 的深链保持原样。
  return /^\/tasks\/[^/?#]+$/.test(initialPath) ? `${initialPath}#task-execution` : initialPath
}

export function renderApp(
  initialPath: string,
  handlers: readonly MockHandler[],
  options: RenderAppOptions = { taskView: 'assistant' },
): TestAppResult & { router: ReturnType<typeof createTestRouter> } {
  const fetchMock = installFetch(handlers)
  const queryClient = makeQueryClient({ retry: false })
  const router = createTestRouter(queryClient, [resolveTaskRoomPath(initialPath, options)])
  const view = render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  )
  return { ...view, router, queryClient, fetchMock }
}

/** 直接挂载一个组件（不需要 router/session 的局部用例）。 */
export function renderUi(element: ReactElement): RenderResult {
  return render(element)
}
