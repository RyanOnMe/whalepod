/**
 * 任务约定面板 + 绑定提示 + 「执行中约定更新」横幅（#378；ADR-0017 §1/§2）页面级判据。
 *
 * 从用户视角驱动（role/label/text）：草稿编辑与并发令牌、确认权限、开关、
 * 绑定提示、三选一横幅（追问填入 / 取消 / 保持本次）——以及请求体里确实带了令牌
 * （页面外面向服务端的契约，不是内部实现）。
 */
import { screen, waitFor, within } from '@testing-library/react'
import { userEvent } from '@testing-library/user-event'
import { describe, expect, it } from 'vitest'
import {
  BOB,
  loggedInHandlers,
  makeRun,
  makeTask,
  ok,
  taskRoomHandler,
  teamMembersHandler,
  apiFailure,
} from './fixtures.js'
import type { MockHandler } from './fixtures.js'
import { showWorkspace } from './workspace.js'
import { renderApp } from './render.jsx'
import type { TaskSpecRevisionView } from '../src/shared/api/types.js'

const TASK_ID = '00000000-0000-4000-8000-0000000000aa'
const REVISION_ID = '00000000-0000-4000-8000-0000000000bb'

function makeRevision(overrides: Partial<TaskSpecRevisionView> = {}): TaskSpecRevisionView {
  return {
    id: REVISION_ID,
    taskId: TASK_ID,
    revisionNumber: 1,
    status: 'confirmed',
    content: {
      goal: '交付登录接口',
      constraints: '不引入新依赖',
      acceptance: '全部用例通过',
      openQuestions: '',
    },
    draftVersion: 1,
    origin: 'manual',
    createdByUserId: BOB.userId,
    createdAt: '2026-08-25T00:00:00.000Z',
    updatedAt: '2026-08-25T00:00:00.000Z',
    confirmedByUserId: BOB.userId,
    confirmedAt: '2026-08-25T01:00:00.000Z',
    ...overrides,
  }
}

function agreementHandler(view: unknown): MockHandler {
  return {
    method: 'GET',
    url: new RegExp(`/api/v1/tasks/${TASK_ID}/agreement$`),
    respond: () => ok(view),
  }
}

function roomHandlers(
  extra: MockHandler[],
  options: {
    runs?: ReturnType<typeof makeRun>[]
    agreement?: { enabled: boolean; latestConfirmedNumber: number | null; hasDraft: boolean }
    agreementEnabled?: boolean
    assigneeUserId?: string
  } = {},
): MockHandler[] {
  const task = makeTask({
    id: TASK_ID,
    assigneeUserId: options.assigneeUserId ?? BOB.userId,
    assignmentStatus: 'accepted',
    acceptedAt: '2026-08-25T00:00:00.000Z',
    status: 'in_progress',
    agreementEnabled: options.agreementEnabled ?? false,
  })
  return loggedInHandlers(BOB, [
    taskRoomHandler(task, {
      runs: options.runs ?? [],
      ...(options.agreement !== undefined ? { agreement: options.agreement } : {}),
    }),
    teamMembersHandler(),
    ...extra,
  ])
}

describe('#378 任务约定面板', () => {
  it('无已确认版本时给起草入口；责任人确认后显示当前版本与历史', async () => {
    const user = userEvent.setup()
    const empty = { enabled: false, draft: null, confirmed: null, history: [], confirmedCount: 0 }
    const confirmed = makeRevision()
    let currentView: unknown = empty
    const handlers = roomHandlers([
      {
        method: 'POST',
        url: new RegExp(`/api/v1/tasks/${TASK_ID}/agreement/draft$`),
        respond: () => {
          const draft = makeRevision({
            revisionNumber: null,
            status: 'draft',
            draftVersion: 1,
            confirmedByUserId: null,
            confirmedAt: null,
          })
          currentView = { ...empty, draft }
          return ok(draft)
        },
      },
      {
        method: 'POST',
        url: new RegExp(`/api/v1/tasks/${TASK_ID}/agreement/confirm$`),
        respond: (init) => {
          expect(JSON.parse(String(init.body))).toEqual({ draftVersion: 1 })
          currentView = {
            enabled: false,
            draft: null,
            confirmed,
            history: [confirmed],
            confirmedCount: 1,
          }
          return ok(confirmed)
        },
      },
      {
        method: 'GET',
        url: new RegExp(`/api/v1/tasks/${TASK_ID}/agreement$`),
        respond: () => ok(currentView),
      },
    ])
    renderApp(`/tasks/${TASK_ID}`, handlers)

    await showWorkspace('agreement')
    const panel = await screen.findByTestId('agreement-panel')
    expect(within(panel).getByTestId('agreement-disabled-chip')).toBeInTheDocument()
    expect(within(panel).getByTestId('agreement-no-confirmed')).toBeInTheDocument()

    await user.click(within(panel).getByRole('button', { name: '起草任务约定' }))
    const editor = within(panel).getByTestId('agreement-editor')
    await user.type(within(editor).getByLabelText('任务约定：目标'), '交付登录接口')
    await user.type(within(editor).getByLabelText('任务约定：验收条件'), '全部用例通过')
    await user.click(within(editor).getByRole('button', { name: '保存为新草稿' }))

    const draftBlock = await within(panel).findByTestId('agreement-draft')
    expect(within(draftBlock).getByText(/未确认，不构成要求/)).toBeInTheDocument()
    await user.click(within(draftBlock).getByRole('button', { name: /确认这一版/ }))

    await waitFor(() => {
      expect(within(panel).getByTestId('agreement-current')).toHaveTextContent('当前正式版本 v1')
    })
    expect(within(panel).getByTestId('agreement-history')).toBeInTheDocument()
    expect(within(panel).getByTestId('agreement-history-v1')).toBeInTheDocument()
  })

  it('非责任人看不到确认按钮与开关，只看到等待责任人确认', async () => {
    const draft = makeRevision({
      revisionNumber: null,
      status: 'draft',
      confirmedByUserId: null,
      confirmedAt: null,
    })
    const view = { enabled: false, draft, confirmed: null, history: [], confirmedCount: 0 }
    // 任务归 Alice；会话是 Bob —— 面板可读，但没有确认权。
    const task = makeTask({
      id: TASK_ID,
      assigneeUserId: 'aaaaaaaa-0000-4000-8000-000000000001',
      assignmentStatus: 'accepted',
      status: 'in_progress',
    })
    renderApp(
      `/tasks/${TASK_ID}`,
      loggedInHandlers(BOB, [taskRoomHandler(task), teamMembersHandler(), agreementHandler(view)]),
    )
    await showWorkspace('agreement')
    const panel = await screen.findByTestId('agreement-panel')
    expect(within(panel).getByTestId('agreement-draft')).toBeInTheDocument()
    expect(within(panel).queryByRole('button', { name: /确认这一版/ })).not.toBeInTheDocument()
    expect(within(panel).queryByRole('switch', { name: '启用约定流程' })).not.toBeInTheDocument()
    expect(within(panel).getByText(/等待责任人/)).toBeInTheDocument()
  })

  it('开关等待真实响应；请求失败保留原状态，重复点击不重发', async () => {
    const user = userEvent.setup()
    const view = { enabled: false, draft: null, confirmed: null, history: [], confirmedCount: 0 }
    let release!: () => void
    const pending = new Promise<void>((resolve) => {
      release = resolve
    })
    let requests = 0
    renderApp(
      `/tasks/${TASK_ID}`,
      roomHandlers([
        agreementHandler(view),
        {
          method: 'PATCH',
          url: new RegExp(`/api/v1/tasks/${TASK_ID}$`),
          respond: async (init) => {
            requests += 1
            expect(JSON.parse(String(init.body))).toEqual({ agreementEnabled: true })
            await pending
            return apiFailure('CONFLICT', '约定状态更新失败，请重试')
          },
        },
      ]),
    )
    await showWorkspace('agreement')
    const toggle = await screen.findByRole('switch', { name: '启用约定流程' })
    expect(toggle).not.toBeChecked()
    await user.click(toggle)
    await waitFor(() => expect(toggle).toBeDisabled())
    expect(toggle).not.toBeChecked()
    await user.click(toggle)
    expect(requests).toBe(1)
    release()
    expect(await screen.findByText(/约定状态更新失败，请重试/)).toBeVisible()
    expect(toggle).not.toBeChecked()
    expect(toggle).toBeEnabled()
  })

  it('并发冲突（409）：提示并重取读模型，不静默重试', async () => {
    const user = userEvent.setup()
    const draft = makeRevision({
      revisionNumber: null,
      status: 'draft',
      draftVersion: 3,
      confirmedByUserId: null,
      confirmedAt: null,
    })
    const view = { enabled: false, draft, confirmed: null, history: [], confirmedCount: 0 }
    let saves = 0
    const handlers = roomHandlers([
      agreementHandler(view),
      {
        method: 'POST',
        url: new RegExp(`/api/v1/tasks/${TASK_ID}/agreement/draft$`),
        respond: (init) => {
          saves += 1
          expect(JSON.parse(String(init.body))).toMatchObject({ expectedDraftVersion: 3 })
          return apiFailure('CONFLICT', '约定草稿已被他人修改；请刷新后重试（未覆盖任何版本）')
        },
      },
    ])
    renderApp(`/tasks/${TASK_ID}`, handlers)

    await showWorkspace('agreement')
    const panel = await screen.findByTestId('agreement-panel')
    const draftBlock = within(panel).getByTestId('agreement-draft')
    await user.click(within(draftBlock).getByRole('button', { name: '继续编辑' }))
    await user.click(within(panel).getByRole('button', { name: '保存草稿' }))

    expect(await within(panel).findByText(/约定草稿已被他人修改/)).toBeInTheDocument()
    expect(saves).toBe(1)
  })

  it('启用后显示绑定提示；已启用但无已确认版本时明确说明执行会被拒绝', async () => {
    const confirmed = makeRevision()
    const view = {
      enabled: true,
      draft: null,
      confirmed,
      history: [confirmed],
      confirmedCount: 1,
    }
    renderApp(
      `/tasks/${TASK_ID}`,
      roomHandlers([agreementHandler(view)], {
        agreementEnabled: true,
        agreement: { enabled: true, latestConfirmedNumber: 1, hasDraft: false },
      }),
    )
    const hint = await screen.findByTestId('agreement-binding-hint')
    expect(hint).toHaveTextContent('v1')
  })

  it('已启用但无已确认版本：面板显式提示执行会被拒绝', async () => {
    const view = { enabled: true, draft: null, confirmed: null, history: [], confirmedCount: 0 }
    renderApp(
      `/tasks/${TASK_ID}`,
      roomHandlers([agreementHandler(view)], {
        agreementEnabled: true,
        agreement: { enabled: true, latestConfirmedNumber: null, hasDraft: false },
      }),
    )
    await showWorkspace('agreement')
    const panel = await screen.findByTestId('agreement-panel')
    expect(within(panel).getByTestId('agreement-enabled-unconfirmed')).toHaveTextContent(
      '新执行会被拒绝',
    )
  })
})

describe('#378 执行中约定更新横幅', () => {
  it('绑定 v1 的活跃运行 + 最新 v2 → 横幅三选一：追问填入草稿、取消请求、保持本次收起', async () => {
    const user = userEvent.setup()
    const run = makeRun({
      id: '00000000-0000-4000-8000-0000000000cc',
      status: 'running',
      specRevision: { id: REVISION_ID, revisionNumber: 1 },
    })
    const confirmed = makeRevision()
    const view = {
      enabled: true,
      draft: null,
      confirmed: makeRevision({ revisionNumber: 2, id: '00000000-0000-4000-8000-0000000000dd' }),
      history: [confirmed],
      confirmedCount: 2,
    }
    let cancelled = 0
    const handlers = roomHandlers(
      [
        agreementHandler(view),
        {
          method: 'POST',
          url: new RegExp(`/api/v1/runs/${run.id}/cancel$`),
          respond: () => {
            cancelled += 1
            return ok({})
          },
        },
      ],
      {
        runs: [run],
        agreementEnabled: true,
        agreement: { enabled: true, latestConfirmedNumber: 2, hasDraft: false },
      },
    )
    renderApp(`/tasks/${TASK_ID}`, handlers)

    const notice = await screen.findByTestId('agreement-update-notice')
    expect(notice).toHaveTextContent('v2')
    expect(notice).toHaveTextContent('v1')

    // 追问：只把建议文字放进执行草稿（用户仍要自己发送）。
    await user.click(within(notice).getByRole('button', { name: '按新版本追问（填入草稿）' }))
    const textbox = screen.getByLabelText('指令') as HTMLTextAreaElement
    expect(textbox.value).toContain('v2')

    // 取消：请求真实取消端点。
    await user.click(within(notice).getByRole('button', { name: '取消本次执行' }))
    await waitFor(() => expect(cancelled).toBe(1))

    // 保持本次：横幅收起（不自动做任何事）。
    await user.click(within(notice).getByRole('button', { name: /保持本次/ }))
    await waitFor(() =>
      expect(screen.queryByTestId('agreement-update-notice')).not.toBeInTheDocument(),
    )
  })

  it('未绑定（历史）的运行不触发横幅——没有版本可比就不猜', async () => {
    const run = makeRun({
      id: '00000000-0000-4000-8000-0000000000ce',
      status: 'running',
      specRevision: null,
    })
    renderApp(
      `/tasks/${TASK_ID}`,
      roomHandlers(
        [
          agreementHandler({
            enabled: true,
            draft: null,
            confirmed: null,
            history: [],
            confirmedCount: 0,
          }),
        ],
        {
          runs: [run],
          agreementEnabled: true,
          agreement: { enabled: true, latestConfirmedNumber: 2, hasDraft: false },
        },
      ),
    )
    await screen.findByTestId('agreement-panel')
    expect(screen.queryByTestId('agreement-update-notice')).not.toBeInTheDocument()
  })
})
