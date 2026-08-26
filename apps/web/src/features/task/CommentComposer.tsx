/**
 * 中间区域：Comment 时间线 + 留言输入（02 Task 7 Step 4）。
 * 提交后精确失效 task-room 查询；失败时保留输入内容并显示 requestId。
 */
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useState, type FormEvent, type ReactNode } from 'react'
import { api } from '../../shared/api/client.js'
import { ErrorBanner } from '../../app/ErrorBanner.js'
import { formatIso, shortId } from '../../shared/format.js'
import type { CommentView, Session } from '../../shared/api/types.js'
import { queryKeys } from '../../app/query-client.js'

export interface CommentListProps {
  comments: CommentView[]
  session: Session | null
}

export function CommentList({ comments, session }: CommentListProps): ReactNode {
  if (comments.length === 0) {
    return <p className="empty-state">还没有留言——向责任人说明下一步吧。</p>
  }
  return (
    <ul className="comment-list" role="list">
      {comments.map((comment) => {
        const isMine = session !== null && comment.authorUserId === session.userId
        return (
          <li key={comment.id} className="comment-item">
            <div className="comment-meta">
              <strong>{isMine ? '你' : shortId(comment.authorUserId)}</strong>
              <time dateTime={comment.createdAt}>{formatIso(comment.createdAt)}</time>
            </div>
            <p className="comment-body">{comment.body}</p>
          </li>
        )
      })}
    </ul>
  )
}

export interface CommentComposerProps {
  taskId: string
}

export function CommentComposer({ taskId }: CommentComposerProps): ReactNode {
  const queryClient = useQueryClient()
  const [body, setBody] = useState('')
  const [error, setError] = useState<unknown>(null)

  const mutation = useMutation({
    mutationFn: (text: string) =>
      api.mutate<CommentView>(`/tasks/${taskId}/comments`, { body: { body: text } }),
    onSuccess: () => {
      setBody('')
      setError(null)
      void queryClient.invalidateQueries({ queryKey: queryKeys.taskRoom(taskId) })
    },
    onError: (mutationError: unknown) => {
      // 失败时保留输入内容，只展示错误（02 Task 7 Step 6）。
      setError(mutationError)
    },
  })

  const submit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault()
    const text = body.trim()
    if (text === '' || mutation.isPending) return
    setError(null)
    mutation.mutate(text)
  }

  return (
    <form className="comment-composer" onSubmit={submit}>
      <label htmlFor={`comment-body-${taskId}`}>留言</label>
      <textarea
        id={`comment-body-${taskId}`}
        name="body"
        rows={3}
        maxLength={10_000}
        value={body}
        onChange={(event) => setBody(event.target.value)}
      />
      <div className="composer-actions">
        <button type="submit" className="button button-primary" disabled={mutation.isPending}>
          {mutation.isPending ? '发送中…' : '发送留言'}
        </button>
        {body.trim() !== '' ? null : <span className="mutation-hint">先输入留言内容</span>}
      </div>
      {error !== null ? <ErrorBanner error={error} /> : null}
    </form>
  )
}
