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

  it('责任人能撤销被授权成员：请求走 DELETE，且撤销后那一行真的从名单上消失', async () => {
    // 复核 B1：这条原本断言 `expect(calls).toContain('GET')`——挂载时就已经 GET 过一次，
    // 于是断言被首次加载满足，与"撤销后重新拉名单"无关：删掉组件的 `invalidate()` 仍 5/5 全绿。
    // 现在改成**有状态名单**（DELETE 后 GET 少一行），断言那一行**消失**——真实回归逃逸点。
    const user = userEvent.setup()
    let revoked = false
    const task = makeTask({ assigneeUserId: BOB.userId })
    const view = renderApp(`/tasks/${task.id}/permissions`, [
      ...loggedInHandlers(BOB, [
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
        {
          method: 'GET',
          url: /\/instruction-grants$/,
          respond: () =>
            new Response(
              JSON.stringify({
                ok: true,
                data: revoked
                  ? [{ userId: BOB.userId, reason: 'assignee' }]
                  : [
                      { userId: BOB.userId, reason: 'assignee' },
                      {
                        userId: ALICE.userId,
                        reason: 'granted',
                        grantedBy: BOB.userId,
                        grantedAt: GRANTED_AT,
                      },
                    ],
              }),
              { status: 200 },
            ),
        },
        {
          method: 'DELETE',
          url: /\/instruction-grants\/[0-9a-f-]+$/,
          respond: () => {
            revoked = true
            return new Response(JSON.stringify({ ok: true, data: { revoked: true } }), {
              status: 200,
            })
          },
        },
        teamMembersHandler([
          makeMember(),
          makeMember({ ...BOB, role: BOB.role }),
          makeMember({ ...ALICE, role: ALICE.role }),
        ]),
      ]),
    ])
    expect(await screen.findAllByTestId('driver-item')).toHaveLength(2)
    await user.click(await screen.findByTestId('driver-revoke'))
    // ① 请求方法必须是 DELETE（服务端只有 DELETE 路由）
    await waitFor(() => {
      const methods = view.fetchMock.mock.calls.map((call) => (call[1] as RequestInit).method)
      expect(methods).toContain('DELETE')
    })
    // ② 那一行必须消失——删掉 invalidate() 时这条会红
    await waitFor(() => {
      expect(screen.getAllByTestId('driver-item')).toHaveLength(1)
    })
    expect(screen.queryByText(ALICE.displayName)).toBeNull()
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

  it('已停用成员不进「授权给」下拉（服务端不拦，落了库就是幽灵名单）', async () => {
    // 复核 S2：服务端只查 team_members 有没有这行、**不看停用态**，所以 UI 漏了过滤就会真落库，
    // 名单上多一个永远登不进来的人。同仓先例：ProjectsPage 的责任人选择器过滤 `enabled`。
    //
    // 夹具特意放**三个不同的人**，好把两种失败区分开：
    //   要是名册压根没被采用（默认夹具只有 Alice/Bob），"Carol 可见"这条会先红；
    //   要是过滤失效，Dave 会出现在下拉里。只断言"某人不在"是区分不出来的。
    const user = userEvent.setup()
    const task = makeTask({ assigneeUserId: BOB.userId })
    const carol = {
      userId: 'carol-1',
      username: 'carol',
      displayName: 'Carol',
      role: 'member' as const,
    }
    const dave = {
      userId: 'dave-1',
      username: 'dave',
      displayName: 'Dave',
      role: 'member' as const,
    }
    renderApp(`/tasks/${task.id}/permissions`, [
      ...loggedInHandlers(BOB, [
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
        ...grantsHandler([{ userId: BOB.userId, reason: 'assignee' }]),
        teamMembersHandler([
          makeMember({ ...BOB, role: BOB.role }),
          makeMember({ ...carol, enabled: true }),
          makeMember({ ...dave, enabled: false }),
        ]),
      ]),
    ])
    const trigger = await screen.findByLabelText('授权给')
    await user.click(trigger)
    const menu = await screen.findByRole('menu')
    // ① 名册确实被采用（否则这条会红，而不是让下面的"不在"假通过）
    expect(within(menu).getByRole('menuitem', { name: carol.displayName })).toBeVisible()
    // ② 停用成员不进下拉
    expect(within(menu).queryByRole('menuitem', { name: dave.displayName })).toBeNull()
  })

  it('名册加载失败时**说清楚**，不是只剩一个"选择成员…"的假空态', async () => {
    // 复核 S3：原先 `membersQuery.isPending/isError` 从不渲染，500 时下拉只剩占位项，
    // 责任人会以为"团队里没别人可授"。空态必须与加载失败区分（仓库口径）。
    const task = makeTask({ assigneeUserId: BOB.userId })
    renderApp(`/tasks/${task.id}/permissions`, [
      ...loggedInHandlers(BOB, [
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
        ...grantsHandler([{ userId: BOB.userId, reason: 'assignee' }]),
        {
          method: 'GET',
          url: /\/team\/members$/,
          respond: () =>
            new Response(
              JSON.stringify({
                ok: false,
                error: { code: 'INTERNAL_ERROR', message: '名册读取失败', requestId: 'req-x' },
              }),
              { status: 500 },
            ),
        },
      ]),
    ])
    expect(await screen.findByText(/名册读取失败|团队/)).toBeVisible()
    // 名单本身仍要能看（名册挂了不影响"谁能驱动"这个问题的答案）。
    expect(await screen.findByTestId('driver-item')).toBeVisible()
  })

  it('两条不可让渡的边界写在页面上（审批不可授予 / 执行不换机器）', async () => {
    renderPermissions()
    // 用 screen 查询（在当前渲染容器内），不用 document.body——它在 cleanup 后是空的。
    expect(await screen.findByText(/审批决定权不可授予/)).toBeVisible()
    expect(screen.getByText(/执行永远用责任人的设备与凭据/)).toBeVisible()
  })
})
