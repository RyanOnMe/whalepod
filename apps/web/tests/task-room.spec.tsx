/**
 * Task Room 四区与状态呈现（02 Task 7 Step 4）：
 * 顶部属性/行动、左侧 Assignment、中间讨论+Run+审批插槽、右侧 Artifacts+Reviewer。
 * 加载与错误必须显式呈现，不能伪装成空数据；空态说明下一步。
 *
 * #162 起本文件还承载「指人的位置必须说人名」的组件层判据（与 e2e 共用
 * `person-identity.ts` 的内核）。
 */
import { screen, waitFor, within } from '@testing-library/react'
import { userEvent } from '@testing-library/user-event'
import { describe, expect, it } from 'vitest'
import {
  ALICE,
  BOB,
  loggedInHandlers,
  makeArtifact,
  makeComment,
  makeMember,
  makeRun,
  makeTask,
  ok,
  pendingHandler,
  taskRoomHandler,
  teamMembersHandler,
} from './fixtures.js'
import type { MockHandler } from './fixtures.js'
import { renderApp } from './render.jsx'
import { FORMER_MEMBER_LABEL, UNKNOWN_MEMBER_LABEL } from '../src/features/team/memberDirectory.js'
import { RUN_NOT_IN_TIMELINE_LABEL } from '../src/features/task/runLabels.js'
import {
  PERSON_SLOTS,
  domPersonSlotSamples,
  personRosterFromMembers,
  personSlotProblems,
} from './person-identity.js'
import type { RunView, TaskRoomRun } from '../src/shared/api/types.js'

const SOURCE_RUN_ID = 'b7b7b7b7-0000-4000-8000-00000000000a'
const RUN_ID = 'f6f6f6f6-0000-4000-8000-00000000000e'
const AGENT_ID = 'a1a1a1a1-0000-4000-8000-00000000000a'
const REVISION_ID = 'a2a2a2a2-0000-4000-8000-00000000000b'
const DEVICE_ID = 'd1d1d1d1-0000-4000-8000-00000000000c'
const WORKSPACE_ID = 'e5e5e5e5-0000-4000-8000-00000000000d'

/** 选中某个 Run 后 RunLivePanel 会拉的两条查询（GET /runs/:id 与 /events）。 */
function runDetailHandlers(run: TaskRoomRun): MockHandler[] {
  const view: RunView = {
    id: run.id,
    taskId: 'task-1',
    ownerUserId: BOB.userId,
    agentId: AGENT_ID,
    profileRevisionId: REVISION_ID,
    deviceId: DEVICE_ID,
    workspaceId: WORKSPACE_ID,
    status: run.status,
    dshSessionId: null,
    failureCode: null,
    failureSummary: null,
    rerunOfRunId: run.rerunOfRunId,
    profileDigest: 'b'.repeat(64),
    createdAt: run.createdAt,
    startedAt: run.startedAt,
    finishedAt: run.finishedAt,
  }
  return [
    { method: 'GET', url: new RegExp(`/api/v1/runs/${run.id}$`), respond: () => ok(view) },
    {
      method: 'GET',
      url: new RegExp(`/api/v1/runs/${run.id}/events`),
      respond: () => ok({ events: [] }),
    },
  ]
}

describe('task-room', () => {
  it('渲染顶部区域：目标、状态与当前责任人', async () => {
    const task = makeTask({ assigneeUserId: BOB.userId, status: 'in_progress' })
    renderApp(`/tasks/${task.id}`, loggedInHandlers(BOB, [taskRoomHandler(task)]))
    expect(await screen.findByRole('heading', { name: task.title })).toBeVisible()
    expect(screen.getByText('进行中')).toBeVisible()
    expect(screen.getByText('当前责任人')).toBeVisible()
    expect(screen.getByText('你')).toBeVisible()
  })

  it('渲染左侧 Assignment 与 Agent 快照插槽的空态', async () => {
    const task = makeTask({ assigneeUserId: BOB.userId })
    renderApp(`/tasks/${task.id}`, loggedInHandlers(BOB, [taskRoomHandler(task)]))
    expect(await screen.findByRole('button', { name: '接受任务' })).toBeVisible()
    expect(screen.getByRole('button', { name: '拒绝任务' })).toBeVisible()
  })

  it('渲染中间讨论区：留言输入与空态', async () => {
    const task = makeTask({ assigneeUserId: BOB.userId })
    renderApp(`/tasks/${task.id}`, loggedInHandlers(BOB, [taskRoomHandler(task)]))
    expect(await screen.findByRole('heading', { name: '讨论' })).toBeVisible()
    expect(screen.getByLabelText('留言')).toBeVisible()
    expect(screen.getByText('还没有留言——向责任人说明下一步吧。')).toBeVisible()
  })

  it('渲染中间 Run 区与审批插槽；有 Run 时展示状态文本', async () => {
    const task = makeTask({ assigneeUserId: BOB.userId })
    renderApp(
      `/tasks/${task.id}`,
      loggedInHandlers(BOB, [
        taskRoomHandler(task, {
          runs: [
            makeRun({ status: 'running' }),
            makeRun({ status: 'completed', finishedAt: '2026-08-25T03:00:00.000Z' }),
          ],
        }),
      ]),
    )
    expect(await screen.findByRole('heading', { name: 'Run' })).toBeVisible()
    expect(await screen.findByText('运行中')).toBeVisible()
    expect(screen.getByText('已完成')).toBeVisible()
    expect(screen.getByRole('heading', { name: '审批' })).toBeVisible()
    // P1-14：无等待审批的 Run 时，审批插槽呈现空态说明。
    expect(screen.getByText('当前没有等待审批的操作。')).toBeVisible()
  })

  it('渲染右侧交付物列表与复核插槽（区段标题是中文，#152）', async () => {
    const task = makeTask({ assigneeUserId: BOB.userId })
    renderApp(
      `/tasks/${task.id}`,
      loggedInHandlers(BOB, [taskRoomHandler(task, { artifacts: [makeArtifact()] })]),
    )
    expect(await screen.findByRole('heading', { name: '交付物' })).toBeVisible()
    expect(await screen.findByText('security-review.md')).toBeVisible()
    expect(screen.getByText('text/markdown')).toBeVisible()
    expect(screen.getByRole('heading', { name: '复核' })).toBeVisible()
    expect(screen.getByText(/只读输入清单/)).toBeVisible()
    // 英文区段标题不再出现（Agent/Run/Task 这些领域术语照旧保留）
    expect(screen.queryByRole('heading', { name: 'Artifacts' })).not.toBeInTheDocument()
    expect(screen.queryByRole('heading', { name: 'Reviewer' })).not.toBeInTheDocument()
  })

  it('空态说明下一步，而不是静默空白', async () => {
    const task = makeTask({ assigneeUserId: BOB.userId })
    renderApp(`/tasks/${task.id}`, loggedInHandlers(BOB, [taskRoomHandler(task)]))
    expect(await screen.findByText(/还没有 Run。/)).toBeVisible()
    expect(screen.getByText(/还没有已发布的 Artifact。/)).toBeVisible()
  })

  it('加载态不伪装成空数据', async () => {
    const task = makeTask({ assigneeUserId: BOB.userId })
    renderApp(
      `/tasks/${task.id}`,
      loggedInHandlers(BOB, [pendingHandler('GET', new RegExp(`/api/v1/tasks/${task.id}$`))]),
    )
    expect(await screen.findByText('正在加载任务…')).toBeVisible()
    expect(screen.queryByText('还没有 Run。')).not.toBeInTheDocument()
  })

  it('错误态展示 message 与 requestId，且不伪装成空数据', async () => {
    const task = makeTask({ assigneeUserId: BOB.userId })
    renderApp(
      `/tasks/${task.id}`,
      loggedInHandlers(BOB, [
        {
          method: 'GET',
          url: new RegExp(`/api/v1/tasks/${task.id}$`),
          respond: () => ({
            status: 500,
            body: {
              ok: false,
              error: {
                code: 'INTERNAL_ERROR',
                message: 'internal error',
                requestId: 'req-task-500',
              },
            },
          }),
        },
      ]),
    )
    expect(await screen.findByRole('alert')).toHaveTextContent('internal error')
    expect(screen.getByRole('alert')).toHaveTextContent('req-task-500')
    expect(screen.getByRole('button', { name: '重试' })).toBeVisible()
    expect(screen.queryByText('还没有 Run。')).not.toBeInTheDocument()
  })

  it('任务不存在（404）时展示明确错误而非空列表', async () => {
    const task = makeTask({ assigneeUserId: BOB.userId })
    renderApp(
      `/tasks/${task.id}`,
      loggedInHandlers(BOB, [
        {
          method: 'GET',
          url: new RegExp(`/api/v1/tasks/${task.id}$`),
          respond: () => ({
            status: 404,
            body: {
              ok: false,
              error: { code: 'NOT_FOUND', message: 'task not found', requestId: 'req-task-404' },
            },
          }),
        },
      ]),
    )
    expect(await screen.findByRole('alert')).toHaveTextContent('task not found')
    expect(screen.queryByRole('heading', { name: task.title })).not.toBeInTheDocument()
  })

  it('未接受任务时顶部不显示责任人的验收行动', async () => {
    const task = makeTask({ assigneeUserId: BOB.userId, assignmentStatus: 'pending' })
    renderApp(`/tasks/${task.id}`, loggedInHandlers(BOB, [taskRoomHandler(task)]))
    await screen.findByRole('heading', { name: task.title })
    expect(screen.queryByRole('button', { name: '提交验收' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: '完成任务' })).not.toBeInTheDocument()
  })
})

/**
 * #162：Task Room 的指人位置必须说人名。
 *
 * 判定用的是 e2e 那一份内核（`person-identity.ts`），这里只是把采样换成 jsdom 的
 * `textContent`——浏览器层面的同一判据由 e2e/task-room.spec.ts 在真浏览器里跑。
 * 分两层是有意的：组件层能在 Q0（无栈）里跑出红→绿，e2e 层证明确实上了屏。
 */
describe('#162 指人的位置用显示名，短 id 不上屏', () => {
  const MEMBERS = [makeMember(), makeMember({ ...BOB, role: BOB.role })]

  it('责任人 / 分配说明 / 留言作者都写「显示名（@用户名）」，判据全过', async () => {
    const task = makeTask({ assigneeUserId: BOB.userId, assignmentStatus: 'pending' })
    const comments = [
      makeComment({ taskId: task.id, authorUserId: BOB.userId, body: '收到，本周内出初稿。' }),
    ]
    renderApp(
      `/tasks/${task.id}`,
      // 非责任人视角（Alice）：三个指人位置同时在场。
      loggedInHandlers(ALICE, [taskRoomHandler(task, { comments }), teamMembersHandler(MEMBERS)]),
    )
    // 等名册解析完再判：名册未就绪时人名的正确呈现就是「未知成员」（加载态不是
    // 判据对象）。这个等待条件在红绿两态下都会满足，所以变异回短 id 时能走到判据。
    await waitFor(() => {
      expect(screen.getByTestId('task-assignee')).not.toHaveTextContent(UNKNOWN_MEMBER_LABEL)
    })

    // 与 e2e 同一份判定：三个槽位的可见文本都不得出现 8 位短 id。
    const problems = personSlotProblems(
      domPersonSlotSamples([
        PERSON_SLOTS.assignee,
        PERSON_SLOTS.assignmentNote,
        PERSON_SLOTS.commentAuthor,
      ]),
      personRosterFromMembers(MEMBERS),
    )
    expect(problems).toEqual([])

    // 正向：三处确实说出了显示名。
    expect(screen.getByTestId('task-assignee')).toHaveTextContent('Bob（@bob）')
    expect(screen.getByTestId('assignment-assignee-note')).toHaveTextContent(
      '此任务分配给 Bob（@bob），等待其接受。',
    )
    expect(screen.getByTestId('comment-author')).toHaveTextContent('Bob（@bob）')
    expect(document.body.textContent).not.toContain(BOB.userId.slice(0, 8))
  })

  it('名册里查不到人：说「已离开的成员」，不回落到短 id', async () => {
    const task = makeTask({ assigneeUserId: BOB.userId, assignmentStatus: 'pending' })
    renderApp(
      `/tasks/${task.id}`,
      loggedInHandlers(ALICE, [taskRoomHandler(task), teamMembersHandler([])]),
    )
    await waitFor(() => {
      expect(screen.getByTestId('task-assignee')).toHaveTextContent(FORMER_MEMBER_LABEL)
    })
    expect(screen.getByTestId('assignment-assignee-note')).toHaveTextContent(
      `此任务分配给 ${FORMER_MEMBER_LABEL}，等待其接受。`,
    )
    expect(document.body.textContent).not.toContain(BOB.userId.slice(0, 8))
  })

  it('名册还没回来：说「未知成员」，同样不回落到短 id', async () => {
    const task = makeTask({ assigneeUserId: BOB.userId, assignmentStatus: 'pending' })
    renderApp(
      `/tasks/${task.id}`,
      loggedInHandlers(ALICE, [
        taskRoomHandler(task),
        pendingHandler('GET', /\/api\/v1\/team\/members$/),
      ]),
    )
    await waitFor(() => {
      expect(screen.getByTestId('task-assignee')).toHaveTextContent(UNKNOWN_MEMBER_LABEL)
    })
    expect(document.body.textContent).not.toContain(BOB.userId.slice(0, 8))
  })
})

/** #162：Run 用「第 N 次运行 / 本次运行 / 来源运行」，原始 id 只在 title 上。 */
describe('#162 Run 与来源运行的可读措辞', () => {
  it('时间线行说「第 N 次运行」、面板说「本次运行」、血缘说「重跑自第 N 次运行」', async () => {
    const task = makeTask({ assigneeUserId: BOB.userId, assignmentStatus: 'accepted' })
    const sourceRun = makeRun({ id: SOURCE_RUN_ID, status: 'failed' })
    const rerun = makeRun({ id: RUN_ID, status: 'queued', rerunOfRunId: SOURCE_RUN_ID })
    const artifact = makeArtifact({ runId: RUN_ID, title: 'security-review.md' })
    const user = userEvent.setup()
    renderApp(
      `/tasks/${task.id}`,
      loggedInHandlers(BOB, [
        taskRoomHandler(task, { runs: [sourceRun, rerun], artifacts: [artifact] }),
        ...runDetailHandlers(rerun),
      ]),
    )

    // 交付物「来源运行」格：与时间线行同款句柄（人可以对回去）。
    const sourceCell = await screen.findByText('来源运行')
    const sourceValue = sourceCell.parentElement?.querySelector('dd')
    expect(sourceValue).toHaveTextContent('第 2 次运行')
    expect(sourceValue).toHaveAttribute('title', RUN_ID)

    await user.click(screen.getByRole('button', { name: /第 2 次运行/ }))
    const heading = await screen.findByRole('heading', { name: '本次运行' })
    expect(heading).toHaveAttribute('title', RUN_ID)
    // 血缘句两处（时间线行 + 直播面板）同款措辞；面板那一处在 run-live-panel 内。
    const lineage = within(screen.getByTestId('run-live-panel')).getByTestId('run-lineage')
    // 来源是第 1 次运行 —— 血缘句说的是「哪一次」，不是含糊的「有来源」。
    expect(lineage).toHaveTextContent('重跑自第 1 次运行')
    expect(lineage).toHaveAttribute('title', SOURCE_RUN_ID)
    const lineages = screen.getAllByTestId('run-lineage')
    expect(lineages).toHaveLength(2)
    for (const node of lineages) expect(node).toHaveTextContent('重跑自第 1 次运行')

    // 短 id 一个都不在正文里（只有 title 属性带着完整 id）。
    const body = document.body.textContent ?? ''
    expect(body).not.toContain(SOURCE_RUN_ID.slice(0, 8))
    expect(body).not.toContain(RUN_ID.slice(0, 8))
    // 行标签从行首开始（血缘句里也会出现「第 1 次运行」，所以锚定行首区分两行）。
    expect(screen.getByRole('button', { name: /^第 1 次运行/ })).toBeVisible()
  })

  it('Artifact 的来源运行不在本任务运行记录里时，给人话而不是 id', async () => {
    const task = makeTask({ assigneeUserId: BOB.userId, assignmentStatus: 'accepted' })
    renderApp(
      `/tasks/${task.id}`,
      loggedInHandlers(BOB, [
        taskRoomHandler(task, {
          runs: [makeRun({ id: RUN_ID, status: 'completed' })],
          artifacts: [makeArtifact({ runId: 'ffffffff-0000-4000-8000-000000000009' })],
        }),
      ]),
    )
    const sourceCell = await screen.findByText('来源运行')
    expect(sourceCell.parentElement?.querySelector('dd')).toHaveTextContent(
      RUN_NOT_IN_TIMELINE_LABEL,
    )
    expect(document.body.textContent).not.toContain('ffffffff')
  })
})
