/**
 * 审批档位（#241；ADR-0009 决策 7）——Web 组件面。
 *
 * 判据：
 * - Agent/Revision 表单带默认档下拉（缺省 approval_required），提交体带 approvalPolicy；
 * - TaskPermissionsPage：覆盖状态如实陈述（未覆盖=跟随 Revision 默认 / 已覆盖=固定），
 *   仅责任人可改，full_access 走确认对话框；PATCH body 的值/null 语义；
 * - RunLauncher：解析结果（Task 覆盖 ?? 所选 Revision 默认）为 full_access 时先出
 *   提示与确认对话框，确认才发 POST；
 * - 运行卡：full_access 的 Run 显著标记「完全权限」。
 */
import { screen, waitFor } from '@testing-library/react'
import { userEvent } from '@testing-library/user-event'
import { describe, expect, it } from 'vitest'
import type { AgentDetailView, TaskView } from '../src/shared/api/types.js'
import {
  ALICE,
  BOB,
  agentsHandler,
  devicesHandler,
  loggedInHandlers,
  makeMember,
  makeRun,
  makeTask,
  ok,
  packsHandler,
  teamMembersHandler,
  taskRoomHandler,
  workspacesHandler,
  type MockHandler,
} from './fixtures.js'
import { renderApp } from './render.jsx'
import { selectOption } from './select-menu.js'

const AGENT_ID = '22222222-0000-4000-8000-00000000000a'
const DEVICE_ID = '77777777-0000-4000-8000-00000000000d'
const WORKSPACE_ID = '88888888-0000-4000-8000-00000000000w'

const CORE_PACK = {
  id: 'eeeeeeee-0000-4000-8000-000000000001',
  name: 'core-empty',
  packDigest: 'f'.repeat(64),
  installations: [],
  entries: [],
  createdBy: ALICE.userId,
  createdAt: '2026-08-25T00:00:00.000Z',
}

function agentDetail(approvalPolicy: 'approval_required' | 'full_access'): AgentDetailView {
  const revision = {
    id: 'rev-1',
    agentId: AGENT_ID,
    revision: 1,
    persona: 'p',
    provider: 'dsh',
    model: 'test-model',
    credentialSlot: 'api_key',
    maxTokens: null,
    approvalPolicy,
    pluginPackId: 'eeeeeeee-0000-4000-8000-000000000001',
    profileDigest: 'a'.repeat(64),
    createdBy: ALICE.userId,
    createdAt: '2026-08-25T00:00:00.000Z',
  }
  return {
    id: AGENT_ID,
    name: 'report-writer',
    description: '',
    createdBy: ALICE.userId,
    archivedAt: null,
    currentRevisionId: revision.id,
    currentRevision: revision,
    revisions: [revision],
  }
}

function agentDetailHandlers(detail: AgentDetailView): MockHandler[] {
  return [
    agentsHandler([detail]),
    {
      method: 'GET',
      url: new RegExp(`/api/v1/agents/${AGENT_ID}$`),
      respond: () => ok(detail),
    },
  ]
}

describe('#241 Agent 表单：默认审批档', () => {
  it('新建 Agent 表单带档位下拉（缺省 approval_required），提交体带 approvalPolicy', async () => {
    const captures: { bodies: unknown[] } = { bodies: [] }
    const user = userEvent.setup()
    renderApp(
      '/agents',
      loggedInHandlers(ALICE, [
        agentsHandler([]),
        packsHandler([CORE_PACK]),
        {
          method: 'POST',
          url: /\/api\/v1\/agents$/,
          respond: (init) => {
            captures.bodies.push(JSON.parse(String(init.body ?? '{}')))
            return ok({ id: 'new-agent' })
          },
        },
      ]),
    )
    // Owner 视角：新建表单常驻（无需展开）。
    await user.type(await screen.findByLabelText('名称'), 'writer')
    await user.type(await screen.findByLabelText('人格设定（Persona）'), 'careful writer')
    await selectOption(user, /插件组合/, 'core-empty')

    const policyTrigger = await screen.findByLabelText('选择审批档位')
    expect(policyTrigger).toHaveTextContent('每次工具调用需批准（默认）')
    await selectOption(user, '选择审批档位', '完全权限（工具调用直接放行）')
    await user.click(screen.getByRole('button', { name: '创建 Agent' }))
    await waitFor(() => expect(captures.bodies).toHaveLength(1))
    expect(captures.bodies[0]).toMatchObject({ approvalPolicy: 'full_access' })
  })
})

describe('#241 TaskPermissionsPage：审批档位块', () => {
  const task = (overrides: Partial<TaskView> = {}): TaskView =>
    makeTask({ assigneeUserId: BOB.userId, assignmentStatus: 'accepted', ...overrides })

  it('未覆盖状态如实陈述；责任人改 full_access 走确认对话框；PATCH body 带值', async () => {
    const captures: { bodies: unknown[] } = { bodies: [] }
    const user = userEvent.setup()
    const t = task()
    renderApp(
      `/tasks/${t.id}/permissions`,
      loggedInHandlers(BOB, [
        taskRoomHandler(t),
        teamMembersHandler([makeMember(BOB), makeMember(ALICE)]),
        {
          method: 'GET',
          url: new RegExp(`/api/v1/tasks/${t.id}/instruction-grants$`),
          respond: () => ok([]),
        },
        {
          method: 'PATCH',
          url: new RegExp(`/api/v1/tasks/${t.id}$`),
          respond: (init) => {
            captures.bodies.push(JSON.parse(String(init.body ?? '{}')))
            return ok({ ...t, approvalPolicy: 'full_access' })
          },
        },
      ]),
    )
    expect(await screen.findByTestId('approval-policy-state')).toHaveTextContent('未覆盖')

    await selectOption(user, '选择审批档覆盖', '完全权限（工具调用直接放行）')
    await user.click(screen.getByTestId('approval-policy-apply'))
    // full_access 必须先过确认对话框（显式放权）。
    const dialog = await screen.findByRole('dialog')
    expect(dialog).toHaveTextContent('不再逐次请求批准')
    await user.click(screen.getByRole('button', { name: '确认放行完全权限' }))
    await waitFor(() => expect(captures.bodies).toHaveLength(1))
    expect(captures.bodies[0]).toEqual({ approvalPolicy: 'full_access' })
  })

  it('已覆盖状态陈述「不跟随 Revision 默认」；清除（继承）发 null；非责任人无控件', async () => {
    const captures: { bodies: unknown[] } = { bodies: [] }
    const user = userEvent.setup()
    const t = task({ approvalPolicy: 'full_access' })
    renderApp(
      `/tasks/${t.id}/permissions`,
      loggedInHandlers(BOB, [
        taskRoomHandler(t),
        teamMembersHandler([makeMember(BOB), makeMember(ALICE)]),
        {
          method: 'GET',
          url: new RegExp(`/api/v1/tasks/${t.id}/instruction-grants$`),
          respond: () => ok([]),
        },
        {
          method: 'PATCH',
          url: new RegExp(`/api/v1/tasks/${t.id}$`),
          respond: (init) => {
            captures.bodies.push(JSON.parse(String(init.body ?? '{}')))
            return ok({ ...t, approvalPolicy: null })
          },
        },
      ]),
    )
    expect(await screen.findByTestId('approval-policy-state')).toHaveTextContent('已覆盖')
    expect(screen.getByTestId('approval-policy-state')).toHaveTextContent('不跟随')

    await selectOption(user, '选择审批档覆盖', '继承（跟随 Agent Revision 默认）')
    await user.click(screen.getByTestId('approval-policy-apply'))
    await waitFor(() => expect(captures.bodies).toHaveLength(1))
    expect(captures.bodies[0]).toEqual({ approvalPolicy: null })
  })

  it('非责任人视角：无下拉无应用钮，只有一句权限说明', async () => {
    const t = task({ approvalPolicy: 'full_access' })
    renderApp(
      `/tasks/${t.id}/permissions`,
      loggedInHandlers(ALICE, [
        taskRoomHandler(t),
        teamMembersHandler([makeMember(BOB), makeMember(ALICE)]),
        {
          method: 'GET',
          url: new RegExp(`/api/v1/tasks/${t.id}/instruction-grants$`),
          respond: () => ok([]),
        },
      ]),
    )
    await screen.findByTestId('approval-policy-state')
    expect(screen.queryByLabelText('选择审批档覆盖')).toBeNull()
    expect(screen.getByText('只有任务责任人可以修改审批档位。')).toBeInTheDocument()
  })
})

describe('#241 RunLauncher：解析为 full_access 时先确认再发', () => {
  it('Revision 默认 full_access（Task 未覆盖）→ 提示在场、确认后才 POST', async () => {
    const captures: { bodies: unknown[] } = { bodies: [] }
    const user = userEvent.setup()
    const t = makeTask({ assigneeUserId: BOB.userId, assignmentStatus: 'accepted' })
    const detail = agentDetail('full_access')
    renderApp(
      `/tasks/${t.id}`,
      loggedInHandlers(BOB, [
        taskRoomHandler(t),
        teamMembersHandler([makeMember(BOB), makeMember(ALICE)]),
        ...agentDetailHandlers(detail),
        devicesHandler([
          {
            id: DEVICE_ID,
            name: 'm4-mini',
            platform: 'darwin',
            status: 'online',
            dshDistributionVersion: '0.1.0-rc.8',
            lastSeenAt: '2026-08-25T00:00:00.000Z',
          },
        ]),
        workspacesHandler([
          {
            workspaceId: WORKSPACE_ID,
            deviceId: DEVICE_ID,
            name: 'whalepod',
            kind: 'directory',
            available: true,
          },
        ]),
        {
          method: 'POST',
          url: /\/api\/v1\/tasks\/[^/]+\/runs$/,
          respond: (init) => {
            captures.bodies.push(JSON.parse(String(init.body ?? '{}')))
            return ok({ id: 'run-1' })
          },
        },
      ]),
    )
    // 选 Agent 后 Revision 默认选中当前 → 提示出现（解析结果可见）。
    await selectOption(user, '选择 Agent', 'report-writer')
    expect(await screen.findByTestId('run-policy-hint')).toHaveTextContent('完全权限')
    // 此时尚未提交任何 Run。
    expect(captures.bodies).toHaveLength(0)

    // 填齐目标与指令后提交 → 先出确认对话框；**取消**不发，**确认**才发 POST。
    await selectOption(user, '选择设备', 'm4-mini（在线）')
    await selectOption(user, '选择 Workspace', 'whalepod')
    await user.type(screen.getByLabelText('Run prompt'), '发布周报')
    await user.click(screen.getByRole('button', { name: '启动 Run' }))
    const dialog = await screen.findByRole('dialog')
    expect(dialog).toHaveTextContent('完全权限')
    expect(captures.bodies).toHaveLength(0) // 对话框没确认前一个请求都不该有

    await user.click(screen.getByRole('button', { name: '确认以完全权限启动' }))
    await waitFor(() => expect(captures.bodies).toHaveLength(1))
    expect(captures.bodies[0]).toMatchObject({ prompt: '发布周报' })
  })
})

describe('#241 运行卡：full_access 显著标记', () => {
  it('approvalPolicy=full_access 的 Run 显示「完全权限」，默认档不显示', async () => {
    const t = makeTask()
    renderApp(
      `/tasks/${t.id}`,
      loggedInHandlers(BOB, [
        taskRoomHandler(t, {
          runs: [
            makeRun({ id: 'run-full', status: 'completed', approvalPolicy: 'full_access' }),
            makeRun({ id: 'run-normal', status: 'completed' }),
          ],
        }),
        teamMembersHandler([makeMember(BOB), makeMember(ALICE)]),
      ]),
    )
    expect(await screen.findByTestId('run-full-access')).toHaveTextContent('完全权限')
    // 只有一条 full_access 标记（默认档的 run 不带）。
    expect(screen.getAllByTestId('run-full-access')).toHaveLength(1)
  })
})
