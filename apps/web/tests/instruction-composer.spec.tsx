/**
 * 执行区输入（切片⑥b）。
 *
 * 判据围绕一件事：**这句话的命运要如实告诉用户**。Hub 对四种命运都回 201（201 只表示
 * "请求受理了"），所以只看状态码分不出来——UI 必须按 `outcome` 分别呈现：
 *   起新运行 / 追问 / 排队 / **未受理（连理由一起）**。
 * 另外两条：失败**不吞用户打的字**；`DEVICE_OFFLINE` 要给"下一步做什么"而不是只丢个错误码。
 */
import { screen, waitFor } from '@testing-library/react'
import { userEvent } from '@testing-library/user-event'
import { describe, expect, it } from 'vitest'
import { renderApp } from './render.jsx'
import {
  BOB,
  deferredResponse,
  loggedInHandlers,
  makeRun,
  makeTask,
  taskRoomHandler,
  teamMembersHandler,
} from './fixtures.js'
import type { MockHandler } from './fixtures.js'

// 责任人是 BOB：执行区输入框要求"有权限驱动"，用责任人登录最直接。
const TASK = makeTask({ assigneeUserId: BOB.userId })

function instructionOk(data: Record<string, unknown>, status = 201): MockHandler {
  return {
    method: 'POST',
    url: new RegExp(`/api/v1/tasks/${TASK.id}/instructions$`),
    respond: () => new Response(JSON.stringify({ ok: true, data }), { status }),
  }
}

function instructionFail(status: number, code: string, message: string): MockHandler {
  return {
    method: 'POST',
    url: new RegExp(`/api/v1/tasks/${TASK.id}/instructions$`),
    respond: () =>
      new Response(JSON.stringify({ ok: false, error: { code, message, requestId: 'req-1' } }), {
        status,
      }),
  }
}

function message(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'm-1',
    taskId: TASK.id,
    authorUserId: TASK.assigneeUserId,
    body: '跑一遍回归',
    createdAt: new Date().toISOString(),
    kind: 'instruction',
    targetAgentId: 'a-1',
    runId: 'run-abcdef12',
    instructionState: 'accepted',
    instructionErrorCode: null,
    instructionErrorMessage: null,
    ...over,
  }
}

/**
 * 走**真实页面**渲染（⑥b 的交付物是"执行栏里能发指令"，而不只是一个孤立组件）：
 * `renderApp` 带真实 router + QueryClient，只替换 fetch。
 */
function renderComposer(
  handlers: readonly MockHandler[],
  hasActiveRun = false,
): ReturnType<typeof renderApp> {
  return renderApp(`/tasks/${TASK.id}`, [
    ...loggedInHandlers(BOB, [
      taskRoomHandler(TASK, {
        runs: hasActiveRun ? [makeRun({ status: 'running' })] : [],
      }),
      ...handlers,
    ]),
    teamMembersHandler([]),
  ])
}

describe('instruction composer', () => {
  it('起新运行：如实说「已起新运行」并给出运行号；输入被清空', async () => {
    const user = userEvent.setup()
    renderComposer([instructionOk({ ...message(), outcome: 'started_run', runId: 'run-abcdef12' })])
    const box = await screen.findByLabelText('指令')
    await user.type(box, '跑一遍回归')
    await user.click(screen.getByRole('button', { name: '发送指令' }))
    await waitFor(() => {
      expect(screen.getByTestId('instruction-outcome').textContent).toContain('已起新运行')
    })
    expect(screen.getByTestId('instruction-outcome').textContent).toContain('run-abcd')
    expect(box).toHaveValue('')
  })

  it('追问：如实说「已作为追问发给当前运行」，并提前告知这句话会去哪', async () => {
    const user = userEvent.setup()
    renderComposer(
      [instructionOk({ ...message(), outcome: 'followup', runId: 'run-abcdef12' })],
      true,
    )
    expect((await screen.findByTestId('instruction-routing-hint')).textContent).toContain('追问')
    await user.type(await screen.findByLabelText('指令'), '再带上堆栈')
    await user.click(screen.getByRole('button', { name: '发送指令' }))
    await waitFor(() => {
      expect(screen.getByTestId('instruction-outcome').textContent).toContain(
        '已作为追问发给当前运行',
      )
    })
  })

  it('排队：与追问**分开说**——这句话还排在当前运行后面，没有下发', async () => {
    const user = userEvent.setup()
    renderComposer(
      [instructionOk({ ...message(), outcome: 'queued', runId: 'run-abcdef12' })],
      true,
    )
    await user.type(await screen.findByLabelText('指令'), '顺便清理缓存')
    await user.click(screen.getByRole('button', { name: '发送指令' }))
    await waitFor(() => {
      expect(screen.getByTestId('instruction-outcome').textContent).toContain('已排队')
    })
    // 排队 ≠ 已下发：文案里不能出现"追问"，否则用户会以为 Agent 已经在做这件事。
    expect(screen.getByTestId('instruction-outcome').textContent).not.toContain('追问')
  })

  it('没有活跃 Run 时告知"这句话会起新运行"', async () => {
    renderComposer([instructionOk({ ...message(), outcome: 'started_run' })], false)
    expect((await screen.findByTestId('instruction-routing-hint')).textContent).toContain(
      '起新运行',
    )
  })

  it('被拒也是 201：必须按 outcome 说出「未受理」并**连理由一起**显示', async () => {
    const user = userEvent.setup()
    renderComposer([
      instructionOk({
        ...message({
          instructionState: 'rejected',
          instructionErrorCode: 'INSTRUCTION_CLOSED',
          instructionErrorMessage: '这个任务的指令面已关闭',
        }),
        outcome: 'rejected',
        runId: null,
      }),
    ])
    await user.type(await screen.findByLabelText('指令'), '继续跑')
    await user.click(screen.getByRole('button', { name: '发送指令' }))
    await waitFor(() => {
      expect(screen.getByTestId('instruction-outcome').textContent).toContain('未受理')
    })
    const reason = screen.getByTestId('instruction-outcome-reason')
    expect(reason.textContent).toContain('INSTRUCTION_CLOSED')
    expect(reason.textContent).toContain('这个任务的指令面已关闭')
  })

  it('错的时候不吞用户打的字，并给出 requestId（失败不乐观更新）', async () => {
    const user = userEvent.setup()
    renderComposer([instructionFail(403, 'FORBIDDEN', '你不是这个任务的责任人')])
    const box = await screen.findByLabelText('指令')
    await user.type(box, '这句要留住')
    await user.click(screen.getByRole('button', { name: '发送指令' }))
    await waitFor(() => {
      expect(screen.getByText(/你不是这个任务的责任人/)).toBeTruthy()
    })
    expect(box).toHaveValue('这句要留住') // 输入内容保留
    expect(screen.getByText(/req-1/)).toBeTruthy() // requestId 原样展示
  })

  it('409 DEVICE_OFFLINE 给的是**下一步怎么做**，不是只丢一个错误码', async () => {
    const user = userEvent.setup()
    renderComposer([instructionFail(409, 'DEVICE_OFFLINE', '没有可用的执行目标')])
    await user.type(await screen.findByLabelText('指令'), '跑吧')
    await user.click(screen.getByRole('button', { name: '发送指令' }))
    const guidance = await screen.findByTestId('instruction-offline-guidance')
    expect(guidance.textContent).toContain('设备')
    expect(guidance.textContent).toContain('显式指定')
  })

  it('提交中禁用按钮（不重复下发同一条指令）', async () => {
    const user = userEvent.setup()
    const gate = deferredResponse()
    renderComposer([
      {
        method: 'POST',
        url: new RegExp(`/api/v1/tasks/${TASK.id}/instructions$`),
        respond: () => gate.promise,
      },
    ])
    await user.type(await screen.findByLabelText('指令'), '跑吧')
    await user.click(screen.getByRole('button', { name: '发送指令' }))
    expect(await screen.findByRole('button', { name: '发送中…' })).toBeDisabled()
    gate.resolve(
      new Response(
        JSON.stringify({ ok: true, data: { ...message(), outcome: 'started_run', runId: null } }),
        { status: 201 },
      ),
    )
  })
})
