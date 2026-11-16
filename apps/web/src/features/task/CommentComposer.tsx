import { DiscussionMessage, DiscussionComposer } from '../../vendor/collectui/collectui.js'
/**
 * 中间区域：Comment 时间线 + 留言输入（02 Task 7 Step 4）。
 * 提交后精确失效 task-room 查询；失败时保留输入内容并显示 requestId。
 */
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { Fragment, useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react'
import { Link } from 'react-router'
import { api } from '../../shared/api/client.js'
import { ErrorBanner } from '../../app/ErrorBanner.js'
import { RelativeTime } from '../../shared/RelativeTime.js'
import { useMemberDirectory } from '../team/memberDirectory.js'
import type { CommentView, Session, TaskRoomArtifact, TaskRoomRun } from '../../shared/api/types.js'
import { SelectMenu } from '../../shared/SelectMenu.js'
import { parseRunReferences } from './runReference.js'
import { useTeamMessageDraft } from './execution-drafts.js'
import { queryKeys } from '../../app/query-client.js'

const reviewPath = (taskId: string, id: string) => `/tasks/${taskId}/review/${id}`
// Comments are plain text. Recognise only a whole line that points to an exact published
// version in this task; old clients can still copy the path, and unknown links stay plain text.
const fileReferenceLine = (path: string) => `文件：${path}`

export interface CommentListProps {
  comments: CommentView[]
  session: Session | null
  taskId: string
  artifacts?: readonly TaskRoomArtifact[]
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
  taskId,
  artifacts = [],
  runs = [],
  onOpenRun,
}: CommentListProps): ReactNode {
  // #162：留言作者写人名（显示名（@用户名）），不写 `shortId(authorUserId)`——
  // 团队讨论里「谁说了这句」是主信息，半截 UUID 提供不了这个信息。
  const directory = useMemberDirectory()
  const fileLinks = new Map(
    artifacts
      .filter((row) => row.status === 'published')
      .map((row) => {
        const path = reviewPath(taskId, row.id)
        return [fileReferenceLine(path), { path, title: row.title }] as const
      }),
  )
  if (comments.length === 0) {
    return <p className="empty-state">还没有留言——向责任人说明下一步吧。</p>
  }
  return (
    <ul className="comment-list" role="list">
      {comments.map((comment) => {
        const isMine = session !== null && comment.authorUserId === session.userId
        return (
          <li key={comment.id} className="comment-item">
            <DiscussionMessage
              author={isMine ? '你' : directory.personOf(comment.authorUserId)}
              time={<RelativeTime iso={comment.createdAt} />}
            >
              <p className="comment-body">
                {comment.body.split('\n').map((line, index) => {
                  const file = fileLinks.get(line)
                  return (
                    <Fragment key={index}>
                      {index === 0 ? null : '\n'}
                      {file !== undefined ? (
                        <Link className="ref-chip" to={file.path}>
                          {file.title}
                        </Link>
                      ) : (
                        parseRunReferences(line, runs).map((segment, part) =>
                          segment.runId === null ? (
                            <span key={part}>{segment.text}</span>
                          ) : (
                            <button
                              key={part}
                              type="button"
                              className="ref-chip"
                              data-testid="comment-run-ref"
                              data-run-id={segment.runId}
                              title="查看这次处理的详细记录"
                              onClick={() => onOpenRun?.(segment.runId as string)}
                            >
                              {segment.text}
                            </button>
                          ),
                        )
                      )}
                    </Fragment>
                  )
                })}
              </p>
            </DiscussionMessage>
          </li>
        )
      })}
    </ul>
  )
}

export interface CommentComposerProps {
  taskId: string
  /**
   * #548：当前登录身份。草稿与幂等键按身份 + 任务存在 AppShell 的页面会话内存里，
   * 切换接收方或去设备页返回时不丢；为空时退回组件内 state（组件级夹具）。
   */
  userId?: string | null
  artifacts?: readonly TaskRoomArtifact[]
  quoteRequest?: { artifactId: string; nonce: string } | null
  onQuoteConsumed?: () => void
}

export function CommentComposer({
  taskId,
  userId = null,
  artifacts = [],
  quoteRequest = null,
  onQuoteConsumed,
}: CommentComposerProps): ReactNode {
  const queryClient = useQueryClient()
  const {
    draft,
    update: updateDraft,
    clearIfPending,
    isPending,
  } = useTeamMessageDraft(taskId, userId)
  const { body, artifactIds } = draft
  const published = artifacts.filter((row) => row.status === 'published')
  const selectedFiles = artifactIds.map((id) => published.find((row) => row.id === id))
  const missingFile = selectedFiles.some((row) => row === undefined)
  const outgoing = [
    body.trim(),
    ...artifactIds.map((id) => fileReferenceLine(reviewPath(taskId, id))),
  ]
    .filter(Boolean)
    .join('\n')
  const [error, setError] = useState<unknown>(null)
  // #548：成功只表示「已发给团队」，不宣称助手已读或采用。
  const [sent, setSent] = useState(false)
  const textareaRef = useRef<HTMLTextAreaElement>(null)

  /** 任何编辑都意味着这是一份新的留言：旧幂等键不能再拿去重试。 */
  const setBody = (change: string | ((current: string) => string)): void => {
    setSent(false)
    updateDraft((old) => ({
      ...old,
      body: typeof change === 'function' ? change(old.body) : change,
      pending: null,
    }))
  }
  const addFile = (id: string): void => {
    setSent(false)
    updateDraft((old) =>
      old.artifactIds.includes(id)
        ? old
        : { ...old, artifactIds: [...old.artifactIds, id], pending: null },
    )
  }
  const removeFile = (id: string): void =>
    updateDraft((old) => ({
      ...old,
      artifactIds: old.artifactIds.filter((row) => row !== id),
      pending: null,
    }))

  // 任务参数变化时路由可能复用同一组件实例：上一条任务的「已发给团队」与错误不能
  // 挂到新任务的输入框上。草稿本身按 taskId 存在 store 里，不需要搬。
  useEffect(() => {
    setSent(false)
    setError(null)
  }, [taskId])

  useEffect(() => {
    if (quoteRequest === null) return
    if (published.some((row) => row.id === quoteRequest.artifactId))
      addFile(quoteRequest.artifactId)
    textareaRef.current?.focus()
    onQuoteConsumed?.()
  }, [quoteRequest, onQuoteConsumed, artifacts])

  const mutation = useMutation({
    mutationFn: ({ text, key }: { text: string; key: string }) =>
      api.mutate<CommentView>(`/tasks/${taskId}/comments`, {
        body: { body: text },
        idempotencyKey: key,
      }),
    onSuccess: (_comment, { key }) => {
      // 迟到的回执只清它自己那份请求——判据取 store 当前快照，组件已卸载/换任务也成立。
      if (clearIfPending(key)) setSent(true)
      setError(null)
      void queryClient.invalidateQueries({ queryKey: queryKeys.taskRoom(taskId) })
    },
    onError: (mutationError: unknown, { key }) => {
      // 失败时保留输入内容与幂等键：同一份未确认请求重试不得重复留言（#548）。
      if (isPending(key)) setError(mutationError)
    },
  })

  const submit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault()
    const text = outgoing
    if (text === '' || missingFile || text.length > 10_000 || mutation.isPending) return
    const key = draft.pending?.signature === text ? draft.pending.key : crypto.randomUUID()
    updateDraft((old) => ({ ...old, pending: { signature: text, key } }))
    setError(null)
    mutation.mutate({ text, key })
  }

  return (
    <form className="comment-composer" onSubmit={submit}>
      <DiscussionComposer
        action={
          <button
            type="submit"
            className="button button-primary"
            disabled={
              mutation.isPending || outgoing === '' || missingFile || outgoing.length > 10_000
            }
          >
            {mutation.isPending ? '发送中…' : '发给团队'}
          </button>
        }
        controls={
          published.length === 0 ? null : (
            <SelectMenu
              id={`comment-file-ref-${taskId}`}
              label="引用文件"
              value=""
              placeholder="选择已发布文件"
              options={published.map((row) => ({
                value: row.id,
                label: published.some((other) => other.id !== row.id && other.title === row.title)
                  ? `${row.title} · ${new Date(row.publishedAt ?? row.createdAt).toLocaleString()}`
                  : row.title,
                disabled: mutation.isPending || artifactIds.includes(row.id),
              }))}
              onChange={addFile}
            />
          )
        }
      >
        <label htmlFor={`comment-body-${taskId}`}>留言</label>
        <textarea
          id={`comment-body-${taskId}`}
          name="body"
          placeholder="补充一条情况…"
          rows={3}
          maxLength={10_000}
          value={body}
          ref={textareaRef}
          onChange={(event) => {
            setSent(false)
            setBody(event.target.value)
          }}
          onKeyDown={(event) => {
            // #229：Cmd/Ctrl+Enter 直发（与提交按钮同一条 form 路径）；纯 Enter 仍是换行。
            if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
              event.preventDefault()
              event.currentTarget.form?.requestSubmit()
            }
          }}
        />
        {artifactIds.length > 0 ? (
          <ul className="comment-file-references" aria-label="引用的文件">
            {artifactIds.map((id, index) => {
              const title = selectedFiles[index]?.title ?? '不可用的文件'
              return (
                <li key={id}>
                  <span>{title}</span>
                  <button
                    type="button"
                    className="button button-quiet"
                    aria-label={`移除引用：${title}`}
                    onClick={() => removeFile(id)}
                  >
                    移除
                  </button>
                </li>
              )
            })}
          </ul>
        ) : null}
        {missingFile ? <p role="status">有文件已不可用，请移除这条引用后再发送。</p> : null}
        {outgoing.length > 10_000 ? (
          <p role="status">留言太长，请删减文字或引用后再发送。</p>
        ) : null}
      </DiscussionComposer>
      {sent ? (
        <p className="composer-feedback" role="status" data-testid="comment-sent-status">
          已发给团队
        </p>
      ) : null}
      {error !== null && draft.pending !== null ? <ErrorBanner error={error} /> : null}
    </form>
  )
}
