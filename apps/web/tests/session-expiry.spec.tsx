/**
 * #227 批次②：session 过期自动跳转。
 *
 * 页面内（非导航）query/mutation 返回 AUTH_REQUIRED/SESSION_EXPIRED 时，
 * QueryCache/MutationCache 的 onError 发事件，AppShell 订阅后带 from 跳 /login，
 * 登录页显示一次性提示并支持登录成功回跳原路径（防开放重定向：只认站内路径）。
 */
import { screen, waitFor } from '@testing-library/react'
import { userEvent } from '@testing-library/user-event'
import { describe, expect, it } from 'vitest'
import { BOB, makeTask, ok, sessionSwitchHandler, setupStatusHandler } from './fixtures.js'
import type { MockHandler } from './fixtures.js'
import { renderApp } from './render.js'

const sessionExpired = {
  status: 401,
  body: {
    ok: false,
    error: { code: 'AUTH_REQUIRED', message: 'auth required', requestId: 'req-401' },
  },
}

function roomHandlers(task: ReturnType<typeof makeTask>, failTask = false): MockHandler[] {
  return [
    {
      method: 'GET',
      url: new RegExp(`/api/v1/tasks/${task.id}$`),
      respond: () => {
        if (failTask) return sessionExpired
        return ok({ task, comments: [], instructions: [], runs: [], artifacts: [] })
      },
    },
  ]
}

describe('session 过期自动跳转（#227）', () => {
  it('页面内 query 401 → 跳登录页，显示「登录已过期」一次性提示', async () => {
    const task = makeTask({ assigneeUserId: BOB.userId })
    // 先正常进入任务页，随后会话过期：session 与 task-room 都开始 401。
    let expired = false
    const sessionSwitch = sessionSwitchHandler(BOB)
    sessionSwitch.flip()
    const handlers: MockHandler[] = [
      setupStatusHandler(true),
      sessionSwitch.handler,
      {
        method: 'GET',
        url: new RegExp(`/api/v1/tasks/${task.id}$`),
        respond: () => {
          if (expired) return sessionExpired
          return ok({ task, comments: [], instructions: [], runs: [], artifacts: [] })
        },
      },
    ]
    const view = renderApp(`/tasks/${task.id}`, handlers)
    await screen.findByRole('heading', { name: task.title })
    expired = true
    sessionSwitch.reset()
    // 重拉带回 401 → cache onError 发事件 → AppShell 跳登录（并清 session 缓存）。
    void view.queryClient.invalidateQueries()
    await waitFor(() => expect(screen.getByRole('button', { name: '登录' })).toBeInTheDocument())
    // #267：「登录钮出现」与「闪屏渲染出来」不保证同一次提交（/login 有两条到达路径，
    // 这条流程里 FlashBanner 实测挂载三次）。等我们真正要断言的那件事，而不是加 timeout 掩盖。
    expect(await screen.findByText(/登录已过期/)).toBeVisible()
    view.unmount()
  })

  it('登录成功后回跳原路径（from）', async () => {
    const task = makeTask({ assigneeUserId: BOB.userId })
    const user = userEvent.setup()
    const sessionSwitch = sessionSwitchHandler(BOB)
    sessionSwitch.flip() // 初始有效。
    let expired = false
    const handlers: MockHandler[] = [
      setupStatusHandler(true),
      sessionSwitch.handler,
      {
        method: 'POST',
        url: /\/api\/v1\/auth\/login$/,
        respond: () => {
          expired = false
          sessionSwitch.flip()
          return ok({ userId: BOB.userId })
        },
      },
      {
        method: 'GET',
        url: new RegExp(`/api/v1/tasks/${task.id}$`),
        respond: () => {
          if (expired) return sessionExpired
          return ok({ task, comments: [], instructions: [], runs: [], artifacts: [] })
        },
      },
    ]
    const view = renderApp(`/tasks/${task.id}`, handlers)
    await screen.findByRole('heading', { name: task.title })
    // 会话中途过期 → 自动送登录页（带 from）。
    expired = true
    sessionSwitch.reset()
    void view.queryClient.invalidateQueries()
    await waitFor(() => expect(screen.getByRole('button', { name: '登录' })).toBeInTheDocument())
    // 重新登录 → 回到原任务页（不是首页）。
    await user.type(screen.getByLabelText('用户名'), 'bob')
    await user.type(screen.getByLabelText('密码'), 'pw')
    await user.click(screen.getByRole('button', { name: '登录' }))
    await waitFor(() =>
      expect(screen.getByRole('heading', { name: task.title })).toBeInTheDocument(),
    )
    view.unmount()
  })

  it('from 只认站内路径：开放重定向被拒收（//evil.com、https://… 都回落首页）', async () => {
    const { safeRedirectFrom } = await import('../src/routes/LoginPage.js')
    expect(safeRedirectFrom('/tasks/abc?x=1')).toBe('/tasks/abc?x=1')
    expect(safeRedirectFrom('//evil.com')).toBe('/')
    expect(safeRedirectFrom('https://evil.com')).toBe('/')
    expect(safeRedirectFrom(null)).toBe('/')
  })
})
