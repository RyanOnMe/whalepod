import { screen, waitFor, within } from '@testing-library/react'
import { userEvent } from '@testing-library/user-event'
import { describe, expect, it } from 'vitest'
import {
  ALICE,
  BOB,
  apiFailure,
  loggedInHandlers,
  makeArtifact,
  makeDevice,
  makeRun,
  makeTask,
  ok,
  taskRoomHandler,
  teamMembersHandler,
  type MockHandler,
} from './fixtures.js'
import { renderApp } from './render.js'
import { changedLineRange } from '../src/features/task/ReviewRevisionPanel.js'

const TASK = '00000000-0000-4000-8000-000000000101'
const ART = '00000000-0000-4000-8000-000000000102'
const ROUND = '00000000-0000-4000-8000-000000000103'
const COMMENT = '00000000-0000-4000-8000-000000000104'
const NEW = '00000000-0000-4000-8000-000000000105'
const RUN = '00000000-0000-4000-8000-000000000106'
const AGENT = '00000000-0000-4000-8000-000000000107'
const REVISION = '00000000-0000-4000-8000-000000000108'
const DEVICE = '00000000-0000-4000-8000-000000000109'
const WORKSPACE = '00000000-0000-4000-8000-000000000110'
const REVISION_RUN = '00000000-0000-4000-8000-000000000111'
const NOW = '2026-10-26T01:00:00.000Z'
const thread = {
  id: COMMENT,
  artifactId: ART,
  authorUserId: BOB.userId,
  parentCommentId: null,
  kind: 'whole',
  anchor: null,
  body: '补充异常输入的处理范围',
  createdAt: NOW,
}
function round(overrides: Record<string, unknown> = {}) {
  return {
    id: ROUND,
    taskId: TASK,
    status: 'preparing',
    sourceArtifact: {
      artifactId: ART,
      runId: RUN,
      title: '原稿.md',
      mediaType: 'text/markdown',
      byteSize: 8,
      sha256: 'a'.repeat(64),
      publishedAt: NOW,
    },
    direction: null,
    comments: [
      {
        commentId: COMMENT,
        authorUserId: BOB.userId,
        kind: 'whole',
        anchor: null,
        body: thread.body,
        createdAt: NOW,
        replies: [],
      },
    ],
    references: [],
    runId: null,
    candidate: null,
    resolutions: [],
    createdAt: NOW,
    startedAt: null,
    ...overrides,
  }
}
function fixture(session = ALICE, initialRounds: unknown[] = []) {
  const task = makeTask({
    id: TASK,
    assigneeUserId: ALICE.userId,
    assignmentStatus: 'accepted',
    status: 'in_progress',
  })
  const sourceRun = makeRun({ id: RUN, status: 'completed' })
  const source = makeArtifact({
    id: ART,
    runId: RUN,
    title: '原稿.md',
    status: 'published',
    ownerUserId: ALICE.userId,
  })
  const newer = makeArtifact({
    id: NEW,
    runId: REVISION_RUN,
    title: '新版.md',
    status: 'published',
    ownerUserId: ALICE.userId,
  })
  const state = {
    rounds: initialRounds,
    createBodies: [] as unknown[],
    resolutionBodies: [] as unknown[],
    failResolution: false,
    failStart: false,
    linkBodies: [] as unknown[],
    startBodies: [] as unknown[],
    startKeys: [] as string[],
  }
  const handlers: MockHandler[] = [
    taskRoomHandler(task, {
      runs: [sourceRun, makeRun({ id: REVISION_RUN, status: 'completed' })],
      artifacts: [source, newer],
    }),
    teamMembersHandler(),
    {
      method: 'GET',
      url: new RegExp(`/runs/${RUN}$`),
      respond: () =>
        ok({
          ...sourceRun,
          taskId: TASK,
          ownerUserId: ALICE.userId,
          agentId: AGENT,
          profileRevisionId: REVISION,
          deviceId: DEVICE,
          workspaceId: WORKSPACE,
          dshSessionId: 'source-session',
        }),
    },
    {
      method: 'GET',
      url: /\/agents$/,
      respond: () => ok([{ id: AGENT, name: '写作 Agent', archivedAt: null }]),
    },
    {
      method: 'GET',
      url: new RegExp(`/agents/${AGENT}$`),
      respond: () =>
        ok({
          id: AGENT,
          name: '写作 Agent',
          archivedAt: null,
          currentRevisionId: REVISION,
          revisions: [
            {
              id: REVISION,
              revision: 1,
              provider: 'fixture',
              model: 'fixture',
              credentialSlot: 'default',
              approvalPolicy: 'approval_required',
            },
          ],
        }),
    },
    { method: 'GET', url: /\/devices$/, respond: () => ok([makeDevice({ id: DEVICE })]) },
    {
      method: 'GET',
      url: /\/workspaces$/,
      respond: () =>
        ok([{ workspaceId: WORKSPACE, deviceId: DEVICE, name: '我的工作区', available: true }]),
    },
    {
      method: 'POST',
      url: new RegExp(`/artifact-revision-rounds/${ROUND}/start$`),
      respond: (init) => {
        state.startBodies.push(JSON.parse(String(init.body)))
        state.startKeys.push(new Headers(init.headers).get('idempotency-key') ?? '')
        if (state.failStart) return apiFailure('DEVICE_OFFLINE', '设备暂时离线')
        state.rounds = [round({ status: 'started', runId: RUN, startedAt: NOW })]
        return ok(state.rounds[0])
      },
    },
    {
      method: 'GET',
      url: new RegExp(`/artifacts/${ART}/review$`),
      respond: () =>
        ok({
          artifact: {
            id: source.id,
            taskId: TASK,
            title: source.title,
            mediaType: source.mediaType,
            byteSize: source.byteSize,
            sha256: source.sha256,
            status: source.status,
            ownerUserId: source.ownerUserId,
            publishedAt: source.publishedAt,
          },
          comments: [thread],
          invitations: [],
          reading: 'text',
          textPreviewMaxBytes: 524288,
          capabilities: { canInvite: session === ALICE, canSubmitReview: false, canComment: true },
        }),
    },
    {
      method: 'GET',
      url: new RegExp(`/tasks/${TASK}/artifact-revision-rounds$`),
      respond: () => ok(state.rounds),
    },
    {
      method: 'GET',
      url: new RegExp(`/artifacts/(${ART}|${NEW})/content$`),
      respond: (_init, url) =>
        new Response(url.includes(NEW) ? '原文\n已补充异常输入范围\n' : '原文\n', { status: 200 }),
    },
    {
      method: 'POST',
      url: new RegExp(`/tasks/${TASK}/artifact-revision-rounds$`),
      respond: (init) => {
        const body = JSON.parse(String(init.body))
        state.createBodies.push(body)
        state.rounds = [round()]
        return ok(round())
      },
    },
    {
      method: 'POST',
      url: new RegExp(`/artifact-revision-rounds/${ROUND}/candidates$`),
      respond: (init) => {
        state.linkBodies.push(JSON.parse(String(init.body)))
        state.rounds = [
          round({
            status: 'started',
            runId: REVISION_RUN,
            startedAt: NOW,
            candidate: { artifactId: NEW, linkedAt: NOW, publishedAt: NOW },
          }),
        ]
        return ok(state.rounds[0])
      },
    },
    {
      method: 'POST',
      url: new RegExp(`/artifact-revision-rounds/${ROUND}/resolutions$`),
      respond: (init) => {
        const body = JSON.parse(String(init.body))
        state.resolutionBodies.push(body)
        if (state.failResolution) return apiFailure('CONFLICT', '版本暂不可用')
        state.rounds = [
          round({
            status: 'started',
            runId: RUN,
            startedAt: NOW,
            candidate: { artifactId: NEW, linkedAt: NOW, publishedAt: NOW },
            resolutions: [
              {
                commentId: COMMENT,
                status: body.status,
                resolvedBy: session.userId,
                note: body.note ?? null,
                updatedAt: NOW,
              },
            ],
          }),
        ]
        return ok(state.rounds[0])
      },
    },
  ]
  renderApp(`/tasks/${TASK}/review/${ART}`, loggedInHandlers(session, handlers))
  return state
}

describe('review revision loop (#430)', () => {
  it('责任人选择意见后创建固定批次；创建本身不启动执行', async () => {
    const user = userEvent.setup()
    const state = fixture()
    await user.click(await screen.findByRole('button', { name: '整理本轮修订' }))
    const panel = await screen.findByTestId('revision-round-organizer')
    expect(within(panel).getByRole('button', { name: '固定本轮意见' })).toBeDisabled()
    await user.click(within(panel).getByRole('checkbox', { name: /补充异常输入/ }))
    await user.type(within(panel).getByLabelText('本轮修订方向'), '只补充依据，不改结论')
    await user.click(within(panel).getByRole('button', { name: '固定本轮意见' }))
    await waitFor(() =>
      expect(state.createBodies).toEqual([
        { sourceArtifactId: ART, commentIds: [COMMENT], direction: '只补充依据，不改结论' },
      ]),
    )
    expect(await screen.findByTestId(`revision-round-${ROUND}`)).toHaveTextContent('尚未开始执行')
  })

  it('固定批次启动失败后保留原稿会话与配置，重试同一轮及幂等键', async () => {
    const user = userEvent.setup()
    const state = fixture(ALICE, [round()])
    state.failStart = true
    const panel = await screen.findByTestId(`revision-round-${ROUND}`)
    const start = within(panel).getByRole('button', { name: '开始修订' })
    await waitFor(() => expect(start).toBeEnabled())
    await user.click(start)
    await screen.findByText(/设备暂时离线/)
    expect(
      (within(panel).getByRole('textbox', { name: '指令' }) as HTMLTextAreaElement).value,
    ).toContain('请按本轮冻结')
    state.failStart = false
    await user.click(start)
    await waitFor(() => expect(state.startBodies).toHaveLength(2))
    expect(state.createBodies).toEqual([])
    expect(state.startBodies[0]).toEqual(state.startBodies[1])
    expect(state.startBodies[0]).toMatchObject({
      agentId: AGENT,
      profileRevisionId: REVISION,
      deviceId: DEVICE,
      workspaceId: WORKSPACE,
      resumeFromRunId: RUN,
      expectedApprovalPolicy: 'approval_required',
    })
    expect(state.startKeys[0]).not.toBe('')
    expect(state.startKeys[0]).toBe(state.startKeys[1])
  })

  it('从任务页已发布的本轮产物仍可明确关联为新版', async () => {
    const user = userEvent.setup()
    const state = fixture(ALICE, [
      round({ status: 'started', runId: REVISION_RUN, startedAt: NOW }),
    ])
    const panel = await screen.findByTestId(`revision-round-${ROUND}`)
    expect(state.linkBodies).toEqual([])
    await user.click(within(panel).getByRole('button', { name: '选择本轮新版候选' }))
    await user.click(await screen.findByRole('menuitem', { name: '新版.md' }))
    await user.click(within(panel).getByRole('button', { name: '关联为本轮新版' }))
    await waitFor(() => expect(state.linkBodies).toEqual([{ candidateArtifactId: NEW }]))
    expect(await within(panel).findByRole('button', { name: '查看原稿与新版' })).toBeEnabled()
  })

  it('修订执行入口定位 Task Room 的实际执行区', async () => {
    fixture(BOB, [round({ status: 'started', runId: REVISION_RUN, startedAt: NOW })])
    const panel = await screen.findByTestId(`revision-round-${ROUND}`)
    expect(within(panel).getByRole('link', { name: '查看执行与产出' })).toHaveAttribute(
      'href',
      `/tasks/${TASK}#task-execution`,
    )
  })

  it('普通审阅者不能组织执行，可核对新版并确认自己的意见', async () => {
    const user = userEvent.setup()
    const state = fixture(BOB, [
      round({
        status: 'started',
        runId: RUN,
        startedAt: NOW,
        candidate: { artifactId: NEW, linkedAt: NOW, publishedAt: NOW },
      }),
    ])
    const panel = await screen.findByTestId(`revision-round-${ROUND}`)
    expect(screen.queryByRole('button', { name: '整理本轮修订' })).not.toBeInTheDocument()
    await user.click(within(panel).getByRole('button', { name: '查看原稿与新版' }))
    const newer = await screen.findByTestId('revision-new-text')
    expect(newer).toHaveTextContent('已补充异常输入范围')
    expect(newer.querySelector('mark')).toHaveTextContent('已补充异常输入范围')
    await user.click(within(panel).getByRole('button', { name: '确认已解决' }))
    await waitFor(() =>
      expect(state.resolutionBodies).toEqual([{ commentId: COMMENT, status: 'resolved' }]),
    )
    await waitFor(() => expect(panel).toHaveTextContent('已解决'))
  })

  it('责任人代收口必须写理由，失败保留输入；未发布新版不显示解决按钮', async () => {
    const user = userEvent.setup()
    const state = fixture(ALICE, [
      round({
        status: 'started',
        runId: RUN,
        startedAt: NOW,
        candidate: { artifactId: NEW, linkedAt: NOW, publishedAt: NOW },
      }),
    ])
    const panel = await screen.findByTestId(`revision-round-${ROUND}`)
    expect(within(panel).getByRole('button', { name: '确认已解决' })).toBeDisabled()
    await user.type(within(panel).getByLabelText('复核说明或代收口理由'), '已按原始样本检查')
    state.failResolution = true
    await user.click(within(panel).getByRole('button', { name: '确认已解决' }))
    await screen.findByText(/版本暂不可用/)
    expect(within(panel).getByLabelText('复核说明或代收口理由')).toHaveValue('已按原始样本检查')
    state.failResolution = false
    await user.click(within(panel).getByRole('button', { name: '仍需修改' }))
    await waitFor(() =>
      expect(state.resolutionBodies.at(-1)).toEqual({
        commentId: COMMENT,
        status: 'needs_work',
        note: '已按原始样本检查',
      }),
    )
  })

  it('未发布候选不暴露给审阅者，也不能确认解决', async () => {
    fixture(BOB, [round({ status: 'started', runId: RUN, startedAt: NOW, candidate: null })])
    const panel = await screen.findByTestId(`revision-round-${ROUND}`)
    expect(within(panel).queryByRole('button', { name: '确认已解决' })).not.toBeInTheDocument()
    expect(panel).toHaveTextContent('尚无已发布新版')
  })
})

it('完成任务显示尚未解决意见并提供准确入口，提示不增加硬闸', async () => {
  const user = userEvent.setup()
  const task = makeTask({
    id: TASK,
    status: 'in_review',
    assigneeUserId: ALICE.userId,
    assignmentStatus: 'accepted',
  })
  let completed = false
  renderApp(
    `/tasks/${TASK}`,
    loggedInHandlers(ALICE, [
      taskRoomHandler(task, { reviewFeedback: { unresolvedCount: 2, artifactId: ART } }),
      teamMembersHandler(),
      {
        method: 'POST',
        url: new RegExp(`/tasks/${TASK}/complete$`),
        respond: () => {
          completed = true
          return ok({ ...task, status: 'done' })
        },
      },
    ]),
  )
  expect(await screen.findByTestId('unresolved-review-warning')).toHaveTextContent('还有 2 条意见')
  expect(screen.getByRole('link', { name: '查看批注与复核' })).toHaveAttribute(
    'href',
    `/tasks/${TASK}/review/${ART}`,
  )
  await user.click(screen.getByRole('button', { name: '完成任务' }))
  const dialog = await screen.findByRole('dialog')
  expect(dialog).toHaveTextContent('仍有 2 条意见')
  await user.click(within(dialog).getByRole('button', { name: '确认完成任务' }))
  await waitFor(() => expect(completed).toBe(true))
})

it.each([
  ['same\n', 'same\n', { old: [5, 5], next: [5, 5] }],
  ['head\nold\ntail\n', 'head\nnew\ntail\n', { old: [5, 9], next: [5, 9] }],
  ['', '新增😀\n', { old: [0, 0], next: [0, 5] }],
] as const)('文本差异保留原文并标记变更行范围', (old, next, expected) => {
  expect(changedLineRange(old, next)).toEqual(expected)
})
