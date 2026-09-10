/**
 * #141 成员页与邀请入口：选角色 → 生成一次性链接 → 链接可复制 + 有效期可见。
 * 从主导航可达（「成员」）也在这里断言——入口藏起来等于没做（Issue 的现象 1）。
 */
import { screen, within } from '@testing-library/react'
import { userEvent } from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import {
  ALICE,
  BOB,
  INVITE_TOKEN,
  createInviteHandler,
  loggedInHandlers,
  makeMember,
  teamMembersHandler,
  type MockHandler,
} from './fixtures.js'
import { renderApp } from './render.jsx'
import { openSelect, selectOption } from './select-menu.js'

/** jsdom 没有 navigator.clipboard：临时注入并在用例结束恢复（P1-17 同形）。 */
function stubClipboardWriteText(options: { reject?: boolean } = {}): {
  writeText: ReturnType<typeof vi.fn>
} {
  const writeText = vi.fn(async (_text: string) => {
    if (options.reject) throw new Error('NotAllowedError: clipboard denied')
  })
  Object.defineProperty(window.navigator, 'clipboard', { value: { writeText }, configurable: true })
  return { writeText }
}

function memberListHandlers(extra: MockHandler[] = []) {
  return loggedInHandlers(ALICE, [
    teamMembersHandler([
      makeMember(),
      makeMember({
        userId: BOB.userId,
        username: BOB.username,
        displayName: BOB.displayName,
        role: 'member',
      }),
    ]),
    ...extra,
  ])
}

describe('members-page', () => {
  it('主导航里有「成员」入口（不能藏）', async () => {
    renderApp('/members', memberListHandlers())
    const nav = await screen.findByRole('navigation', { name: '主导航' })
    expect(within(nav).getByRole('link', { name: '成员' })).toHaveAttribute('href', '/members')
  })

  it('成员名单展示显示名、用户名与角色', async () => {
    renderApp('/members', memberListHandlers())
    expect(await screen.findByRole('heading', { name: '成员' })).toBeVisible()
    const alice = (await screen.findByText('Alice')).closest('li')
    expect(alice).not.toBeNull()
    expect(within(alice as HTMLElement).getByText('@alice')).toBeVisible()
    expect(within(alice as HTMLElement).getByText('所有者')).toBeVisible()
    const bob = screen.getByText('Bob').closest('li') as HTMLElement
    expect(within(bob).getByText('@bob')).toBeVisible()
    expect(within(bob).getByText('成员')).toBeVisible()
  })

  it('#152 角色徽标是中文，且与角色下拉同一套措辞（不再是 Owner vs Member）', async () => {
    const user = userEvent.setup()
    renderApp('/members', memberListHandlers())
    const alice = (await screen.findByText('Alice')).closest('li') as HTMLElement
    const bob = screen.getByText('Bob').closest('li') as HTMLElement
    for (const row of [alice, bob]) {
      const badges = [...row.querySelectorAll('.badge')]
      expect(badges.length).toBeGreaterThan(0)
      for (const badge of badges) {
        expect(badge.textContent ?? '').not.toMatch(/[A-Za-z]/)
      }
    }
    // 下拉项用同一套角色名（徽标「成员」↔ 下拉「成员」）。
    // #158 起角色下拉是 vendored Menu：项是 `role=menuitem` 且**只在菜单打开时**在
    // DOM 里（原来读 `option` 的写法在迁移后恒为空集，等于假绿）。
    const list = await openSelect(user, '角色')
    expect(list.getByRole('menuitem', { name: '成员' })).toBeVisible()
    expect(list.getByRole('menuitem', { name: /管理员/ })).toBeVisible()
    expect(screen.queryByRole('option', { name: /Member|Admin/ })).not.toBeInTheDocument()
  })

  it('已停用成员仍在名单里并标注「已停用」（不静默隐藏）', async () => {
    renderApp(
      '/members',
      loggedInHandlers(ALICE, [
        teamMembersHandler([
          makeMember(),
          makeMember({ userId: BOB.userId, username: 'bob', displayName: 'Bob', enabled: false }),
        ]),
      ]),
    )
    expect(await screen.findByText('已停用')).toBeVisible()
  })

  it('所有者选角色生成邀请：链接可见、可一键复制、有效期显示', async () => {
    const user = userEvent.setup()
    const clipboard = stubClipboardWriteText()
    const invite = createInviteHandler({ role: 'admin', expiresAt: '2026-08-28T10:00:00.000Z' })
    renderApp('/members', memberListHandlers([invite.handler]))

    await selectOption(user, '角色', '管理员（可管理插件与邀请）')
    await user.click(screen.getByRole('button', { name: '生成邀请链接' }))

    // 链接完整可见（Token 只出现一次，必须当场给全）
    const link = await screen.findByText(`${window.location.origin}/invites/${INVITE_TOKEN}`)
    expect(link).toBeVisible()
    expect(invite.requests[0]).toEqual({ role: 'admin' })

    // 一键复制：写进剪贴板的正是这条链接；按钮文案用中文角色名
    await user.click(screen.getByRole('button', { name: '复制管理员邀请链接' }))
    expect(clipboard.writeText).toHaveBeenCalledWith(
      `${window.location.origin}/invites/${INVITE_TOKEN}`,
    )
    expect(await screen.findByText('已复制')).toBeVisible()

    // 有效期（Hub 侧 72 小时）与角色都写清楚
    expect(screen.getByText('有效期至')).toBeVisible()
    expect(screen.getByText('（72 小时）')).toBeVisible()
    expect(screen.getByText('管理员')).toBeVisible()
  })

  it('复制失败如实报错，不伪造「已复制」', async () => {
    const user = userEvent.setup()
    stubClipboardWriteText({ reject: true })
    const invite = createInviteHandler({ role: 'member' })
    renderApp('/members', memberListHandlers([invite.handler]))

    await user.click(await screen.findByRole('button', { name: '生成邀请链接' }))
    await user.click(await screen.findByRole('button', { name: '复制成员邀请链接' }))
    expect(await screen.findByText('复制失败，请手动复制邀请链接')).toBeVisible()
    expect(screen.queryByText('已复制')).not.toBeInTheDocument()
  })

  it('生成失败展示 Hub 的错误与 requestId（不假装成功）', async () => {
    const user = userEvent.setup()
    renderApp(
      '/members',
      memberListHandlers([
        {
          method: 'POST',
          url: /\/api\/v1\/invites$/,
          respond: () => ({
            status: 403,
            body: {
              ok: false,
              error: {
                code: 'FORBIDDEN',
                message: 'only owner or admin can create invites',
                requestId: 'req-invite-403',
              },
            },
          }),
        },
      ]),
    )
    await user.click(await screen.findByRole('button', { name: '生成邀请链接' }))
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'only owner or admin can create invites',
    )
    // 失败时不给链接（不假装成功）
    expect(screen.queryByText(/\/invites\//)).not.toBeInTheDocument()
    expect(screen.queryByText('把这条链接发给他')).not.toBeInTheDocument()
  })

  it('成员看不到邀请表单，但能看到「只有所有者或管理员能邀请」的说明', async () => {
    renderApp(
      '/members',
      loggedInHandlers(BOB, [teamMembersHandler([makeMember(), makeMember({ role: 'member' })])]),
    )
    expect(await screen.findByRole('heading', { name: '邀请成员' })).toBeVisible()
    expect(screen.queryByRole('button', { name: '生成邀请链接' })).not.toBeInTheDocument()
    expect(screen.getByText(/只有所有者或管理员能邀请成员/)).toBeVisible()
  })
})
