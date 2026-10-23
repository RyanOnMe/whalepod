import { QueryClientProvider } from '@tanstack/react-query'
import { screen, waitFor, within } from '@testing-library/react'
import { userEvent } from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { ArtifactList } from '../src/features/task/ArtifactList.js'
import { makeQueryClient } from '../src/app/query-client.js'
import { BOB, makeArtifact, makeRun } from './fixtures.js'
import { renderUi } from './render.js'

function files() {
  const first = makeArtifact({ status: 'published', title: 'report.md' })
  const second = makeArtifact({
    id: 'aaaaaaaa-1111-4111-8111-111111111111',
    status: 'published',
    title: 'feedback.md',
    runId: 'bbbbbbbb-1111-4111-8111-111111111111',
  })
  const review = vi.fn()
  const revise = vi.fn()
  const reference = vi.fn()
  renderUi(
    <QueryClientProvider client={makeQueryClient({ retry: false })}>
      <ArtifactList
        artifacts={[first, second]}
        session={BOB}
        taskId="task-1"
        runs={[makeRun({ id: first.runId }), makeRun({ id: second.runId })]}
        onRequestReview={review}
        onRequestRevision={revise}
        onReferenceRun={reference}
      />
    </QueryClientProvider>,
  )
  return { first, second, review, revise, reference }
}

describe('P1-421 文件操作层级', () => {
  it('预览与下载常驻；低频动作收进更多，并传递当前文件的真实归属', async () => {
    const user = userEvent.setup()
    const f = files()
    expect(screen.getAllByRole('button', { name: '预览' })).toHaveLength(2)
    expect(screen.getAllByRole('button', { name: '下载' })).toHaveLength(2)
    expect(screen.queryAllByRole('button', { name: '发起复核' })).toHaveLength(0)
    const row = screen.getByText('feedback.md').closest('li')!
    await user.click(within(row).getByRole('button', { name: '更多文件操作' }))
    await user.click(screen.getByRole('menuitem', { name: '发起复核' }))
    expect(f.review).toHaveBeenCalledExactlyOnceWith(f.second.id)
    expect(screen.queryByRole('menu')).not.toBeInTheDocument()
    await user.click(within(row).getByRole('button', { name: '更多文件操作' }))
    await user.click(screen.getByRole('menuitem', { name: '根据意见修订' }))
    expect(f.revise).toHaveBeenCalledExactlyOnceWith(f.second.id)
    await user.click(within(row).getByRole('button', { name: '更多文件操作' }))
    await user.click(screen.getByRole('menuitem', { name: '在讨论中引用' }))
    expect(f.reference).toHaveBeenCalledExactlyOnceWith(f.second.runId)
    expect(f.review).toHaveBeenCalledTimes(1)
  })

  it('键盘打开聚焦首项，方向键可达，Escape 关闭并回到同一文件的触发器', async () => {
    const user = userEvent.setup()
    files()
    const trigger = screen.getAllByRole('button', { name: '更多文件操作' })[1]!
    trigger.focus()
    await user.keyboard('{Enter}')
    await waitFor(() => expect(screen.getByRole('menuitem', { name: '发起复核' })).toHaveFocus())
    await user.keyboard('{ArrowDown}')
    expect(screen.getByRole('menuitem', { name: '根据意见修订' })).toHaveFocus()
    await user.keyboard('{Escape}')
    expect(screen.queryByRole('menu')).not.toBeInTheDocument()
    expect(trigger).toHaveFocus()
  })

  it('点外关闭不会执行动作，也不会抢走新点击控件的焦点', async () => {
    const user = userEvent.setup()
    const f = files()
    const download = screen.getAllByRole('button', { name: '下载' })[0]!
    await user.click(screen.getAllByRole('button', { name: '更多文件操作' })[1]!)
    // 点标题只关闭；不触发受控内容接口或其他业务动作。
    await user.click(screen.getByText('report.md'))
    expect(screen.queryByRole('menu')).not.toBeInTheDocument()
    expect(f.review).not.toHaveBeenCalled()
    expect(f.revise).not.toHaveBeenCalled()
    expect(f.reference).not.toHaveBeenCalled()
    download.focus()
    expect(download).toHaveFocus()
  })
})
