/**
 * 交付物审阅页（#429；ADR-0021 §2-4）页面判据。
 *
 * 从用户动作驱动：读准确版本 → 选词/整件批注（请求体带版本内偏移与前后文）→
 * 回复 → 提交本轮意见/本轮无意见 → 邀请审阅人；不支持定位的格式明确回退整件批注。
 */
import { fireEvent, screen, waitFor, within } from '@testing-library/react'
import { userEvent } from '@testing-library/user-event'
import { describe, expect, it } from 'vitest'
import {
  ALICE,
  BOB,
  loggedInHandlers,
  ok,
  teamMembersHandler,
  type MockHandler,
} from './fixtures.js'
import { renderApp } from './render.js'
import { keysForPersistentEvent } from '../src/shared/realtime/event-router.js'
import { persistentFrame } from './frames.js'

const TASK_ID = '00000000-0000-4000-8000-0000000000a1'
const ARTIFACT_ID = '00000000-0000-4000-8000-0000000000a2'
const SHA = 'a'.repeat(64)
const TEXT = 'alpha orderId beta\nbeta orderId gamma\n'
const SECOND = TEXT.indexOf('orderId', TEXT.indexOf('orderId') + 1)

function invitation(overrides: Record<string, unknown> = {}) {
  return {
    id: '00000000-0000-4000-8000-0000000000a3',
    artifactId: ARTIFACT_ID,
    inviterUserId: ALICE.userId,
    reviewerUserId: BOB.userId,
    focus: null,
    status: 'pending',
    noComment: false,
    createdAt: '2026-10-23T01:00:00.000Z',
    submittedAt: null,
    ...overrides,
  }
}

function reviewView(overrides: Record<string, unknown> = {}) {
  return {
    artifact: {
      id: ARTIFACT_ID,
      taskId: TASK_ID,
      title: '接口约定.md',
      mediaType: 'text/markdown',
      byteSize: TEXT.length,
      sha256: SHA,
      status: 'published',
      ownerUserId: ALICE.userId,
      publishedAt: '2026-10-23T01:00:00.000Z',
    },
    comments: [],
    invitations: [],
    reading: 'text',
    textPreviewMaxBytes: 524288,
    capabilities: { canInvite: false, canSubmitReview: false, canComment: true },
    ...overrides,
  }
}

function baseHandlers(input: {
  view: () => unknown
  comments?: unknown[]
  onComment?: (body: unknown) => void
  onInvite?: (body: unknown) => void
  onSubmit?: (body: unknown) => void
}): MockHandler[] {
  return [
    {
      method: 'GET',
      url: new RegExp(`/api/v1/artifacts/${ARTIFACT_ID}/review$`),
      respond: () => ok(input.view()),
    },
    {
      method: 'GET',
      url: new RegExp(`/api/v1/artifacts/${ARTIFACT_ID}/content$`),
      respond: () => new Response(TEXT, { status: 200 }),
    },
    {
      method: 'POST',
      url: new RegExp(`/api/v1/artifacts/${ARTIFACT_ID}/comments$`),
      respond: (init) => {
        const body = JSON.parse(String(init.body)) as {
          body: string
          anchor?: Record<string, unknown>
          parentCommentId?: string
        }
        input.onComment?.(body)
        const comment = {
          id: `00000000-0000-4000-8000-${String((input.comments?.length ?? 0) + 1).padStart(12, '0')}`,
          artifactId: ARTIFACT_ID,
          authorUserId: BOB.userId,
          parentCommentId: body.parentCommentId ?? null,
          kind: body.anchor === undefined ? 'whole' : 'text',
          anchor: body.anchor ?? null,
          body: body.body,
          createdAt: '2026-10-23T02:00:00.000Z',
        }
        input.comments?.push(comment)
        return { status: 201, body: { ok: true, data: comment } }
      },
    },
    {
      method: 'POST',
      url: new RegExp(`/api/v1/artifacts/${ARTIFACT_ID}/review-invitations$`),
      respond: (init) => {
        input.onInvite?.(JSON.parse(String(init.body)))
        return { status: 201, body: { ok: true, data: [invitation()] } }
      },
    },
    {
      method: 'POST',
      url: new RegExp(`/api/v1/artifacts/${ARTIFACT_ID}/review-submissions$`),
      respond: (init) => {
        input.onSubmit?.(JSON.parse(String(init.body)))
        return ok(
          invitation({
            status: 'submitted',
            noComment: JSON.parse(String(init.body)).noComment,
            submittedAt: '2026-10-23T03:00:00.000Z',
          }),
        )
      },
    },
    teamMembersHandler(),
  ]
}

describe('#429 交付物审阅页', () => {
  it('整件批注 → 提交本轮意见；没有意见时提交被禁用', async () => {
    const user = userEvent.setup()
    const comments: unknown[] = []
    const submitBodies: unknown[] = []
    const handlers = baseHandlers({
      view: () =>
        reviewView({
          comments,
          invitations: [invitation()],
          capabilities: { canInvite: false, canSubmitReview: true, canComment: true },
        }),
      comments,
      onSubmit: (body) => {
        submitBodies.push(body)
      },
    })
    renderApp(`/tasks/${TASK_ID}/review/${ARTIFACT_ID}`, loggedInHandlers(BOB, handlers))
    expect(await screen.findByTestId('review-version')).toHaveTextContent(SHA.slice(0, 12))
    expect(await screen.findByTestId('review-text')).toHaveTextContent('orderId')

    const submitButton = screen.getByTestId('review-submit-button')
    expect(submitButton).toBeDisabled()
    await user.type(screen.getByLabelText('对整件文件的评论'), '整体可以，字段名再统一。')
    await user.click(screen.getByRole('button', { name: '发表整件批注' }))
    expect(await screen.findByTestId('review-comments')).toHaveTextContent(
      '整体可以，字段名再统一。',
    )
    await waitFor(() => expect(submitButton).toBeEnabled())

    await user.click(submitButton)
    await waitFor(() => expect(submitBodies).toContainEqual({ noComment: false }))
    await user.click(screen.getByTestId('review-no-comment-button'))
    await waitFor(() => expect(submitBodies).toContainEqual({ noComment: true }))
  })

  it('选词后发表原位批注：请求体带版本内偏移与前后文', async () => {
    const user = userEvent.setup()
    const comments: unknown[] = []
    let commentBody: {
      anchor?: { quote: string; prefix: string; suffix: string; start: number; end: number }
    } | null = null
    const handlers = baseHandlers({
      view: () =>
        reviewView({
          comments,
          invitations: [invitation()],
          capabilities: { canInvite: false, canSubmitReview: true, canComment: true },
        }),
      comments,
      onComment: (body) => {
        commentBody = body as typeof commentBody
      },
    })
    renderApp(`/tasks/${TASK_ID}/review/${ARTIFACT_ID}`, loggedInHandlers(BOB, handlers))
    const pre = await screen.findByTestId('review-text')
    const node = pre.firstChild
    expect(node).not.toBeNull()
    const range = document.createRange()
    range.setStart(node!, SECOND)
    range.setEnd(node!, SECOND + 'orderId'.length)
    const selection = window.getSelection()
    selection?.removeAllRanges()
    selection?.addRange(range)
    fireEvent.mouseUp(pre)

    const composer = await screen.findByTestId('review-anchor-composer')
    expect(within(composer).getByText(/orderId/)).toBeVisible()
    await user.type(within(composer).getByLabelText('对所选文字的批注'), '这里要统一字段名。')
    await user.click(within(composer).getByRole('button', { name: '发表原位批注' }))
    await waitFor(() => expect(commentBody).not.toBeNull())
    expect(commentBody!.anchor).toMatchObject({
      quote: 'orderId',
      start: SECOND,
      end: SECOND + 'orderId'.length,
      prefix: TEXT.slice(Math.max(0, SECOND - 32), SECOND),
      suffix: TEXT.slice(SECOND + 7, SECOND + 7 + 32),
    })
    expect(await screen.findByTestId('review-comments')).toHaveTextContent('这里要统一字段名。')
  })

  it('URL 的任务与交付物归属对不上：明确报错并给正确入口', async () => {
    const handlers = baseHandlers({ view: () => reviewView() })
    renderApp(
      '/tasks/00000000-0000-4000-8000-0000000000ff/review/' + ARTIFACT_ID,
      loggedInHandlers(BOB, handlers),
    )
    expect(await screen.findByTestId('review-task-mismatch')).toBeVisible()
    expect(screen.getByRole('link', { name: '打开正确的审阅页' })).toHaveAttribute(
      'href',
      `/tasks/${TASK_ID}/review/${ARTIFACT_ID}`,
    )
  })

  it('他人批注/邀请经 artifact.changed 精确失效审阅页，同时刷新待办', () => {
    expect(
      keysForPersistentEvent(
        persistentFrame('artifact.changed', { artifactId: ARTIFACT_ID }).event,
      ),
    ).toContainEqual(['artifact-review', ARTIFACT_ID])
    expect(
      keysForPersistentEvent(
        persistentFrame('artifact.changed', { artifactId: ARTIFACT_ID }).event,
      ),
    ).toContainEqual(['attention'])
  })

  it('不支持定位的格式：明确说明并允许整件批注，不显示空白伪内容', async () => {
    const user = userEvent.setup()
    const comments: unknown[] = []
    let commentBody: unknown = null
    const handlers = baseHandlers({
      view: () =>
        reviewView({
          reading: 'unsupported',
          artifact: {
            ...reviewView().artifact,
            mediaType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
          },
          capabilities: { canInvite: false, canSubmitReview: false, canComment: true },
        }),
      comments,
      onComment: (body) => {
        commentBody = body
      },
    })
    renderApp(`/tasks/${TASK_ID}/review/${ARTIFACT_ID}`, loggedInHandlers(BOB, handlers))
    expect(await screen.findByTestId('review-unsupported')).toHaveTextContent('对整件文件发表评论')
    expect(screen.queryByTestId('review-text')).not.toBeInTheDocument()
    await user.type(screen.getByLabelText('对整件文件的评论'), '第 3 页的公式需要核对。')
    await user.click(screen.getByRole('button', { name: '发表整件批注' }))
    await waitFor(() => expect(commentBody).toEqual({ body: '第 3 页的公式需要核对。' }))
  })

  it('责任人可邀请审阅人：请求体带成员与审阅重点；进展显示待提交', async () => {
    const user = userEvent.setup()
    let inviteBody: unknown = null
    const handlers = baseHandlers({
      view: () =>
        reviewView({
          capabilities: { canInvite: true, canSubmitReview: false, canComment: true },
        }),
      onInvite: (body) => {
        inviteBody = body
      },
    })
    renderApp(`/tasks/${TASK_ID}/review/${ARTIFACT_ID}`, loggedInHandlers(ALICE, handlers))
    await screen.findByTestId('review-text')
    const bob = await screen.findByLabelText(/Bob（@bob）/)
    await user.click(bob)
    await user.type(screen.getByLabelText('请重点看什么（可选）'), '重点看命名')
    await user.click(screen.getByRole('button', { name: '发送审阅邀请' }))
    await waitFor(() =>
      expect(inviteBody).toEqual({
        reviewerUserIds: [BOB.userId],
        focus: '重点看命名',
      }),
    )
  })
})
