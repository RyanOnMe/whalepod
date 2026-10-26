import { fireEvent, screen, waitFor, within } from '@testing-library/react'
import { userEvent } from '@testing-library/user-event'
import { describe, expect, it } from 'vitest'
import { ALICE, BOB, apiFailure, loggedInHandlers, makeArtifact, makeRun, makeTask, ok, taskRoomHandler, teamMembersHandler, type MockHandler } from './fixtures.js'
import { renderApp } from './render.js'

const TASK = '00000000-0000-4000-8000-000000000101'
const ART = '00000000-0000-4000-8000-000000000102'
const ROUND = '00000000-0000-4000-8000-000000000103'
const COMMENT = '00000000-0000-4000-8000-000000000104'
const NEW = '00000000-0000-4000-8000-000000000105'
const RUN = '00000000-0000-4000-8000-000000000106'
const NOW = '2026-10-26T01:00:00.000Z'
const thread = { id: COMMENT, artifactId: ART, authorUserId: BOB.userId, parentCommentId: null, kind: 'whole', anchor: null, body: '补充异常输入的处理范围', createdAt: NOW }
function round(overrides: Record<string, unknown> = {}) {
  return { id: ROUND, taskId: TASK, status: 'preparing', sourceArtifact: { artifactId: ART, runId: RUN, title: '原稿.md', mediaType: 'text/markdown', byteSize: 8, sha256: 'a'.repeat(64), publishedAt: NOW }, direction: null, comments: [{ commentId: COMMENT, authorUserId: BOB.userId, kind: 'whole', anchor: null, body: thread.body, createdAt: NOW, replies: [] }], references: [], runId: null, candidate: null, resolutions: [], createdAt: NOW, startedAt: null, ...overrides }
}
function fixture(session = ALICE, initialRounds: unknown[] = []) {
  const task = makeTask({ id: TASK, assigneeUserId: ALICE.userId, assignmentStatus: 'accepted', status: 'in_progress' })
  const sourceRun = makeRun({ id: RUN, status: 'completed' })
  const source = makeArtifact({ id: ART, runId: RUN, title: '原稿.md', status: 'published', ownerUserId: ALICE.userId })
  const newer = makeArtifact({ id: NEW, runId: RUN, title: '新版.md', status: 'published', ownerUserId: ALICE.userId })
  const state = { rounds: initialRounds, createBodies: [] as unknown[], resolutionBodies: [] as unknown[], failResolution: false }
  const handlers: MockHandler[] = [
    taskRoomHandler(task, { runs: [sourceRun], artifacts: [source, newer] }),
    teamMembersHandler(),
    { method: 'GET', url: new RegExp(`/artifacts/${ART}/review$`), respond: () => ok({ artifact: { ...source, taskId: TASK }, comments: [thread], invitations: [], reading: 'text', textPreviewMaxBytes: 524288, capabilities: { canInvite: session === ALICE, canSubmitReview: false, canComment: true } }) },
    { method: 'GET', url: new RegExp(`/tasks/${TASK}/artifact-revision-rounds$`), respond: () => ok(state.rounds) },
    { method: 'GET', url: new RegExp(`/artifacts/(${ART}|${NEW})/content$`), respond: (_init, url) => new Response(url.includes(NEW) ? '原文\n已补充异常输入范围\n' : '原文\n', { status: 200 }) },
    { method: 'POST', url: new RegExp(`/tasks/${TASK}/artifact-revision-rounds$`), respond: init => { const body = JSON.parse(String(init.body)); state.createBodies.push(body); state.rounds = [round()]; return ok(round()) } },
    { method: 'POST', url: new RegExp(`/artifact-revision-rounds/${ROUND}/resolutions$`), respond: init => { const body = JSON.parse(String(init.body)); state.resolutionBodies.push(body); if (state.failResolution) return apiFailure('CONFLICT', '版本暂不可用'); state.rounds = [round({ status: 'started', runId: RUN, startedAt: NOW, candidate: { artifactId: NEW, linkedAt: NOW, publishedAt: NOW }, resolutions: [{ commentId: COMMENT, status: body.status, resolvedBy: session.userId, note: body.note ?? null, updatedAt: NOW }] })]; return ok(state.rounds[0]) } },
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
    await waitFor(() => expect(state.createBodies).toEqual([{ sourceArtifactId: ART, commentIds: [COMMENT], direction: '只补充依据，不改结论' }]))
    expect(await screen.findByTestId(`revision-round-${ROUND}`)).toHaveTextContent('尚未开始执行')
  })

  it('普通审阅者不能组织执行，可核对新版并确认自己的意见', async () => {
    const user = userEvent.setup()
    const state = fixture(BOB, [round({ status: 'started', runId: RUN, startedAt: NOW, candidate: { artifactId: NEW, linkedAt: NOW, publishedAt: NOW } })])
    const panel = await screen.findByTestId(`revision-round-${ROUND}`)
    expect(screen.queryByRole('button', { name: '整理本轮修订' })).not.toBeInTheDocument()
    await user.click(within(panel).getByRole('button', { name: '查看原稿与新版' }))
    expect(await screen.findByTestId('revision-new-text')).toHaveTextContent('已补充异常输入范围')
    await user.click(within(panel).getByRole('button', { name: '确认已解决' }))
    await waitFor(() => expect(state.resolutionBodies).toEqual([{ commentId: COMMENT, status: 'resolved' }]))
    await waitFor(() => expect(panel).toHaveTextContent('已解决'))
  })

  it('责任人代收口必须写理由，失败保留输入；未发布新版不显示解决按钮', async () => {
    const user = userEvent.setup()
    const state = fixture(ALICE, [round({ status: 'started', runId: RUN, startedAt: NOW, candidate: { artifactId: NEW, linkedAt: NOW, publishedAt: NOW } })])
    const panel = await screen.findByTestId(`revision-round-${ROUND}`)
    expect(within(panel).getByRole('button', { name: '确认已解决' })).toBeDisabled()
    await user.type(within(panel).getByLabelText('复核说明或代收口理由'), '已按原始样本检查')
    state.failResolution = true
    await user.click(within(panel).getByRole('button', { name: '确认已解决' }))
    await screen.findByText(/版本暂不可用/)
    expect(within(panel).getByLabelText('复核说明或代收口理由')).toHaveValue('已按原始样本检查')
    state.failResolution = false
    await user.click(within(panel).getByRole('button', { name: '仍需修改' }))
    await waitFor(() => expect(state.resolutionBodies.at(-1)).toEqual({ commentId: COMMENT, status: 'needs_work', note: '已按原始样本检查' }))
  })

  it('未发布候选不暴露给审阅者，也不能确认解决', async () => {
    fixture(BOB, [round({ status: 'started', runId: RUN, startedAt: NOW, candidate: null })])
    const panel = await screen.findByTestId(`revision-round-${ROUND}`)
    expect(within(panel).queryByRole('button', { name: '确认已解决' })).not.toBeInTheDocument()
    expect(panel).toHaveTextContent('尚无已发布新版')
  })
})
