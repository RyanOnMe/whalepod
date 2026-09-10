/**
 * Run 行动与失败呈现（P1-16 G7-04 UI 血缘 / G7-05 未知副作用警示；02 Task 16 Step 6）。
 *
 * 用户视角断言（mock 仅在 HTTP 层）：
 * - 活跃 Run 显示「取消」；点击走真人路径 POST /runs/:id/cancel，携带 Idempotency-Key；
 * - 终态 Run 显示「重跑」；确认后 POST /tasks/:taskId/runs 带 rerunOfRunId 指向旧
 *   Run（血缘），重复确认用同一 Idempotency-Key；
 * - failed/lost Run 明示「需验证外部状态」，绝不声称会自动重放/安全恢复；
 * - 时间线用 rerunOfRunId 显示「由 Run xx 重跑」。
 */
import { describe, expect, it } from 'vitest'
import { cleanup, screen, waitFor } from '@testing-library/react'
import { userEvent } from '@testing-library/user-event'
import { renderApp } from './render.js'
import {
  BOB,
  created,
  loggedInHandlers,
  makeRun,
  makeTask,
  ok,
  taskRoomHandler,
  type MockHandler,
} from './fixtures.js'
import type { RunView } from '../src/shared/api/types.js'

const RUN_ID = 'f6f6f6f6-0000-4000-8000-00000000000e'
const SOURCE_RUN_ID = 'b7b7b7b7-0000-4000-8000-0000000000b7'
const AGENT_ID = 'a1a1a1a1-0000-4000-8000-00000000000a'
const REVISION_ID = 'a2a2a2a2-0000-4000-8000-00000000000b'
const DEVICE_ID = 'd1d1d1d1-0000-4000-8000-00000000000c'
const WORKSPACE_ID = 'e5e5e5e5-0000-4000-8000-00000000000d'

function makeRunView(overrides: Partial<RunView> = {}): RunView {
  return {
    id: RUN_ID,
    taskId: 'task-1',
    ownerUserId: BOB.userId,
    agentId: AGENT_ID,
    profileRevisionId: REVISION_ID,
    deviceId: DEVICE_ID,
    workspaceId: WORKSPACE_ID,
    status: 'failed',
    dshSessionId: null,
    failureCode: 'RUNTIME_LOST',
    failureSummary: 'runtime exited unexpectedly (code=1)',
    rerunOfRunId: null,
    profileDigest: 'b'.repeat(64),
    createdAt: '2026-08-25T00:00:00.000Z',
    startedAt: '2026-08-25T00:01:00.000Z',
    finishedAt: '2026-08-25T00:02:00.000Z',
    ...overrides,
  }
}

function runDetailHandlers(
  run: RunView,
  events: unknown[] = [],
  captures: {
    cancelCalls?: Array<{ key?: string | null }>
    rerunBodies?: unknown[]
    rerunKeys?: Array<string | null>
  } = {},
): MockHandler[] {
  return [
    { method: 'GET', url: new RegExp(`/api/v1/runs/${run.id}$`), respond: () => ok(run) },
    {
      method: 'GET',
      url: new RegExp(`/api/v1/runs/${run.id}/events`),
      respond: () => ok({ events }),
    },
    {
      method: 'POST',
      url: new RegExp(`/api/v1/runs/${run.id}/cancel$`),
      respond: (init) => {
        const headers = init.headers as Record<string, string> | undefined
        captures.cancelCalls?.push({
          key: headers?.['idempotency-key'] ?? null,
        })
        return ok({ ...run, status: 'cancel_requested' })
      },
    },
    {
      method: 'POST',
      url: /\/api\/v1\/tasks\/task-1\/runs$/,
      respond: (init) => {
        captures.rerunBodies?.push(JSON.parse(String(init.body ?? '{}')))
        const headers = init.headers as Record<string, string> | undefined
        captures.rerunKeys?.push(headers?.['idempotency-key'] ?? null)
        return created({ ...run, id: SOURCE_RUN_ID, status: 'queued' })
      },
    },
  ]
}

function taskWith(runs: ReturnType<typeof makeRun>[]) {
  return makeTask({
    assigneeUserId: BOB.userId,
    assignmentStatus: 'accepted',
    status: 'in_progress',
  })
}

describe('G7-05: failed/lost Run 的未知副作用警示', () => {
  it('failed Run 显示失败码与「需验证外部状态」；不声称自动重放或安全恢复', async () => {
    const task = taskWith([])
    const user = userEvent.setup()
    renderApp(
      `/tasks/${task.id}`,
      loggedInHandlers(BOB, [
        taskRoomHandler(task, { runs: [makeRun({ id: RUN_ID, status: 'failed' })] }),
        ...runDetailHandlers(makeRunView({ status: 'failed' })),
      ]),
    )

    await user.click(await screen.findByRole('button', { name: /第 1 次运行/ }))
    const banner = await screen.findByTestId('run-failure-notice')
    expect(banner).toBeVisible()
    expect(banner).toHaveTextContent('需验证外部状态')
    expect(banner).toHaveTextContent('RUNTIME_LOST')
    // 红线：绝不声称「会自动重放/已安全恢复」。
    expect(banner.textContent).not.toMatch(/自动重放这些操作并继续|已安全恢复|安全重放/)
    // 明示重跑语义：全新 Run、不自动重放上一次的工具调用。
    expect(banner.textContent).toMatch(/不会自动重放/)
  })

  it('lost Run 同样警示；completed Run 不出现警示', async () => {
    const task = taskWith([])
    const user = userEvent.setup()
    renderApp(
      `/tasks/${task.id}`,
      loggedInHandlers(BOB, [
        taskRoomHandler(task, { runs: [makeRun({ id: RUN_ID, status: 'lost' })] }),
        ...runDetailHandlers(makeRunView({ status: 'lost', failureCode: 'RUNTIME_LOST' })),
      ]),
    )
    await user.click(await screen.findByRole('button', { name: /第 1 次运行/ }))
    expect(await screen.findByTestId('run-failure-notice')).toHaveTextContent('需验证外部状态')

    // completed：无警示（先卸载上一棵树，避免同文档残留干扰查询）。
    cleanup()
    renderApp(
      `/tasks/${task.id}`,
      loggedInHandlers(BOB, [
        taskRoomHandler(task, { runs: [makeRun({ id: RUN_ID, status: 'completed' })] }),
        ...runDetailHandlers(
          makeRunView({ status: 'completed', failureCode: null, failureSummary: null }),
        ),
      ]),
    )
    await user.click(await screen.findByRole('button', { name: /第 1 次运行/ }))
    await waitFor(() => expect(screen.getByText('事件')).toBeVisible())
    expect(screen.queryByTestId('run-failure-notice')).not.toBeInTheDocument()
  })
})

describe('G7-04: UI 血缘与 Run 行动', () => {
  it('#162 血缘说「重跑自第 N 次运行」，原始 id 退到 title（不再拿短 id 当标签）', async () => {
    const task = taskWith([])
    renderApp(
      `/tasks/${task.id}`,
      loggedInHandlers(BOB, [
        taskRoomHandler(task, {
          runs: [
            makeRun({ id: SOURCE_RUN_ID, status: 'failed' }),
            makeRun({ id: RUN_ID, status: 'queued', rerunOfRunId: SOURCE_RUN_ID }),
          ],
        }),
        ...runDetailHandlers(makeRunView()),
      ]),
    )
    const lineage = await screen.findByTestId('run-lineage')
    expect(lineage).toBeVisible()
    // 来源是第 1 次运行（本用例里 SOURCE_RUN_ID 在前）→ 血缘句带上这个序号。
    expect(lineage).toHaveTextContent('重跑自第 1 次运行')
    // 原始 id 不丢：悬停可见（title）；正文里不得出现它的短形态。
    expect(lineage).toHaveAttribute('title', SOURCE_RUN_ID)
    // 行标签是「第 N 次运行」这种人话句柄，短 id 同样不冒充标签。
    expect(screen.getByRole('button', { name: /第 2 次运行/ })).toBeVisible()
    const body = document.body.textContent ?? ''
    expect(body).not.toContain(SOURCE_RUN_ID.slice(0, 8))
    expect(body).not.toContain(RUN_ID.slice(0, 8))
  })

  it('活跃 Run 显示「取消」；点击后走 cancel 路由并带 Idempotency-Key', async () => {
    const task = taskWith([])
    const captures: { cancelCalls: Array<{ key?: string | null }> } = {
      cancelCalls: [],
    }
    const user = userEvent.setup()
    renderApp(
      `/tasks/${task.id}`,
      loggedInHandlers(BOB, [
        taskRoomHandler(task, { runs: [makeRun({ id: RUN_ID, status: 'running' })] }),
        ...runDetailHandlers(makeRunView({ status: 'running' }), [], captures),
      ]),
    )
    await user.click(await screen.findByRole('button', { name: /第 1 次运行/ }))
    const cancel = await screen.findByRole('button', { name: '取消 Run' })
    await user.click(cancel)
    await waitFor(() => expect(captures.cancelCalls).toHaveLength(1))
    expect(captures.cancelCalls[0]?.key).toBeTruthy()
    expect(captures.cancelCalls[0]?.key?.length).toBeGreaterThanOrEqual(16)
  })

  it('终态 Run 显示「重跑」；确认后 POST 携带 rerunOfRunId 指旧 Run；重复确认同幂等键', async () => {
    const task = taskWith([])
    const captures: { rerunBodies: unknown[]; rerunKeys: Array<string | null> } = {
      rerunBodies: [],
      rerunKeys: [],
    }
    const user = userEvent.setup()
    renderApp(
      `/tasks/${task.id}`,
      loggedInHandlers(BOB, [
        taskRoomHandler(task, { runs: [makeRun({ id: RUN_ID, status: 'failed' })] }),
        ...runDetailHandlers(makeRunView({ status: 'failed' }), [], captures),
      ]),
    )
    await user.click(await screen.findByRole('button', { name: /第 1 次运行/ }))
    await user.click(await screen.findByRole('button', { name: '重跑此 Run' }))

    const promptBox = await screen.findByLabelText('新 Run 的指令')
    await user.type(promptBox, '重试并修复上次的问题')
    const confirm = screen.getByRole('button', { name: '确认重跑' })
    await user.click(confirm)
    await user.click(confirm) // 重复点击：同一 Idempotency-Key（服务端幂等去重）
    await waitFor(() => expect(captures.rerunBodies.length).toBeGreaterThanOrEqual(1))

    const body = captures.rerunBodies[0] as Record<string, unknown>
    expect(body).toMatchObject({
      agentId: AGENT_ID,
      deviceId: DEVICE_ID,
      workspaceId: WORKSPACE_ID,
      rerunOfRunId: RUN_ID,
      prompt: '重试并修复上次的问题',
    })
    expect(captures.rerunKeys[0]).toBeTruthy()
    for (const key of captures.rerunKeys) {
      expect(key).toBe(captures.rerunKeys[0])
    }
  })

  it('成员（非 owner）看不到取消/重跑动作', async () => {
    const task = taskWith([])
    const aliceSession = {
      userId: 'aaaaaaaa-0000-4000-8000-000000000001',
      username: 'alice',
      displayName: 'Alice',
      role: 'member' as const,
    }
    const user = userEvent.setup()
    renderApp(
      `/tasks/${task.id}`,
      loggedInHandlers(aliceSession, [
        taskRoomHandler(task, { runs: [makeRun({ id: RUN_ID, status: 'running' })] }),
        ...runDetailHandlers(makeRunView({ status: 'running', ownerUserId: BOB.userId })),
      ]),
    )
    await user.click(await screen.findByRole('button', { name: /第 1 次运行/ }))
    await screen.findByText('事件')
    expect(screen.queryByRole('button', { name: '取消 Run' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: '重跑此 Run' })).not.toBeInTheDocument()
  })
})
