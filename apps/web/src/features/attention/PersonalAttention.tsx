import { InboxFrame, InboxRow, EnterItem } from '../../vendor/collectui/collectui.js'
import { useQuery } from '@tanstack/react-query'
import { AttentionViewSchema, type AttentionItem } from '@whalepod/protocol'
import { Link } from 'react-router'
import { useState, type ReactNode } from 'react'
import { HelpDisclosure } from '../../shared/HelpDisclosure.js'
import { api } from '../../shared/api/client.js'
import { useSession } from '../../app/session.js'
import { queryKeys } from '../../app/query-client.js'
import { ErrorBanner } from '../../app/ErrorBanner.js'

const LABELS: Record<AttentionItem['kind'], string> = {
  accept_assignment: '接受任务',
  reassign_task: '重新指派',
  decide_approval: '处理审批',
  confirm_handoff: '确认接收交接',
  submit_review: '提交审阅意见',
  organize_feedback: '处理审阅反馈',
  resolve_comments: '复核修订结果',
  inspect_candidate: '检查候选',
  complete_task: '确认完成',
}
function destination(item: AttentionItem): string {
  // 审阅页是独立路由：待办直达准确版本，而不是先回任务页再找文件卡。
  if (['submit_review', 'organize_feedback', 'resolve_comments'].includes(item.kind)) {
    return `/tasks/${item.taskId}/review/${item.objectId}`
  }
  const anchor =
    item.kind === 'decide_approval'
      ? `approval-${item.objectId}`
      : item.kind === 'inspect_candidate'
        ? `artifact-${item.objectId}`
        : item.kind === 'complete_task'
          ? 'task-actions'
          : item.kind === 'confirm_handoff'
            ? `handoff-receipt-${item.objectId}`
            : 'task-assignment'
  return `/tasks/${item.taskId}#${anchor}`
}
function category(kind: AttentionItem['kind']): 'approval' | 'delivery' | 'assignment' {
  return kind === 'decide_approval'
    ? 'approval'
    : kind === 'inspect_candidate' ||
        kind === 'complete_task' ||
        kind === 'confirm_handoff' ||
        kind === 'submit_review' ||
        kind === 'organize_feedback' ||
        kind === 'resolve_comments'
      ? 'delivery'
      : 'assignment'
}
/** A small existing-homepage experiment; only the server's actionable identities. */
export function PersonalAttention(): ReactNode {
  const [filter, setFilter] = useState<'all' | 'approval' | 'delivery' | 'assignment'>('all')
  const session = useSession()
  const query = useQuery({
    queryKey: queryKeys.attention(session?.userId ?? ''),
    queryFn: async () => AttentionViewSchema.parse(await api.get('/tasks/attention')),
    enabled: session !== null,
    staleTime: 0,
    // Candidate uploads intentionally have no team-wide event. While this page is
    // visible, re-read the viewer-filtered projection; WS/reconnect handles other transitions.
    refetchInterval: 15000,
    refetchIntervalInBackground: false,
    refetchOnWindowFocus: true,
  })
  if (session === null) return null
  const ready =
    !query.isPending && !(query.isFetching && !query.isFetchedAfterMount) && !query.isError
  const items = ready ? query.data.items : []
  const rows = items.filter((item) => filter === 'all' || category(item.kind) === filter)
  return (
    <section
      className="personal-attention page-inbox"
      aria-labelledby="attention-heading"
      aria-busy={query.isFetching}
    >
      <InboxFrame
        title={<h2 id="attention-heading">需要我处理</h2>}
        {...(ready ? { count: `${items.length}${query.data.hasMore ? '+' : ''}` } : {})}
        actions={
          <button
            type="button"
            className="button button-quiet"
            disabled={query.isFetching}
            onClick={() => void query.refetch()}
          >
            刷新待办
          </button>
        }
        filters={
          items.length === 0 ? undefined : (
            <div className="attention-filters" role="group" aria-label="待办筛选">
              {(
                [
                  ['all', '全部'],
                  ['approval', '审批'],
                  ['delivery', '交付'],
                  ['assignment', '指派'],
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
          )
        }
      >
        {query.isPending || (query.isFetching && !query.isFetchedAfterMount) ? (
          <p role="status">正在确认需处理事项…</p>
        ) : query.isError ? (
          <>
            <ErrorBanner error={query.error} />
            <button type="button" className="button" onClick={() => void query.refetch()}>
              重新读取待办
            </button>
          </>
        ) : (
          <>
            {query.isFetching ? <p className="mutation-hint">正在更新待办…</p> : null}
            {rows.length === 0 ? (
              <p>{items.length === 0 ? '暂无待办。' : '此分类暂无待办。'}</p>
            ) : (
              <ul className="attention-list">
                {rows.map((item, index) => (
                  <EnterItem key={`${item.kind}:${item.objectId}`} index={index}>
                    <InboxRow
                      icon={
                        item.kind === 'decide_approval'
                          ? '✓'
                          : item.kind === 'accept_assignment' || item.kind === 'reassign_task'
                            ? '↗'
                            : '▤'
                      }
                      meta={item.projectName}
                    >
                      <Link to={destination(item)}>
                        {LABELS[item.kind]} · {item.taskTitle}
                      </Link>
                    </InboxRow>
                  </EnterItem>
                ))}
              </ul>
            )}
            {query.data.hasMore ? (
              <p className="mutation-hint">当前显示前12项；处理后将补上后续事项。</p>
            ) : null}
          </>
        )}
      </InboxFrame>
      <HelpDisclosure label="待办说明">
        <p>请进入任务处理审批、指派与交付事项。</p>
      </HelpDisclosure>
    </section>
  )
}
