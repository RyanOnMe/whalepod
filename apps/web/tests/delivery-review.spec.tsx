import { act, screen, waitFor } from '@testing-library/react'
import { userEvent } from '@testing-library/user-event'
import { describe, expect, it } from 'vitest'
import { queryKeys } from '../src/app/query-client.js'
import { renderApp } from './render.jsx'
import { selectOption } from './select-menu.js'
import {
  ALICE,
  BOB,
  devicesHandler,
  loggedInHandlers,
  makeArtifact,
  makeDevice,
  makeRun,
  makeTask,
  ok,
  taskRoomHandler,
  teamMembersHandler,
  workspacesHandler,
  type MockHandler,
} from './fixtures.js'

const BUILDER = '00000000-0000-4000-8000-000000000010'
const REVIEWER = '00000000-0000-4000-8000-000000000020'
const REVISION = '00000000-0000-4000-8000-000000000021'
const WORKSPACE = '00000000-0000-4000-8000-000000000030'
function fixture(
  options: {
    active?: boolean
    unauthorized?: boolean
    fullAccess?: boolean
    unknownHistory?: boolean
    revisionHistory?: boolean
    taskStatus?: 'in_progress' | 'in_review'
    candidateOnly?: boolean
    instructionGate?: Promise<void>
  } = {},
) {
  const task = makeTask({
    assignmentStatus: 'accepted',
    status: options.taskStatus ?? 'in_progress',
    approvalPolicy: options.fullAccess ? 'full_access' : 'approval_required',
  })
  const producer = makeRun({ status: options.active ? 'running' : 'completed' })
  const reviewer = makeRun({ status: 'completed' })
  const artifact = makeArtifact({
    runId: options.revisionHistory ? reviewer.id : producer.id,
    status: options.candidateOnly ? 'candidate' : 'published',
    title: '待复核报告.md',
  })
  const late = makeArtifact({
    runId: producer.id,
    status: 'published',
    title: '后来发布的报告.md',
  })
  const device = makeDevice()
  const posts: unknown[] = []
  const agents = [
    { id: BUILDER, name: 'Builder', archivedAt: null, currentRevisionId: REVISION },
    { id: REVIEWER, name: 'Reviewer', archivedAt: null, currentRevisionId: REVISION },
  ]
  const handlers: MockHandler[] = [
    taskRoomHandler(task, {
      runs: options.revisionHistory ? [producer, reviewer] : [producer],
      artifacts: [artifact],
      reviewEligibility: {
        allowed:
          !options.active &&
          !options.unauthorized &&
          !options.candidateOnly &&
          task.status === 'in_progress',
        reason: options.active
          ? 'active_run'
          : options.unauthorized
            ? 'not_assignee'
            : options.candidateOnly
              ? 'no_published_artifact'
              : task.status === 'in_review'
                ? 'task_not_in_progress'
                : null,
      },
    }),
    teamMembersHandler(),
    { method: 'GET', url: /\/instruction-grants$/, respond: () => ok([]) },
    { method: 'GET', url: /\/agents$/, respond: () => ok(agents) },
    ...agents.map((agent) => ({
      method: 'GET',
      url: new RegExp(`/agents/${agent.id}$`),
      respond: () =>
        ok({
          ...agent,
          revisions: [
            {
              id: REVISION,
              revision: 1,
              provider: 'replay',
              model: 'replay',
              credentialSlot: 'default',
              approvalPolicy: 'approval_required',
            },
          ],
        }),
    })),
    devicesHandler([device]),
    workspacesHandler([
      {
        workspaceId: WORKSPACE,
        deviceId: device.id,
        name: 'work',
        kind: 'directory',
        available: true,
      },
    ]),
    {
      method: 'POST',
      url: /\/instructions$/,
      respond: async (init) => {
        posts.push(JSON.parse(String(init.body)))
        await options.instructionGate
        return ok({ outcome: 'started_run', runId: producer.id, instructionState: 'pending' })
      },
    },
    {
      method: 'GET',
      url: new RegExp(`/runs/${producer.id}$`),
      respond: () =>
        ok({
          ...producer,
          taskId: task.id,
          agentId: BUILDER,
          profileRevisionId: REVISION,
          ownerUserId: BOB.userId,
          dshSessionId: 'producer-session',
        }),
    },
    {
      method: 'GET',
      url: new RegExp(`/runs/${reviewer.id}$`),
      respond: () =>
        ok({
          ...reviewer,
          taskId: task.id,
          agentId: REVIEWER,
          profileRevisionId: REVISION,
          ownerUserId: BOB.userId,
          dshSessionId: 'reviewer-session',
        }),
    },
    { method: 'GET', url: /\/events(?:\?.*)?$/, respond: () => ok([]) },
    {
      method: 'GET',
      url: /\/input-manifest$/,
      respond: () =>
        ok(
          options.unknownHistory
            ? null
            : {
                taskId: task.id,
                artifacts: [
                  {
                    artifactId: artifact.id,
                    runId: producer.id,
                    title: artifact.title,
                    mediaType: artifact.mediaType,
                    byteSize: artifact.byteSize,
                    sha256: artifact.sha256,
                    publishedAt: artifact.publishedAt,
                  },
                ],
              },
        ),
    },
  ]
  const view = renderApp(
    `/tasks/${task.id}`,
    loggedInHandlers(options.unauthorized ? ALICE : BOB, handlers),
  )
  return { ...view, task, producer, reviewer, artifact, late, posts }
}
async function review(user: ReturnType<typeof userEvent.setup>) {
  await user.click(await screen.findByRole('button', { name: '发起复核' }))
}
describe('从交付物发起复核 (#326)', () => {
  it('保留草稿、明确选Agent、只发送所选材料；新发布不扩大选择', async () => {
    const user = userEvent.setup()
    const f = fixture()
    await user.type(await screen.findByLabelText('指令'), '我已写好的复核要求')
    await review(user)
    expect(screen.getByLabelText('指令')).toHaveValue('我已写好的复核要求')
    expect(screen.getByRole('button', { name: '开始复核' })).toBeDisabled()
    expect(f.posts).toHaveLength(0)
    expect(screen.getByLabelText(`复核材料：${f.artifact.title}`)).toBeChecked()
    await act(async () =>
      f.queryClient.setQueryData(queryKeys.taskRoom(f.task.id), (old: object | undefined) => ({
        ...old,
        artifacts: [f.artifact, f.late],
      })),
    )
    expect(await screen.findByLabelText(`复核材料：${f.late.title}`)).not.toBeChecked()
    await selectOption(user, '选择 Agent', 'Reviewer')
    await user.click(screen.getByRole('button', { name: '开始复核' }))
    await waitFor(() => expect(f.posts).toHaveLength(1))
    expect(f.posts[0]).toMatchObject({
      agentId: REVIEWER,
      artifactInputIds: [f.artifact.id],
      intent: { kind: 'new' },
      text: '我已写好的复核要求',
    })
  })
  it('活跃执行时不把复核改投追问，保留草稿并说明阻塞', async () => {
    const user = userEvent.setup()
    const f = fixture({ active: true })
    const box = await screen.findByLabelText('指令')
    await waitFor(() => expect(box).toBeEnabled())
    await user.type(box, '保留的下一次复核要求')
    await review(user)
    expect(screen.getByTestId('execution-blocker')).toHaveTextContent('已有执行进行中')
    expect(screen.getByLabelText('指令')).toHaveValue('保留的下一次复核要求')
    expect(screen.getByRole('button', { name: '开始复核' })).toBeDisabled()
    expect(f.posts).toHaveLength(0)
  })
  it('无指令权成员可定位讨论，不能借产出复核探查私有现场或发送', async () => {
    const user = userEvent.setup()
    const f = fixture({ unauthorized: true })
    await review(user)
    expect(screen.getByTestId('execution-blocker')).toHaveTextContent('只有责任人和已授权成员')
    expect(screen.getByRole('link', { name: '前往讨论' })).toBeVisible()
    expect(f.posts).toHaveLength(0)
    expect(
      f.fetchMock.mock.calls.some(([url]) => /\/(devices|workspaces)$/.test(String(url))),
    ).toBe(false)
  })
  it('材料副本只读不承诺整次执行只读，完全权限仍需人工确认', async () => {
    const user = userEvent.setup()
    const f = fixture({ fullAccess: true })
    await review(user)
    expect(screen.getByTestId('review-scope')).toHaveTextContent('材料副本只读')
    expect(screen.getByTestId('review-scope')).toHaveTextContent('工具')
    await selectOption(user, '选择 Agent', 'Reviewer')
    await user.click(screen.getByRole('button', { name: '开始复核' }))
    expect(await screen.findByRole('dialog')).toBeVisible()
    expect(f.posts).toHaveLength(0)
    await user.click(screen.getByRole('button', { name: '确认以完全权限启动' }))
    await waitFor(() => expect(f.posts).toHaveLength(1))
    expect(f.posts[0]).toMatchObject({
      expectedApprovalPolicy: 'full_access',
      artifactInputIds: [f.artifact.id],
    })
  })
  it('历史执行读取实际固定清单，不能用当前材料列表代替', async () => {
    const user = userEvent.setup()
    const f = fixture()
    await user.click(await screen.findByRole('button', { name: /第 1 次运行/ }))
    await user.click(await screen.findByRole('button', { name: '查看本次固定输入' }))
    expect(await screen.findByTestId('run-input-manifest')).toHaveTextContent(f.artifact.title)
    await act(async () =>
      f.queryClient.setQueryData(queryKeys.taskRoom(f.task.id), (old: object | undefined) => ({
        ...old,
        artifacts: [f.artifact, f.late],
      })),
    )
    await screen.findByText(f.late.title, { selector: '.artifact-title' })
    expect(screen.getByTestId('run-input-manifest')).not.toHaveTextContent(f.late.title)
    expect(screen.getByTestId('run-input-manifest')).toHaveTextContent(
      f.artifact.sha256.slice(0, 12),
    )
  })
  it('旧记录输入未知，不能展示成没有材料', async () => {
    const user = userEvent.setup()
    fixture({ unknownHistory: true })
    await user.click(await screen.findByRole('button', { name: /第 1 次运行/ }))
    await user.click(await screen.findByRole('button', { name: '查看本次固定输入' }))
    expect(await screen.findByTestId('run-input-manifest')).toHaveTextContent('历史输入无法确认')
    expect(screen.getByTestId('run-input-manifest')).not.toHaveTextContent('未选择交付物')
  })
})

describe('根据意见修订与真人验收 (#327)', () => {
  it.each(['review-then-revision', 'revision-then-review'] as const)(
    '发送期间连续选择按最后意图执行：%s',
    async (order) => {
      const user = userEvent.setup()
      let release!: () => void
      const instructionGate = new Promise<void>((resolve) => {
        release = resolve
      })
      const f = fixture({ instructionGate })
      await user.type(await screen.findByLabelText('指令'), '当前执行要求')
      await selectOption(user, '选择 Agent', 'Builder')
      await user.click(screen.getByRole('button', { name: '开始执行' }))
      await waitFor(() => expect(f.posts).toHaveLength(1))
      expect(screen.getByRole('button', { name: '执行方式' })).toBeDisabled()
      for (const name of order === 'review-then-revision'
        ? ['发起复核', '根据意见修订']
        : ['根据意见修订', '发起复核']) {
        await user.click(screen.getByRole('button', { name }))
      }
      await act(async () => {
        release()
      })
      await waitFor(() => expect(screen.getByRole('button', { name: '执行方式' })).toBeEnabled())
      expect(f.posts).toHaveLength(1)
      if (order === 'review-then-revision') {
        expect(screen.getByTestId('revision-context')).toHaveTextContent(f.artifact.title)
        expect(screen.getByLabelText('来源执行')).toHaveTextContent('选择要继续的会话')
        expect(screen.queryByTestId('review-scope')).not.toBeInTheDocument()
      } else {
        expect(screen.queryByTestId('revision-context')).not.toBeInTheDocument()
        expect(screen.getByTestId('review-scope')).toBeVisible()
        expect(screen.getByLabelText(`复核材料：${f.artifact.title}`)).toBeChecked()
      }
    },
  )
  it('最近执行是Reviewer时仍不自动选来源；手动回到Builder并携带意见材料', async () => {
    const user = userEvent.setup()
    const f = fixture({ revisionHistory: true })
    await user.type(await screen.findByLabelText('指令'), '请保留这段修订要求')
    await user.click(screen.getByRole('button', { name: '根据意见修订' }))
    expect(screen.getByLabelText('来源执行')).toHaveTextContent('选择要继续的会话')
    expect(screen.getByLabelText('指令')).toHaveValue('请保留这段修订要求')
    expect(screen.getByRole('button', { name: '继续会话' })).toBeDisabled()
    expect(f.posts).toHaveLength(0)
    await selectOption(user, '来源执行', '第 1 次运行')
    expect(await screen.findByTestId('execution-context')).toHaveTextContent('Builder')
    expect(screen.getByTestId('revision-context')).toHaveTextContent(f.artifact.title)
    await user.click(screen.getByRole('button', { name: '继续会话' }))
    await waitFor(() => expect(f.posts).toHaveLength(1))
    expect(f.posts[0]).toMatchObject({
      intent: { kind: 'resume', runId: f.producer.id },
      artifactInputIds: [f.artifact.id],
      text: '请保留这段修订要求',
    })
  })
  it('可选择新执行修订，但必须重新选择产出Agent，不能继承Reviewer', async () => {
    const user = userEvent.setup()
    const f = fixture({ revisionHistory: true })
    await user.click(await screen.findByRole('button', { name: '根据意见修订' }))
    await selectOption(user, '执行方式', '开始新执行（不接旧会话）')
    expect(screen.getByRole('button', { name: '开始执行' })).toBeDisabled()
    await selectOption(user, '选择 Agent', 'Builder')
    await user.click(screen.getByRole('button', { name: '开始执行' }))
    await waitFor(() => expect(f.posts).toHaveLength(1))
    expect(f.posts[0]).toMatchObject({
      intent: { kind: 'new' },
      agentId: BUILDER,
      artifactInputIds: [f.artifact.id],
    })
  })
  it('复核可选，不新增验收闸门；完成始终由真人确认，状态变化关闭旧确认', async () => {
    const user = userEvent.setup()
    const f = fixture({ taskStatus: 'in_review' })
    expect(await screen.findByTestId('delivery-next')).toHaveTextContent('确认完成')
    expect(screen.getByTestId('delivery-flow')).toHaveTextContent('可选复核')
    expect(
      f.fetchMock.mock.calls.filter(
        ([url, init]) => String(url).endsWith('/complete') && init?.method === 'POST',
      ),
    ).toHaveLength(0)
    await user.click(screen.getByRole('button', { name: '完成任务' }))
    expect(await screen.findByRole('dialog')).toBeVisible()
    await act(async () =>
      f.queryClient.setQueryData(queryKeys.taskRoom(f.task.id), (old: object | undefined) => ({
        ...old,
        task: { ...f.task, status: 'in_progress' },
      })),
    )
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    expect(
      f.fetchMock.mock.calls.filter(
        ([url, init]) => String(url).endsWith('/complete') && init?.method === 'POST',
      ),
    ).toHaveLength(0)
  })
  it('候选下一步是拥有者检查并发布，不把候选直接送给Reviewer', async () => {
    const f = fixture({ candidateOnly: true })
    expect(await screen.findByTestId('delivery-next')).toHaveTextContent('检查')
    expect(screen.getByTestId('delivery-next')).toHaveTextContent('发布')
    expect(screen.queryByRole('button', { name: '根据意见修订' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: '发起复核' })).not.toBeInTheDocument()
    expect(f.posts).toHaveLength(0)
  })
  it('修订的完全权限确认期间任务结束，关闭旧确认并保留草稿', async () => {
    const user = userEvent.setup()
    const f = fixture({ revisionHistory: true, fullAccess: true })
    await user.click(await screen.findByRole('button', { name: '根据意见修订' }))
    await selectOption(user, '来源执行', '第 1 次运行')
    await user.click(screen.getByRole('button', { name: '继续会话' }))
    expect(await screen.findByRole('dialog')).toBeVisible()
    const draft = (screen.getByLabelText('指令') as HTMLTextAreaElement).value
    await act(async () =>
      f.queryClient.setQueryData(queryKeys.taskRoom(f.task.id), (old: object | undefined) => ({
        ...old,
        task: { ...f.task, status: 'done' },
      })),
    )
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    expect(screen.getByLabelText('指令')).toHaveValue(draft)
    expect(screen.getByRole('button', { name: '继续会话' })).toBeDisabled()
    expect(f.posts).toHaveLength(0)
  })
  it('没有Reviewer执行也可按服务端条件提交验收', async () => {
    fixture()
    expect(await screen.findByRole('button', { name: '提交验收' })).toBeEnabled()
    expect(screen.getByTestId('delivery-next')).toHaveTextContent('可选复核')
    expect(screen.getByRole('link', { name: '前往提交验收' })).toBeVisible()
  })
})
