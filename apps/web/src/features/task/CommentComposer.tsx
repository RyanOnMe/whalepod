/**
 * 中间区域：Comment 时间线 + 留言输入（02 Task 7 Step 4）。
 * 提交后精确失效 task-room 查询；失败时保留输入内容并显示 requestId。
 */
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useState, type FormEvent, type ReactNode } from 'react'
import { api } from '../../shared/api/client.js'
import { ErrorBanner } from '../../app/ErrorBanner.js'
import { RelativeTime } from '../../shared/RelativeTime.js'
import { useMemberDirectory } from '../team/memberDirectory.js'
import type { CommentView, Session, TaskRoomRun } from '../../shared/api/types.js'
import { SelectMenu } from '../../shared/SelectMenu.js'
import { formatRunReference, parseRunReferences } from './runReference.js'
import { queryKeys } from '../../app/query-client.js'

export interface CommentListProps {
  comments: CommentView[]
  session: Session | null
  /**
   * 本任务的运行（团队可见投影）：讨论里的 `运行 R-xxxxxxxx` 只有能在**本任务**解析到时
   * 才渲染成可点的引用 chip——对不上就保持纯文本，绝不做死链（⑥f）。
   */
  runs?: readonly TaskRoomRun[]
  /** 点引用 chip 时打开那次运行的 Console（⑥d 的覆盖层）。 */
  onOpenRun?: (runId: string) => void
}

export function CommentList({
  comments,
  session,
  runs = [],
  onOpenRun,
}: CommentListProps): ReactNode {
  // #162：留言作者写人名（显示名（@用户名）），不写 `shortId(authorUserId)`——
  // 团队讨论里「谁说了这句」是主信息，半截 UUID 提供不了这个信息。
  const directory = useMemberDirectory()
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
              <strong data-testid="comment-author">
                {isMine ? '你' : directory.personOf(comment.authorUserId)}
              </strong>
              <RelativeTime iso={comment.createdAt} />
            </div>
            <p className="comment-body">
              {parseRunReferences(comment.body, runs).map((segment, index) =>
                segment.runId === null ? (
                  <span key={index}>{segment.text}</span>
                ) : (
                  <button
                    key={index}
                    type="button"
                    className="ref-chip"
                    data-testid="comment-run-ref"
                    data-run-id={segment.runId}
                    title="打开这次运行的 Console"
                    onClick={() => onOpenRun?.(segment.runId as string)}
                  >
                    {segment.text}
                  </button>
                ),
              )}
            </p>
          </li>
        )
      })}
    </ul>
  )
}

export interface CommentComposerProps {
  taskId: string
  /** 本任务的运行列表（团队可见投影）：引用只能指向本任务的运行，所以按钮里列的就是它。 */
  runs?: readonly TaskRoomRun[]
  /** 运行短号 → 展示名（「第 N 次运行」）；由页面注入，避免这里重新发明编号规则。 */
  runLabels?: ReadonlyMap<string, string>
}

export function CommentComposer({
  taskId,
  runs = [],
  runLabels = new Map<string, string>(),
}: CommentComposerProps): ReactNode {
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
        {/* ⑥f：引用某次运行。插入的是**可读 token**（「运行 R-ab12cd34」），与手打同一套语法——
            不做"只有点按钮才会被识别"的隐藏规则。没有运行时如实禁用，而不是给一个空菜单。 */}
        {runs.length === 0 ? null : (
          <SelectMenu
            id={`comment-run-ref-${taskId}`}
            label="引用运行"
            value=""
            placeholder="引用运行…"
            options={runs.map((run) => ({
              value: run.id,
              label: runLabels.get(run.id) ?? '运行',
              disabled: false,
            }))}
            onChange={(runId: string) => {
              if (runId === '') return
              setBody((current) =>
                current === ''
                  ? formatRunReference(runId)
                  : `${current} ${formatRunReference(runId)}`,
              )
            }}
          />
        )}
        {body.trim() !== '' ? null : <span className="mutation-hint">先输入留言内容</span>}
      </div>
      {error !== null ? <ErrorBanner error={error} /> : null}
    </form>
  )
}
