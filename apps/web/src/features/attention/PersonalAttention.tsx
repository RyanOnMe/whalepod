import { useQuery } from '@tanstack/react-query'
import { AttentionViewSchema, type AttentionItem } from '@whalepod/protocol'
import { Link } from 'react-router'
import type { ReactNode } from 'react'
import { HelpDisclosure } from '../../shared/HelpDisclosure.js'
import { api } from '../../shared/api/client.js'
import { useSession } from '../../app/session.js'
import { queryKeys } from '../../app/query-client.js'
import { ErrorBanner } from '../../app/ErrorBanner.js'

const LABELS: Record<AttentionItem['kind'], string> = {
  accept_assignment: '接受任务',
  reassign_task: '重新指派',
  decide_approval: '处理审批',
  inspect_candidate: '检查候选',
  complete_task: '确认完成',
}
function destination(item: AttentionItem): string {
  const anchor =
    item.kind === 'decide_approval'
      ? `approval-${item.objectId}`
      : item.kind === 'inspect_candidate'
        ? `artifact-${item.objectId}`
        : item.kind === 'complete_task'
          ? 'task-actions'
          : 'task-assignment'
  return `/tasks/${item.taskId}#${anchor}`
}
/** A small existing-homepage experiment; only the server's actionable identities. */
export function PersonalAttention(): ReactNode {
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
  return (
    <section
      className="card personal-attention"
      aria-labelledby="attention-heading"
      aria-busy={query.isFetching}
    >
      <div className="attention-head">
        <h2 id="attention-heading">需要我处理</h2>
        <button
          type="button"
          className="button button-quiet"
          disabled={query.isPending}
          onClick={() => void query.refetch()}
        >
          刷新待办
        </button>
      </div>
      <HelpDisclosure label="待办说明">
        <p>接受、审批、改派、候选检查与验收事项会出现在这里。请进入任务处理。</p>
      </HelpDisclosure>
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
          {query.data.items.length === 0 ? (
            <p>暂无待办。</p>
          ) : (
            <ul className="attention-list">
              {query.data.items.map((item) => (
                <li key={`${item.kind}:${item.objectId}`}>
                  <Link to={destination(item)}>
                    {LABELS[item.kind]} · {item.taskTitle}
                  </Link>
                  <span className="mutation-hint">{item.projectName}</span>
                </li>
              ))}
            </ul>
          )}
          {query.data.hasMore ? (
            <p className="mutation-hint">当前显示前12项；处理后将补上后续事项。</p>
          ) : null}
        </>
      )}
    </section>
  )
}
