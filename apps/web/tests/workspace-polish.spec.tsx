import { screen, within } from '@testing-library/react'
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
import { renderApp } from './render.js'

const RESULT_RUN = 'abababab-0000-4000-8000-00000000000e'

function room(withArtifact = false) {
  const task = makeTask({ assigneeUserId: BOB.userId, assignmentStatus: 'accepted' })
  const run = makeRun({ id: RESULT_RUN, status: 'completed' })
  return renderApp(
    `/tasks/${task.id}`,
    loggedInHandlers(BOB, [
      // ADR-0019：文件按 runId 落在对应回复之后（没有所属 Run 的卡片留在交付抽屉里）；
      // 无历史时输入框默认新执行（带 Agent 选择），有历史时默认续聊或追问。
      taskRoomHandler(task, {
        ...(withArtifact
          ? { runs: [run], artifacts: [makeArtifact({ title: 'result.md', runId: RESULT_RUN })] }
          : {}),
      }),
      {
        method: 'GET',
        url: new RegExp(`/api/v1/runs/${RESULT_RUN}/events`),
        respond: () => ok({ events: [] }),
      },
    ]),
  )
}

describe('工作区 Micro 精修', () => {
  it('执行正文、Agent 选择和发送在同一个 Prompt Bar 中，只有一个指令输入', async () => {
    room()
    const composer = await screen.findByTestId('execution-composer')
    const bar = within(composer).getByTestId('prompt-bar')
    expect(within(bar).getAllByRole('textbox', { name: '指令' })).toHaveLength(1)
    expect(within(bar).getByRole('button', { name: '选择 Agent' })).toBeVisible()
    expect(within(bar).getByRole('button', { name: '开始执行' })).toBeDisabled()
  })

  it('底部选择菜单通过 portal 展开，Escape 收起并返回原控件', async () => {
    const user = userEvent.setup()
    room()
    const trigger = await screen.findByRole('button', { name: '选择 Agent' })
    expect(trigger).toHaveClass('glide-select__trigger')
    await user.click(trigger)
    expect(screen.getByRole('menu')).toHaveClass('glide-select__menu')
    expect(within(screen.getByTestId('prompt-bar')).queryByRole('menu')).toBeNull()
    await user.keyboard('{Escape}')
    expect(screen.queryByRole('menu')).toBeNull()
    expect(trigger).toHaveFocus()
  })

  it('视图切换复用 RubberSegment，切换仍保留团队讨论草稿', async () => {
    const user = userEvent.setup()
    room()
    const views = await screen.findByRole('group', { name: '工作区视图' })
    expect(views).toHaveClass('rubber-segment')
    await user.click(within(views).getByRole('button', { name: '团队讨论' }))
    await user.type(screen.getByLabelText('留言'), '待团队确认')
    await user.click(within(views).getByRole('button', { name: 'Agent 执行' }))
    await user.click(within(views).getByRole('button', { name: '团队讨论' }))
    expect(screen.getByLabelText('留言')).toHaveValue('待团队确认')
  })

  it('交付物使用文件图标与独立状态层次，保留原详情入口', async () => {
    const user = userEvent.setup()
    room(true)
    const file = await screen.findByRole('button', { name: '查看交付物 result.md' })
    expect(file.querySelector('.workspace-file-icon svg')).not.toBeNull()
    expect(file).toHaveTextContent('已发布给团队')
    await user.click(file)
    expect(screen.getByRole('region', { name: '工作区详情' })).toBeVisible()
  })
})
