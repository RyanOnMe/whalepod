/**
 * 执行目标条（切片⑥c）。
 *
 * 判据围绕四件必须成立的事，而不是"选择器画出来了"：
 *   ① **权限形态**：目标条只对责任人可操作；被授权成员看到只读说明
 *      （`GET /devices` 只列自己的设备，而执行永远用责任人的设备与凭据，见 ③c-2b）；
 *   ② **UI 说的话与载荷一致**（评审 B1 的教训）：chip 上写"钉住了什么"，载荷里就必须真带着它。
 *      只选设备、还没选工作区时 chip 说的是「指定设备（工作区自动选）」，载荷必须带 `deviceId`
 *      ——原先这一态两者都不发，等于让用户以为钉死了设备 A，实际可能落在 B 上；
 *   ③ **自动解析时一个目标字段都不发**（发了就等于把"自动"钉死成某台机器，与 ADR-0010 决策 3 相反）；
 *   ④ **回到自动**后不再带目标字段。
 *
 * 关于归因（评审纠正过我一次）：**非责任人不发设备/工作区请求**这条性质，我原先以"旧启动器
 * `RunLauncher` 也在拉、请求计数无法归因"为由没写判据——评审指出该理由不成立：**单独挂载
 * `TargetPicker`**（不经过整页）就能干净归因。本文件最后一条就是这么写的。
 */
import { render, screen, waitFor } from '@testing-library/react'
import { userEvent } from '@testing-library/user-event'
import { QueryClientProvider } from '@tanstack/react-query'
import { describe, expect, it } from 'vitest'
import { ALICE, BOB, loggedInHandlers, makeTask, teamMembersHandler } from './fixtures.js'
import type { MockHandler } from './fixtures.js'
import { makeQueryClient } from '../src/app/query-client.js'
import { TargetPicker } from '../src/features/task/TargetPicker.js'
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
const OTHER_DEVICE = {
  id: 'dev-2',
  name: '老张的 Mac mini',
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
const OTHER_WS = {
  workspaceId: 'ws-2',
  deviceId: 'dev-2',
  name: '~/work/other',
  kind: 'directory',
  available: true,
}

const okJson = (data: unknown, status = 200): Response =>
  new Response(JSON.stringify({ ok: true, data }), { status })

/**
 * 任务房间聚合。**必须传入同一份 task 对象**：`makeTask()` 每次调用生成新 id，路径与 handler
 * 各造一个就会对不上（第一版就是这么写的：4 条用例全挂在"页面没渲染"）。
 */
function roomHandler(task: ReturnType<typeof makeTask>): MockHandler {
  return {
    method: 'GET',
    url: new RegExp(`/api/v1/tasks/${task.id}$`),
    respond: () => okJson({ task, comments: [], instructions: [], runs: [], artifacts: [] }),
  }
}

function infraHandlers(): MockHandler[] {
  return [
    { method: 'GET', url: /\/devices$/, respond: () => okJson([DEVICE, OTHER_DEVICE]) },
    { method: 'GET', url: /\/workspaces$/, respond: () => okJson([WS, OTHER_WS]) },
  ]
}

/** 记录每次指令请求的**载荷**——判据 ②③④ 的关键（看发了什么，而不是看请求数）。 */
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
      ...infraHandlers(),
    ]),
  )
}

async function sendInstruction(user: ReturnType<typeof userEvent.setup>): Promise<void> {
  await user.type(await screen.findByLabelText('指令'), '跑一遍')
  await user.click(screen.getByRole('button', { name: '发送指令' }))
}

describe('执行目标条（⑥c）', () => {
  it('自动解析时一个目标字段都不发（发了就等于把「自动」钉死成某台机器）', async () => {
    const user = userEvent.setup()
    const bodies: unknown[] = []
    renderAsAssignee(bodies)
    expect(await screen.findByTestId('target-mode')).toHaveTextContent('自动选')
    await sendInstruction(user)
    await waitFor(() => expect(bodies).toHaveLength(1))
    expect(bodies[0]).toEqual({ text: '跑一遍' })
  })

  it('只选设备（工作区还没选）：chip 如实说「指定设备（工作区自动选）」，载荷**必须带 deviceId**', async () => {
    // 评审 B1 的回归钉：原先这一态 chip 写「显式指定」而载荷里一个目标字段都没有——
    // 用户以为钉死了设备 A，实际可能落在"沿用上一轮"的 B 上。chip 与载荷必须一致。
    const user = userEvent.setup()
    const bodies: unknown[] = []
    renderAsAssignee(bodies)
    await selectOption(user, '指定设备', DEVICE.name)
    expect(await screen.findByTestId('target-mode')).toHaveTextContent('指定设备（工作区自动选）')
    await sendInstruction(user)
    await waitFor(() => expect(bodies).toHaveLength(1))
    expect(bodies[0]).toEqual({ text: '跑一遍', deviceId: DEVICE.id })
  })

  it('设备与工作区都选定：chip 说「显式指定」，载荷带上两者', async () => {
    const user = userEvent.setup()
    const bodies: unknown[] = []
    renderAsAssignee(bodies)
    await selectOption(user, '指定设备', DEVICE.name)
    await selectOption(user, '工作区', WS.name)
    const chip = await screen.findByTestId('target-mode')
    expect(chip).toHaveTextContent('显式指定')
    // 视觉区分必须有判据（评审 M6：去掉 `target-mode-explicit` 类时全绿）——
    // CSS 注释自己写着"显式指定与自动选必须一眼可分"，光断言文案钉不住它。
    expect(chip).toHaveClass('target-mode-explicit')
    await sendInstruction(user)
    await waitFor(() => expect(bodies).toHaveLength(1))
    expect(bodies[0]).toEqual({ text: '跑一遍', deviceId: DEVICE.id, workspaceId: WS.workspaceId })
  })

  it('显式态**换设备**会重置工作区（工作区属于设备，留着会组成不存在的组合）', async () => {
    // 评审指出这条 handler 此前没有任何判据走过（把它改成保留旧工作区仍 4/4 全绿）。
    const user = userEvent.setup()
    const bodies: unknown[] = []
    renderAsAssignee(bodies)
    await selectOption(user, '指定设备', DEVICE.name)
    await selectOption(user, '工作区', WS.name)
    await selectOption(user, '设备', OTHER_DEVICE.name)
    // 换设备后工作区被清掉 ⇒ 回到"只钉住设备"那一态（chip 也要跟着变）
    expect(await screen.findByTestId('target-mode')).toHaveTextContent('指定设备（工作区自动选）')
    await sendInstruction(user)
    await waitFor(() => expect(bodies).toHaveLength(1))
    expect(bodies[0]).toEqual({ text: '跑一遍', deviceId: OTHER_DEVICE.id })
  })

  it('「回到自动」后不再带目标字段（可以退回自动解析）', async () => {
    const user = userEvent.setup()
    const bodies: unknown[] = []
    renderAsAssignee(bodies)
    await selectOption(user, '指定设备', DEVICE.name)
    await user.click(await screen.findByRole('button', { name: '回到自动' }))
    expect(await screen.findByTestId('target-mode')).toHaveTextContent('自动选')
    await sendInstruction(user)
    await waitFor(() => expect(bodies).toHaveLength(1))
    expect(bodies[0]).toEqual({ text: '跑一遍' })
  })

  it('有活跃 Run 时**明说目标暂不生效**（服务端只带 text 走追问，会忽略目标字段）', async () => {
    // 评审 O5：有活跃 Run 的追问路径完全忽略 deviceId/workspaceId（instruction.ts 的 sendRunFollowup），
    // 而目标条原先照样可操作、一个字都不说——用户会以为自己刚选的设备生效了。
    const user = userEvent.setup()
    const bodies: unknown[] = []
    const task = makeTask({ assigneeUserId: BOB.userId })
    const activeRun = {
      id: 'run-1',
      status: 'running',
      createdAt: new Date().toISOString(),
      startedAt: new Date().toISOString(),
      finishedAt: null,
      rerunOfRunId: null,
    }
    renderApp(
      `/tasks/${task.id}`,
      loggedInHandlers(BOB, [
        {
          method: 'GET',
          url: new RegExp(`/api/v1/tasks/${task.id}$`),
          respond: () =>
            okJson({ task, comments: [], instructions: [], runs: [activeRun], artifacts: [] }),
        },
        instructionHandler(bodies),
        teamMembersHandler([]),
        ...infraHandlers(),
      ]),
    )
    // 自动态也要说（一进来就该知道）
    expect(await screen.findByText(/目标由该运行决定/)).toBeVisible()
    // 显式态再说一次（此刻最容易误解）
    await selectOption(user, '指定设备', DEVICE.name)
    expect(await screen.findByTestId('target-inert')).toBeVisible()
  })

  it('被授权成员看到的是只读说明，没有任何可操作的目标控件', async () => {
    const task = makeTask({ assigneeUserId: 'someone-else' })
    renderApp(
      `/tasks/${task.id}`,
      loggedInHandlers(ALICE, [roomHandler(task), teamMembersHandler([]), ...infraHandlers()]),
    )
    const readonly = await screen.findByTestId('target-readonly')
    expect(readonly).toBeVisible()
    // S2 的回归保护（评审 M18）：门的规则只锚"标点相邻"的折行，句中折行它永远看不见，
    // 所以在这里直接断言**渲染文本**——把折行放回去会让这句出现「要 换」。
    expect(readonly).toHaveTextContent('）。要换目标请找责任人。')
    // 只读 = 没有可操作控件（不是"控件变灰"）。
    expect(screen.queryByTestId('target-bar')).toBeNull()
    expect(screen.queryByLabelText('指定设备')).toBeNull()
    expect(screen.queryByLabelText('设备')).toBeNull()
    expect(screen.queryByLabelText('工作区')).toBeNull()
    expect(task.assigneeUserId).toBe('someone-else') // 夹具前提：我确实不是责任人
  })

  it('责任人**会**发起设备/工作区请求（正向对照：没有它，"0 次请求"可能只是恒真）', async () => {
    // 复核指出：单挂组件能抓"去掉 enabled"（那种变异会让非责任人用例红），但抓不到
    // "enabled 恒 false"——因为同页 RunLauncher 的三个 useQuery 没有 enabled 门、hooks 又先跑，
    // 共享缓存会把数据兜住，页面级判据看不见。这条正向对照用**同一套 harness** 证明
    // `seen` 真的会被填充：若把 enabled 写死 false，它立刻红。
    const seen: string[] = []
    const handlers: MockHandler[] = [
      {
        method: 'GET',
        url: /\/devices$/,
        respond: () => {
          seen.push('devices')
          return okJson([DEVICE])
        },
      },
      {
        method: 'GET',
        url: /\/workspaces$/,
        respond: () => {
          seen.push('workspaces')
          return okJson([WS])
        },
      },
    ]
    ;(await import('./fixtures.js')).installFetch(handlers)
    render(
      <QueryClientProvider client={makeQueryClient({ retry: false })}>
        <TargetPicker
          isAssignee
          value={null}
          onChange={() => {}}
          assigneeName="老张"
          hasActiveRun={false}
        />
      </QueryClientProvider>,
    )
    await waitFor(() => expect(seen).toContain('devices'))
    expect(seen).toContain('workspaces')
  })

  it('非责任人**不发起**设备/工作区请求（单独挂载组件，归因干净）', async () => {
    // 评审纠正：我原先认为"整页里旧启动器 RunLauncher 也在拉 ⇒ 计数无法归因"，理由不成立——
    // 单独挂载 `TargetPicker` 就绕开了整页，请求数可干净归因（评审实测：非责任人 0 次、
    // 去掉 `enabled: isAssignee` 后 1 次）。
    const seen: string[] = []
    const handlers: MockHandler[] = [
      {
        method: 'GET',
        url: /\/devices$/,
        respond: () => {
          seen.push('devices')
          return okJson([DEVICE])
        },
      },
      {
        method: 'GET',
        url: /\/workspaces$/,
        respond: () => {
          seen.push('workspaces')
          return okJson([WS])
        },
      },
    ]
    const fetchMock = (await import('./fixtures.js')).installFetch(handlers)
    render(
      <QueryClientProvider client={makeQueryClient({ retry: false })}>
        <TargetPicker
          isAssignee={false}
          value={null}
          onChange={() => {}}
          assigneeName="老张"
          hasActiveRun={false}
        />
      </QueryClientProvider>,
    )
    expect(await screen.findByTestId('target-readonly')).toBeVisible()
    // 给 react-query 一个机会（若 enabled 写错，这里会发出请求）
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(seen).toEqual([])
    expect(fetchMock.mock.calls).toHaveLength(0)
  })
})
