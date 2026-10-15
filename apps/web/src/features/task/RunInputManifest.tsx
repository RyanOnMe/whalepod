import { useQuery } from '@tanstack/react-query'
import { useState, type ReactNode } from 'react'
import { ArtifactInputManifestSchema } from '@whalepod/protocol'
import { api } from '../../shared/api/client.js'
import { queryKeys } from '../../app/query-client.js'
import { ErrorBanner } from '../../app/ErrorBanner.js'
import { formatBytes } from '../../shared/format.js'

export function RunInputManifest({
  runId,
  taskId,
  runLabels,
}: {
  runId: string
  taskId: string
  runLabels: ReadonlyMap<string, string>
}): ReactNode {
  const [open, setOpen] = useState(false)
  const query = useQuery({
    queryKey: queryKeys.runInputManifest(runId),
    enabled: open,
    queryFn: async () => {
      const data = ArtifactInputManifestSchema.nullable().parse(
        await api.get(`/runs/${runId}/input-manifest`),
      )
      if (data !== null && data.taskId !== taskId) throw new Error('输入记录与本任务不一致，请重试')
      return data
    },
  })
  return (
    <section className="run-input-manifest" aria-label="本次固定输入">
      <button
        type="button"
        className="button button-quiet"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        {open ? '收起本次固定输入' : '查看本次固定输入'}
      </button>
      {open ? (
        <div data-testid="run-input-manifest">
          {query.isPending ? <p role="status">正在读取本次输入…</p> : null}
          {query.isError ? (
            <>
              <ErrorBanner error={query.error} />
              <button type="button" className="button" onClick={() => void query.refetch()}>
                重新读取输入
              </button>
            </>
          ) : null}
          {query.isSuccess && query.data === null ? (
            <p>历史输入无法确认，不能用当前材料列表代替。请明确选择材料后开始新执行。</p>
          ) : null}
          {query.isSuccess && query.data !== null ? (
            <>
              <p className="mutation-hint">
                这是本次执行创建时固定的材料；后续发布不会改变此清单。续跑仍可能保留旧会话上下文。
              </p>
              {query.data.artifacts.length === 0 ? (
                <p>本次未选择交付物输入。</p>
              ) : (
                <ul>
                  {query.data.artifacts.map((item) => (
                    <li key={item.artifactId}>
                      <strong>{item.title}</strong> · {formatBytes(item.byteSize)} · 内容摘要{' '}
                      {item.sha256.slice(0, 12)}
                      <p>
                        来源：{runLabels.get(item.runId) ?? '本任务历史执行'} · 交付物身份{' '}
                        <code>{item.artifactId}</code>
                      </p>
                    </li>
                  ))}
                </ul>
              )}
            </>
          ) : null}
        </div>
      ) : null}
    </section>
  )
}
