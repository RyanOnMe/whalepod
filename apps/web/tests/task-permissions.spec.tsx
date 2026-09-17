/**
 * 任务级权限页（切片⑥e）：谁能驱动这个任务的 Agent。
 *
 * 判据围绕 ADR-0009 决策 4 的三条边界，而不是"页面画出来了"：
 *   ① 责任人**永远**可驱动（名单第一行、**没有**撤销入口——他不是被授权者）；
 *   ② 写路径只有责任人（非责任人看到只读说明，**根本不给**写入口，而不是"按钮变灰"）；
 *   ③ 被授权成员带"由谁何时授"（审计要能回答谁授的）。
 * 另加一条请求形态判据：撤销必须走 **DELETE**（不是 POST——服务端只有 DELETE 路由）。
 */
import { screen, waitFor, within } from '@testing-library/react'
import { userEvent } from '@testing-library/user-event'
import { describe, expect, it } from 'vitest'
import {
  ALICE,
  BOB,
  loggedInHandlers,
  makeMember,
  makeTask,
  teamMembersHandler,
} from './fixtures.js'
import type { MockHandler } from './fixtures.js'
import { renderApp } from './render.jsx'

const GRANTED_AT = '2026-09-15T02:00:00.000Z'

function grantsHandler(
  entries: readonly { userId: string; reason: 'assignee' | 'granted'; grantedBy?: string }[],
  onCall?: (method: string) => void,
): MockHandler[] {
  return [
    {
      method: 'GET',
      url: /\/instruction-grants$/,
      respond: () => {
        onCall?.('GET')
        return new Response(
          JSON.stringify({
            ok: true,
            data: entries.map((entry) =>
              entry.reason === 'assignee'
                ? { userId: entry.userId, reason: 'assignee' }
                : {
                    userId: entry.userId,
                    reason: 'granted',
                    grantedBy: entry.grantedBy ?? BOB.userId,
                    grantedAt: GRANTED_AT,
                  },
            ),
          }),
          { status: 200 },
        )
      },
    },
  ]
}

function renderPermissions(
  session = BOB,
  grants: MockHandler[] = grantsHandler([{ userId: BOB.userId, reason: 'assignee' }]),
  assigneeUserId = BOB.userId,
): ReturnType<typeof renderApp> {
  const task = makeTask({ assigneeUserId })
  return renderApp(`/tasks/${task.id}/permissions`, [
    ...loggedInHandlers(session, [
      {
        method: 'GET',
        url: new RegExp(`/api/v1/tasks/${task.id}$`),
        respond: () =>
          new Response(
            JSON.stringify({
              ok: true,
              data: { task, comments: [], instructions: [], runs: [], artifacts: [] },
            }),
            { status: 200 },
          ),
      },
      ...grants,
      teamMembersHandler([
        makeMember(),
        makeMember({ ...BOB, role: BOB.role }),
        makeMember({ ...ALICE, role: ALICE.role }),
      ]),
    ]),
  ])
}

describe('任务权限页（⑥e）', () => {
  it('责任人排第一且标注「永远可驱动」，并且**没有**撤销入口（他不是被授权者）', async () => {
    renderPermissions(BOB, grantsHandler([{ userId: BOB.userId, reason: 'assignee' }]))
    const items = await screen.findAllByTestId('driver-item')
    expect(items).toHaveLength(1)
    expect(within(items[0]!).getByTestId('driver-reason').textContent).toContain('永远可驱动')
    expect(screen.queryByTestId('driver-revoke')).toBeNull()
  })

  it('被授权成员带「由谁何时授」——审计要能回答是谁授的', async () => {
    renderPermissions(
      BOB,
      grantsHandler([
        { userId: BOB.userId, reason: 'assignee' },
        { userId: ALICE.userId, reason: 'granted', grantedBy: BOB.userId },
      ]),
    )
    const reasons = (await screen.findAllByTestId('driver-reason')).map(
      (el) => el.textContent ?? '',
    )
    expect(reasons[1]).toContain('被授权')
    expect(reasons[1]).toContain(GRANTED_AT.slice(0, 10))
  })

  it('责任人能撤销被授权成员，且请求必须走 **DELETE**（服务端只有 DELETE 路由）', async () => {
    const user = userEvent.setup()
    const calls: string[] = []
    const view = renderPermissions(BOB, [
      ...grantsHandler(
        [
          { userId: BOB.userId, reason: 'assignee' },
          { userId: ALICE.userId, reason: 'granted' },
        ],
        (method) => calls.push(method),
      ),
      {
        method: 'DELETE',
        url: /\/instruction-grants\/[0-9a-f-]+$/,
        respond: () =>
          new Response(JSON.stringify({ ok: true, data: { revoked: true } }), { status: 200 }),
      },
    ])
    await user.click(await screen.findByTestId('driver-revoke'))
    await waitFor(() => {
      const methods = view.fetchMock.mock.calls.map((call) => (call[1] as RequestInit).method)
      expect(methods).toContain('DELETE')
    })
    expect(calls).toContain('GET') // 撤销后要重新拉名单
  })

  it('非责任人看到的是**只读**名单：有只读说明、没有任何写入口', async () => {
    // 责任人仍是 BOB；ALICE 是被授权成员，她能看名单但改不了。
    renderPermissions(
      ALICE,
      grantsHandler([
        { userId: BOB.userId, reason: 'assignee' },
        { userId: ALICE.userId, reason: 'granted' },
      ]),
    )
    expect(await screen.findByTestId('drivers-readonly')).toBeVisible()
    expect(screen.queryByTestId('driver-revoke')).toBeNull()
    expect(screen.queryByRole('button', { name: '授权' })).toBeNull()
  })

  it('两条不可让渡的边界写在页面上（审批不可授予 / 执行不换机器）', async () => {
    renderPermissions()
    // 用 screen 查询（在当前渲染容器内），不用 document.body——它在 cleanup 后是空的。
    expect(await screen.findByText(/审批决定权不可授予/)).toBeVisible()
    expect(screen.getByText(/执行永远用责任人的设备与凭据/)).toBeVisible()
  })
})
