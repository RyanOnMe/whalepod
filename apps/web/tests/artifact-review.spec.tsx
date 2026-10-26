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
import { applyClientFrame, keysForPersistentEvent } from '../src/shared/realtime/event-router.js'
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

/** HTTP replay seam: persist first, then lose a response; same key returns that first row. */
function lostCommentResponse(dropCount: number, comments: Array<Record<string, unknown>>) {
  const requests: Array<{
    key: string
    body: { body: string; anchor?: Record<string, unknown>; parentCommentId?: string }
  }> = []
  const receipts = new Map<string, Record<string, unknown>>()
  const handler: MockHandler = {
    method: 'POST',
    url: new RegExp(`/api/v1/artifacts/${ARTIFACT_ID}/comments$`),
    respond: (init) => {
      const key = new Headers(init.headers).get('idempotency-key')!
      const body = JSON.parse(String(init.body)) as (typeof requests)[number]['body']
      requests.push({ key, body })
      let row = receipts.get(key)
      if (row === undefined) {
        row = {
          id: `00000000-0000-4000-8000-${String(comments.length + 1).padStart(12, '0')}`,
          artifactId: ARTIFACT_ID,
          authorUserId: BOB.userId,
          parentCommentId: body.parentCommentId ?? null,
          kind: body.anchor === undefined ? 'whole' : 'text',
          anchor: body.anchor ?? null,
          body: body.body.trim(),
          createdAt: '2026-10-23T02:00:00.000Z',
        }
        comments.push(row)
        receipts.set(key, row)
      }
      if (dropCount-- > 0) throw new Error('response lost after storing comment')
      return { status: 201, body: { ok: true, data: row } }
    },
  }
  return { requests, handler }
}
const RETRY_PARENT_ID = '00000000-0000-4000-8000-0000000000c1'
function retryParent() {
  return {
    id: RETRY_PARENT_ID,
    artifactId: ARTIFACT_ID,
    authorUserId: ALICE.userId,
    parentCommentId: null,
    kind: 'whole',
    anchor: null,
    body: '请核对这项',
    createdAt: '2026-10-23T01:00:00.000Z',
  }
}
async function commentComposer(
  kind: 'whole' | 'text' | 'reply',
  user: ReturnType<typeof userEvent.setup>,
) {
  if (kind === 'text') {
    const pre = await screen.findByTestId('review-text')
    const range = document.createRange()
    range.setStart(pre.firstChild!, SECOND)
    range.setEnd(pre.firstChild!, SECOND + 'orderId'.length)
    const selection = window.getSelection()
    selection?.removeAllRanges()
    selection?.addRange(range)
    fireEvent.mouseUp(pre)
    return {
      field: await screen.findByLabelText('对所选文字的批注'),
      button: screen.getByRole('button', { name: '发表原位批注' }),
    }
  }
  if (kind === 'reply') {
    await user.click(
      within(await screen.findByTestId(`review-comment-${RETRY_PARENT_ID}`)).getByRole('button', {
        name: '回复',
      }),
    )
    return {
      field: await screen.findByLabelText('回复批注'),
      button: screen.getByRole('button', { name: '发表回复' }),
    }
  }
  return {
    field: await screen.findByLabelText('对整件文件的评论'),
    button: screen.getByRole('button', { name: '发表整件批注' }),
  }
}

describe('#429 交付物审阅页', () => {
  it.each(['whole', 'text', 'reply'] as const)(
    '%s 批注已保存但响应丢失：同意图重试只保存一次，成功后允许新一次同文',
    async (kind) => {
      const user = userEvent.setup()
      const comments: Array<Record<string, unknown>> = kind === 'reply' ? [retryParent()] : []
      const replay = lostCommentResponse(1, comments)
      renderApp(
        `/tasks/${TASK_ID}/review/${ARTIFACT_ID}`,
        loggedInHandlers(BOB, [
          replay.handler,
          ...baseHandlers({ view: () => reviewView({ comments }) }),
        ]),
      )
      const composer = await commentComposer(kind, user)
      await user.type(composer.field, '请补充错误处理')
      await user.click(composer.button)
      await screen.findByRole('alert')
      await user.type(composer.field, '  ')
      await user.click(composer.button)
      await waitFor(() =>
        kind === 'whole'
          ? expect(composer.field).toHaveValue('')
          : expect(composer.field).not.toBeInTheDocument(),
      )
      expect(replay.requests).toHaveLength(2)
      expect(replay.requests[1]!.key).toBe(replay.requests[0]!.key)
      expect(comments.filter((row) => row.body === '请补充错误处理')).toHaveLength(1)
      const next = await commentComposer(kind, user)
      await user.type(next.field, '请补充错误处理')
      await user.click(next.button)
      await waitFor(() =>
        kind === 'whole'
          ? expect(next.field).toHaveValue('')
          : expect(next.field).not.toBeInTheDocument(),
      )
      expect(replay.requests[2]!.key).not.toBe(replay.requests[1]!.key)
      expect(comments.filter((row) => row.body === '请补充错误处理')).toHaveLength(2)
    },
  )

  it.each(['whole', 'text', 'reply'] as const)(
    '%s 未知结果 A→B→A 回到同一待定意图时重放A而不重复保存',
    async (kind) => {
      const user = userEvent.setup()
      const comments: Array<Record<string, unknown>> = kind === 'reply' ? [retryParent()] : []
      const replay = lostCommentResponse(2, comments)
      renderApp(
        `/tasks/${TASK_ID}/review/${ARTIFACT_ID}`,
        loggedInHandlers(BOB, [
          replay.handler,
          ...baseHandlers({ view: () => reviewView({ comments }) }),
        ]),
      )
      const composer = await commentComposer(kind, user)
      for (const text of ['意见 A', '意见 B']) {
        await user.clear(composer.field)
        await user.type(composer.field, text)
        await user.click(composer.button)
        await screen.findByRole('alert')
        await waitFor(() => expect(composer.button).toBeEnabled())
      }
      await user.clear(composer.field)
      await user.type(composer.field, '意见 A')
      await user.click(composer.button)
      await waitFor(() =>
        kind === 'whole'
          ? expect(composer.field).toHaveValue('')
          : expect(composer.field).not.toBeInTheDocument(),
      )
      expect(new Set(replay.requests.map((row) => row.key)).size).toBe(2)
      expect(replay.requests[2]!.key).toBe(replay.requests[0]!.key)
      expect(
        comments
          .filter((row) => ['意见 A', '意见 B'].includes(String(row.body)))
          .map((row) => row.body),
      ).toEqual(['意见 A', '意见 B'])
    },
  )

  it('同文原位意见换到另一处引用时，不重放原位置的回执', async () => {
    const user = userEvent.setup()
    const comments: Array<Record<string, unknown>> = []
    const replay = lostCommentResponse(1, comments)
    renderApp(
      `/tasks/${TASK_ID}/review/${ARTIFACT_ID}`,
      loggedInHandlers(BOB, [
        replay.handler,
        ...baseHandlers({ view: () => reviewView({ comments }) }),
      ]),
    )
    const composer = await commentComposer('text', user)
    await user.type(composer.field, '同一意见')
    await user.click(composer.button)
    await screen.findByRole('alert')
    const pre = screen.getByTestId('review-text')
    const range = document.createRange()
    const start = TEXT.indexOf('orderId')
    range.setStart(pre.firstChild!, start)
    range.setEnd(pre.firstChild!, start + 7)
    const selection = window.getSelection()
    selection?.removeAllRanges()
    selection?.addRange(range)
    fireEvent.mouseUp(pre)
    await user.click(composer.button)
    await waitFor(() => expect(composer.field).not.toBeInTheDocument())
    expect(replay.requests[1]!.key).not.toBe(replay.requests[0]!.key)
    expect(replay.requests.map((row) => row.body.anchor?.start)).toEqual([SECOND, start])
    expect(comments).toHaveLength(2)
  })

  it('同文回复换到另一条线程时，不重放旧父批注的回执', async () => {
    const user = userEvent.setup()
    const otherId = '00000000-0000-4000-8000-0000000000c2'
    const comments: Array<Record<string, unknown>> = [
      retryParent(),
      { ...retryParent(), id: otherId, body: '另一条意见' },
    ]
    const replay = lostCommentResponse(1, comments)
    renderApp(
      `/tasks/${TASK_ID}/review/${ARTIFACT_ID}`,
      loggedInHandlers(BOB, [
        replay.handler,
        ...baseHandlers({ view: () => reviewView({ comments }) }),
      ]),
    )
    const composer = await commentComposer('reply', user)
    await user.type(composer.field, '同一回复')
    await user.click(composer.button)
    await screen.findByRole('alert')
    await user.click(
      within(screen.getByTestId(`review-comment-${otherId}`)).getByRole('button', { name: '回复' }),
    )
    const next = screen.getByLabelText('回复批注')
    await user.type(next, '同一回复')
    await user.click(screen.getByRole('button', { name: '发表回复' }))
    await waitFor(() => expect(next).not.toBeInTheDocument())
    expect(replay.requests[1]!.key).not.toBe(replay.requests[0]!.key)
    expect(replay.requests.map((row) => row.body.parentCommentId)).toEqual([
      RETRY_PARENT_ID,
      otherId,
    ])
    expect(comments).toHaveLength(4)
  })

  it('整件批注 → 提交本轮意见；没有意见时提交被禁用', async () => {
    const user = userEvent.setup()
    const comments: unknown[] = []
    const submitBodies: unknown[] = []
    const handlers = baseHandlers({
      view: () =>
        reviewView({
          comments,
          invitations: [invitation({ focus: '重点看字段命名' })],
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
    expect(screen.getByTestId('review-focus')).toHaveTextContent('重点看字段命名')

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
    // 已经发表过意见时不能再说「本轮无意见」：按钮禁用，避免自相矛盾的提交。
    expect(screen.getByTestId('review-no-comment-button')).toBeDisabled()
  })

  it('没有发表任何批注时可以提交「本轮无意见」', async () => {
    const user = userEvent.setup()
    const submitBodies: unknown[] = []
    const handlers = baseHandlers({
      view: () =>
        reviewView({
          invitations: [invitation()],
          capabilities: { canInvite: false, canSubmitReview: true, canComment: true },
        }),
      onSubmit: (body) => {
        submitBodies.push(body)
      },
    })
    renderApp(`/tasks/${TASK_ID}/review/${ARTIFACT_ID}`, loggedInHandlers(BOB, handlers))
    await screen.findByTestId('review-text')
    expect(screen.getByTestId('review-submit-button')).toBeDisabled()
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
