/**
 * 执行目标条（切片⑥c）。
 *
 * 判据围绕三件必须成立的事，而不是"选择器画出来了"：
 *   ① **权限形态**：目标条只对责任人可操作；被授权成员看到只读说明
 *      （`GET /devices` 只列自己的设备，而执行永远用责任人的设备与凭据，见 ③c-2b）；
 *   ② **发送语义**：只有**显式指定**才把 `deviceId`/`workspaceId` 发给 Hub；自动解析时一个都不发
 *      （发了就等于把"自动"钉死成某台机器，与 ADR-0010 决策 3 相反）；
 *   ③ **回到自动**：显式指定后能退回自动，退回后载荷里不再带目标字段。
 */
import { screen, waitFor } from '@testing-library/react'
import { userEvent } from '@testing-library/user-event'
import { describe, expect, it } from 'vitest'
import { ALICE, BOB, loggedInHandlers, makeTask, teamMembersHandler } from './fixtures.js'
import type { MockHandler } from './fixtures.js'
import { renderApp } from './render.jsx'
import { selectOption } from './select-menu.js'

const DEVICE = {
  id: 'dev-1',
  name: '老张的 MacBook Pro',
  platform: 'darwin',
  status: 'online',
  dshDistributionVersion: '1.0.0',
  lastSeenAt: null,
}
const WS = {
  workspaceId: 'ws-1',
  deviceId: 'dev-1',
  name: '~/work/whalepod',
  kind: 'directory',
  available: true,
}

const okJson = (data: unknown, status = 200): Response =>
  new Response(JSON.stringify({ ok: true, data }), { status })

/**
 * 任务房间聚合。**必须传入同一份 task 对象**：`makeTask()` 每次调用生成新 id，路径与 handler
 * 各造一个就会对不上（第一版就是这么写的：4 条用例全挂在"页面没渲染"，因为没有任何 handler
 * 匹配那个 URL）。
 */
function roomHandler(task: ReturnType<typeof makeTask>): MockHandler {
  return {
    method: 'GET',
    url: new RegExp(`/api/v1/tasks/${task.id}$`),
    respond: () => okJson({ task, comments: [], instructions: [], runs: [], artifacts: [] }),
  }
}

function devicesHandler(): MockHandler[] {
  return [
    { method: 'GET', url: /\/devices$/, respond: () => okJson([DEVICE]) },
    { method: 'GET', url: /\/workspaces$/, respond: () => okJson([WS]) },
  ]
}

/** 记录每次指令请求的**载荷**——判据 ②③ 的关键（看发了什么，而不是看请求数）。 */
function instructionHandler(bodies: unknown[]): MockHandler {
  return {
    method: 'POST',
    url: /\/instructions$/,
    respond: (init) => {
      bodies.push(JSON.parse(String((init as RequestInit | undefined)?.body ?? '{}')))
      return okJson(
        {
          id: 'm',
          taskId: 't',
          authorUserId: BOB.userId,
          body: 'x',
          createdAt: new Date().toISOString(),
          kind: 'instruction',
          targetAgentId: null,
          runId: null,
          instructionState: 'pending',
          instructionErrorCode: null,
          instructionErrorMessage: null,
          outcome: 'started_run',
        },
        201,
      )
    },
  }
}

/** 责任人视角渲染任务房间（设备/工作区两个接口都可用）。 */
function renderAsAssignee(bodies: unknown[]): void {
  const task = makeTask({ assigneeUserId: BOB.userId })
  renderApp(
    `/tasks/${task.id}`,
    loggedInHandlers(BOB, [
      roomHandler(task),
      instructionHandler(bodies),
      teamMembersHandler([]),
      ...devicesHandler(),
    ]),
  )
}

describe('执行目标条（⑥c）', () => {
  it('自动解析时一个目标字段都不发（发了就等于把「自动」钉死成某台机器）', async () => {
    const user = userEvent.setup()
    const bodies: unknown[] = []
    renderAsAssignee(bodies)
    expect(await screen.findByTestId('target-mode')).toHaveTextContent('自动选')
    await user.type(await screen.findByLabelText('指令'), '跑一遍')
    await user.click(screen.getByRole('button', { name: '发送指令' }))
    await waitFor(() => expect(bodies).toHaveLength(1))
    expect(bodies[0]).toEqual({ text: '跑一遍' })
  })

  it('显式指定设备与工作区后，载荷带上两者', async () => {
    const user = userEvent.setup()
    const bodies: unknown[] = []
    renderAsAssignee(bodies)
    await selectOption(user, '指定设备', DEVICE.name)
    expect(await screen.findByTestId('target-mode')).toHaveTextContent('显式指定')
    await selectOption(user, '工作区', WS.name)
    await user.type(await screen.findByLabelText('指令'), '跑一遍')
    await user.click(screen.getByRole('button', { name: '发送指令' }))
    await waitFor(() => expect(bodies).toHaveLength(1))
    expect(bodies[0]).toEqual({ text: '跑一遍', deviceId: DEVICE.id, workspaceId: WS.workspaceId })
  })

  it('「回到自动」后不再带目标字段（可以退回自动解析）', async () => {
    const user = userEvent.setup()
    const bodies: unknown[] = []
    renderAsAssignee(bodies)
    await selectOption(user, '指定设备', DEVICE.name)
    await user.click(await screen.findByRole('button', { name: '回到自动' }))
    expect(await screen.findByTestId('target-mode')).toHaveTextContent('自动选')
    await user.type(await screen.findByLabelText('指令'), '跑一遍')
    await user.click(screen.getByRole('button', { name: '发送指令' }))
    await waitFor(() => expect(bodies).toHaveLength(1))
    expect(bodies[0]).toEqual({ text: '跑一遍' })
  })

  it('被授权成员看到的是只读说明，没有任何可操作的目标控件', async () => {
    const task = makeTask({ assigneeUserId: 'someone-else' })
    renderApp(
      `/tasks/${task.id}`,
      loggedInHandlers(ALICE, [roomHandler(task), teamMembersHandler([]), ...devicesHandler()]),
    )
    expect(await screen.findByTestId('target-readonly')).toBeVisible()
    // 只读 = 没有可操作控件（不是"控件变灰"）。
    expect(screen.queryByTestId('target-bar')).toBeNull()
    expect(screen.queryByLabelText('指定设备')).toBeNull()
    expect(screen.queryByLabelText('设备')).toBeNull()
    expect(screen.queryByLabelText('工作区')).toBeNull()
    expect(task.assigneeUserId).toBe('someone-else') // 夹具前提：我确实不是责任人
  })

  // 诚实标注（别假装验过）：**没有**断言"非责任人不发起 /devices 请求"。
  // 本分支上旧启动器 `RunLauncher` 仍在执行栏里，它自己就会拉设备与工作区，所以按请求计数
  // 无法把行为归因到目标条（我第一版就是这么写的，实测 `seen = ['devices','workspaces']`，
  // 归因不成立——既不是目标条违规，也不说明这条性质不成立）。等后续片把 RunLauncher 从
  // 执行栏移除后，这条断言才可归因，届时应补上。
})
