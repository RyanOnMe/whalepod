/**
 * P1-14 Task Room Approval 卡（用户视角，mock 仅 HTTP 层）：
 *
 * - 责任人：pending 时见完整卡（工具/原因/preview/过期时间）与「批准一次/拒绝」；
 * - 成员（project 受众）：只见「等待责任人批准」等待态，无决定入口、无参数正文；
 * - 决定提交走真人同一条 HTTP 路径（POST /approvals/:id/decisions），成功后
 *   时间线翻转为已决状态；冲突/过期错误显式呈现，不静默吞掉。
 */
import { describe, expect, it } from 'vitest'
import { screen, waitFor } from '@testing-library/react'
import { userEvent } from '@testing-library/user-event'
import { renderApp } from './render.js'
import {
  ALICE,
  BOB,
  apiFailure,
  loggedInHandlers,
  makeRun,
  makeTask,
  ok,
  taskRoomHandler,
  type MockHandler,
  type MockResponse,
} from './fixtures.js'

const APPROVAL_ID = '3c3c3c3c-0000-4000-8000-00000000003c'
const CALL_ID = 'call-artifact-1'
const RUN_ID = 'f6f6f6f6-0000-4000-8000-00000000000e'

const REQUESTED_AT = '2026-08-25T10:00:00.000Z'
const EXPIRES_AT = '2026-08-25T10:10:00.000Z'

interface ApprovalCardFixture {
  reason: string
  preview: unknown
  audience: 'owner' | 'project'
}

/** /runs/:runId/events 的 approval 事件夹具（形状 = protocol ProjectedRunEvent）。 */
function approvalEventHandlers(
  runId: string,
  card: ApprovalCardFixture,
  state: { decided?: 'allowed_once' | 'rejected' | 'expired' | 'cancelled' },
): MockHandler[] {
  const approvalBase = {
    approvalId: APPROVAL_ID,
    runId,
    callId: CALL_ID,
    toolName: 'bash',
    status: 'pending',
    requestedAt: REQUESTED_AT,
    expiresAt: EXPIRES_AT,
  }
  // 每次响应时读 state：POST 处理器改写 state.decided 后，invalidate 触发的
  // refetch 即返回已决事件（与 production 的 invalidate + refetch 语义一致）。
  const events = (): unknown[] => {
    const list: unknown[] = [
      {
        runId,
        seq: 1,
        type: 'approval.requested',
        audience: card.audience,
        event: {
          type: 'approval.requested',
          approval: { ...approvalBase, reason: card.reason, preview: card.preview },
        },
        occurredAt: REQUESTED_AT,
        receivedAt: REQUESTED_AT,
      },
    ]
    if (state.decided !== undefined) {
      list.push({
        runId,
        seq: 2,
        type: 'approval.decided',
        audience: card.audience,
        event: { type: 'approval.decided', approvalId: APPROVAL_ID, status: state.decided },
        occurredAt: '2026-08-25T10:01:00.000Z',
        receivedAt: '2026-08-25T10:01:00.000Z',
      })
    }
    return list
  }
  return [
    { method: 'GET', url: new RegExp(`/api/v1/runs/${runId}$`), respond: () => ok({ id: runId }) },
    {
      method: 'GET',
      url: new RegExp(`/api/v1/runs/${runId}/events`),
      respond: () => ok({ events: events() }),
    },
  ]
}

function decisionHandler(
  capture: { body?: unknown; url?: string },
  state?: { decided?: 'allowed_once' | 'rejected' | 'expired' | 'cancelled' },
  response?: MockResponse,
) {
  return {
    method: 'POST',
    url: new RegExp(`/api/v1/approvals/${APPROVAL_ID}/decisions$`),
    respond: (init: RequestInit) => {
      capture.body = JSON.parse(String(init.body))
      if (state !== undefined) state.decided = 'allowed_once'
      return response ?? ok({ id: APPROVAL_ID, status: 'allowed_once' })
    },
  } satisfies MockHandler
}

function waitingTask(assigneeUserId: string) {
  return makeTask({ assigneeUserId, assignmentStatus: 'accepted', status: 'in_progress' })
}

describe('task room approval card', () => {
  it('责任人见完整审批卡（工具/原因/preview/过期时间）与批准、拒绝入口', async () => {
    const task = waitingTask(BOB.userId)
    renderApp(
      `/tasks/${task.id}`,
      loggedInHandlers(BOB, [
        taskRoomHandler(task, { runs: [makeRun({ id: RUN_ID, status: 'waiting_approval' })] }),
        ...approvalEventHandlers(
          RUN_ID,
          {
            audience: 'owner',
            reason: '需要删除构建目录',
            preview: { command: 'rm -rf build' },
          },
          {},
        ),
      ]),
    )
    expect(await screen.findByTestId('approval-card')).toBeVisible()
    expect(screen.getByTestId('approval-tool')).toHaveTextContent('bash')
    expect(screen.getByTestId('approval-reason')).toHaveTextContent('需要删除构建目录')
    expect(screen.getByTestId('approval-preview')).toHaveTextContent('rm -rf build')
    expect(screen.getByTestId('approval-expires')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '批准一次' })).toBeEnabled()
    expect(screen.getByRole('button', { name: '拒绝' })).toBeEnabled()
  })

  it('成员只见「等待责任人批准」等待态：无按钮、无原因正文与参数', async () => {
    const task = waitingTask(BOB.userId)
    renderApp(
      `/tasks/${task.id}`,
      loggedInHandlers(ALICE, [
        taskRoomHandler(task, { runs: [makeRun({ id: RUN_ID, status: 'waiting_approval' })] }),
        ...approvalEventHandlers(
          RUN_ID,
          {
            audience: 'project',
            reason: '',
            preview: { category: 'shell' },
          },
          {},
        ),
      ]),
    )
    expect(await screen.findByTestId('approval-waiting')).toHaveTextContent('等待责任人批准')
    expect(screen.queryByRole('button', { name: '批准一次' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: '拒绝' })).not.toBeInTheDocument()
    expect(screen.queryByText('需要删除构建目录')).not.toBeInTheDocument()
    expect(screen.queryByTestId('approval-card')).not.toBeInTheDocument()
  })

  it('点击批准一次 → POST decisions allowed_once；成功后时间线翻转为已批准', async () => {
    const task = waitingTask(BOB.userId)
    const capture: { body?: unknown; url?: string } = {}
    const state: { decided?: 'allowed_once' } = {}
    const user = userEvent.setup()
    renderApp(
      `/tasks/${task.id}`,
      loggedInHandlers(BOB, [
        taskRoomHandler(task, { runs: [makeRun({ id: RUN_ID, status: 'waiting_approval' })] }),
        ...approvalEventHandlers(
          RUN_ID,
          {
            audience: 'owner',
            reason: '需要删除构建目录',
            preview: { command: 'rm -rf build' },
          },
          state,
        ),
        decisionHandler(capture, state),
      ]),
    )
    await screen.findByTestId('approval-card')
    await user.click(screen.getByRole('button', { name: '批准一次' }))

    await waitFor(() => expect(capture.body).toEqual({ decision: 'allowed_once' }))
    // 决定后 refetch 回 decided 事件：卡片翻转为终态行，决定入口消失。
    expect(await screen.findByTestId('approval-decided')).toHaveTextContent('已批准一次')
    expect(screen.queryByRole('button', { name: '批准一次' })).not.toBeInTheDocument()
  })

  it('决定冲突（APPROVAL_ALREADY_DECIDED）显式报错，不静默吞掉', async () => {
    const task = waitingTask(BOB.userId)
    const capture: { body?: unknown; url?: string } = {}
    const user = userEvent.setup()
    renderApp(
      `/tasks/${task.id}`,
      loggedInHandlers(BOB, [
        taskRoomHandler(task, { runs: [makeRun({ id: RUN_ID, status: 'waiting_approval' })] }),
        ...approvalEventHandlers(
          RUN_ID,
          {
            audience: 'owner',
            reason: '需要删除构建目录',
            preview: { command: 'rm -rf build' },
          },
          {},
        ),
        decisionHandler(
          capture,
          undefined,
          apiFailure('APPROVAL_ALREADY_DECIDED', 'approval already decided'),
        ),
      ]),
    )
    await screen.findByTestId('approval-card')
    await user.click(screen.getByRole('button', { name: '批准一次' }))

    expect(await screen.findByRole('alert')).toHaveTextContent('approval already decided')
  })

  it('没有等待审批的 Run 时空态说明，而不是空白', async () => {
    const task = waitingTask(BOB.userId)
    renderApp(
      `/tasks/${task.id}`,
      loggedInHandlers(BOB, [taskRoomHandler(task, { runs: [makeRun({ status: 'running' })] })]),
    )
    expect(await screen.findByRole('heading', { name: '审批' })).toBeVisible()
    expect(screen.getByText('当前没有等待审批的操作。')).toBeVisible()
  })
})
