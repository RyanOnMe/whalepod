/**
 * 上游交接包的接收面与执行区交接勾选（#380；ADR-0017 §5）页面级判据。
 *
 * 从用户视角驱动：下游面板（待确认 → 确认表单 → 已确认理解；有新版本 → 采用）、
 * 非接收人只读、执行区「附带上游交接材料」默认勾选与请求体形状（勾选/取消），
 * 以及 Run 固定输入清单里的交接材料来源。
 */
import { screen, waitFor, within } from '@testing-library/react'
import { userEvent } from '@testing-library/user-event'
import { describe, expect, it } from 'vitest'
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
import { renderApp } from './render.jsx'
import { openSelect, selectOption } from './select-menu.js'
import type { HandoffReceiptView, TaskView } from '../src/shared/api/types.js'

const TASK_ID = '00000000-0000-4000-8000-0000000000aa'
const UPSTREAM_TASK_ID = '00000000-0000-4000-8000-0000000000bb'
const RECEIPT_ID = '00000000-0000-4000-8000-0000000000cc'
const REVISION_ID = '00000000-0000-4000-8000-0000000000dd'
const AGENT_ID = 'a1a1a1a1-0000-4000-8000-00000000000a'
const PROFILE_REVISION_ID = 'a2a2a2a2-0000-4000-8000-00000000000b'
const DEVICE_ID = 'd1d1d1d1-0000-4000-8000-00000000000c'
const WORKSPACE_ID = 'e5e5e5e5-0000-4000-8000-00000000000d'

function makeReceipt(overrides: Partial<HandoffReceiptView> = {}): HandoffReceiptView {
  return {
    id: RECEIPT_ID,
    revisionId: REVISION_ID,
    revisionNumber: 1,
    latestRevisionNumber: 1,
    upstreamTaskId: UPSTREAM_TASK_ID,
    upstreamTaskTitle: '后端交付',
    downstreamTaskId: TASK_ID,
    downstreamTaskTitle: '前端接入',
    receiverUserId: BOB.userId,
    deliveredByUserId: ALICE.userId,
    status: 'pending',
    understanding: null,
    differences: null,
    createdAt: '2026-10-18T01:00:00.000Z',
    updatedAt: '2026-10-18T01:00:00.000Z',
    confirmedAt: null,
    ...overrides,
  }
}

function receiptsHandler(rows: HandoffReceiptView[]): MockHandler {
  return {
    method: 'GET',
    url: new RegExp(`/api/v1/tasks/${TASK_ID}/handoff-receipts$`),
    respond: () => ok(rows),
  }
}

function downstreamTask(overrides: Partial<TaskView> = {}): TaskView {
  return makeTask({
    id: TASK_ID,
    assigneeUserId: BOB.userId,
    assignmentStatus: 'accepted',
    acceptedAt: '2026-10-18T00:00:00.000Z',
    status: 'in_progress',
    ...overrides,
  })
}

const launcherHandlers: MockHandler[] = [
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
          currentRevisionId: PROFILE_REVISION_ID,
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
        currentRevisionId: PROFILE_REVISION_ID,
        currentRevision: null,
        revisions: [
          {
            id: PROFILE_REVISION_ID,
            agentId: AGENT_ID,
            revision: 1,
            persona: 'p',
            provider: 'deepseek',
            model: 'deepseek-chat',
            credentialSlot: 'default',
            maxTokens: null,
            pluginPackId: '00000000-0000-4000-8000-0000000000ee',
            profileDigest: 'b'.repeat(64),
            createdBy: BOB.userId,
            createdAt: '2026-10-18T00:00:00.000Z',
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
          lastSeenAt: '2026-10-18T00:00:00.000Z',
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
]

async function arrangeAndType(
  user: ReturnType<typeof userEvent.setup>,
  text: string,
): Promise<void> {
  await openSelect(user, '选择 Agent')
  await user.click(screen.getByRole('menuitem', { name: 'Fixer' }))
  await selectOption(user, '选择设备', 'm4-mini（在线）')
  await selectOption(user, '选择 Workspace', 'whalepod')
  await user.type(screen.getByLabelText('指令'), text)
}

describe('#380 下游接收面板', () => {
  it('待确认：接收人填理解与差异 → 确认请求体正确 → 显示已确认理解', async () => {
    const user = userEvent.setup()
    const pending = makeReceipt()
    let rows: HandoffReceiptView[] = [pending]
    let confirmBody: unknown = null
    renderApp(
      `/tasks/${TASK_ID}`,
      loggedInHandlers(BOB, [
        taskRoomHandler(downstreamTask()),
        {
          method: 'GET',
          url: new RegExp(`/api/v1/tasks/${TASK_ID}/handoff-receipts$`),
          respond: () => ok(rows),
        },
        {
          method: 'POST',
          url: new RegExp(`/api/v1/handoff-receipts/${RECEIPT_ID}/confirm$`),
          respond: (init) => {
            confirmBody = JSON.parse(String(init.body))
            const confirmed = makeReceipt({
              status: 'confirmed',
              understanding: '先做订单列表页',
              differences: 'orderId 字段名要对齐',
              confirmedAt: '2026-10-18T02:00:00.000Z',
            })
            rows = [confirmed]
            return ok(confirmed)
          },
        },
      ]),
    )
    const panel = await screen.findByTestId('handoff-receipt-panel')
    expect(within(panel).getByTestId('handoff-receipt-pending')).toHaveTextContent('后端交付')
    expect(within(panel).getByTestId('handoff-receipt-pending')).toHaveTextContent('待确认版本 v1')

    const form = within(panel).getByTestId('handoff-确认接收-form')
    const submit = within(form).getByRole('button', { name: '确认接收（不动任务状态）' })
    expect(submit).toBeDisabled() // 理解必填
    await user.type(within(form).getByLabelText('确认接收：本次准备做什么'), '先做订单列表页')
    await user.type(within(form).getByLabelText('确认接收：差异'), 'orderId 字段名要对齐')
    await user.click(submit)

    await waitFor(() =>
      expect(confirmBody).toEqual({
        understanding: '先做订单列表页',
        differences: 'orderId 字段名要对齐',
      }),
    )
    expect(await within(panel).findByTestId('handoff-receipt-active')).toHaveTextContent(
      '先做订单列表页',
    )
    expect(within(panel).getByTestId('handoff-receipt-active')).toHaveTextContent('固定版本 v1')
  })

  it('非接收人：只读（无确认表单，说明在等谁确认）', async () => {
    renderApp(
      `/tasks/${TASK_ID}`,
      loggedInHandlers(ALICE, [
        taskRoomHandler(downstreamTask()),
        receiptsHandler([makeReceipt()]),
      ]),
    )
    const panel = await screen.findByTestId('handoff-receipt-panel')
    expect(within(panel).getByTestId('handoff-receipt-pending')).toHaveTextContent('等待接收人确认')
    expect(within(panel).queryByTestId('handoff-确认接收-form')).not.toBeInTheDocument()
  })

  it('上游有新版本：显示提示与采用表单；采用请求体带理解', async () => {
    const user = userEvent.setup()
    const confirmed = makeReceipt({
      status: 'confirmed',
      understanding: '按 v1 做',
      confirmedAt: '2026-10-18T02:00:00.000Z',
      latestRevisionNumber: 2,
    })
    let adoptBody: unknown = null
    renderApp(
      `/tasks/${TASK_ID}`,
      loggedInHandlers(BOB, [
        taskRoomHandler(downstreamTask()),
        receiptsHandler([confirmed]),
        {
          method: 'POST',
          url: new RegExp(`/api/v1/handoff-receipts/${RECEIPT_ID}/adopt$`),
          respond: (init) => {
            adoptBody = JSON.parse(String(init.body))
            return created(confirmed)
          },
        },
      ]),
    )
    const panel = await screen.findByTestId('handoff-receipt-panel')
    const newer = await within(panel).findByTestId('handoff-newer-version')
    expect(newer).toHaveTextContent('上游已发布新版本 v2')
    expect(newer).toHaveTextContent('旧执行的材料不变')
    await user.type(within(newer).getByLabelText('采用新版本：本次准备做什么'), '对齐字段后再做')
    await user.click(within(newer).getByRole('button', { name: '采用 v2' }))
    await waitFor(() => expect(adoptBody).toEqual({ understanding: '对齐字段后再做' }))
  })
})

describe('#380 执行区交接勾选', () => {
  const handoffSummary = {
    receiptId: RECEIPT_ID,
    revisionNumber: 1,
    upstreamTaskTitle: '后端交付',
    hasNewerVersion: false,
  }

  it('存在已确认交接：默认勾选并显示固定版本号；开始执行的请求体显式带 receipt', async () => {
    const user = userEvent.setup()
    const capture: { body?: unknown } = {}
    renderApp(
      `/tasks/${TASK_ID}`,
      loggedInHandlers(BOB, [
        taskRoomHandler(downstreamTask(), { handoff: handoffSummary }),
        receiptsHandler([
          makeReceipt({
            status: 'confirmed',
            understanding: '按 v1 做',
            confirmedAt: '2026-10-18T02:00:00.000Z',
          }),
        ]),
        ...launcherHandlers,
        {
          method: 'POST',
          url: new RegExp(`/api/v1/tasks/${TASK_ID}/instructions$`),
          respond: (init) => {
            capture.body = JSON.parse(String(init.body))
            return created({ outcome: 'started_run', runId: null })
          },
        },
      ]),
    )
    const attach = await screen.findByTestId('handoff-attach')
    expect(attach).toHaveTextContent('附带上游交接材料：「后端交付」v1')
    expect(within(attach).getByLabelText('附带上游交接材料')).toBeChecked()
    await arrangeAndType(user, '接入订单接口')
    await user.click(screen.getByRole('button', { name: '开始执行' }))
    await waitFor(() => expect(capture.body).toBeDefined())
    expect(capture.body).toMatchObject({ handoffReceiptId: RECEIPT_ID })
  })

  it('取消勾选：请求体不带交接输入（缺省即不带）', async () => {
    const user = userEvent.setup()
    const capture: { body?: unknown } = {}
    renderApp(
      `/tasks/${TASK_ID}`,
      loggedInHandlers(BOB, [
        taskRoomHandler(downstreamTask(), { handoff: handoffSummary }),
        receiptsHandler([
          makeReceipt({
            status: 'confirmed',
            understanding: '按 v1 做',
            confirmedAt: '2026-10-18T02:00:00.000Z',
          }),
        ]),
        ...launcherHandlers,
        {
          method: 'POST',
          url: new RegExp(`/api/v1/tasks/${TASK_ID}/instructions$`),
          respond: (init) => {
            capture.body = JSON.parse(String(init.body))
            return created({ outcome: 'started_run', runId: null })
          },
        },
      ]),
    )
    await user.click(await screen.findByLabelText('附带上游交接材料'))
    await arrangeAndType(user, '这次不用交接材料')
    await user.click(screen.getByRole('button', { name: '开始执行' }))
    await waitFor(() => expect(capture.body).toBeDefined())
    expect(capture.body).not.toHaveProperty('handoffReceiptId')
  })
})

describe('#380 Run 固定输入里的交接材料', () => {
  it('选中 Run 后展示交接来源与逐件摘要；无交接输入时不出现这一节', async () => {
    const user = userEvent.setup()
    const run = makeRun({ id: '00000000-0000-4000-8000-0000000000ff', status: 'completed' })
    const handlers = (handoff: unknown): MockHandler[] =>
      loggedInHandlers(BOB, [
        taskRoomHandler(downstreamTask(), { runs: [run] }),
        receiptsHandler([
          makeReceipt({
            status: 'confirmed',
            understanding: 'x',
            confirmedAt: '2026-10-18T02:00:00.000Z',
          }),
        ]),
        {
          method: 'GET',
          url: new RegExp(`/api/v1/runs/${run.id}$`),
          respond: () =>
            ok({
              ...run,
              taskId: TASK_ID,
              ownerUserId: BOB.userId,
              agentId: AGENT_ID,
              profileRevisionId: PROFILE_REVISION_ID,
              dshSessionId: null,
            }),
        },
        { method: 'GET', url: /\/events(?:\?.*)?$/, respond: () => ok([]) },
        {
          method: 'GET',
          url: new RegExp(`/api/v1/runs/${run.id}/input-manifest$`),
          respond: () => ok({ taskId: TASK_ID, artifacts: [] }),
        },
        {
          method: 'GET',
          url: new RegExp(`/api/v1/runs/${run.id}/handoff-input$`),
          respond: () => ok(handoff),
        },
      ])
    renderApp(`/tasks/${TASK_ID}`, handlers(null))
    await user.click(await screen.findByRole('button', { name: /第 1 次运行/ }))
    await user.click(await screen.findByRole('button', { name: '查看本次固定输入' }))
    await screen.findByTestId('run-input-manifest')
    // 无交接输入：这一节不出现（null 不是错误，也不占位）。
    expect(screen.queryByTestId('run-handoff-input')).not.toBeInTheDocument()
  })

  it('有交接输入：显示上游任务标题、版本号与材料摘要', async () => {
    const user = userEvent.setup()
    const run = makeRun({ id: '00000000-0000-4000-8000-0000000000f0', status: 'completed' })
    renderApp(
      `/tasks/${TASK_ID}`,
      loggedInHandlers(BOB, [
        taskRoomHandler(downstreamTask(), { runs: [run] }),
        receiptsHandler([
          makeReceipt({
            status: 'confirmed',
            understanding: 'x',
            confirmedAt: '2026-10-18T02:00:00.000Z',
          }),
        ]),
        {
          method: 'GET',
          url: new RegExp(`/api/v1/runs/${run.id}$`),
          respond: () =>
            ok({
              ...run,
              taskId: TASK_ID,
              ownerUserId: BOB.userId,
              agentId: AGENT_ID,
              profileRevisionId: PROFILE_REVISION_ID,
              dshSessionId: null,
            }),
        },
        { method: 'GET', url: /\/events(?:\?.*)?$/, respond: () => ok([]) },
        {
          method: 'GET',
          url: new RegExp(`/api/v1/runs/${run.id}/input-manifest$`),
          respond: () => ok({ taskId: TASK_ID, artifacts: [] }),
        },
        {
          method: 'GET',
          url: new RegExp(`/api/v1/runs/${run.id}/handoff-input$`),
          respond: () =>
            ok({
              upstreamTaskId: UPSTREAM_TASK_ID,
              upstreamTaskTitle: '后端交付',
              receiptId: RECEIPT_ID,
              revisionId: REVISION_ID,
              revisionNumber: 1,
              artifacts: [
                {
                  artifactId: '00000000-0000-4000-8000-000000000abc',
                  runId: '00000000-0000-4000-8000-0000000000ab',
                  title: '接口约定.md',
                  mediaType: 'text/markdown',
                  byteSize: 2048,
                  sha256: 'c'.repeat(64),
                  publishedAt: '2026-10-18T01:00:00.000Z',
                },
              ],
            }),
        },
      ]),
    )
    await user.click(await screen.findByRole('button', { name: /第 1 次运行/ }))
    await user.click(await screen.findByRole('button', { name: '查看本次固定输入' }))
    const handoffSection = await screen.findByTestId('run-handoff-input')
    expect(handoffSection).toHaveTextContent('「后端交付」的已发布交接包 v1')
    expect(handoffSection).toHaveTextContent('接口约定.md')
    expect(handoffSection).toHaveTextContent('c'.repeat(12))
  })
})
