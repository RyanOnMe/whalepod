import { useQuery } from '@tanstack/react-query'
import { ArtifactDeliveryBasisSchema, type ArtifactDeliveryBasis } from '@whalepod/protocol'
import { api } from '../../shared/api/client.js'
import { ErrorBanner } from '../../app/ErrorBanner.js'
import { queryKeys } from '../../app/query-client.js'
import { RUN_STATUS_LABEL } from '../../shared/format.js'

function Materials({
  value,
  handoff = false,
}: {
  value: ArtifactDeliveryBasis['taskInputs']
  handoff?: boolean
}) {
  if (value.status === 'unknown') return <p>历史输入记录未知，不能据此认定没有使用材料。</p>
  if (value.status === 'not_selected') return <p>该次执行未选择上游交接输入。</p>
  return (
    <>
      {!value.complete ? <p role="status">部分固定材料当前不可读取，以下清单不完整。</p> : null}
      {value.artifacts.length === 0 && value.complete ? (
        <p>{handoff ? '已记录的上游交接没有文件材料。' : '该次执行明确未选择本任务交付物。'}</p>
      ) : null}
      <ul>
        {value.artifacts.map((item) => (
          <li key={item.artifactId}>
            <a href={`/api/v1/artifacts/${item.artifactId}/content`}>{item.title}</a>
            <span className="mutation-hint"> · 固定内容摘要 {item.sha256.slice(0, 12)}</span>
          </li>
        ))}
      </ul>
    </>
  )
}

export function DeliveryBasisPanel({ artifactId, taskId }: { artifactId: string; taskId: string }) {
  const query = useQuery({
    // Existing task/run/artifact events invalidate this derived read without a new event type.
    queryKey: [...queryKeys.taskRoom(taskId), 'artifact-delivery-basis', artifactId],
    queryFn: async () => {
      const result = ArtifactDeliveryBasisSchema.parse(
        await api.get(`/artifacts/${artifactId}/delivery-basis`),
      )
      if (result.artifactId !== artifactId || result.taskId !== taskId)
        throw new Error('成果依据与当前文件不匹配')
      return result
    },
    retry: false,
  })
  if (query.isPending)
    return (
      <section className="card" aria-label="成果依据" aria-busy="true">
        <p role="status">正在读取成果依据…</p>
      </section>
    )
  if (query.isError)
    return (
      <section className="card" aria-label="成果依据">
        <ErrorBanner error={query.error} />
        <button type="button" className="button" onClick={() => void query.refetch()}>
          重试读取依据
        </button>
      </section>
    )
  const basis = query.data
  const revision = basis.agreement.revision
  const sections = [
    ['completed', '完成说明'],
    ['interfaces', '接口约定'],
    ['unfinished', '未完成与限制'],
    ['decisions', '关键决定'],
    ['evidence', '验证说明'],
    ['downstream', '后续行动'],
  ] as const
  return (
    <section className="card delivery-basis" aria-label="成果依据" data-testid="delivery-basis">
      <h2>成果依据</h2>
      <p className="mutation-hint">这些是来源记录与已发布说明，不代表成果已通过充分验证。</p>
      {basis.sourceRun === null ? (
        <p>来源执行记录不可取得。</p>
      ) : (
        <p>
          来源执行：<span title={basis.sourceRun.id}>{basis.sourceRun.id.slice(0, 8)}</span>
          {' · '}
          {RUN_STATUS_LABEL[basis.sourceRun.status]}
          {' · '}
          <a href={`/tasks/${taskId}#task-execution`}>查看来源任务的执行记录</a>
          <span title={basis.sourceRun.id}>
            {' '}
            · {new Date(basis.sourceRun.createdAt).toLocaleString()}
          </span>
        </p>
      )}
      <details open>
        <summary>执行时采用的任务约定</summary>
        {revision === null ? (
          <p>
            {basis.agreement.status === 'unbound'
              ? '该次执行未绑定任务约定。'
              : '历史任务约定不可取得，未使用当前版本替代。'}
          </p>
        ) : (
          <>
            <p>本次执行采用第 {revision.revisionNumber} 版</p>
            <dl>
              <dt>目标</dt>
              <dd>{revision.content.goal}</dd>
              <dt>约束</dt>
              <dd>{revision.content.constraints || '未填写'}</dd>
              <dt>验收条件</dt>
              <dd>{revision.content.acceptance || '未填写'}</dd>
              <dt>待确认问题</dt>
              <dd>{revision.content.openQuestions || '未填写'}</dd>
            </dl>
          </>
        )}
      </details>
      <details>
        <summary>执行时固定的材料</summary>
        <h3>本任务交付物输入</h3>
        <Materials value={basis.taskInputs} />
        <h3>上游交接文件输入</h3>
        <Materials value={basis.handoffInputs} handoff />
        <p className="mutation-hint">
          固定清单不等于执行期间没有使用其他材料，也不证明 Agent 正确理解。
        </p>
      </details>
      {basis.handoffs.length === 0 ? (
        <p>尚未找到与这份成果明确对应的已发布交接说明。</p>
      ) : (
        basis.handoffs.map((handoff) => (
          <details key={handoff.id}>
            <summary>对应的最近发布交接说明 · 第 {handoff.revisionNumber} 版</summary>
            <p className="mutation-hint">核实标记由发布者确认；引用存在不等于检查充分。</p>
            {!handoff.referencesComplete ? (
              <p role="status">部分引用当前不可读取，未展示不可见材料的身份。</p>
            ) : null}
            {sections.map(([key, label]) =>
              handoff.narrative[key].length === 0 ? null : (
                <div key={key}>
                  <h3>{label}</h3>
                  <ul>
                    {handoff.narrative[key].map((item, index) => (
                      <li key={index}>
                        <p>
                          {item.text}{' '}
                          <span className="badge">{item.verified ? '发布者已核实' : '待核实'}</span>
                        </p>
                        <ul>
                          {item.refs.map((ref, i) => (
                            <li key={i}>
                              {ref.kind === 'artifact' ? (
                                <a href={`/api/v1/artifacts/${ref.artifactId}/content`}>
                                  查看引用材料
                                </a>
                              ) : ref.kind === 'url' ? (
                                ref.url
                              ) : ref.kind === 'commit' ? (
                                `提交 ${ref.sha}`
                              ) : (
                                '来源执行引用'
                              )}
                            </li>
                          ))}
                        </ul>
                      </li>
                    ))}
                  </ul>
                </div>
              ),
            )}
          </details>
        ))
      )}
    </section>
  )
}
