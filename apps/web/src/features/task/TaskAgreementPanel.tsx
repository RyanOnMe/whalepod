/**
 * 任务约定面板（#378；ADR-0017 §1）：执行前的**共同依据**——目标/约束/验收条件/待确认问题。
 *
 * 语义（与 Hub 命令层一致，前端不是安全边界）：
 * - 草稿（draft）**不构成要求**：任何成员都可起草；编辑携带 `draftVersion` 并发令牌，
 *   服务端 409 时本组件如实提示并重取（不覆盖他人版本，也不静默重试）。
 * - 确认（confirm）**仅 Task 真人责任人**：确认看过的这一版 → 不可变版本 vN；确认后
 *   该 Task 的业务 Run 必须绑定已确认版本（服务端收口）。
 * - 开关（agreementEnabled）：责任人开启（前提已有已确认版本）/ 可关闭。
 * - 版本历史只增不改：修改产生新草稿、新版本；已确认版本不原地覆盖。
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { api } from '../../shared/api/client.js'
import { isApiError } from '../../shared/api/errors.js'
import { ErrorBanner } from '../../app/ErrorBanner.js'
import { queryKeys } from '../../app/query-client.js'
import { RelativeTime } from '../../shared/RelativeTime.js'
import { useMemberDirectory } from '../team/memberDirectory.js'
import type {
  Session,
  TaskAgreementView,
  TaskSpecContent,
  TaskSpecRevisionView,
  TaskView,
} from '../../shared/api/types.js'

const EMPTY_CONTENT: TaskSpecContent = {
  goal: '',
  constraints: '',
  acceptance: '',
  openQuestions: '',
}

export const AGREEMENT_SECTIONS: ReadonlyArray<{
  key: keyof TaskSpecContent
  label: string
  hint: string
}> = [
  { key: 'goal', label: '目标', hint: '这次要达成的结果（必填才能确认）' },
  { key: 'constraints', label: '约束', hint: '必须遵守的边界（技术、时间、范围）' },
  { key: 'acceptance', label: '验收条件', hint: '怎样算完成，尽量可检验' },
  { key: 'openQuestions', label: '待确认问题', hint: '还没定的点，执行中留意' },
]

function RevisionContent({ content }: { content: TaskSpecContent }): ReactNode {
  return (
    <dl className="agreement-content">
      {AGREEMENT_SECTIONS.map((section) => (
        <div key={section.key} className="agreement-content-row">
          <dt>{section.label}</dt>
          <dd>
            {content[section.key].trim() === '' ? (
              <span className="agreement-empty">（未填写）</span>
            ) : (
              <span className="agreement-text">{content[section.key]}</span>
            )}
          </dd>
        </div>
      ))}
    </dl>
  )
}

function revisionLabel(revision: TaskSpecRevisionView): string {
  return revision.status === 'draft'
    ? `草稿第 ${revision.draftVersion} 稿`
    : `v${revision.revisionNumber}`
}

/**
 * 草稿编辑器。`seed` 决定初始内容与并发令牌：
 * - `{ kind: 'draft', revision }`：续编现有草稿（带 draftVersion）；
 * - `{ kind: 'confirmed', revision }`：从已确认版本派生新草稿（无令牌 = 新建）；
 * - `{ kind: 'empty' }`：从空白开始（无令牌 = 新建）。
 */
export type AgreementEditorSeed =
  | { kind: 'draft'; revision: TaskSpecRevisionView }
  | { kind: 'confirmed'; revision: TaskSpecRevisionView }
  | { kind: 'empty' }

export function TaskAgreementPanel({
  task,
  session,
}: {
  task: TaskView
  session: Session | null
}): ReactNode {
  const queryClient = useQueryClient()
  const directory = useMemberDirectory()
  const [editor, setEditor] = useState<AgreementEditorSeed | null>(null)
  const [actionError, setActionError] = useState<unknown>(null)
  const isAssignee = session !== null && session.userId === task.assigneeUserId

  const query = useQuery({
    queryKey: queryKeys.taskAgreement(task.id),
    queryFn: () => api.get<TaskAgreementView>(`/tasks/${task.id}/agreement`),
    enabled: task.id !== '',
  })

  const invalidate = (): void => {
    void queryClient.invalidateQueries({ queryKey: queryKeys.taskAgreement(task.id) })
    void queryClient.invalidateQueries({ queryKey: queryKeys.taskRoom(task.id) })
  }

  const saveMutation = useMutation({
    mutationFn: (input: { content: TaskSpecContent; expectedDraftVersion?: number }) =>
      api.mutate<TaskSpecRevisionView>(`/tasks/${task.id}/agreement/draft`, {
        body: {
          content: input.content,
          ...(input.expectedDraftVersion !== undefined
            ? { expectedDraftVersion: input.expectedDraftVersion }
            : {}),
        },
      }),
    onSuccess: () => {
      setActionError(null)
      setEditor(null)
      invalidate()
    },
    onError: (error: unknown) => {
      setActionError(error)
      // 409 = 草稿状态被他人改变：重取读模型，让用户看到最新版本再决定（不自动重试）。
      if (isApiError(error) && error.code === 'CONFLICT') invalidate()
    },
  })

  const confirmMutation = useMutation({
    mutationFn: (draftVersion: number) =>
      api.mutate<TaskSpecRevisionView>(`/tasks/${task.id}/agreement/confirm`, {
        body: { draftVersion },
      }),
    onSuccess: () => {
      setActionError(null)
      setEditor(null)
      invalidate()
    },
    onError: (error: unknown) => {
      setActionError(error)
      if (isApiError(error) && error.code === 'CONFLICT') invalidate()
    },
  })

  const discardMutation = useMutation({
    mutationFn: () => api.remove<{ discarded: boolean }>(`/tasks/${task.id}/agreement/draft`),
    onSuccess: () => {
      setActionError(null)
      setEditor(null)
      invalidate()
    },
    onError: (error: unknown) => setActionError(error),
  })

  const enableMutation = useMutation({
    mutationFn: (enabled: boolean) =>
      api.update<TaskView>(`/tasks/${task.id}`, { body: { agreementEnabled: enabled } }),
    onSuccess: () => {
      setActionError(null)
      invalidate()
    },
    onError: (error: unknown) => setActionError(error),
  })

  if (query.isPending) {
    return (
      <section className="card agreement-panel" aria-label="任务约定">
        <h2>任务约定</h2>
        <p className="agreement-note">正在读取…</p>
      </section>
    )
  }
  if (query.isError) {
    return (
      <section className="card agreement-panel" aria-label="任务约定">
        <h2>任务约定</h2>
        <ErrorBanner error={query.error} />
      </section>
    )
  }

  const agreement = query.data
  const pending = saveMutation.isPending || confirmMutation.isPending || discardMutation.isPending
  const confirmed = agreement.confirmed
  const draft = agreement.draft

  return (
    <section className="card agreement-panel" aria-label="任务约定" data-testid="agreement-panel">
      <div className="room-column-head">
        <h2>任务约定</h2>
        <span className="room-column-note">执行前的共同依据 · 责任人确认后才是正式要求</span>
      </div>

      <div className="agreement-status" data-testid="agreement-status">
        {agreement.enabled ? (
          <span className="agreement-chip enabled" data-testid="agreement-enabled-chip">
            已启用：本任务的新执行必须绑定已确认版本
          </span>
        ) : (
          <span className="agreement-chip" data-testid="agreement-disabled-chip">
            未启用：普通任务路径（不要求绑定）
          </span>
        )}
        {confirmed !== null ? (
          <span className="agreement-current" data-testid="agreement-current">
            当前正式版本 v{confirmed.revisionNumber}（
            {confirmed.confirmedByUserId === session?.userId
              ? '你'
              : directory.personOf(confirmed.confirmedByUserId ?? confirmed.createdByUserId)}
            确认）
          </span>
        ) : (
          <span className="agreement-current" data-testid="agreement-no-confirmed">
            还没有已确认版本——草稿不计入执行依据
          </span>
        )}
        {isAssignee ? (
          <button
            type="button"
            className="button agreement-toggle"
            disabled={enableMutation.isPending}
            onClick={() => enableMutation.mutate(!agreement.enabled)}
            title={
              agreement.enabled
                ? '停用后新执行不再要求绑定（历史 Run 与已确认版本保留）'
                : '启用后本任务的新执行必须绑定已确认版本（还没有版本时执行会被拒绝并提示）'
            }
          >
            {agreement.enabled ? '停用约定流程' : '启用约定流程'}
          </button>
        ) : null}
      </div>
      {!agreement.enabled && confirmed !== null && !isAssignee ? (
        <p className="agreement-note">约定流程未启用，新执行暂不要求绑定；责任人可随时启用。</p>
      ) : null}
      {!agreement.enabled && confirmed === null ? (
        <p className="agreement-note">
          起草目标、约束与验收条件，由责任人确认第一个版本；启用约定流程后，新执行必须绑定
          已确认版本（尚无版本时会被拒绝并提示）。
        </p>
      ) : null}
      {agreement.enabled && confirmed === null ? (
        <p className="agreement-note" data-testid="agreement-enabled-unconfirmed">
          已启用，但还没有已确认版本：本任务的新执行会被拒绝（先起草并确认第一个版本）。
        </p>
      ) : null}

      {actionError !== null ? <ErrorBanner error={actionError} /> : null}

      {/* 编辑中的草稿 */}
      {editor !== null && session !== null ? (
        <AgreementDraftEditor
          seed={editor}
          pending={pending}
          canConfirm={isAssignee}
          onCancel={() => setEditor(null)}
          onSave={(content) =>
            saveMutation.mutate({
              content,
              ...(editor.kind === 'draft'
                ? { expectedDraftVersion: editor.revision.draftVersion }
                : {}),
            })
          }
          onConfirm={(draftVersion) => confirmMutation.mutate(draftVersion)}
        />
      ) : null}

      {/* 现有草稿（未在编辑时） */}
      {editor === null && draft !== null ? (
        <div className="agreement-draft" data-testid="agreement-draft">
          <div className="agreement-draft-head">
            <strong>{revisionLabel(draft)}（未确认，不构成要求）</strong>
            <span className="agreement-meta">
              {directory.personOf(draft.createdByUserId)} 编辑于{' '}
              <RelativeTime iso={draft.updatedAt} />
            </span>
          </div>
          <RevisionContent content={draft.content} />
          <div className="agreement-actions">
            <button
              type="button"
              className="button"
              disabled={pending}
              onClick={() => setEditor({ kind: 'draft', revision: draft })}
            >
              继续编辑
            </button>
            {isAssignee ? (
              <button
                type="button"
                className="button button-primary"
                disabled={pending || session === null}
                onClick={() => confirmMutation.mutate(draft.draftVersion)}
                title="确认后产生不可变版本；本任务的新执行将绑定它"
              >
                确认这一版（v{(confirmed?.revisionNumber ?? 0) + 1}）
              </button>
            ) : (
              <span className="agreement-note">
                等待责任人{directory.personOf(task.assigneeUserId)}确认
              </span>
            )}
            <button
              type="button"
              className="button"
              disabled={pending}
              onClick={() => discardMutation.mutate()}
            >
              丢弃草稿
            </button>
          </div>
        </div>
      ) : null}

      {/* 无草稿：查看当前版本 + 起草入口 */}
      {editor === null && draft === null ? (
        <div className="agreement-confirmed" data-testid="agreement-confirmed">
          {confirmed !== null ? <RevisionContent content={confirmed.content} /> : null}
          {session !== null ? (
            <div className="agreement-actions">
              <button
                type="button"
                className="button"
                disabled={pending}
                onClick={() =>
                  setEditor(
                    confirmed === null
                      ? { kind: 'empty' }
                      : { kind: 'confirmed', revision: confirmed },
                  )
                }
                title={
                  confirmed === null
                    ? '起草任务约定的第一个版本'
                    : '基于当前版本修改：保存产生新草稿，确认后成为新版本'
                }
              >
                {confirmed === null ? '起草任务约定' : '修改约定（产生新版本）'}
              </button>
            </div>
          ) : null}
        </div>
      ) : null}

      {agreement.history.length > 0 ? (
        <details className="agreement-history" data-testid="agreement-history">
          <summary>
            版本历史（{agreement.confirmedCount}
            {agreement.confirmedCount > agreement.history.length
              ? `，显示最近 ${agreement.history.length}`
              : ''}
            ）
          </summary>
          <ol>
            {agreement.history.map((revision) => (
              <li key={revision.id} data-testid={`agreement-history-v${revision.revisionNumber}`}>
                <div className="agreement-history-head">
                  <strong>v{revision.revisionNumber}</strong>
                  <span className="agreement-meta">
                    {directory.personOf(revision.confirmedByUserId ?? revision.createdByUserId)}
                    {' 于 '}
                    <RelativeTime iso={revision.confirmedAt ?? revision.updatedAt} />
                    {revision.id === confirmed?.id ? ' · 当前版本' : ''}
                  </span>
                </div>
                <RevisionContent content={revision.content} />
              </li>
            ))}
          </ol>
        </details>
      ) : null}
    </section>
  )
}

/** 草稿编辑器：四段文本域 + 保存/确认（责任人）。确认按钮直接从编辑态可用（看一眼→确认）。 */
export function AgreementDraftEditor({
  seed,
  pending,
  canConfirm,
  onCancel,
  onSave,
  onConfirm,
}: {
  seed: AgreementEditorSeed
  pending: boolean
  canConfirm: boolean
  onCancel: () => void
  onSave: (content: TaskSpecContent) => void
  onConfirm: (draftVersion: number) => void
}): ReactNode {
  const initial = seed.kind === 'empty' ? EMPTY_CONTENT : seed.revision.content
  const [content, setContent] = useState<TaskSpecContent>(initial)
  const goalRef = useRef<HTMLTextAreaElement>(null)
  useEffect(() => {
    goalRef.current?.focus()
  }, [])
  const dirty = AGREEMENT_SECTIONS.some((s) => content[s.key] !== initial[s.key])
  const goalMissing = content.goal.trim() === ''
  return (
    <form
      className="agreement-editor"
      data-testid="agreement-editor"
      onSubmit={(event) => {
        event.preventDefault()
        onSave(content)
      }}
    >
      {AGREEMENT_SECTIONS.map((section) => (
        <label key={section.key} className="agreement-field">
          <span className="agreement-field-label">
            {section.label}
            <span className="agreement-field-hint">{section.hint}</span>
          </span>
          <textarea
            ref={section.key === 'goal' ? goalRef : undefined}
            className="input agreement-input"
            rows={section.key === 'goal' ? 3 : 2}
            value={content[section.key]}
            aria-label={`任务约定：${section.label}`}
            onChange={(event) =>
              setContent((old) => ({ ...old, [section.key]: event.target.value }))
            }
          />
        </label>
      ))}
      <div className="agreement-actions">
        <button type="submit" className="button button-primary" disabled={pending}>
          {seed.kind === 'draft' ? '保存草稿' : '保存为新草稿'}
        </button>
        {canConfirm && seed.kind === 'draft' && !dirty ? (
          <button
            type="button"
            className="button"
            disabled={pending || goalMissing}
            onClick={() => onConfirm(seed.revision.draftVersion)}
            title={goalMissing ? '目标不能为空' : '确认这一版为不可变版本'}
          >
            保存并确认本稿
          </button>
        ) : null}
        <button type="button" className="button" disabled={pending} onClick={onCancel}>
          取消
        </button>
        {dirty ? <span className="agreement-note">有未保存修改</span> : null}
      </div>
    </form>
  )
}
