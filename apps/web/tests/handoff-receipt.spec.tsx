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
  apiFailure,
  created,
  loggedInHandlers as baseLoggedInHandlers,
  makeRun,
  makeTask,
  ok,
  taskRoomHandler,
  teamMembersHandler,
  type MockHandler,
} from './fixtures.js'
import { showWorkspace } from './workspace.js'
import { renderApp } from './render.jsx'
import { openSelect, selectOption } from './select-menu.js'
import { queryKeys } from '../src/app/query-client.js'
import type { HandoffReceiptView, TaskView } from '../src/shared/api/types.js'
import type { Session } from '../src/shared/api/types.js'
import { emptyHandoffNarrative } from '@whalepod/protocol'

function publishedRevision(id: string, revisionNumber = 1) {
  return {
    id,
    taskId: UPSTREAM_TASK_ID,
    revisionNumber,
    sourceRunId: '00000000-0000-4000-8000-000000000011',
    specRevisionId: null,
    content: {
      system: {
        sourceRunId: '00000000-0000-4000-8000-000000000011',
        specRevision: null,
        artifacts: [],
      },
      narrative: {
        ...emptyHandoffNarrative(),
        interfaces: [{ text: `固定接口正文 v${revisionNumber}`, verified: false, refs: [] }],
      },
    },
    publishedByUserId: ALICE.userId,
    publishedAt: '2026-10-18T00:00:00Z',
  }
}
function loggedInHandlers(session: Session, extra: MockHandler[] = []): MockHandler[] {
  return baseLoggedInHandlers(session, [
    ...extra,
    {
      method: 'GET',
      url: /\/handoff-revisions\/[^/]+$/,
      respond: (_init, url) => {
        const id = url.split('/').at(-1)!
        return ok(publishedRevision(id, id === NEW_REVISION_ID ? 2 : 1))
      },
    },
    {
      method: 'GET',
      url: /\/tasks\/[^/]+\/handoff-revisions$/,
      respond: () => ok([publishedRevision(NEW_REVISION_ID, 2)]),
    },
  ])
}

const TASK_ID = '00000000-0000-4000-8000-0000000000aa'
const UPSTREAM_TASK_ID = '00000000-0000-4000-8000-0000000000bb'
const RECEIPT_ID = '00000000-0000-4000-8000-0000000000cc'
const REVISION_ID = '00000000-0000-4000-8000-0000000000dd'
// 待采用的新版本必须与当前 receipt 的版本不同：否则「发送 target.id」与
// 「误发 active.revisionId」无法区分，CAS 判据会假绿。
const NEW_REVISION_ID = '00000000-0000-4000-8000-0000000000ee'
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
  it('#396 确认前展示固定版本正文，读取失败明确报错且禁止确认', async () => {
    const user = userEvent.setup()
    let failed = true
    renderApp(
      `/tasks/${TASK_ID}`,
      loggedInHandlers(BOB, [
        taskRoomHandler(downstreamTask()),
        receiptsHandler([makeReceipt()]),
        {
          method: 'GET',
          url: new RegExp(`/handoff-revisions/${REVISION_ID}$`),
          respond: () =>
            failed
              ? new Response('unavailable', { status: 503 })
              : ok(publishedRevision(REVISION_ID)),
        },
      ]),
    )
    const panel = await screen.findByTestId('handoff-receipt-panel')
    await user.type(within(panel).getByLabelText('确认接收：本次准备做什么'), '接前端')
    expect(within(panel).getByRole('button', { name: '确认接收（不动任务状态）' })).toBeDisabled()
    failed = false
    await user.click(await within(panel).findByRole('button', { name: '重试交接正文' }))
    expect(await within(panel).findByText('固定接口正文 v1')).toBeVisible()
    await waitFor(() =>
      expect(within(panel).getByRole('button', { name: '确认接收（不动任务状态）' })).toBeEnabled(),
    )
  })
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
        teamMembersHandler(),
      ]),
    )
    const panel = await screen.findByTestId('handoff-receipt-panel')
    await waitFor(() =>
      expect(within(panel).getByTestId('handoff-receipt-pending')).toHaveTextContent(
        '等待 Bob（@bob） 确认',
      ),
    )
    expect(within(panel).queryByTestId('handoff-确认接收-form')).not.toBeInTheDocument()
  })

  it('非接收人查看已确认回执（评审 B7）：理解与差异都不冒充「你」', async () => {
    renderApp(
      `/tasks/${TASK_ID}`,
      loggedInHandlers(ALICE, [
        taskRoomHandler(downstreamTask()),
        receiptsHandler([
          makeReceipt({
            status: 'confirmed',
            understanding: '按 v1 做',
            differences: 'orderId 要对齐',
            confirmedAt: '2026-10-18T02:00:00.000Z',
          }),
        ]),
        teamMembersHandler(),
      ]),
    )
    const panel = await screen.findByTestId('handoff-receipt-panel')
    const active = await within(panel).findByTestId('handoff-receipt-active')
    // 回执属于接收人（Bob）；当前会话是 Alice——两行都必须落接收人的名，不能写「你」。
    expect(active).toHaveTextContent(/Bob（@bob）确认的理解/)
    expect(active).toHaveTextContent(/Bob（@bob）提出的差异/)
    expect(active).not.toHaveTextContent(/你确认的|你提出的/)
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
    await waitFor(() =>
      expect(adoptBody).toEqual({
        understanding: '对齐字段后再做',
        expectedRevisionId: NEW_REVISION_ID,
      }),
    )
  })

  it('采用时版本被他人推进：409 明确报错并立即重读回执', async () => {
    const user = userEvent.setup()
    let receiptCalls = 0
    let adoptCalls = 0
    const confirmed = makeReceipt({
      status: 'confirmed',
      understanding: '按 v1 做',
      confirmedAt: '2026-10-18T02:00:00.000Z',
      latestRevisionNumber: 2,
    })
    renderApp(
      `/tasks/${TASK_ID}`,
      loggedInHandlers(BOB, [
        taskRoomHandler(downstreamTask()),
        {
          method: 'GET',
          url: new RegExp(`/api/v1/tasks/${TASK_ID}/handoff-receipts$`),
          respond: () => {
            receiptCalls += 1
            return ok([confirmed])
          },
        },
        {
          method: 'POST',
          url: new RegExp(`/api/v1/handoff-receipts/${RECEIPT_ID}/adopt$`),
          respond: () => {
            adoptCalls += 1
            return apiFailure('CONFLICT', '交接版本已变化，请查看新版本正文后重新确认')
          },
        },
      ]),
    )
    const panel = await screen.findByTestId('handoff-receipt-panel')
    const newer = await within(panel).findByTestId('handoff-newer-version')
    await user.type(within(newer).getByLabelText('采用新版本：本次准备做什么'), '对齐字段后再做')
    const callsBefore = receiptCalls
    const submit = within(newer).getByRole('button', { name: '采用 v2' })
    // 正文读取成功前按钮按设计禁用；先等到可点，避免把「没发出请求」误判成没报错。
    await waitFor(() => expect(submit).toBeEnabled())
    await user.click(submit)
    await waitFor(() => expect(adoptCalls).toBe(1))
    // 页面其他区块也可能有 alert；这里只认接收面板里的那一条。
    expect(await within(panel).findByRole('alert')).toHaveTextContent('交接版本已变化')
    // 不是「报错后让用户对着旧版本反复撞 409」：失效查询会立刻重读回执/最新版本。
    await waitFor(() => expect(receiptCalls).toBeGreaterThan(callsBefore))
  })

  it('待接收入口：任务尚未接受时标注清楚，确认不冒充接受', async () => {
    renderApp(
      `/tasks/${TASK_ID}`,
      loggedInHandlers(BOB, [
        taskRoomHandler(downstreamTask({ assignmentStatus: 'pending', acceptedAt: null })),
        receiptsHandler([makeReceipt()]),
      ]),
    )
    const panel = await screen.findByTestId('handoff-receipt-panel')
    expect(within(panel).getByTestId('handoff-task-not-accepted')).toHaveTextContent('任务尚未接受')
  })

  it('任务指派被拒绝：同样不算接受，提示重新指派或重新交付', async () => {
    renderApp(
      `/tasks/${TASK_ID}`,
      loggedInHandlers(BOB, [
        taskRoomHandler(downstreamTask({ assignmentStatus: 'rejected', acceptedAt: null })),
        receiptsHandler([makeReceipt()]),
      ]),
    )
    const panel = await screen.findByTestId('handoff-receipt-panel')
    expect(within(panel).getByTestId('handoff-task-not-accepted')).toHaveTextContent(
      '任务指派已被拒绝',
    )
  })

  it('上游问题已保存但响应丢失：trim等价重试同键，成功后新意图换键', async () => {
    const user = userEvent.setup()
    const stored = new Map<string, string>()
    const requests: Array<{ key: string; text: string }> = []
    let lose = true
    renderApp(
      `/tasks/${TASK_ID}`,
      loggedInHandlers(BOB, [
        taskRoomHandler(downstreamTask()),
        receiptsHandler([makeReceipt()]),
        {
          method: 'POST',
          url: new RegExp(`/api/v1/tasks/${UPSTREAM_TASK_ID}/comments$`),
          respond: (init) => {
            const key = new Headers(init.headers).get('idempotency-key')!
            const text = (JSON.parse(String(init.body)) as { body: string }).body
            requests.push({ key, text })
            if (!stored.has(key)) stored.set(key, text)
            if (lose) {
              lose = false
              throw new Error('response lost after storing question')
            }
            return created({ id: 'comment-1', body: stored.get(key) })
          },
        },
      ]),
    )
    const panel = await screen.findByTestId('handoff-receipt-panel')
    const field = within(panel).getByLabelText('向上游提问')
    const send = within(panel).getByRole('button', { name: '发送问题' })
    await user.type(field, '问题 A')
    await user.click(send)
    await within(panel).findByRole('alert')
    await user.type(field, '  ')
    await user.click(send)
    await waitFor(() => expect(field).toHaveValue(''))
    expect(requests[1]!.key).toBe(requests[0]!.key)
    expect(stored.size).toBe(1)
    await user.type(field, '问题 A')
    await user.click(send)
    await waitFor(() => expect(field).toHaveValue(''))
    expect(requests[2]!.key).not.toBe(requests[1]!.key)
    expect(stored.size).toBe(2)
  })

  it('未知结果后编辑问题 A→B→A：每个新意图都实际保存，不重放旧问题', async () => {
    const user = userEvent.setup()
    const stored = new Map<string, string>()
    const requests: string[] = []
    let lose = 2
    renderApp(
      `/tasks/${TASK_ID}`,
      loggedInHandlers(BOB, [
        taskRoomHandler(downstreamTask()),
        receiptsHandler([makeReceipt()]),
        {
          method: 'POST',
          url: new RegExp(`/api/v1/tasks/${UPSTREAM_TASK_ID}/comments$`),
          respond: (init) => {
            const key = new Headers(init.headers).get('idempotency-key')!
            const text = (JSON.parse(String(init.body)) as { body: string }).body
            requests.push(key)
            if (!stored.has(key)) stored.set(key, text)
            if (lose-- > 0) throw new Error('response lost after storing question')
            return created({ id: 'comment-1', body: stored.get(key) })
          },
        },
      ]),
    )
    const panel = await screen.findByTestId('handoff-receipt-panel')
    const field = within(panel).getByLabelText('向上游提问')
    const send = within(panel).getByRole('button', { name: '发送问题' })
    for (const text of ['问题 A', '问题 B']) {
      await user.clear(field)
      await user.type(field, text)
      await user.click(send)
      await within(panel).findByRole('alert')
      await waitFor(() => expect(send).toBeEnabled())
    }
    await user.clear(field)
    await user.type(field, '问题 A')
    await user.click(send)
    await waitFor(() => expect(field).toHaveValue(''))
    expect(new Set(requests).size).toBe(3)
    expect([...stored.values()]).toEqual([
      '【交接 v1 · 前端接入】问题 A',
      '【交接 v1 · 前端接入】问题 B',
      '【交接 v1 · 前端接入】问题 A',
    ])
  })

  it('失败后交接上下文改变：相同问题仍是新的发送意图', async () => {
    const user = userEvent.setup()
    const receipt = makeReceipt()
    const requests: Array<{ key: string; text: string }> = []
    let lose = true
    const view = renderApp(
      `/tasks/${TASK_ID}`,
      loggedInHandlers(BOB, [
        taskRoomHandler(downstreamTask()),
        receiptsHandler([receipt]),
        {
          method: 'POST',
          url: new RegExp(`/api/v1/tasks/${UPSTREAM_TASK_ID}/comments$`),
          respond: (init) => {
            requests.push({
              key: new Headers(init.headers).get('idempotency-key')!,
              text: (JSON.parse(String(init.body)) as { body: string }).body,
            })
            if (lose) {
              lose = false
              throw new Error('response lost after storing question')
            }
            return created({ id: 'comment-1' })
          },
        },
      ]),
    )
    const panel = await screen.findByTestId('handoff-receipt-panel')
    const field = within(panel).getByLabelText('向上游提问')
    await user.type(field, '问题 A')
    await user.click(within(panel).getByRole('button', { name: '发送问题' }))
    await within(panel).findByRole('alert')
    receipt.downstreamTaskTitle = '接入新版前端'
    await view.queryClient.invalidateQueries({ queryKey: queryKeys.taskHandoffReceipts(TASK_ID) })
    await user.click(within(panel).getByRole('button', { name: '发送问题' }))
    await waitFor(() => expect(field).toHaveValue(''))
    expect(requests[1]!.key).not.toBe(requests[0]!.key)
    expect(requests[1]!.text).toBe('【交接 v1 · 接入新版前端】问题 A')
  })

  it('向上游提问不要求先确认接收；失败保留文字，成功后正文不变', async () => {
    const user = userEvent.setup()
    const pending = makeReceipt()
    let commentBody: unknown = null
    let fail = true
    renderApp(
      `/tasks/${TASK_ID}`,
      loggedInHandlers(BOB, [
        taskRoomHandler(downstreamTask()),
        receiptsHandler([pending]),
        {
          method: 'POST',
          url: new RegExp(`/api/v1/tasks/${UPSTREAM_TASK_ID}/comments$`),
          respond: (init) => {
            commentBody = JSON.parse(String(init.body))
            return fail ? apiFailure('INTERNAL_ERROR', '发送失败') : created({ id: 'comment-1' })
          },
        },
      ]),
    )
    const panel = await screen.findByTestId('handoff-receipt-panel')
    const question = within(panel).getByLabelText('向上游提问')
    await user.type(question, '订单号为空时怎么处理？')
    await user.click(within(panel).getByRole('button', { name: '发送问题' }))
    expect(await within(panel).findByRole('alert')).toHaveTextContent('文字已保留')
    expect(question).toHaveValue('订单号为空时怎么处理？')
    // 提问不改 receipt 状态：仍停在待确认。
    expect(within(panel).getByTestId('handoff-receipt-pending')).toBeVisible()
    expect(within(panel).queryByTestId('handoff-receipt-active')).not.toBeInTheDocument()

    fail = false
    await user.click(within(panel).getByRole('button', { name: '发送问题' }))
    expect(await within(panel).findByRole('status')).toHaveTextContent('已发到上游任务讨论区')
    expect(commentBody).toEqual({ body: '【交接 v1 · 前端接入】订单号为空时怎么处理？' })
    expect(question).toHaveValue('')
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

  it('接收方在别处确认后房间实时更新（评审 B6）：默认勾选随之生效，不覆盖主动取消', async () => {
    const user = userEvent.setup()
    const view = renderApp(
      `/tasks/${TASK_ID}`,
      loggedInHandlers(BOB, [
        taskRoomHandler(downstreamTask()),
        receiptsHandler([]),
        ...launcherHandlers,
      ]),
    )
    await screen.findByLabelText('指令')
    expect(screen.queryByTestId('handoff-attach')).not.toBeInTheDocument()

    // 房间经 WS 失效后重取：摘要 null → 非 null（接收方在别台机器上刚确认）。
    const room = (summary: typeof handoffSummary): Record<string, unknown> => ({
      task: downstreamTask(),
      comments: [],
      instructions: [],
      artifacts: [],
      runs: [],
      agreement: { enabled: false, latestConfirmedNumber: null, hasDraft: false },
      handoff: summary,
      nextRunApprovalPolicy: null,
    })
    view.queryClient.setQueryData(queryKeys.taskRoom(TASK_ID), room(handoffSummary))
    const attach = await screen.findByTestId('handoff-attach')
    expect(within(attach).getByLabelText('附带上游交接材料')).toBeChecked()

    // 用户主动取消后来一次刷新：保持取消——默认值只负责「从未有过 → 有」这一步。
    await user.click(within(attach).getByLabelText('附带上游交接材料'))
    expect(within(attach).getByLabelText('附带上游交接材料')).not.toBeChecked()
    view.queryClient.setQueryData(
      queryKeys.taskRoom(TASK_ID),
      room({ ...handoffSummary, revisionNumber: 2 }),
    )
    await waitFor(() => expect(within(attach).getByLabelText('附带上游交接材料')).not.toBeChecked())
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
    await showWorkspace('run')
    await user.click(await screen.findByRole('button', { name: '查看本次固定输入' }))
    await screen.findByTestId('run-input-manifest')
    // 无交接输入：这一节不出现（null 不是错误，也不占位）。
    expect(screen.queryByTestId('run-handoff-input')).not.toBeInTheDocument()
  })

  it('交接读面失败（评审 B8）：显式报错不冒充「没有」；重试同时重取交接读面', async () => {
    const user = userEvent.setup()
    const run = makeRun({ id: '00000000-0000-4000-8000-0000000000f1', status: 'completed' })
    let handoffFails = true
    let handoffRequests = 0
    renderApp(
      `/tasks/${TASK_ID}`,
      loggedInHandlers(BOB, [
        taskRoomHandler(downstreamTask(), { runs: [run] }),
        receiptsHandler([]),
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
          respond: () => {
            handoffRequests += 1
            if (handoffFails) {
              return {
                status: 500,
                body: {
                  ok: false,
                  error: {
                    code: 'INTERNAL_ERROR',
                    message: '读取失败',
                    requestId: 'req-handoff-retry',
                  },
                },
              }
            }
            return ok({
              upstreamTaskId: UPSTREAM_TASK_ID,
              upstreamTaskTitle: '后端交付',
              receiptId: RECEIPT_ID,
              revisionId: REVISION_ID,
              revisionNumber: 1,
              artifacts: [],
            })
          },
        },
      ]),
    )
    await user.click(await screen.findByRole('button', { name: /第 1 次运行/ }))
    await showWorkspace('run')
    await user.click(await screen.findByRole('button', { name: '查看本次固定输入' }))
    const errorLine = await screen.findByTestId('run-handoff-input-error')
    expect(errorLine).toHaveTextContent('这不等于「本次不带交接材料」')
    expect(screen.queryByTestId('run-handoff-input')).not.toBeInTheDocument()

    // 重试必须把交接读面一起重取（只重取同 Task 清单时错误行永远挂着）。
    handoffFails = false
    await user.click(screen.getByRole('button', { name: '重新读取输入' }))
    expect(await screen.findByTestId('run-handoff-input')).toHaveTextContent('「后端交付」')
    expect(handoffRequests).toBe(2)
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
    await showWorkspace('run')
    await user.click(await screen.findByRole('button', { name: '查看本次固定输入' }))
    const handoffSection = await screen.findByTestId('run-handoff-input')
    expect(handoffSection).toHaveTextContent('「后端交付」的已发布交接包 v1')
    expect(handoffSection).toHaveTextContent('接口约定.md')
    expect(handoffSection).toHaveTextContent('c'.repeat(12))
  })
})
