/**
 * Artifact 区（P1-15；G6-01/04/08 的 Web 最小面）：
 * - 已发布 Artifact：全员可见 + 下载按钮（下载走 Session Cookie 的受控接口）。
 * - 候选 Artifact（Hub 只给 owner 下发）：owner 见「发布」按钮；发布成功刷新 Task Room。
 * - Reviewer 输入说明：已发布交付物作为 Reviewer Run 的只读输入（sha256 固定内容）。
 */
import { screen, waitFor } from '@testing-library/react'
import { userEvent } from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  BOB,
  loggedInHandlers,
  makeArtifact,
  makeRun,
  makeTask,
  ok,
  taskRoomHandler,
} from './fixtures.js'
import { renderApp } from './render.jsx'
import type { MockHandler } from './fixtures.js'

beforeEach(() => {
  vi.stubGlobal(
    'URL.createObjectURL',
    vi.fn(() => 'blob:mock'),
  )
  vi.stubGlobal('URL.revokeObjectURL', vi.fn())
})

describe('artifact-list（Task Room 右侧）', () => {
  it('已发布 Artifact 展示元数据与下载按钮；点击走受控下载接口', async () => {
    const user = userEvent.setup()
    const artifact = makeArtifact({ status: 'published' })
    const task = makeTask()
    const contentHandler: MockHandler = {
      method: 'GET',
      url: new RegExp(`/api/v1/artifacts/${artifact.id}/content$`),
      respond: () =>
        new Response('# report body\n', {
          status: 200,
          headers: { 'content-type': 'text/markdown' },
        }),
    }
    const view = renderApp(`/tasks/${task.id}`, [
      ...loggedInHandlers(BOB, [taskRoomHandler(task, { artifacts: [artifact] }), contentHandler]),
    ])
    expect(await screen.findByText('security-review.md')).toBeVisible()
    const download = await screen.findByRole('button', { name: '下载' })
    await user.click(download)
    await waitFor(() => {
      const calls = view.fetchMock.mock.calls
      expect(
        calls.some(
          ([url, init]) =>
            String(url).endsWith(`/api/v1/artifacts/${artifact.id}/content`) &&
            (init as RequestInit | undefined)?.credentials === 'include',
        ),
      ).toBe(true)
    })
  })

  it('candidate 仅 owner 可见并带发布按钮；发布后刷新 Task Room', async () => {
    const user = userEvent.setup()
    const task = makeTask({ assigneeUserId: BOB.userId })
    const candidate = makeArtifact({ status: 'candidate', ownerUserId: BOB.userId })
    const view = renderApp(`/tasks/${task.id}`, [
      ...loggedInHandlers(BOB, [
        taskRoomHandler(task, { artifacts: [candidate] }),
        publishHandler(candidate.id),
      ]),
    ])
    expect(await screen.findByText('security-review.md')).toBeVisible()
    expect(screen.getByText('仅你可见，待发布')).toBeVisible()
    const publish = screen.getByRole('button', { name: '发布' })
    await user.click(publish)
    await waitFor(() => {
      const calls = view.fetchMock.mock.calls
      expect(
        calls.some(
          ([url, init]) =>
            String(url).endsWith(`/api/v1/artifacts/${candidate.id}/publish`) &&
            (init as RequestInit | undefined)?.method === 'POST',
        ),
      ).toBe(true)
    })
  })

  it('非 owner（Alice）看不到 candidate 行，也看不到发布按钮', async () => {
    const task = makeTask()
    const candidate = makeArtifact({ status: 'candidate', ownerUserId: BOB.userId })
    renderApp(`/tasks/${task.id}`, [
      ...loggedInHandlers(
        { ...BOB, userId: 'aaaaaaaa-0000-4000-8000-000000000001', displayName: 'Alice' },
        [taskRoomHandler(task, { artifacts: [candidate] })],
      ),
    ])
    expect(
      await screen.findByText('还没有已发布的 Artifact。Run 产出经发布后，交付物会出现在这里。'),
    ).toBeVisible()
    expect(screen.queryByRole('button', { name: '发布' })).toBeNull()
  })

  it('Reviewer 输入说明与内容摘要随已发布 Artifact 展示', async () => {
    const artifact = makeArtifact({ status: 'published' })
    const task = makeTask()
    renderApp(`/tasks/${task.id}`, [
      ...loggedInHandlers(BOB, [taskRoomHandler(task, { artifacts: [artifact] })]),
    ])
    expect(await screen.findByText(/Reviewer Run 的只读输入/)).toBeVisible()
    expect(screen.getByText(artifact.sha256.slice(0, 12))).toBeVisible()
  })
})

/**
 * #250（#243 第 3 条「交付物有脸」）：文本类工件页面内可读 + 「对这个工件继续说」
 * 接 #216 引用-运行机制。判据全走真实页面（讨论输入框在左栏，交付物在右栏详情区）。
 */
describe('#250 交付物文本预览与引用入口', () => {
  function contentHandler(
    artifactId: string,
    body: string,
    status = 200,
    contentType = 'text/markdown; charset=utf-8',
  ): MockHandler {
    return {
      method: 'GET',
      url: new RegExp(`/api/v1/artifacts/${artifactId}/content$`),
      respond: () => new Response(body, { status, headers: { 'content-type': contentType } }),
    }
  }

  it('文本工件可预览：点击后页内渲染内容', async () => {
    const user = userEvent.setup()
    const artifact = makeArtifact({ status: 'published', mediaType: 'text/markdown' })
    const task = makeTask()
    renderApp(`/tasks/${task.id}`, [
      ...loggedInHandlers(BOB, [
        taskRoomHandler(task, { artifacts: [artifact] }),
        contentHandler(artifact.id, '# 报告\n\n结论：没问题。'),
      ]),
    ])
    await user.click(await screen.findByRole('button', { name: '预览' }))
    const preview = await screen.findByTestId('artifact-preview')
    expect(preview.textContent).toContain('结论：没问题。')
  })

  it('预览超长内容截断并标注（完整内容请下载）', async () => {
    const user = userEvent.setup()
    const artifact = makeArtifact({ status: 'published', mediaType: 'text/plain' })
    const task = makeTask()
    renderApp(`/tasks/${task.id}`, [
      ...loggedInHandlers(BOB, [
        taskRoomHandler(task, { artifacts: [artifact] }),
        contentHandler(artifact.id, 'x'.repeat(70_000)),
      ]),
    ])
    await user.click(await screen.findByRole('button', { name: '预览' }))
    const preview = await screen.findByTestId('artifact-preview')
    // 截断标注在 pre 的兄弟节点（mutation-hint），不在 pre 里。
    expect(preview.textContent).not.toHaveLength(70_000)
    expect(await screen.findByText(/已截断/)).toBeVisible()
  })

  it('预览失败不装死：给出失败提示，下载仍在', async () => {
    const user = userEvent.setup()
    const artifact = makeArtifact({ status: 'published', mediaType: 'text/markdown' })
    const task = makeTask()
    renderApp(`/tasks/${task.id}`, [
      ...loggedInHandlers(BOB, [
        taskRoomHandler(task, { artifacts: [artifact] }),
        contentHandler(artifact.id, 'nope', 500),
      ]),
    ])
    await user.click(await screen.findByRole('button', { name: '预览' }))
    expect(await screen.findByTestId('artifact-preview-error')).toBeVisible()
    expect(screen.getByRole('button', { name: '下载' })).toBeVisible()
  })

  it('二进制与超大文本不画预览钮——不假装能预览', async () => {
    const image = makeArtifact({ status: 'published', mediaType: 'image/png' })
    const huge = makeArtifact({
      status: 'published',
      mediaType: 'text/markdown',
      byteSize: 600 * 1024,
    })
    const task = makeTask()
    renderApp(`/tasks/${task.id}`, [
      ...loggedInHandlers(BOB, [taskRoomHandler(task, { artifacts: [image, huge] })]),
    ])
    expect(await screen.findAllByRole('button', { name: '下载' })).toHaveLength(2)
    expect(screen.queryByRole('button', { name: '预览' })).not.toBeInTheDocument()
  })

  it('对这个工件继续说：点击把来源运行引用注入讨论输入框并聚焦', async () => {
    const user = userEvent.setup()
    const run = makeRun({ status: 'completed' })
    const artifact = makeArtifact({ status: 'published', runId: run.id })
    const task = makeTask()
    renderApp(`/tasks/${task.id}`, [
      ...loggedInHandlers(BOB, [taskRoomHandler(task, { runs: [run], artifacts: [artifact] })]),
    ])
    await user.click(await screen.findByRole('button', { name: '对这个工件继续说' }))
    const box = screen.getByLabelText('留言')
    // 注入的是 #216 同一套引用 token（运行 R-<短号>），窄解析把它渲染成可点 chip。
    expect(box).toHaveValue(`运行 R-${run.id.slice(0, 8)}`)
    expect(box).toHaveFocus()
  })
})

// ---- helpers ----

function publishHandler(artifactId: string): MockHandler {
  return {
    method: 'POST',
    url: new RegExp(`/api/v1/artifacts/${artifactId}/publish$`),
    respond: () =>
      ok({
        id: artifactId,
        status: 'published',
        publishedAt: '2026-08-25T03:05:00.000Z',
      }),
  }
}
