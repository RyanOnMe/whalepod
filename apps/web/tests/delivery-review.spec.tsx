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
    cachedNavigation?: boolean
  } = {},
) {
  const task = makeTask({
    assignmentStatus: 'accepted',
    approvalPolicy: options.fullAccess ? 'full_access' : 'approval_required',
  })
  const other = makeTask({
    title: '缓存中的另一个任务',
    assignmentStatus: 'accepted',
    status: 'in_progress',
  })
  const producer = makeRun({ status: options.active ? 'running' : 'completed' })
  const artifact = makeArtifact({
    runId: producer.id,
    status: 'published',
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
    ...(options.cachedNavigation
      ? [
          taskRoomHandler(other),
          {
            method: 'GET',
            url: /\/tasks\/recent$/,
            respond: () =>
              ok(
                [task, other].map((row) => ({
                  id: row.id,
                  title: row.title,
                  status: row.status,
                  projectName: '导航测试',
                  lastActiveAt: row.createdAt,
                })),
              ),
          },
        ]
      : []),
    taskRoomHandler(task, { runs: [producer], artifacts: [artifact] }),
    teamMembersHandler(),
    { method: 'GET', url: /\/instruction-grants$/, respond: () => ok([]) },
    { method: 'GET', url: /\/agents$/, respond: () => ok(agents) },
    {
      method: 'GET',
      url: /\/agents\/[^/]+$/,
      respond: () =>
        ok({
          id: REVIEWER,
          name: 'Reviewer',
          currentRevisionId: REVISION,
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
    },
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
      respond: (init) => {
        posts.push(JSON.parse(String(init.body)))
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
  return { ...view, task, other, producer, artifact, late, posts }
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
  it('往返两个已缓存任务后不在新任务显示旧执行输入', async () => {
    const user = userEvent.setup()
    const f = fixture({ cachedNavigation: true })
    await user.click(await screen.findByRole('link', { name: new RegExp(f.other.title) }))
    expect(await screen.findByRole('heading', { name: f.other.title })).toBeVisible()
    await user.click(screen.getByRole('link', { name: new RegExp(f.task.title) }))
    expect(await screen.findByRole('heading', { name: f.task.title })).toBeVisible()
    await user.click(await screen.findByRole('button', { name: /第 1 次运行/ }))
    await user.click(await screen.findByRole('button', { name: '查看本次固定输入' }))
    expect(await screen.findByTestId('run-input-manifest')).toHaveTextContent(f.artifact.title)
    const reads = () =>
      f.fetchMock.mock.calls.filter(([url]) => String(url).endsWith('/input-manifest')).length
    expect(reads()).toBe(1)
    await user.click(screen.getByRole('link', { name: new RegExp(f.other.title) }))
    expect(await screen.findByRole('heading', { name: f.other.title })).toBeVisible()
    expect(screen.queryByTestId('run-input-manifest')).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /本次固定输入/ })).not.toBeInTheDocument()
    expect(reads()).toBe(1)
    await user.click(screen.getByRole('link', { name: new RegExp(f.task.title) }))
    expect(await screen.findByRole('heading', { name: f.task.title })).toBeVisible()
    expect(screen.queryByTestId('run-input-manifest')).not.toBeInTheDocument()
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
