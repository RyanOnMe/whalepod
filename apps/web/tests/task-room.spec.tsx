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
  makeInstruction,
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

  it('渲染执行栏的运行区与审批插槽；有 Run 时展示状态文本', async () => {
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
    // 两栏形态（ADR-0010）：讨论与执行是两个并列区段，各有标题。
    expect(await screen.findByRole('heading', { name: '讨论' })).toBeVisible()
    expect(screen.getByRole('heading', { name: '执行' })).toBeVisible()
    expect(await screen.findByRole('heading', { name: '运行' })).toBeVisible()
    expect(await screen.findByText('运行中')).toBeVisible()
    expect(screen.getByText('已完成')).toBeVisible()
    expect(screen.getByRole('heading', { name: '审批' })).toBeVisible()
    // P1-14：无等待审批的 Run 时，审批插槽呈现空态说明。
    expect(screen.getByText('当前没有等待审批的操作。')).toBeVisible()
  })

  it('#211 B1：运行卡画落点显示名；未知落点画"未知设备"、不画 id', async () => {
    const task = makeTask({ assigneeUserId: BOB.userId })
    renderApp(
      `/tasks/${task.id}`,
      loggedInHandlers(BOB, [
        taskRoomHandler(task, {
          runs: [
            makeRun({ status: 'running', deviceName: 'MacBook-Pro', workspaceName: 'whalepod' }),
            makeRun({ status: 'completed', finishedAt: '2026-08-25T03:00:00.000Z' }),
          ],
        }),
      ]),
    )
    const placements = await screen.findAllByTestId('run-placement')
    expect(placements).toHaveLength(2)
    // 有名：设备名 · 工作区名（显示名，不是 id）
    expect(placements[0]).toHaveTextContent('MacBook-Pro · whalepod')
    // 无名（deviceName null）：画"未知设备"，不编造、不画 id
    expect(placements[1]).toHaveTextContent('未知设备')
    expect(placements[1]?.textContent).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}/)
  })

  it('交付物与复核折在执行栏底部的任务详情里（**默认展开**：默认折叠会断 G6-04 金路径；区段标题中文）', async () => {
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

/**
 * 切片⑥a 的页面级判据（复核 #209 应改 ③④ 补的缺口）：
 *
 * 为什么必须补：复核用变异证明——把 `TaskRoomPage` 里的 `instructions={instructions}` 换成
 * `instructions={[]}`（整页指令流断掉）**218 条判据全绿**，因为**没有任何测试给页面级喂过非空
 * instructions**；同理 `authorName={directory.personOf}` 删掉也全绿（真页面会退化成半截 UUID）。
 * 这两条都是"组件测过了、接线没人管"的典型，所以这里从**页面**驱动。
 */
describe('task-room 执行栏接线（⑥a 页面级）', () => {
  it('指令流真的接到页面上：四态可见，且作者写人名（不是半截 UUID）', async () => {
    const task = makeTask({ assigneeUserId: BOB.userId })
    const instructions = [
      makeInstruction({ id: 'i-pending', instructionState: 'pending', authorUserId: BOB.userId }),
      makeInstruction({ id: 'i-accepted', instructionState: 'accepted', authorUserId: BOB.userId }),
      makeInstruction({
        id: 'i-accepted-other',
        instructionState: 'accepted',
        authorUserId: ALICE.userId,
      }),
      makeInstruction({
        id: 'i-rejected',
        authorUserId: BOB.userId,
        instructionState: 'rejected',
        instructionErrorCode: 'DEVICE_OFFLINE',
        instructionErrorMessage: '没有可用的执行目标',
      }),
    ]
    // 活跃 Run 还没进 running（dispatching）⇒ 那条 pending 应当显示为「已排队」（③c-1）。
    renderApp(
      `/tasks/${task.id}`,
      loggedInHandlers(BOB, [
        taskRoomHandler(task, { instructions, runs: [makeRun({ status: 'dispatching' })] }),
        // 成员目录要喂：人名解析走它（不喂就会印「未知成员」——这本身就是接线在生效的证据）。
        teamMembersHandler([makeMember(), makeMember({ ...BOB, role: BOB.role })]),
      ]),
    )

    // 三种服务端状态 + 一个派生显示态都必须渲染出来（把 instructions 换成 [] 时这条会红）。
    const states = (await screen.findAllByTestId('instruction-state')).map((el) => el.textContent)
    expect(states).toContain('已受理')
    expect(states).toContain('已排队') // pending + 活跃 Run 未 running ⇒ 派生
    expect(states).toContain('已拒绝')
    expect(states).not.toContain('待受理') // 已排队比"待受理"对用户更准确（排队优先）

    // 拒绝理由要落在页面上（④b/③b 把理由落库就是为了这一刻）。
    expect(screen.getByTestId('instruction-error').textContent).toContain('DEVICE_OFFLINE')

    // 作者必须写人名：删掉 authorName 注入时页面会印短 id，这条会红。
    // 自己发的写「你」，他人发的写人名（两条路径都要走通：只断言一条的话，
    // 删掉 `authorName` 注入仍会绿——复核正是这么变异活下来的）。
    const authors = screen.getAllByTestId('instruction-author').map((el) => el.textContent)
    expect(authors).toContain('你')
    expect(authors.some((text) => text?.includes(ALICE.displayName))).toBe(true)
    expect(screen.queryByText(/^[0-9a-f]{8}$/)).not.toBeInTheDocument()
  })

  it('服务端没返回指令流时**显式告警**，不假装成"还没有指令"（复核 O-3：该分支此前零判据）', async () => {
    // 复核实测：把 `instructionsMissing` 恒 false 或恒 true，判据**全绿**——整块 R1 修复没人守。
    // 这里直接喂一个"契约违约"的响应体（不带 instructions 字段），断言：
    //   ① 告警出现；② **不是**空态文案（这是这条修复的全部意义）。
    const task = makeTask({ assigneeUserId: BOB.userId })
    renderApp(`/tasks/${task.id}`, [
      ...loggedInHandlers(BOB, [
        {
          method: 'GET',
          url: new RegExp(`/api/v1/tasks/${task.id}$`),
          respond: () =>
            new Response(
              JSON.stringify({ ok: true, data: { task, comments: [], runs: [], artifacts: [] } }),
              { status: 200 },
            ),
        },
      ]),
    ])
    expect(await screen.findByTestId('instructions-missing')).toBeVisible()
    expect(screen.queryByText(/还没有人驱动过这个任务/)).not.toBeInTheDocument()
    // 文案不得夹协议字段名，也不得留 Markdown 星号（复核 R1 实测页面会原样显示 `**`）。
    const text = screen.getByTestId('instructions-missing').textContent ?? ''
    expect(text).not.toContain('instructions')
    expect(text).not.toContain('**')
  })

  it('正常响应（带 instructions: []）**不**触发告警——空指令流与"读取不完整"是两回事', async () => {
    const task = makeTask({ assigneeUserId: BOB.userId })
    renderApp(`/tasks/${task.id}`, loggedInHandlers(BOB, [taskRoomHandler(task)]))
    expect(await screen.findByText(/还没有人驱动过这个任务/)).toBeVisible()
    expect(screen.queryByTestId('instructions-missing')).not.toBeInTheDocument()
  })

  it('取消中的 Run **不算可排队窗口**：pending 指令显示「待受理」，不是「已排队」', async () => {
    // 复核 R3 实测的语义错误：页面的 ACTIVE_RUN 含 `cancel_requested`，我原先写成
    // `status !== 'running'` ⇒ 取消中的 Run 下 pending 指令被显示成「已排队」，
    // 而 hub 的 `FOLLOWUP_QUEUEING_STATUSES` 只含 queued/dispatching/waiting_approval，
    // cancel_requested 走 RUN_CANCELLING **当场拒绝**。可达：Run 在排队窗口时发的指令落成
    // pending，随后用户取消该 Run，指令仍是 pending。
    const task = makeTask({ assigneeUserId: BOB.userId })
    renderApp(
      `/tasks/${task.id}`,
      loggedInHandlers(BOB, [
        taskRoomHandler(task, {
          instructions: [
            makeInstruction({
              id: 'i-pending',
              instructionState: 'pending',
              authorUserId: BOB.userId,
            }),
          ],
          runs: [makeRun({ status: 'cancel_requested' })],
        }),
      ]),
    )
    const state = (await screen.findAllByTestId('instruction-state'))[0]
    expect(state?.textContent).toBe('待受理')
    expect(state?.textContent).not.toBe('已排队')
  })

  it('「任务详情」默认展开且**仍可折叠**（复核 ⑥：这条此前零判据）', async () => {
    const user = userEvent.setup()
    const task = makeTask({ assigneeUserId: BOB.userId })
    renderApp(
      `/tasks/${task.id}`,
      loggedInHandlers(BOB, [taskRoomHandler(task, { artifacts: [makeArtifact()] })]),
    )
    // 默认展开：交付物可见（G6-04 要点发布按钮，折叠会断链——这是当初改成 open 的理由）。
    expect(await screen.findByText('security-review.md')).toBeVisible()
    const summary = screen.getByText(/任务详情/)
    await user.click(summary)
    // 收起后交付物必须真的不可见（不是"还在 DOM 里但假装收起"）。
    await waitFor(() => {
      expect(screen.queryByText('security-review.md')).not.toBeVisible()
    })
    await user.click(summary)
    expect(await screen.findByText('security-review.md')).toBeVisible()
  })
})
