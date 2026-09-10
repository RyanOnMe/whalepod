/**
 * P1-13 Run 启动器与直播面板（用户视角：role/label/text 断言，mock 仅在 HTTP 层）。
 *
 * - Launcher：可见性守卫（仅已接受指派的责任人、非终态、无活跃 Run）；
 *   Agent→Revision（快照语义）→设备→Workspace 级联；提交体形状与幂等键。
 * - LivePanel：owner 见直播区与完整事件；member 无直播区（服务端已过滤，
 *   客户端呈现层也不伪造入口）；直播 delta 经 run-buffer 实时上屏。
 */
import { describe, expect, it } from 'vitest'
import { act, screen, waitFor } from '@testing-library/react'
import { userEvent } from '@testing-library/user-event'
import { renderApp } from './render.js'
import {
  ALICE,
  BOB,
  created,
  loggedInHandlers,
  makeRun,
  makeTask,
  ok,
  taskRoomHandler,
  type MockHandler,
} from './fixtures.js'
import { appendLiveDelta } from '../src/shared/realtime/run-buffer.js'
import type { RunView } from '../src/shared/api/types.js'

const AGENT_ID = 'a1a1a1a1-0000-4000-8000-00000000000a'
const REVISION_ID = 'a2a2a2a2-0000-4000-8000-00000000000b'
const DEVICE_ID = 'd1d1d1d1-0000-4000-8000-00000000000c'
const WORKSPACE_ID = 'e5e5e5e5-0000-4000-8000-00000000000d'
const RUN_ID = 'f6f6f6f6-0000-4000-8000-00000000000e'

function launcherHandlers(capture?: { body?: unknown; key?: unknown }): MockHandler[] {
  return [
    {
      method: 'GET',
      url: /\/api\/v1\/agents$/,
      respond: () =>
        ok([
          {
            id: AGENT_ID,
            name: 'Fixer',
            description: '',
            createdBy: BOB.userId,
            archivedAt: null,
            currentRevisionId: REVISION_ID,
          },
        ]),
    },
    {
      method: 'GET',
      url: new RegExp(`/api/v1/agents/${AGENT_ID}$`),
      respond: () =>
        ok({
          id: AGENT_ID,
          name: 'Fixer',
          description: '',
          createdBy: BOB.userId,
          archivedAt: null,
          currentRevisionId: REVISION_ID,
          currentRevision: null,
          revisions: [
            {
              id: REVISION_ID,
              agentId: AGENT_ID,
              revision: 3,
              persona: 'p',
              provider: 'deepseek',
              model: 'deepseek-chat',
              credentialSlot: 'default',
              maxTokens: null,
              pluginPackId: 'p1',
              profileDigest: 'b'.repeat(64),
              createdBy: BOB.userId,
              createdAt: '2026-08-25T00:00:00.000Z',
            },
          ],
        }),
    },
    {
      method: 'GET',
      url: /\/api\/v1\/devices$/,
      respond: () =>
        ok([
          {
            id: DEVICE_ID,
            name: 'm4-mini',
            platform: 'darwin',
            status: 'online',
            dshDistributionVersion: '0.1.0-rc.8',
            lastSeenAt: '2026-08-25T00:00:00.000Z',
          },
        ]),
    },
    {
      method: 'GET',
      url: /\/api\/v1\/workspaces$/,
      respond: () =>
        ok([
          {
            workspaceId: WORKSPACE_ID,
            deviceId: DEVICE_ID,
            name: 'whalepod',
            kind: 'directory',
            available: true,
          },
        ]),
    },
    {
      method: 'POST',
      url: /\/api\/v1\/tasks\/[^/]+\/runs$/,
      respond: (init) => {
        if (capture !== undefined) {
          capture.body = JSON.parse(String(init.body))
          capture.key = (init.headers as Record<string, string>)['idempotency-key']
        }
        return created({ id: RUN_ID })
      },
    },
  ]
}

function runDetailHandlers(ownerUserId: string, events: unknown[]): MockHandler[] {
  const run: RunView = {
    id: RUN_ID,
    taskId: 'task-1',
    ownerUserId,
    agentId: AGENT_ID,
    profileRevisionId: REVISION_ID,
    deviceId: DEVICE_ID,
    workspaceId: WORKSPACE_ID,
    status: 'running',
    dshSessionId: null,
    failureCode: null,
    failureSummary: null,
    rerunOfRunId: null,
    profileDigest: 'b'.repeat(64),
    createdAt: '2026-08-25T00:00:00.000Z',
    startedAt: '2026-08-25T00:01:00.000Z',
    finishedAt: null,
  }
  return [
    { method: 'GET', url: new RegExp(`/api/v1/runs/${RUN_ID}$`), respond: () => ok(run) },
    {
      method: 'GET',
      url: new RegExp(`/api/v1/runs/${RUN_ID}/events`),
      respond: () => ok({ events }),
    },
  ]
}

describe('RunLauncher', () => {
  it('已接受指派的责任人可见启动器；级联选择后提交正确载荷与幂等键', async () => {
    const task = makeTask({
      assigneeUserId: BOB.userId,
      assignmentStatus: 'accepted',
      status: 'in_progress',
    })
    const capture: { body?: unknown; key?: unknown } = {}
    const user = userEvent.setup()
    renderApp(
      `/tasks/${task.id}`,
      loggedInHandlers(BOB, [taskRoomHandler(task), ...launcherHandlers(capture)]),
    )

    // 级联：选 Agent → Revision 选项出现（缺省钉住当前 Revision）→ 设备 → Workspace。
    const agentSelect = await screen.findByLabelText('选择 Agent')
    await screen.findByRole('option', { name: 'Fixer' }) // 等 agents 查询落地
    await user.selectOptions(agentSelect, AGENT_ID)
    await waitFor(() => expect(screen.getByLabelText('选择 Revision')).toHaveValue(REVISION_ID))
    await screen.findByRole('option', { name: /m4-mini/ })
    await user.selectOptions(screen.getByLabelText('选择设备'), DEVICE_ID)
    await screen.findByRole('option', { name: 'whalepod' })
    await user.selectOptions(screen.getByLabelText('选择 Workspace'), WORKSPACE_ID)
    await user.type(screen.getByLabelText('Run prompt'), '把登录页修好')

    const submit = screen.getByRole('button', { name: '启动 Run' })
    expect(submit).toBeEnabled()
    await user.click(submit)

    await waitFor(() => expect(capture.body).toBeDefined())
    expect(capture.body).toEqual({
      agentId: AGENT_ID,
      profileRevisionId: REVISION_ID,
      deviceId: DEVICE_ID,
      workspaceId: WORKSPACE_ID,
      prompt: '把登录页修好',
    })
    expect(typeof capture.key).toBe('string')
  })

  it('非责任人不见启动器；有活跃 Run 时责任人也不见（一任务一活跃）', async () => {
    const task = makeTask({
      assigneeUserId: ALICE.userId,
      assignmentStatus: 'accepted',
      status: 'in_progress',
    })
    renderApp(`/tasks/${task.id}`, loggedInHandlers(BOB, [taskRoomHandler(task)]))
    expect(await screen.findByRole('heading', { name: 'Run' })).toBeVisible()
    expect(screen.queryByRole('heading', { name: '启动 Run' })).not.toBeInTheDocument()

    // 责任人自己有活跃 Run 时同样不可见。
    const task2 = makeTask({
      assigneeUserId: BOB.userId,
      assignmentStatus: 'accepted',
      status: 'in_progress',
    })
    renderApp(
      `/tasks/${task2.id}`,
      loggedInHandlers(BOB, [
        taskRoomHandler(task2, { runs: [makeRun({ status: 'running' })] }),
        ...launcherHandlers(),
      ]),
    )
    expect(await screen.findByText('运行中')).toBeVisible()
    expect(screen.queryByRole('heading', { name: '启动 Run' })).not.toBeInTheDocument()
  })
})

describe('RunLivePanel', () => {
  it('owner：选中 Run 后出现直播区与事件列表；live delta 实时上屏', async () => {
    const task = makeTask({ assigneeUserId: BOB.userId, assignmentStatus: 'accepted' })
    const run = makeRun({ id: RUN_ID, status: 'running' })
    const user = userEvent.setup()
    renderApp(
      `/tasks/${task.id}`,
      loggedInHandlers(BOB, [
        taskRoomHandler(task, { runs: [run] }),
        ...runDetailHandlers(BOB.userId, [
          {
            runId: RUN_ID,
            seq: 1,
            type: 'run.phase',
            audience: 'project',
            event: { type: 'run.phase', phase: 'thinking' },
            occurredAt: '2026-08-25T02:00:01.000Z',
            receivedAt: '2026-08-25T02:00:01.100Z',
          },
        ]),
      ]),
    )

    await user.click(await screen.findByRole('button', { name: /Run f6f6f6f6/ }))
    expect(await screen.findByText('实时输出')).toBeVisible()
    expect(await screen.findByText('阶段：思考中')).toBeVisible()

    // live delta 经缓冲实时上屏（不落库）。
    act(() => {
      appendLiveDelta(RUN_ID, 1, 'Hello, ')
      appendLiveDelta(RUN_ID, 2, 'world')
    })
    expect(screen.getByTestId('run-live-text')).toHaveTextContent('Hello, world')
  })

  it('member：无直播区；事件列表呈现服务端过滤后的 project 行', async () => {
    const task = makeTask({ assigneeUserId: BOB.userId, assignmentStatus: 'accepted' })
    const run = makeRun({ id: RUN_ID, status: 'running' })
    const user = userEvent.setup()
    renderApp(
      `/tasks/${task.id}`,
      loggedInHandlers(ALICE, [
        taskRoomHandler(task, { runs: [run] }),
        ...runDetailHandlers(BOB.userId, [
          {
            runId: RUN_ID,
            seq: 1,
            type: 'run.phase',
            audience: 'project',
            event: { type: 'run.phase', phase: 'tool' },
            occurredAt: '2026-08-25T02:00:01.000Z',
            receivedAt: '2026-08-25T02:00:01.100Z',
          },
          {
            runId: RUN_ID,
            seq: 2,
            type: 'approval.requested',
            audience: 'project',
            event: {
              type: 'approval.requested',
              approval: { reason: '', preview: { category: 'shell' } },
            },
            occurredAt: '2026-08-25T02:00:02.000Z',
            receivedAt: '2026-08-25T02:00:02.100Z',
          },
        ]),
      ]),
    )

    await user.click(await screen.findByRole('button', { name: /Run f6f6f6f6/ }))
    expect(await screen.findByText('阶段：工具执行中')).toBeVisible()
    // project 缩水卡：reason 恒空 → 固定文案，不显示空框（03 §8）。
    expect(screen.getByText('等待责任人批准')).toBeVisible()
    // member 视角无直播区入口（Hub 扇出已保证收不到，呈现层同样不出现）。
    expect(screen.queryByText('实时输出')).not.toBeInTheDocument()
    // live delta 即使意外进入缓冲也不呈现给非 owner（无订阅者）。
    act(() => {
      appendLiveDelta(RUN_ID, 1, 'should-not-render')
    })
    expect(screen.queryByText('should-not-render')).not.toBeInTheDocument()
  })
})
