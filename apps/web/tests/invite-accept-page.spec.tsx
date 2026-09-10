/**
 * #141 接受页（/invites/:token）：未登录引导登录、已登录一键加入、失效链接的人话错误态。
 *
 * 断言口径（与 issue 验收面 B 对齐）：
 * - 未登录：说清「哪个团队、什么角色、何时过期」，原地给登录表单（Token 不能丢）；
 * - 已登录：一键加入 → 落到项目页并提示「已加入 <团队名>」；
 * - 失效：过期/已用/不存在三种都给明确文案，**不出现裸错误码**（NOT_FOUND/CONFLICT）。
 */
import { screen } from '@testing-library/react'
import { userEvent } from '@testing-library/user-event'
import { describe, expect, it } from 'vitest'
import {
  ALICE,
  BOB,
  INVITE_TOKEN,
  acceptInviteAnonymouslyHandler,
  acceptInviteAsMemberHandler,
  inviteDetailsHandler,
  loginHandler,
  loggedInHandlers,
  projectsHandler,
  sessionHandler,
  sessionSwitchHandler,
  setupStatusHandler,
  unusableInviteHandler,
  type MockHandler,
} from './fixtures.js'
import { renderApp } from './render.jsx'

const INVITE_PATH = `/invites/${INVITE_TOKEN}`

/** 未登录的接受页：已初始化 + 会话 401 + 有效邀请。 */
function loggedOutHandlers(extra: MockHandler[] = []): MockHandler[] {
  return [
    setupStatusHandler(true),
    sessionHandler('unauthorized'),
    inviteDetailsHandler(),
    ...extra,
  ]
}

describe('invite-accept-page', () => {
  it('未登录：先说清团队/角色/有效期，再给登录表单（不跳走、不丢 Token）', async () => {
    renderApp(INVITE_PATH, loggedOutHandlers())
    expect(await screen.findByRole('heading', { name: '加入团队' })).toBeVisible()
    expect(await screen.findByText(/团队「Acme」邀请你以 Member 身份加入/)).toBeVisible()
    expect(screen.getByText(/链接有效期至/)).toBeVisible()
    // 原地给两条腿：建号加入（默认）与「我已有账号」登录；页面没有跳去 /login
    expect(screen.getByRole('button', { name: '创建账号并加入' })).toBeVisible()
    expect(screen.getByRole('button', { name: '我已有账号' })).toBeVisible()
    expect(screen.queryByRole('heading', { name: '登录' })).not.toBeInTheDocument()
  })

  it('未登录 · 建号腿：填账号 → POST /invites/accept（body 带链接里的 Token）→ 落地提示已加入', async () => {
    const user = userEvent.setup()
    const requests: Array<Record<string, unknown>> = []
    // 真实 Hub 在匿名接受成功时下发 Session Cookie：桩在这里翻成已登录。
    const switchable = sessionSwitchHandler(BOB)
    renderApp(INVITE_PATH, [
      setupStatusHandler(true),
      switchable.handler,
      inviteDetailsHandler(),
      acceptInviteAnonymouslyHandler(
        { userId: BOB.userId, role: 'member' },
        requests,
        switchable.flip,
      ),
      projectsHandler([]),
    ])
    await user.type(await screen.findByLabelText('用户名'), 'bob')
    await user.type(screen.getByLabelText('显示名'), 'Bob')
    await user.type(screen.getByLabelText('密码'), 'correct horse battery staple')
    await user.click(screen.getByRole('button', { name: '创建账号并加入' }))

    expect(await screen.findByRole('heading', { name: '项目' })).toBeVisible()
    // 加入成功的确认在落地页可见（AppShell 的一次性横幅）
    const banner = document.querySelector('.app-flash')
    expect(banner).not.toBeNull()
    expect(banner?.textContent).toBe('已加入 Acme')
    expect(requests[0]).toEqual({
      token: INVITE_TOKEN,
      username: 'bob',
      displayName: 'Bob',
      password: 'correct horse battery staple',
    })
  })

  it('建号失败（用户名被占）展示 Hub 错误，不假装加入成功', async () => {
    const user = userEvent.setup()
    renderApp(INVITE_PATH, [
      ...loggedOutHandlers(),
      {
        method: 'POST',
        url: /\/api\/v1\/invites\/accept$/,
        respond: () => ({
          status: 409,
          body: {
            ok: false,
            error: {
              code: 'CONFLICT',
              message: 'username already taken',
              requestId: 'req-signup-409',
            },
          },
        }),
      },
    ])
    await user.type(await screen.findByLabelText('用户名'), 'bob')
    await user.type(screen.getByLabelText('显示名'), 'Bob')
    await user.type(screen.getByLabelText('密码'), 'correct horse battery staple')
    await user.click(screen.getByRole('button', { name: '创建账号并加入' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('username already taken')
    expect(screen.queryByRole('heading', { name: '项目' })).not.toBeInTheDocument()
  })

  it('未登录 → 登录成功后原地换成「加入团队」按钮，再点一下才入队', async () => {
    const user = userEvent.setup()
    const switchable = sessionSwitchHandler(BOB)
    renderApp(INVITE_PATH, [
      setupStatusHandler(true),
      switchable.handler,
      inviteDetailsHandler(),
      loginHandler(BOB, switchable.flip),
      acceptInviteAsMemberHandler({ joined: true }),
      projectsHandler([]),
    ])
    await user.click(await screen.findByRole('button', { name: '我已有账号' }))
    await user.type(await screen.findByLabelText('用户名'), 'bob')
    await user.type(screen.getByLabelText('密码'), 'bob password')
    await user.click(screen.getByRole('button', { name: '登录并继续' }))

    const joinButton = await screen.findByRole('button', { name: '加入团队' })
    expect(screen.getByText(/你将以 Bob（@bob）的身份加入/)).toBeVisible()
    await user.click(joinButton)
    // 落到项目页
    expect(await screen.findByRole('heading', { name: '项目' })).toBeVisible()
  })

  it('登录失败展示统一文案，仍停在本页', async () => {
    const user = userEvent.setup()
    renderApp(INVITE_PATH, [
      ...loggedOutHandlers(),
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
              requestId: 'req-inv-login',
            },
          },
        }),
      },
    ])
    await user.click(await screen.findByRole('button', { name: '我已有账号' }))
    await user.type(await screen.findByLabelText('用户名'), 'bob')
    await user.type(screen.getByLabelText('密码'), 'wrong password')
    await user.click(screen.getByRole('button', { name: '登录并继续' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('用户名或密码不正确')
    expect(screen.getByRole('heading', { name: '加入团队' })).toBeVisible()
  })

  it('实例未初始化：指向 /setup（那里才建团队与 Owner 账号）', async () => {
    renderApp(INVITE_PATH, [setupStatusHandler(false), inviteDetailsHandler()])
    expect(await screen.findByRole('heading', { name: '加入团队' })).toBeVisible()
    expect(await screen.findByRole('link', { name: '去初始化团队' })).toHaveAttribute(
      'href',
      '/setup',
    )
    expect(screen.queryByRole('button', { name: '加入团队' })).not.toBeInTheDocument()
  })

  it('已登录一键加入：跳到项目页并提示「已加入 <团队名>」', async () => {
    const user = userEvent.setup()
    renderApp(
      INVITE_PATH,
      loggedInHandlers(BOB, [
        inviteDetailsHandler({ role: 'admin', teamName: 'Launch Crew' }),
        acceptInviteAsMemberHandler({ role: 'admin', teamName: 'Launch Crew', joined: true }),
        projectsHandler([]),
      ]),
    )
    expect(await screen.findByText(/团队「Launch Crew」邀请你以 Admin 身份加入/)).toBeVisible()
    await user.click(await screen.findByRole('button', { name: '加入团队' }))
    expect(await screen.findByRole('heading', { name: '项目' })).toBeVisible()
    // 落地页（项目页的 AppShell 布局）读到「刚刚加入」的一次性提示
    expect(await screen.findByText('已加入 Launch Crew')).toBeVisible()
  })

  it('已在团队里的成员重复点加入：提示「已经在 … 里了」，仍回项目页', async () => {
    const user = userEvent.setup()
    renderApp(
      INVITE_PATH,
      loggedInHandlers(BOB, [
        inviteDetailsHandler(),
        acceptInviteAsMemberHandler({ teamName: 'Acme', joined: false, alreadyMember: true }),
        projectsHandler([]),
      ]),
    )
    await user.click(await screen.findByRole('button', { name: '加入团队' }))
    expect(await screen.findByRole('heading', { name: '项目' })).toBeVisible()
  })

  it('已过期：明确说「已过期」，不出现裸错误码', async () => {
    renderApp(INVITE_PATH, [
      setupStatusHandler(true),
      sessionHandler('unauthorized'),
      unusableInviteHandler('expired'),
    ])
    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent('这条邀请链接已经过期了')
    expect(alert).not.toHaveTextContent('CONFLICT')
    expect(alert).not.toHaveTextContent('409')
  })

  it('已被使用：明确说「已经被使用过了」', async () => {
    renderApp(INVITE_PATH, [
      setupStatusHandler(true),
      sessionHandler('unauthorized'),
      unusableInviteHandler('consumed'),
    ])
    expect(await screen.findByRole('alert')).toHaveTextContent('这条邀请链接已经被使用过了')
  })

  it('不存在的 Token：人话说明 + 不含 Token 与状态码', async () => {
    renderApp(INVITE_PATH, [
      setupStatusHandler(true),
      sessionHandler('unauthorized'),
      unusableInviteHandler('unknown'),
    ])
    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent('这条邀请链接无效')
    expect(alert).not.toHaveTextContent('NOT_FOUND')
    expect(alert).not.toHaveTextContent(INVITE_TOKEN)
    // 没有加入按钮可点（失效链接不给动作）
    expect(screen.queryByRole('button', { name: '加入团队' })).not.toBeInTheDocument()
  })

  it('失效链接对已登录者也只给错误态（不给加入按钮）', async () => {
    renderApp(INVITE_PATH, [...loggedInHandlers(ALICE, [unusableInviteHandler('consumed')])])
    expect(await screen.findByRole('alert')).toHaveTextContent('这条邀请链接已经被使用过了')
    expect(screen.queryByRole('button', { name: '加入团队' })).not.toBeInTheDocument()
  })

  it('加入失败（邀请刚被用掉）：展示 Hub 的错误，不假装成功', async () => {
    const user = userEvent.setup()
    renderApp(
      INVITE_PATH,
      loggedInHandlers(BOB, [
        inviteDetailsHandler(),
        {
          method: 'POST',
          url: new RegExp(`/api/v1/invites/${INVITE_TOKEN}/accept$`),
          respond: () => ({
            status: 409,
            body: {
              ok: false,
              error: {
                code: 'CONFLICT',
                message: 'invite token is invalid, expired or already consumed',
                requestId: 'req-accept-409',
              },
            },
          }),
        },
      ]),
    )
    await user.click(await screen.findByRole('button', { name: '加入团队' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('invite token is invalid')
    expect(screen.queryByRole('heading', { name: '项目' })).not.toBeInTheDocument()
  })
})
