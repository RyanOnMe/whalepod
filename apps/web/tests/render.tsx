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

export function renderApp(initialPath: string, handlers: readonly MockHandler[]): TestAppResult {
  const fetchMock = installFetch(handlers)
  const queryClient = makeQueryClient({ retry: false })
  const router = createTestRouter(queryClient, [initialPath])
  const view = render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  )
  return { ...view, queryClient, fetchMock }
}

/** 直接挂载一个组件（不需要 router/session 的局部用例）。 */
export function renderUi(element: ReactElement): RenderResult {
  return render(element)
}
