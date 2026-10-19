import { useEffect, type ReactNode } from 'react'
import { useQuery } from '@tanstack/react-query'
import { HandoffRevisionViewSchema } from '@whalepod/protocol'
import { api } from '../../shared/api/client.js'
import { ErrorBanner } from '../../app/ErrorBanner.js'

/** 读取指定不可变版本；接收确认绝不借用最新版本或 owner 的私有草稿。 */
export function HandoffPublishedContent({
  revisionId,
  onReady,
}: {
  revisionId: string
  onReady?: (ready: boolean) => void
}): ReactNode {
  const query = useQuery({
    queryKey: ['handoff-published-content', revisionId],
    queryFn: async () => {
      const value = HandoffRevisionViewSchema.parse(
        await api.get(`/handoff-revisions/${revisionId}`),
      )
      if (value.id !== revisionId) throw new Error('交接版本不匹配，请重新读取')
      return value
    },
    retry: false,
  })
  useEffect(() => {
    onReady?.(query.isSuccess)
  }, [onReady, query.isSuccess, revisionId])
  if (query.isPending) return <p role="status">正在读取固定版本交接正文…</p>
  if (query.isError)
    return (
      <div role="alert">
        <ErrorBanner error={query.error} />
        <button type="button" className="button" onClick={() => void query.refetch()}>
          重试交接正文
        </button>
      </div>
    )
  const { content, revisionNumber } = query.data
  const sections = [
    ['completed', '完成项'],
    ['interfaces', '接口约定'],
    ['unfinished', '未完成项'],
    ['decisions', '关键决定'],
    ['evidence', '验证证据'],
    ['downstream', '下游行动'],
  ] as const
  return (
    <div data-testid="handoff-published-content">
      <p>已发布交接正文 · v{revisionNumber}</p>
      {sections.map(([key, title]) => (
        <div key={key}>
          <strong>{title}</strong>
          {content.narrative[key].length === 0 ? (
            <p>未提供</p>
          ) : (
            <ul>
              {content.narrative[key].map((item, index) => (
                <li key={index}>
                  <span>{item.text}</span> <span>{item.verified ? '发布者已核实' : '待核实'}</span>
                  {item.refs.map((ref, i) => (
                    <p key={i}>
                      {ref.kind === 'artifact' ? (
                        <a href={`/api/v1/artifacts/${ref.artifactId}/content`}>查看引用材料</a>
                      ) : ref.kind === 'run' ? (
                        `执行引用：${ref.runId}`
                      ) : ref.kind === 'commit' ? (
                        `提交：${ref.sha}`
                      ) : (
                        ref.url
                      )}
                    </p>
                  ))}
                </li>
              ))}
            </ul>
          )}
        </div>
      ))}
      <p>提交：{content.narrative.commits.join('、') || '未提供'}</p>
      <p>PR：{content.narrative.prs.join('、') || '未提供'}</p>
      <ul>
        {content.system.artifacts.map((item) => (
          <li key={item.artifactId}>
            <a href={`/api/v1/artifacts/${item.artifactId}/content`}>{item.title}</a>{' '}
            <code>{item.sha256}</code>
          </li>
        ))}
      </ul>
    </div>
  )
}
