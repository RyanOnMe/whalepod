/**
 * Artifact 区（P1-15；G6-01/04/08 的 Web 最小面）：
 * - 已发布 Artifact：全员可见 + 下载按钮（下载走 Session Cookie 的受控接口）。
 * - 候选 Artifact（Hub 只给 owner 下发）：owner 见「发布」按钮；发布成功刷新 Task Room。
 * - Reviewer 输入说明：已发布交付物作为 Reviewer Run 的只读输入（sha256 固定内容）。
 */
import { screen, waitFor } from '@testing-library/react'
import { userEvent } from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { BOB, loggedInHandlers, makeArtifact, makeTask, ok, taskRoomHandler } from './fixtures.js'
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
