/**
 * 交接草稿面板（#379；ADR-0017 §4）页面级判据。
 *
 * 从用户视角驱动（role/label/text）：仅终态 Run 的面板出现、草稿编辑与并发令牌、
 * 发布、失败恢复与未启用禁用、发布校验失败原样展示——以及**私有性**（404 → 面板
 * 整体不出现，不渲染占位、不泄露存在性）与请求体确实带令牌（面向服务端的契约）。
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
} from './fixtures.js'
import type { MockHandler } from './fixtures.js'
import { renderApp } from './render.jsx'
import { parseRefs, serializeRefs } from '../src/features/task/RunHandoffDraft.js'
import type {
  HandoffDraftView,
  HandoffNarrative,
  HandoffRevisionView,
} from '../src/shared/api/types.js'

const TASK_ID = '00000000-0000-4000-8000-0000000000aa'
const RUN_ID = '00000000-0000-4000-8000-0000000000bb'
const REVISION_ID = '00000000-0000-4000-8000-0000000000cc'

function makeNarrative(overrides: Partial<HandoffNarrative> = {}): HandoffNarrative {
  return {
    completed: [{ text: '完成登录接口', verified: false, refs: [] }],
    interfaces: [],
    unfinished: [],
    decisions: [],
    evidence: [],
    downstream: [],
    commits: [],
    prs: [],
    ...overrides,
  }
}

function makeDraftView(overrides: Partial<HandoffDraftView> = {}): HandoffDraftView {
  return {
    id: '00000000-0000-4000-8000-0000000000dd',
    taskId: TASK_ID,
    sourceRunId: RUN_ID,
    specRevisionId: REVISION_ID,
    status: 'ready',
    failureReason: null,
    content: {
      system: {
        sourceRunId: RUN_ID,
        specRevision: { id: REVISION_ID, revisionNumber: 1 },
        artifacts: [],
      },
      narrative: makeNarrative(),
    },
    draftVersion: 3,
    origin: 'auto',
    createdByUserId: BOB.userId,
    createdAt: '2026-08-25T04:00:00.000Z',
    updatedAt: '2026-08-25T04:00:00.000Z',
    publishedRevisionId: null,
    ...overrides,
  }
}

function makeRevisionView(): HandoffRevisionView {
  const draft = makeDraftView({ status: 'published' })
  return {
    id: '00000000-0000-4000-8000-0000000000ee',
    taskId: TASK_ID,
    revisionNumber: 1,
    sourceRunId: RUN_ID,
    specRevisionId: REVISION_ID,
    content: draft.content as HandoffRevisionView['content'],
    publishedByUserId: BOB.userId,
    publishedAt: '2026-08-25T05:00:00.000Z',
  }
}

function roomHandlers(
  extra: MockHandler[],
  options: {
    runStatus?: NonNullable<Parameters<typeof makeRun>[0]>['status']
    agreementEnabled?: boolean
  } = {},
): MockHandler[] {
  const task = makeTask({
    id: TASK_ID,
    assigneeUserId: BOB.userId,
    assignmentStatus: 'accepted',
    acceptedAt: '2026-08-25T00:00:00.000Z',
    status: 'in_progress',
    agreementEnabled: options.agreementEnabled ?? true,
  })
  const run = makeRun({ id: RUN_ID, status: options.runStatus ?? 'completed' })
  return loggedInHandlers(BOB, [
    taskRoomHandler(task, { runs: [run] }),
    // 选中 Run 后 RunLivePanel 会拉这两条：缺了它们面板停在「正在加载 Run…」。
    {
      method: 'GET',
      url: new RegExp(`/api/v1/runs/${RUN_ID}$`),
      respond: () =>
        ok({
          ...run,
          taskId: TASK_ID,
          agentId: '00000000-0000-4000-8000-000000000012',
          profileRevisionId: REVISION_ID,
          ownerUserId: BOB.userId,
          dshSessionId: 'session-1',
        }),
    },
    { method: 'GET', url: /\/events(?:\?.*)?$/, respond: () => ok([]) },
    teamMembersHandler(),
    ...extra,
  ])
}

async function openRun(user: ReturnType<typeof userEvent.setup>): Promise<void> {
  await user.click(await screen.findByRole('button', { name: /第 1 次运行/ }))
}

describe('#379 交接草稿面板', () => {
  it('ready 草稿：编辑文本与引用、保存携带并发令牌、发布后显示不可变', async () => {
    const user = userEvent.setup()
    const ready = makeDraftView()
    let currentView: HandoffDraftView | null = ready
    const saved = makeDraftView({
      draftVersion: 4,
      origin: 'manual',
      content: {
        system: {
          sourceRunId: RUN_ID,
          specRevision: { id: REVISION_ID, revisionNumber: 1 },
          artifacts: [],
        },
        narrative: makeNarrative({
          completed: [
            {
              text: '完成登录与注册',
              verified: true,
              refs: [
                { kind: 'commit', sha: 'abc1234' },
                { kind: 'url', url: 'https://example.dev/pr/1' },
              ],
            },
          ],
        }),
      },
    })
    const handlers = roomHandlers([
      {
        method: 'GET',
        url: new RegExp(`/api/v1/runs/${RUN_ID}/handoff-draft$`),
        respond: () => ok(currentView),
      },
      {
        method: 'PATCH',
        url: new RegExp(`/api/v1/runs/${RUN_ID}/handoff-draft$`),
        respond: (init) => {
          const body = JSON.parse(String(init.body)) as {
            narrative: HandoffNarrative
            expectedDraftVersion: number
          }
          expect(body.expectedDraftVersion).toBe(3)
          expect(body.narrative.completed[0]).toEqual({
            text: '完成登录与注册',
            verified: true,
            refs: [
              { kind: 'commit', sha: 'abc1234' },
              { kind: 'url', url: 'https://example.dev/pr/1' },
            ],
          })
          currentView = saved
          return ok(saved)
        },
      },
      {
        method: 'POST',
        url: new RegExp(`/api/v1/runs/${RUN_ID}/handoff-draft/publish$`),
        respond: () => {
          currentView = makeDraftView({
            status: 'published',
            draftVersion: 4,
            publishedRevisionId: makeRevisionView().id,
          })
          return ok(makeRevisionView())
        },
      },
    ])
    renderApp(`/tasks/${TASK_ID}`, handlers)
    await openRun(user)

    const panel = await screen.findByTestId('handoff-draft')
    expect(panel).toHaveTextContent('仅你可见')
    const editor = within(panel).getByTestId('handoff-editor')
    const textInput = within(editor).getByLabelText('完成项第 1 条')
    expect(textInput).toHaveValue('完成登录接口')

    await user.clear(textInput)
    await user.type(textInput, '完成登录与注册')
    await user.click(within(editor).getByLabelText('已核实第 1 条'))
    // 引用逐键输入（未成形的 token 必须留在输入框里，不被序列化吞掉）。
    await user.type(
      within(editor).getByLabelText('引用第 1 条'),
      'commit:abc1234 url:https://example.dev/pr/1',
    )
    expect(within(editor).getByLabelText('引用第 1 条')).toHaveValue(
      'commit:abc1234 url:https://example.dev/pr/1',
    )

    await user.click(within(editor).getByRole('button', { name: '保存草稿' }))
    await waitFor(() =>
      expect(within(panel).getByLabelText('完成项第 1 条')).toHaveValue('完成登录与注册'),
    )

    await user.click(within(panel).getByRole('button', { name: '发布交接包' }))
    expect(await within(panel).findByTestId('handoff-draft-published')).toHaveTextContent(
      '不可变版本',
    )
    expect(within(panel).queryByTestId('handoff-editor')).not.toBeInTheDocument()
    expect(within(panel).getByRole('button', { name: '基于此版本新建草稿' })).toBeInTheDocument()
  })

  it('无草稿：说明自动生成时机；手工新建后进入编辑器', async () => {
    const user = userEvent.setup()
    const created = makeDraftView({ origin: 'manual', draftVersion: 1 })
    let currentView: HandoffDraftView | null = null
    const handlers = roomHandlers([
      {
        method: 'GET',
        url: new RegExp(`/api/v1/runs/${RUN_ID}/handoff-draft$`),
        respond: () => ok(currentView),
      },
      {
        method: 'POST',
        url: new RegExp(`/api/v1/runs/${RUN_ID}/handoff-draft$`),
        respond: () => {
          currentView = created
          return ok(created)
        },
      },
    ])
    renderApp(`/tasks/${TASK_ID}`, handlers)
    await openRun(user)

    const panel = await screen.findByTestId('handoff-draft')
    expect(within(panel).getByTestId('handoff-draft-none')).toHaveTextContent(
      '正常完成的执行会自动整理一份草稿',
    )
    await user.click(within(panel).getByRole('button', { name: '手工新建草稿' }))
    const editor = await within(panel).findByTestId('handoff-editor')
    expect(within(editor).getByLabelText('完成项第 1 条')).toHaveValue('完成登录接口')
  })

  it('生成失败：说明「未生成」与业务不受影响；未启用约定时禁止手工新建', async () => {
    const failed = makeDraftView({
      status: 'failed',
      failureReason: 'timeout',
      content: null,
    })
    renderApp(
      `/tasks/${TASK_ID}`,
      roomHandlers(
        [
          {
            method: 'GET',
            url: new RegExp(`/api/v1/runs/${RUN_ID}/handoff-draft$`),
            respond: () => ok(failed),
          },
        ],
        { agreementEnabled: false },
      ),
    )
    await openRun(userEvent.setup())
    const panel = await screen.findByTestId('handoff-draft')
    expect(within(panel).getByTestId('handoff-draft-failed')).toHaveTextContent('timeout')
    expect(within(panel).getByTestId('handoff-draft-failed')).toHaveTextContent(
      '业务执行结果不受影响',
    )
    const create = within(panel).getByRole('button', { name: '手工新建草稿' })
    expect(create).toBeDisabled()
    expect(create).toHaveAttribute('title', '任务未启用约定流程，交接包无法发布')
  })

  it('非 owner（404）：面板整体不出现，不渲染占位', async () => {
    renderApp(
      `/tasks/${TASK_ID}`,
      roomHandlers([
        {
          method: 'GET',
          url: new RegExp(`/api/v1/runs/${RUN_ID}/handoff-draft$`),
          respond: () => ({
            status: 404,
            body: {
              ok: false,
              error: { code: 'NOT_FOUND', message: 'handoff draft not found', requestId: 'req-1' },
            },
          }),
        },
      ]),
    )
    await openRun(userEvent.setup())
    await screen.findByTestId('run-live-panel')
    expect(screen.queryByTestId('handoff-draft')).not.toBeInTheDocument()
    expect(screen.queryByText('交接草稿')).not.toBeInTheDocument()
  })

  it('运行中 Run：不查询也不渲染（进行中没有草稿语义）', async () => {
    const fetchMock = renderApp(
      `/tasks/${TASK_ID}`,
      roomHandlers(
        [
          {
            method: 'GET',
            url: new RegExp(`/api/v1/runs/${RUN_ID}/handoff-draft$`),
            respond: () => ok(null),
          },
        ],
        { runStatus: 'running' },
      ),
    ).fetchMock
    await openRun(userEvent.setup())
    await screen.findByTestId('run-live-panel')
    expect(screen.queryByTestId('handoff-draft')).not.toBeInTheDocument()
    expect(fetchMock.mock.calls.some(([url]) => String(url).endsWith('/handoff-draft'))).toBe(false)
  })

  it('发布校验失败：原样展示错误，不自动重试', async () => {
    const user = userEvent.setup()
    let publishes = 0
    renderApp(
      `/tasks/${TASK_ID}`,
      roomHandlers([
        {
          method: 'GET',
          url: new RegExp(`/api/v1/runs/${RUN_ID}/handoff-draft$`),
          respond: () => ok(makeDraftView()),
        },
        {
          method: 'POST',
          url: new RegExp(`/api/v1/runs/${RUN_ID}/handoff-draft/publish$`),
          respond: () => {
            publishes += 1
            return {
              status: 400,
              body: {
                ok: false,
                error: {
                  code: 'VALIDATION_FAILED',
                  message: '验证证据条目必须附至少一条引用',
                  requestId: 'req-2',
                },
              },
            }
          },
        },
      ]),
    )
    await openRun(user)
    const panel = await screen.findByTestId('handoff-draft')
    await user.click(within(panel).getByRole('button', { name: '发布交接包' }))
    expect(await within(panel).findByText(/验证证据条目必须附至少一条引用/)).toBeInTheDocument()
    expect(publishes).toBe(1)
  })
})

describe('#379 引用 token 解析', () => {
  it('serialize/parse 往返：四类引用一致，非法 token 单独报告', () => {
    const refs = [
      { kind: 'url' as const, url: 'https://example.dev/a' },
      { kind: 'commit' as const, sha: 'abc1234' },
      { kind: 'run' as const, runId: RUN_ID },
      { kind: 'artifact' as const, artifactId: '00000000-0000-4000-8000-0000000000ff' },
    ]
    expect(parseRefs(serializeRefs(refs))).toEqual({ refs, invalid: [] })
    const mixed = parseRefs('commit:abc1234 nope ftp://x file:y')
    expect(mixed.refs).toEqual([{ kind: 'commit', sha: 'abc1234' }])
    expect(mixed.invalid).toEqual(['nope', 'ftp://x', 'file:y'])
  })
})
