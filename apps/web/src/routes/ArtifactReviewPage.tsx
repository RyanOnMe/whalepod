/**
 * 交付物审阅页（#429；ADR-0021 §2-4）。
 *
 * 一条路径：首页待办/文件卡进入准确版本 → 阅读（文本可选词，其他格式下载兜底）→
 * 发表整件或原位批注、回复 → 提交本轮意见（或本轮无意见）。邀请由责任人/拥有者
 * 发出，只决定待办归属，不改变文件权限；批注不驱动 Agent。
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { Link, useParams } from 'react-router'
import {
  ArtifactReviewViewSchema,
  locateArtifactCommentAnchor,
  type ArtifactCommentAnchor,
  type ArtifactCommentView,
  type ArtifactReviewView,
} from '@whalepod/protocol'
import { api } from '../shared/api/client.js'
import { useSession } from '../app/session.js'
import { useMemberDirectory } from '../features/team/memberDirectory.js'
import { queryKeys } from '../app/query-client.js'
import { ErrorBanner } from '../app/ErrorBanner.js'
import { RelativeTime } from '../shared/RelativeTime.js'

type Filter = 'all' | 'unresolved' | 'round'
type CommentInput = { body: string; anchor?: ArtifactCommentAnchor; parentCommentId?: string }
type CommentIntent = { signature: string; key: string }
function commentKind(input: CommentInput): 'whole' | 'text' | 'reply' {
  return input.parentCommentId !== undefined
    ? 'reply'
    : input.anchor !== undefined
      ? 'text'
      : 'whole'
}

/** 从当前选择算出「版本内偏移 + 前后文」；选择为空或不在正文里返回 null。 */
export function selectionAnchor(
  container: HTMLElement,
  text: string,
  selection: Selection | null,
): ArtifactCommentAnchor | null {
  if (selection === null || selection.rangeCount === 0 || selection.isCollapsed) return null
  const range = selection.getRangeAt(0)
  if (!container.contains(range.commonAncestorContainer)) return null
  const before = document.createRange()
  before.selectNodeContents(container)
  before.setEnd(range.startContainer, range.startOffset)
  const start = before.toString().length
  const quote = range.toString()
  if (quote.trim() === '' || start + quote.length > text.length) return null
  if (text.slice(start, start + quote.length) !== quote) return null
  return {
    quote,
    prefix: text.slice(Math.max(0, start - 32), start),
    suffix: text.slice(start + quote.length, start + quote.length + 32),
    start,
    end: start + quote.length,
  }
}

/** 页内定位：唯一命中才高亮；找不到时调用方必须显示「无法定位」。 */
export function locateInText(
  text: string,
  anchor: ArtifactCommentAnchor,
): ArtifactCommentAnchor | null {
  return locateArtifactCommentAnchor(text, anchor)
}

function CommentThread({
  comment,
  replies,
  authorName,
  onReply,
  onJump,
  locateState,
}: {
  comment: ArtifactCommentView
  replies: ArtifactCommentView[]
  authorName: (userId: string) => string
  onReply: (commentId: string) => void
  onJump: (anchor: ArtifactCommentAnchor, commentId: string) => void
  locateState: 'ok' | 'unlocated'
}): ReactNode {
  return (
    <li className="review-thread" data-testid={`review-comment-${comment.id}`}>
      <div className="review-comment">
        <div className="review-comment-meta">
          <strong>{authorName(comment.authorUserId)}</strong>
          <RelativeTime iso={comment.createdAt} />
        </div>
        {comment.anchor !== null ? (
          <button
            type="button"
            className="review-quote"
            onClick={() => onJump(comment.anchor!, comment.id)}
          >
            「{comment.anchor.quote}」
            {locateState === 'unlocated' ? (
              <span className="mutation-hint">（无法定位，已保留原引用）</span>
            ) : null}
          </button>
        ) : (
          <p className="mutation-hint">对整件文件</p>
        )}
        <p className="review-comment-body">{comment.body}</p>
        <button type="button" className="button button-quiet" onClick={() => onReply(comment.id)}>
          回复
        </button>
      </div>
      {replies.length > 0 ? (
        <ul className="review-replies">
          {replies.map((reply) => (
            <li key={reply.id} data-testid={`review-reply-${reply.id}`}>
              <strong>{authorName(reply.authorUserId)}</strong>
              <RelativeTime iso={reply.createdAt} />
              <p>{reply.body}</p>
            </li>
          ))}
        </ul>
      ) : null}
    </li>
  )
}

export function ArtifactReviewPage(): ReactNode {
  const { taskId = '', artifactId = '' } = useParams()
  const session = useSession()
  const directory = useMemberDirectory()
  const queryClient = useQueryClient()
  const preRef = useRef<HTMLPreElement>(null)
  const [filter, setFilter] = useState<Filter>('all')
  const [selection, setSelection] = useState<ArtifactCommentAnchor | null>(null)
  const [wholeBody, setWholeBody] = useState('')
  const [anchorBody, setAnchorBody] = useState('')
  const [replyTo, setReplyTo] = useState<string | null>(null)
  const [replyBody, setReplyBody] = useState('')
  const [actionError, setActionError] = useState<unknown>(null)
  const [inviteFocus, setInviteFocus] = useState('')
  const [invitees, setInvitees] = useState<string[]>([])
  const [locateErrors, setLocateErrors] = useState<Record<string, true>>({})
  const [notice, setNotice] = useState<string | null>(null)
  const commentIntents = useRef<Record<'whole' | 'text' | 'reply', CommentIntent | null>>({
    whole: null,
    text: null,
    reply: null,
  })
  const normalizedWholeBody = wholeBody.trim()
  const normalizedAnchorBody = anchorBody.trim()
  const normalizedReplyBody = replyBody.trim()
  const selectedAnchor = JSON.stringify(selection)
  // Each composer retains only its current request intent. Whitespace equivalent
  // retries stay identical; semantic edits, including A → B → A, start a new one.
  useEffect(() => {
    commentIntents.current.whole = null
  }, [artifactId, normalizedWholeBody])
  useEffect(() => {
    commentIntents.current.text = null
  }, [artifactId, normalizedAnchorBody, selectedAnchor])
  useEffect(() => {
    commentIntents.current.reply = null
  }, [artifactId, normalizedReplyBody, replyTo])

  const query = useQuery({
    queryKey: ['artifact-review', artifactId],
    queryFn: async () =>
      ArtifactReviewViewSchema.parse(await api.get(`/artifacts/${artifactId}/review`)),
    enabled: artifactId !== '',
  })
  const view: ArtifactReviewView | undefined = query.data

  const content = useQuery({
    queryKey: ['artifact-review-content', artifactId],
    queryFn: async () => {
      const response = await fetch(`/api/v1/artifacts/${artifactId}/content`, {
        credentials: 'include',
      })
      if (!response.ok) throw new Error('交付物内容读取失败')
      return response.text()
    },
    enabled: view?.reading === 'text',
    retry: false,
  })
  const text = content.data ?? ''

  useEffect(() => {
    setSelection(null)
    setLocateErrors({})
    setNotice(null)
  }, [artifactId])

  const invalidate = (): void => {
    void queryClient.invalidateQueries({ queryKey: ['artifact-review', artifactId] })
    void queryClient.invalidateQueries({ queryKey: ['attention'] })
    void queryClient.invalidateQueries({ queryKey: queryKeys.taskRoom(taskId) })
  }

  const comment = useMutation({
    mutationFn: (input: CommentInput) => {
      const body = {
        body: input.body.trim(),
        ...(input.anchor === undefined ? {} : { anchor: input.anchor }),
        ...(input.parentCommentId === undefined ? {} : { parentCommentId: input.parentCommentId }),
      }
      const kind = commentKind(input)
      const signature = JSON.stringify({ artifactId, ...body })
      let intent = commentIntents.current[kind]
      if (intent === null || intent.signature !== signature) {
        intent = { signature, key: crypto.randomUUID() }
        commentIntents.current[kind] = intent
      }
      return api.mutate<ArtifactCommentView>(`/artifacts/${artifactId}/comments`, {
        body,
        idempotencyKey: intent.key,
      })
    },
    onSuccess: (_comment, input) => {
      commentIntents.current[commentKind(input)] = null
      setActionError(null)
      invalidate()
    },
    onError: (error: unknown) => setActionError(error),
  })
  const invite = useMutation({
    mutationFn: () =>
      api.mutate(`/artifacts/${artifactId}/review-invitations`, {
        body: {
          reviewerUserIds: invitees,
          ...(inviteFocus.trim() === '' ? {} : { focus: inviteFocus.trim() }),
        },
      }),
    onSuccess: () => {
      setActionError(null)
      setInviteFocus('')
      setInvitees([])
      setNotice('邀请已发出。打开页面不算提交意见，审阅人需自己提交本轮意见。')
      invalidate()
    },
    onError: (error: unknown) => setActionError(error),
  })
  const submit = useMutation({
    mutationFn: (noComment: boolean) =>
      api.mutate(`/artifacts/${artifactId}/review-submissions`, { body: { noComment } }),
    onSuccess: () => {
      setActionError(null)
      setNotice('本轮意见已提交；之后仍可追加意见并再次提交。')
      invalidate()
    },
    onError: (error: unknown) => setActionError(error),
  })

  const comments = view?.comments ?? []
  const mine = comments.filter((row) => row.authorUserId === session?.userId)
  const ownInvitation = view?.invitations.find((row) => row.reviewerUserId === session?.userId)
  const threads = useMemo(() => comments.filter((row) => row.parentCommentId === null), [comments])
  const visibleThreads = threads.filter((thread) => {
    if (filter === 'round') return false
    // 首版没有解决记录：全部批注都属于「未解决」；解决/复核在下一批接通。
    return true
  })
  const enabledMembers = directory.members.filter(
    (member) => member.enabled && member.userId !== session?.userId,
  )

  function captureSelection(): void {
    if (preRef.current === null || view?.reading !== 'text') return
    setSelection(selectionAnchor(preRef.current, text, window.getSelection()))
  }

  function jumpTo(anchor: ArtifactCommentAnchor, commentId: string): void {
    const located = locateInText(text, anchor)
    if (located === null || preRef.current === null) {
      setLocateErrors((current) => ({ ...current, [commentId]: true }))
      return
    }
    const node = preRef.current.firstChild
    if (node === null) {
      setLocateErrors((current) => ({ ...current, [commentId]: true }))
      return
    }
    const range = document.createRange()
    range.setStart(node, located.start)
    range.setEnd(node, located.end)
    const selectionObject = window.getSelection()
    selectionObject?.removeAllRanges()
    selectionObject?.addRange(range)
    range.startContainer.parentElement?.scrollIntoView({ block: 'center' })
  }

  if (session === null) return null
  if (query.isPending) return <p role="status">正在读取审阅页…</p>
  if (query.isError) {
    return (
      <div className="card" role="alert">
        <ErrorBanner error={query.error} />
        <Link to={`/tasks/${taskId}`}>返回任务</Link>
      </div>
    )
  }
  if (view === undefined) return null
  // 审阅页 URL 同时带任务与 Artifact：两者对不上时不冒充「这个任务的交付物」。
  if (view.artifact.taskId !== taskId) {
    return (
      <div className="card" role="alert" data-testid="review-task-mismatch">
        <p>该交付物不属于这个任务。</p>
        <Link to={`/tasks/${view.artifact.taskId}/review/${view.artifact.id}`}>
          打开正确的审阅页
        </Link>
      </div>
    )
  }
  const busy = comment.isPending || invite.isPending || submit.isPending
  const canSubmit = ownInvitation !== undefined && mine.length > 0
  const reading = view.reading

  return (
    <div className="page review-page" data-testid="artifact-review-page">
      <header className="review-header">
        <Link to={`/tasks/${taskId}`} data-testid="review-back-link">
          ← 返回任务
        </Link>
        <div>
          <h1>{view.artifact.title}</h1>
          <p className="mutation-hint" data-testid="review-version">
            {`交付物版本 · 内容摘要 ${view.artifact.sha256.slice(0, 12)} · `}
            {view.artifact.publishedAt === null
              ? '尚未发布'
              : `发布于 ${new Date(view.artifact.publishedAt).toLocaleString()}`}
            {` · 发布人 ${directory.personOf(view.artifact.ownerUserId)}`}
          </p>
        </div>
        <a
          className="button"
          href={`/api/v1/artifacts/${view.artifact.id}/content`}
          data-testid="review-download"
        >
          下载原件
        </a>
      </header>

      {actionError !== null ? <ErrorBanner error={actionError} /> : null}
      {notice !== null ? (
        <p className="mutation-hint" role="status">
          {notice}
        </p>
      ) : null}

      <div className="review-layout">
        <main className="review-content" aria-label="文件内容">
          {reading === 'unsupported' ? (
            <p data-testid="review-unsupported">
              该格式暂不支持在线定位批注。请下载原件查看后，对整件文件发表评论
              {view.artifact.mediaType.startsWith('application/pdf') ? '，并写明页码或位置' : ''}。
            </p>
          ) : content.isPending ? (
            <p role="status">正在读取文件内容…</p>
          ) : content.isError ? (
            <div role="alert" data-testid="review-content-error">
              <p>文件内容读取失败；可下载原件查看，或重试后再批注。</p>
              <button type="button" className="button" onClick={() => void content.refetch()}>
                重试读取内容
              </button>
            </div>
          ) : (
            <pre
              ref={preRef}
              className="review-text"
              data-testid="review-text"
              onMouseUp={captureSelection}
            >
              {text}
            </pre>
          )}

          <section className="review-composer" aria-label="发表批注">
            {reading === 'text' && content.isSuccess ? (
              selection !== null ? (
                <div data-testid="review-anchor-composer">
                  <p>
                    已选：
                    <mark>{`「${selection.quote}」`}</mark>
                    <button
                      type="button"
                      className="button button-quiet"
                      onClick={() => setSelection(null)}
                    >
                      取消选择
                    </button>
                  </p>
                  <textarea
                    className="input"
                    rows={2}
                    aria-label="对所选文字的批注"
                    value={anchorBody}
                    onChange={(event) => setAnchorBody(event.target.value)}
                  />
                  <button
                    type="button"
                    className="button button-primary"
                    disabled={busy || anchorBody.trim() === ''}
                    onClick={() =>
                      comment.mutate(
                        { body: anchorBody, anchor: selection },
                        {
                          onSuccess: () => {
                            setAnchorBody('')
                            setSelection(null)
                          },
                        },
                      )
                    }
                  >
                    发表原位批注
                  </button>
                </div>
              ) : (
                <p className="mutation-hint">
                  在正文里选择文字可发表原位批注；也可以直接对整件文件发表评论。
                </p>
              )
            ) : reading === 'text' ? (
              <p className="mutation-hint">
                正文暂不可读，仍可对整件文件发表评论（不会假装内容已读）。
              </p>
            ) : (
              <p className="mutation-hint">该格式只支持对整件文件发表评论。</p>
            )}
            <label className="review-field">
              <span>对整件文件发表评论</span>
              <textarea
                className="input"
                rows={2}
                aria-label="对整件文件的评论"
                value={wholeBody}
                onChange={(event) => setWholeBody(event.target.value)}
              />
            </label>
            <button
              type="button"
              className="button"
              disabled={busy || wholeBody.trim() === ''}
              onClick={() =>
                comment.mutate({ body: wholeBody }, { onSuccess: () => setWholeBody('') })
              }
            >
              发表整件批注
            </button>
          </section>
        </main>

        <aside className="review-side" aria-label="批注与审阅">
          <div className="review-filters" role="group" aria-label="批注筛选">
            {(
              [
                ['all', '全部'],
                ['unresolved', '未解决'],
                ['round', '本轮待复核'],
              ] as const
            ).map(([value, label]) => (
              <button
                type="button"
                key={value}
                aria-pressed={filter === value}
                onClick={() => setFilter(value)}
              >
                {label}
              </button>
            ))}
          </div>
          {filter === 'round' ? (
            <p className="mutation-hint">新一轮修订发布后，这里会出现待复核意见。</p>
          ) : null}
          {visibleThreads.length === 0 && filter !== 'round' ? (
            <p>还没有批注。</p>
          ) : (
            <ul className="review-thread-list" data-testid="review-comments">
              {visibleThreads.map((thread) => (
                <CommentThread
                  key={thread.id}
                  comment={thread}
                  replies={comments.filter((row) => row.parentCommentId === thread.id)}
                  authorName={directory.personOf}
                  onReply={(id) => {
                    setReplyTo(id)
                    setReplyBody('')
                  }}
                  onJump={jumpTo}
                  locateState={locateErrors[thread.id] === true ? 'unlocated' : 'ok'}
                />
              ))}
            </ul>
          )}

          {replyTo !== null ? (
            <div className="review-reply-form" data-testid="review-reply-form">
              <label className="review-field">
                <span>回复</span>
                <textarea
                  className="input"
                  rows={2}
                  aria-label="回复批注"
                  value={replyBody}
                  onChange={(event) => setReplyBody(event.target.value)}
                />
              </label>
              <button
                type="button"
                className="button"
                disabled={busy || replyBody.trim() === ''}
                onClick={() =>
                  comment.mutate(
                    { body: replyBody, parentCommentId: replyTo },
                    {
                      onSuccess: () => {
                        setReplyBody('')
                        setReplyTo(null)
                      },
                    },
                  )
                }
              >
                发表回复
              </button>
              <button
                type="button"
                className="button button-quiet"
                onClick={() => setReplyTo(null)}
              >
                取消
              </button>
            </div>
          ) : null}

          {view.capabilities.canInvite ? (
            <section className="review-invite" aria-label="邀请审阅">
              <h2>请同事审阅</h2>
              <p className="mutation-hint">
                邀请只决定待办归属；文件仍按当前团队可见范围读取，不授予执行权限。
              </p>
              <fieldset>
                <legend>审阅人</legend>
                {enabledMembers.map((member) => (
                  <label key={member.userId} className="review-invitee">
                    <input
                      type="checkbox"
                      checked={invitees.includes(member.userId)}
                      onChange={(event) =>
                        setInvitees((current) =>
                          event.target.checked
                            ? [...current, member.userId]
                            : current.filter((id) => id !== member.userId),
                        )
                      }
                    />
                    {`${member.displayName}（@${member.username}）`}
                  </label>
                ))}
              </fieldset>
              <label className="review-field">
                <span>请重点看什么（可选）</span>
                <input
                  className="input"
                  value={inviteFocus}
                  onChange={(event) => setInviteFocus(event.target.value)}
                />
              </label>
              <button
                type="button"
                className="button"
                disabled={busy || invitees.length === 0}
                onClick={() => invite.mutate()}
              >
                发送审阅邀请
              </button>
            </section>
          ) : null}

          {view.capabilities.canSubmitReview && ownInvitation !== undefined ? (
            <section className="review-submit" aria-label="提交本轮意见">
              <h2>本轮审阅</h2>
              {ownInvitation.focus !== null ? (
                <p data-testid="review-focus">邀请人请你重点看：{ownInvitation.focus}</p>
              ) : null}
              <p className="mutation-hint">
                {ownInvitation.status === 'submitted'
                  ? `${ownInvitation.noComment ? '已提交：本轮无意见' : '已提交意见'}（${new Date(ownInvitation.submittedAt ?? ownInvitation.createdAt).toLocaleString()}）；补充意见后可再次提交。`
                  : '打开页面不算提交；看完后再选提交。'}
              </p>
              <button
                type="button"
                className="button button-primary"
                data-testid="review-submit-button"
                disabled={busy || !canSubmit}
                onClick={() => submit.mutate(false)}
              >
                提交本轮意见
              </button>
              <button
                type="button"
                className="button"
                data-testid="review-no-comment-button"
                disabled={busy || mine.length > 0}
                title={mine.length > 0 ? '已经发表过意见，不能选择本轮无意见' : undefined}
                onClick={() => submit.mutate(true)}
              >
                本轮无意见
              </button>
              {mine.length > 0 ? (
                <span className="mutation-hint">
                  已经发表批注；如本轮无意见请先撤回，当前不支持撤回。
                </span>
              ) : null}
            </section>
          ) : null}

          {view.capabilities.canInvite ? (
            <section aria-label="审阅进展">
              <h2>审阅进展</h2>
              {view.invitations.length === 0 ? (
                <p>还没有邀请。</p>
              ) : (
                <ul data-testid="review-invitations">
                  {view.invitations.map((invitation) => (
                    <li key={invitation.id}>
                      {directory.personOf(invitation.reviewerUserId)}：
                      {invitation.status === 'pending'
                        ? '待提交意见'
                        : invitation.noComment
                          ? '本轮无意见'
                          : '已提交意见'}
                    </li>
                  ))}
                </ul>
              )}
            </section>
          ) : null}
        </aside>
      </div>
    </div>
  )
}
