import { DiscussionMessage, DiscussionComposer } from '../../vendor/collectui/collectui.js'
/**
 * 中间区域：Comment 时间线 + 留言输入（02 Task 7 Step 4）。
 * 提交后精确失效 task-room 查询；失败时保留输入内容并显示 requestId。
 */
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react'
import { api } from '../../shared/api/client.js'
import { ErrorBanner } from '../../app/ErrorBanner.js'
import { RelativeTime } from '../../shared/RelativeTime.js'
import { useMemberDirectory } from '../team/memberDirectory.js'
import type { CommentView, Session, TaskRoomRun } from '../../shared/api/types.js'
import { SelectMenu } from '../../shared/SelectMenu.js'
import { formatRunReference, parseRunReferences } from './runReference.js'
import { useTeamMessageDraft } from './execution-drafts.js'
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
            <DiscussionMessage
              author={isMine ? '你' : directory.personOf(comment.authorUserId)}
              time={<RelativeTime iso={comment.createdAt} />}
            >
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
  /** 本任务的运行列表（团队可见投影）：引用只能指向本任务的运行，所以按钮里列的就是它。 */
  runs?: readonly TaskRoomRun[]
  /** 运行短号 → 展示名（「第 N 次运行」）；由页面注入，避免这里重新发明编号规则。 */
  runLabels?: ReadonlyMap<string, string>
  /**
   * #250 外部注入的引用 token（「对这个工件继续说」）：页面把来源运行的引用文本从
   * 交付物区递进来，这里追加到正文尾部并聚焦。`nonce` 每次注入都变——同一 token
   * 连点两次也要落两次账。消费后回调页面清状态，避免重渲染时重复追加。
   */
  insertToken?: { text: string; nonce: number } | null
  onInsertTokenConsumed?: () => void
}

export function CommentComposer({
  taskId,
  userId = null,
  runs = [],
  runLabels = new Map<string, string>(),
  insertToken = null,
  onInsertTokenConsumed,
}: CommentComposerProps): ReactNode {
  const queryClient = useQueryClient()
  const {
    draft,
    update: updateDraft,
    clearIfPending,
    isPending,
  } = useTeamMessageDraft(taskId, userId)
  const body = draft.body
  const [error, setError] = useState<unknown>(null)
  // #548：成功只表示「已发给团队」，不宣称助手已读或采用。
  const [sent, setSent] = useState(false)
  const textareaRef = useRef<HTMLTextAreaElement>(null)

  /** 任何编辑都意味着这是一份新的留言：旧幂等键不能再拿去重试。 */
  const setBody = (change: string | ((current: string) => string)): void => {
    setSent(false)
    updateDraft((old) => ({
      body: typeof change === 'function' ? change(old.body) : change,
      pending: null,
    }))
  }

  // 任务参数变化时路由可能复用同一组件实例：上一条任务的「已发给团队」与错误不能
  // 挂到新任务的输入框上。草稿本身按 taskId 存在 store 里，不需要搬。
  useEffect(() => {
    setSent(false)
    setError(null)
  }, [taskId])

  useEffect(() => {
    if (insertToken === null) return
    // 追加而非覆盖：用户可能已经打了半句话（#250 从交付物区点进来时正文通常为空，
    // 但不假设）。分隔恒用空格——窄解析对紧邻 token 的边界有断言（runReference.ts）。
    setBody((current) => (current === '' ? insertToken.text : `${current} ${insertToken.text}`))
    textareaRef.current?.focus()
    onInsertTokenConsumed?.()
  }, [insertToken, onInsertTokenConsumed])

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
    const text = body.trim()
    if (text === '' || mutation.isPending) return
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
            disabled={mutation.isPending || body.trim() === ''}
          >
            {mutation.isPending ? '发送中…' : '发给团队'}
          </button>
        }
        controls={
          <>
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
          </>
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
