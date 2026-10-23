import { act, screen, within, waitFor } from '@testing-library/react'
import { userEvent } from '@testing-library/user-event'
import { describe, expect, it } from 'vitest'
import {
  BOB,
  loggedInHandlers,
  makeArtifact,
  makeRun,
  makeTask,
  ok,
  taskRoomHandler,
} from './fixtures.js'
import { formatRunReference } from '../src/features/task/runReference.js'
import { renderApp } from './render.js'
import { chooseFileAction } from './workspace.js'

const ROOM_RUN = 'abababab-0000-4000-8000-0000000000aa'

function openRoom(artifacts: ReturnType<typeof makeArtifact>[] = []) {
  const task = makeTask({
    assigneeUserId: BOB.userId,
    assignmentStatus: 'accepted',
    status: 'in_progress',
  })
  const run = makeRun({ id: ROOM_RUN, status: 'completed' })
  return renderApp(
    `/tasks/${task.id}`,
    loggedInHandlers(BOB, [
      // ADR-0019：文件按 runId 落在对应回复之后——夹具也要有那个 Run。
      taskRoomHandler(task, {
        runs: [run],
        artifacts: artifacts.map((artifact) => ({ ...artifact, runId: ROOM_RUN })),
      }),
      {
        method: 'GET',
        url: new RegExp(`/api/v1/runs/${ROOM_RUN}/events`),
        respond: () => ok({ events: [] }),
      },
    ]),
  )
}

describe('聚焦工作区', () => {
  it('打开详情后点击团队讨论，会收起详情并显示留言', async () => {
    const user = userEvent.setup()
    openRoom()
    await user.click(await screen.findByRole('button', { name: '任务约定' }))
    await user.click(screen.getByRole('button', { name: '团队讨论' }))
    expect(screen.queryByRole('region', { name: '工作区详情' })).toBeNull()
    expect(screen.getByRole('textbox', { name: '留言' })).toBeVisible()
  })

  it.each([
    ['#comments-heading', '团队讨论', 'comments-heading'],
    ['#task-execution', 'Agent 执行', 'task-execution'],
    ['#task-assignment', 'Agent 执行', 'task-assignment'],
  ])('同任务内 %s 导航会收起详情并聚焦可见目标', async (hash, channel, target) => {
    const user = userEvent.setup()
    const app = openRoom()
    await user.click(await screen.findByRole('button', { name: '团队讨论' }))
    await user.click(screen.getByRole('button', { name: '任务约定' }))
    expect(screen.getByRole('region', { name: '工作区详情' })).toBeVisible()
    await act(async () => {
      await app.router.navigate(hash)
    })
    await waitFor(() => expect(screen.queryByRole('region', { name: '工作区详情' })).toBeNull())
    expect(screen.getByRole('button', { name: channel })).toHaveAttribute('aria-pressed', 'true')
    await waitFor(() => expect(document.getElementById(target)).toHaveFocus())
  })

  it('默认进入 Agent 执行，讨论单独切换，来回切换保留留言草稿', async () => {
    const user = userEvent.setup()
    openRoom()
    expect(await screen.findByRole('button', { name: 'Agent 执行' })).toHaveAttribute(
      'aria-pressed',
      'true',
    )
    expect(screen.queryByRole('textbox', { name: '留言' })).not.toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: '团队讨论' }))
    await user.type(screen.getByLabelText('留言'), '请确认验收口径')
    await user.click(screen.getByRole('button', { name: 'Agent 执行' }))
    await user.click(screen.getByRole('button', { name: '团队讨论' }))
    expect(screen.getByLabelText('留言')).toHaveValue('请确认验收口径')
  })

  it('交付物入口按需打开检查面板，Escape 关闭并还焦，不改变任务状态', async () => {
    const user = userEvent.setup()
    openRoom([makeArtifact({ title: 'report.md' })])
    const trigger = await screen.findByRole('button', { name: '查看交付物 report.md' })
    expect(screen.queryByRole('region', { name: '工作区详情' })).not.toBeInTheDocument()
    await user.click(trigger)
    const panel = screen.getByRole('region', { name: '工作区详情' })
    expect(within(panel).getByRole('heading', { name: 'report.md' })).toBeVisible()
    await user.keyboard('{Escape}')
    expect(screen.queryByRole('region', { name: '工作区详情' })).not.toBeInTheDocument()
    expect(trigger).toHaveFocus()
    expect(screen.getByTestId('task-current-state')).toHaveTextContent('进行中')
  })

  it('不会把响应里误带的他人候选展示为入口或数量', async () => {
    const user = userEvent.setup()
    openRoom([
      makeArtifact({ title: 'private.md', status: 'candidate', ownerUserId: 'other-user' }),
    ])
    await screen.findByRole('button', { name: 'Agent 执行' })
    expect(screen.queryByRole('button', { name: /查看交付物/ })).not.toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: '交付与复核' }))
    expect(screen.queryByText('private.md')).not.toBeInTheDocument()
    expect(screen.getByText(/还没有已发布的 Artifact/)).toBeVisible()
  })

  it('从交付物引用运行时切换到团队讨论，引用不会发送给 Agent', async () => {
    const user = userEvent.setup()
    const artifact = makeArtifact({ title: 'team.md', runId: ROOM_RUN })
    const app = openRoom([artifact])
    await user.click(await screen.findByRole('button', { name: '查看交付物 team.md' }))
    await chooseFileAction('在讨论中引用', user)
    expect(screen.getByRole('button', { name: '团队讨论' })).toHaveAttribute('aria-pressed', 'true')
    await waitFor(() =>
      expect(screen.getByLabelText('留言')).toHaveValue(formatRunReference(artifact.runId)),
    )
    expect(app.fetchMock.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(0)
  })
})
