/**
 * 导航与会话引导（02 Task 7 Step 3）：root loader 先 setup/status → 未初始化
 * 进 /setup；已初始化再看 auth/session → 未登录进 /login；已登录进 Project 列表。
 * 重定向只发生在站内固定路径，外部 URL 不存在可注入点。
 */
import { screen, waitFor } from '@testing-library/react'
import { userEvent } from '@testing-library/user-event'
import { describe, expect, it } from 'vitest'
import type { CommentView } from '../src/shared/api/types.js'
import {
  ALICE,
  BOB,
  created,
  initOf,
  loginHandler,
  loggedInHandlers,
  makeTask,
  ok,
  projectsHandler,
  setupFlow,
  setupStatusHandler,
  sessionHandler,
  sessionSwitchHandler,
  taskRoomHandler,
  teamMembersHandler,
  type MockHandler,
} from './fixtures.js'
import { renderApp } from './render.jsx'

function projectListHandlers() {
  return [
    setupStatusHandler(true),
    sessionHandler(ALICE),
    projectsHandler([
      {
        id: '11111111-0000-4000-8000-000000000001',
        name: 'Launch Kit',
        description: '上市准备',
        createdBy: ALICE.userId,
        archivedAt: null,
        createdAt: '2026-08-24T00:00:00.000Z',
        updatedAt: '2026-08-24T00:00:00.000Z',
      },
    ]),
  ]
}

describe('auth-navigation', () => {
  it('未初始化的实例把任意站内路径重定向到 /setup', async () => {
    renderApp('/tasks/some-task', [setupStatusHandler(false)])
    expect(await screen.findByRole('heading', { name: '初始化团队' })).toBeVisible()
    expect(screen.queryByRole('heading', { name: '登录' })).not.toBeInTheDocument()
  })

  it('已初始化但未登录时重定向到 /login', async () => {
    renderApp('/', [setupStatusHandler(true), sessionHandler('unauthorized')])
    expect(await screen.findByRole('heading', { name: '登录' })).toBeVisible()
    expect(screen.getByLabelText('用户名')).toBeVisible()
  })

  it('已登录进入 Project 列表', async () => {
    renderApp('/', projectListHandlers())
    expect(await screen.findByRole('heading', { name: '项目' })).toBeVisible()
    expect(await screen.findByRole('heading', { name: 'Launch Kit' })).toBeVisible()
  })

  it('已登录可直接进入 Task Room（重定向只保留站内 path）', async () => {
    const task = makeTask({ assigneeUserId: BOB.userId })
    renderApp(`/tasks/${task.id}`, loggedInHandlers(BOB, [taskRoomHandler(task)]))
    expect(await screen.findByRole('heading', { name: task.title })).toBeVisible()
  })

  it('登录表单提交成功后进入项目列表', async () => {
    const switchable = sessionSwitchHandler(ALICE)
    const handlers: MockHandler[] = [
      switchable.handler,
      loginHandler(ALICE, switchable.flip),
      setupStatusHandler(true),
      projectsHandler([]),
    ]
    const user = userEvent.setup()
    renderApp('/login', handlers)
    await user.type(await screen.findByLabelText('用户名'), 'alice')
    await user.type(screen.getByLabelText('密码'), 'correct horse battery staple')
    await user.click(screen.getByRole('button', { name: '登录' }))
    expect(await screen.findByRole('heading', { name: '项目' })).toBeVisible()
    expect(await screen.findByText('还没有项目——先创建第一个项目，再为它建 Task。')).toBeVisible()
  })

  it('登录失败展示统一错误，不离开登录页', async () => {
    const user = userEvent.setup()
    renderApp('/login', [
      sessionHandler('unauthorized'),
      {
        method: 'POST',
        url: /\/api\/v1\/auth\/login$/,
        respond: () => ({
          status: 401,
          body: {
            ok: false,
            error: {
              code: 'INVALID_CREDENTIALS',
              message: 'invalid username or password',
              requestId: 'req-login-1',
            },
          },
        }),
      },
    ])
    await user.type(await screen.findByLabelText('用户名'), 'alice')
    await user.type(screen.getByLabelText('密码'), 'wrong-password')
    await user.click(screen.getByRole('button', { name: '登录' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('用户名或密码不正确')
    expect(screen.getByRole('heading', { name: '登录' })).toBeVisible()
  })

  it('Setup 表单提交成功后进入项目列表', async () => {
    const switchable = sessionSwitchHandler(ALICE)
    const flow = setupFlow(() => switchable.flip())
    const user = userEvent.setup()
    renderApp('/setup', [
      flow.statusHandler,
      switchable.handler,
      flow.setupHandler,
      projectsHandler([]),
    ])
    await user.type(await screen.findByLabelText('Setup Token'), 'setup-token-123')
    await user.type(screen.getByLabelText('团队名称'), 'Acme')
    await user.type(screen.getByLabelText('用户名'), 'alice')
    await user.type(screen.getByLabelText('显示名'), 'Alice')
    await user.type(screen.getByLabelText('密码'), 'correct horse battery staple')
    await user.click(screen.getByRole('button', { name: '创建团队' }))
    expect(await screen.findByRole('heading', { name: '项目' })).toBeVisible()
  })

  it('会话过期后导航被重定向回登录页（不展示业务数据）', async () => {
    const task = makeTask({ assigneeUserId: BOB.userId })
    renderApp(`/tasks/${task.id}`, [setupStatusHandler(true), sessionHandler('unauthorized')])
    expect(await screen.findByRole('heading', { name: '登录' })).toBeVisible()
    expect(screen.queryByRole('heading', { name: task.title })).not.toBeInTheDocument()
  })

  it('退出登录回到登录页', async () => {
    let loggedIn = true
    const user = userEvent.setup()
    renderApp('/', [
      setupStatusHandler(true),
      {
        method: 'GET',
        url: /\/api\/v1\/auth\/session$/,
        respond: () =>
          loggedIn
            ? ok(ALICE)
            : {
                status: 401,
                body: {
                  ok: false,
                  error: {
                    code: 'AUTH_REQUIRED',
                    message: 'login required',
                    requestId: 'req-out-1',
                  },
                },
              },
      },
      {
        method: 'POST',
        url: /\/api\/v1\/auth\/logout$/,
        respond: () => {
          loggedIn = false
          return ok({})
        },
      },
      projectsHandler([]),
    ])
    await screen.findByRole('heading', { name: '项目' })
    await user.click(screen.getByRole('button', { name: '退出登录' }))
    expect(await screen.findByRole('heading', { name: '登录' })).toBeVisible()
  })

  it('“键盘可完成主链”：登录 → 创建任务 → Task Room → 接受 → 留言', async () => {
    const switchable = sessionSwitchHandler(BOB)
    const task = makeTask({ assigneeUserId: BOB.userId })
    const project = {
      id: '11111111-0000-4000-8000-000000000001',
      name: 'Launch Kit',
      description: '上市准备',
      createdBy: ALICE.userId,
      archivedAt: null,
      createdAt: '2026-08-24T00:00:00.000Z',
      updatedAt: '2026-08-24T00:00:00.000Z',
    }
    const comment: CommentView = {
      id: 'c-1',
      taskId: task.id,
      authorUserId: BOB.userId,
      body: 'handling this run',
      createdAt: '2026-08-26T00:01:00.000Z',
      editedAt: null,
    }
    // 可变的 Task Room 状态：接受/留言后 refetch 返回新快照（模拟 server reconciliation）。
    let room = { task: { ...task }, comments: [] as CommentView[] }
    const user = userEvent.setup()
    const { fetchMock } = renderApp('/login', [
      switchable.handler,
      loginHandler(BOB, switchable.flip),
      setupStatusHandler(true),
      projectsHandler([project]),
      teamMembersHandler(),
      {
        method: 'POST',
        url: /\/api\/v1\/projects\/[^/]+\/tasks$/,
        respond: () => created(task),
      },
      {
        method: 'GET',
        url: new RegExp(`/api/v1/tasks/${task.id}$`),
        respond: () => ok({ task: room.task, comments: room.comments, runs: [], artifacts: [] }),
      },
      {
        method: 'POST',
        url: new RegExp(`/api/v1/tasks/${task.id}/accept$`),
        respond: () => {
          room = {
            task: { ...task, assignmentStatus: 'accepted', acceptedAt: '2026-08-26T00:00:00.000Z' },
            comments: room.comments,
          }
          return ok(room.task)
        },
      },
      {
        method: 'POST',
        url: new RegExp(`/api/v1/tasks/${task.id}/comments$`),
        respond: () => {
          room = { task: room.task, comments: [...room.comments, comment] }
          return { status: 201, body: { ok: true, data: comment } }
        },
      },
    ])

    // 登录（键盘：聚焦用户名 → Tab 到密码 → Enter 提交）
    const username = await screen.findByLabelText('用户名')
    username.focus()
    await user.keyboard('bob{TAB}correct horse battery staple{Enter}')
    expect(await screen.findByRole('heading', { name: '项目' })).toBeVisible()

    // 展开项目里的「创建任务」表单（键盘：聚焦按钮 + Enter）
    // 时序纪律（#143）：跳转后出现的元素一律 findBy*——「项目」标题先于项目列表
    // 查询结果渲染，同步 getByRole 会在并行 project 的 CPU 竞争下踩空（~50% 假红）。
    const createTaskToggle = await screen.findByRole('button', { name: '创建任务' })
    createTaskToggle.focus()
    await user.keyboard('{Enter}')

    // 填表并提交（#136：成员列表就绪后默认选中自己=Bob；键盘只填标题）
    // #158：责任人已从原生 <select> 迁到 vendored Menu 的触发器按钮，所以这里断言
    // 「触发器上显示的值」而不是 `select.value`——真人看到的就是这段文字。
    const title = await screen.findByLabelText('任务标题')
    const assigneeTrigger = await screen.findByLabelText('责任人')
    expect(assigneeTrigger.tagName).toBe('BUTTON')
    await waitFor(() => expect(assigneeTrigger).toHaveTextContent(BOB.displayName))
    title.focus()
    await user.keyboard('Write onboarding guide{TAB}')
    const createButton = screen.getByRole('button', { name: /^创建任务$/ })
    createButton.focus()
    await user.keyboard('{Enter}')
    expect(await screen.findByRole('heading', { name: task.title })).toBeVisible()

    // 接受任务（键盘：聚焦按钮 + Enter）
    const acceptButton = await screen.findByRole('button', { name: '接受任务' })
    acceptButton.focus()
    await user.keyboard('{Enter}')
    expect(await screen.findByText('你已接受此任务。')).toBeVisible()

    // 留言（键盘：聚焦输入框 + 输入 + Tab 到发送 + Enter）
    const textarea = await screen.findByLabelText('留言')
    textarea.focus()
    await user.keyboard('handling this run')
    await user.tab()
    await user.keyboard('{Enter}')
    expect(await screen.findByText('handling this run')).toBeVisible()

    // 幂等：三条 mutation 都带了 Idempotency-Key
    const calls = fetchMock.mock.calls
    const findMutation = (suffix: RegExp): Headers => {
      const call = calls.find(([input, requestInit]) => {
        const method = requestInit?.method ?? 'GET'
        return method === 'POST' && suffix.test(String(input))
      })
      expect(call).toBeDefined()
      return new Headers(initOf(call as [RequestInfo | URL, RequestInit?]).headers)
    }
    expect(findMutation(/\/projects\/[^/]+\/tasks$/).get('idempotency-key')).toMatch(
      /^[0-9a-f-]{36}$/,
    )
    expect(findMutation(/\/accept$/).get('idempotency-key')).toMatch(/^[0-9a-f-]{36}$/)
    expect(findMutation(/\/comments$/).get('idempotency-key')).toMatch(/^[0-9a-f-]{36}$/)
  })
})
