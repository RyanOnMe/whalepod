/**
 * 交接草稿面板（#379；ADR-0017 §4）：**仅源 Run owner 可见**。
 *
 * - 正常完成的执行由 Runtime 收尾自动生成；失败/取消不自动调用——owner 可手工
 *   新建/编辑（失败恢复）；已有 ready 草稿时编辑走 CAS 并发令牌。
 * - 发布是显式动作：服务端校验（证据必须附引用、材料必须已发布、任务启用约定流程）
 *   失败时原样展示错误，不自动重试。
 * - 发布后不可变；「修改」= 新建草稿（服务端会以最近已发布版本作种子）→ 再发布成
 *   新版本。其他成员与管理员看不到这一节（GET 404 → 本组件整体不渲染）。
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useState, type ReactNode } from 'react'
import { api } from '../../shared/api/client.js'
import { isApiError } from '../../shared/api/errors.js'
import { ErrorBanner } from '../../app/ErrorBanner.js'
import { queryKeys } from '../../app/query-client.js'
import type {
  HandoffDraftView,
  HandoffItem,
  HandoffNarrative,
  HandoffRef,
  HandoffRevisionView,
  Session,
  TaskView,
} from '../../shared/api/types.js'

const SECTIONS: ReadonlyArray<{ key: keyof HandoffNarrative; label: string }> = [
  { key: 'completed', label: '完成项' },
  { key: 'interfaces', label: '接口约定' },
  { key: 'unfinished', label: '未完成项' },
  { key: 'decisions', label: '关键决定' },
  { key: 'evidence', label: '验证证据' },
  { key: 'downstream', label: '下游行动' },
]

/** 引用 token ↔ 结构：`url:https://…` / `commit:abc1234` / `run:<uuid>` / `artifact:<uuid>`。 */
export function serializeRefs(refs: readonly HandoffRef[]): string {
  return refs
    .map((ref) => {
      switch (ref.kind) {
        case 'url':
          return `url:${ref.url}`
        case 'commit':
          return `commit:${ref.sha}`
        case 'run':
          return `run:${ref.runId}`
        case 'artifact':
          return `artifact:${ref.artifactId}`
      }
    })
    .join(' ')
}

export function parseRefs(text: string): { refs: HandoffRef[]; invalid: string[] } {
  const refs: HandoffRef[] = []
  const invalid: string[] = []
  for (const token of text.split(/\s+/).filter((part) => part !== '')) {
    const separator = token.indexOf(':')
    const kind = separator < 0 ? '' : token.slice(0, separator)
    const value = separator < 0 ? '' : token.slice(separator + 1)
    if (value === '') {
      invalid.push(token)
      continue
    }
    if (kind === 'url' && /^https?:\/\/\S+$/.test(value)) refs.push({ kind: 'url', url: value })
    else if (kind === 'commit' && /^[0-9a-fA-F]{4,}$/.test(value))
      refs.push({ kind: 'commit', sha: value })
    else if (kind === 'run' && /^[0-9a-fA-F-]{36}$/.test(value))
      refs.push({ kind: 'run', runId: value })
    else if (kind === 'artifact' && /^[0-9a-fA-F-]{36}$/.test(value))
      refs.push({ kind: 'artifact', artifactId: value })
    else invalid.push(token)
  }
  return { refs, invalid }
}

function emptyItem(): HandoffItem {
  return { text: '', verified: false, refs: [] }
}

export function RunHandoffDraft({
  runId,
  task,
  session,
  runTerminal,
}: {
  runId: string
  task: TaskView
  session: Session
  /** 仅终态 Run 有草稿语义（进行中不查询、不渲染）。 */
  runTerminal: boolean
}): ReactNode {
  const queryClient = useQueryClient()
  const [edit, setEdit] = useState<HandoffNarrative | null>(null)
  const [actionError, setActionError] = useState<unknown>(null)
  // 引用输入的**原始文本**（键 = `section:index`）：受控值若直接取解析后的 refs，
  // 打「commit:a」这种尚未成形的 token 会在每个按键后被重新序列化丢掉——根本打不进字。
  // 原文单独存，解析只发生在 onChange 与「无法识别」提示。
  const [refTexts, setRefTexts] = useState<Record<string, string>>({})
  // 评审 B2：有未保存的修改时**禁止发布**——否则「发布」发的是上一次保存的内容，
  // 用户刚核对的改动在「已发布」提示下悄悄丢掉。所有编辑入口都要置脏。
  const [dirty, setDirty] = useState(false)

  const query = useQuery({
    queryKey: queryKeys.runHandoffDraft(runId),
    queryFn: () => api.get<HandoffDraftView | null>(`/runs/${runId}/handoff-draft`),
    enabled: runTerminal,
    // 私有面：404（非 owner）不是错误，是本组件该不出现。
    retry: false,
  })

  const invalidate = (): void => {
    void queryClient.invalidateQueries({ queryKey: queryKeys.runHandoffDraft(runId) })
  }

  const seedEdit = (draft: HandoffDraftView): void => {
    setEdit(draft.content?.narrative ?? null)
    setRefTexts({})
    setDirty(false)
  }

  const createMutation = useMutation({
    mutationFn: () => api.mutate<HandoffDraftView>(`/runs/${runId}/handoff-draft`),
    onSuccess: (draft) => {
      setActionError(null)
      seedEdit(draft)
      invalidate()
    },
    onError: (error: unknown) => setActionError(error),
  })

  const saveMutation = useMutation({
    mutationFn: (input: { narrative: HandoffNarrative; expectedDraftVersion: number }) =>
      api.update<HandoffDraftView>(`/runs/${runId}/handoff-draft`, {
        body: { narrative: input.narrative, expectedDraftVersion: input.expectedDraftVersion },
      }),
    onSuccess: (draft) => {
      setActionError(null)
      seedEdit(draft)
      invalidate()
    },
    onError: (error: unknown) => {
      setActionError(error)
      if (isApiError(error) && error.code === 'CONFLICT') invalidate()
    },
  })

  const publishMutation = useMutation({
    mutationFn: () => api.mutate<HandoffRevisionView>(`/runs/${runId}/handoff-draft/publish`),
    onSuccess: () => {
      setActionError(null)
      setEdit(null)
      setRefTexts({})
      setDirty(false)
      invalidate()
      void queryClient.invalidateQueries({
        queryKey: ['task-handoff-revisions', task.id],
      })
    },
    onError: (error: unknown) => setActionError(error),
  })

  // 404（不是 owner）/ 终态之外：本组件不出现——不渲染占位、不泄露存在性。
  if (!runTerminal || query.isPending || query.isError) return null
  const draft = query.data

  // 新建后拿到 ready 草稿且还没有编辑副本：以服务端内容为编辑起点。
  const editing = edit ?? draft?.content?.narrative ?? null
  const pending = createMutation.isPending || saveMutation.isPending || publishMutation.isPending

  const renderItemEditor = (
    sectionKey: (typeof SECTIONS)[number]['key'],
    index: number,
    item: HandoffItem,
  ): ReactNode => {
    // 起点是 `editing`（服务端种子或本地副本都算）——若只看 `edit`，草稿刚从服务端
    // 读出来（edit===null）时第一次编辑会被静默丢弃：输入框受控回弹，用户以为打上了。
    const patchItem = (next: HandoffItem): void => {
      if (editing === null) return
      const list = [...(editing[sectionKey] as HandoffItem[])]
      list[index] = next
      setEdit({ ...editing, [sectionKey]: list })
      setDirty(true)
    }
    const refKey = `${sectionKey}:${index}`
    const refText = refTexts[refKey] ?? serializeRefs(item.refs)
    const { invalid } = parseRefs(refText)
    return (
      <li key={refKey} className="handoff-item" data-testid={`handoff-item-${sectionKey}-${index}`}>
        <input
          className="input"
          value={item.text}
          placeholder="这条要说什么（≤200 字）"
          aria-label={`${SECTIONS.find((s) => s.key === sectionKey)?.label}第 ${index + 1} 条`}
          onChange={(event) => patchItem({ ...item, text: event.target.value })}
        />
        <label className="handoff-verified">
          <input
            type="checkbox"
            checked={item.verified}
            aria-label={`已核实第 ${index + 1} 条`}
            onChange={(event) => patchItem({ ...item, verified: event.target.checked })}
          />
          已核实
        </label>
        <input
          className="input handoff-refs"
          value={refText}
          placeholder="引用：url:… commit:… run:… artifact:…"
          aria-label={`引用第 ${index + 1} 条`}
          onChange={(event) => {
            setRefTexts((prev) => ({ ...prev, [refKey]: event.target.value }))
            patchItem({ ...item, refs: parseRefs(event.target.value).refs })
          }}
        />
        {invalid.length > 0 ? (
          <span className="handoff-invalid" role="status">
            无法识别的引用：{invalid.join(' ')}
          </span>
        ) : null}
        <button
          type="button"
          className="button button-quiet"
          disabled={pending}
          onClick={() => {
            if (editing === null) return
            // 删除会移动后续行号（原文键含 index）→ 清掉本节原文，避免张冠李戴。
            setRefTexts((prev) =>
              Object.fromEntries(
                Object.entries(prev).filter(([key]) => !key.startsWith(`${sectionKey}:`)),
              ),
            )
            setEdit({
              ...editing,
              [sectionKey]: (editing[sectionKey] as HandoffItem[]).filter((_, i) => i !== index),
            })
            setDirty(true)
          }}
        >
          删除这条
        </button>
      </li>
    )
  }

  return (
    <section className="card handoff-draft" data-testid="handoff-draft" aria-label="交接草稿">
      <div className="room-column-head">
        <h2>交接草稿</h2>
        <span className="room-column-note">
          仅你可见 · 模型整理的内容默认「待核实」，核对后再发布
        </span>
      </div>

      {actionError !== null ? <ErrorBanner error={actionError} /> : null}

      {draft === null ? (
        <p className="mutation-hint" data-testid="handoff-draft-none">
          {task.agreementEnabled
            ? '尚未生成：正常完成的执行会自动整理一份草稿（额外一次模型调用，最多等待 60 秒）；失败或取消不会自动调用。'
            : '任务未启用约定流程：不自动生成交接草稿。'}
        </p>
      ) : null}

      {draft?.status === 'failed' ? (
        <p className="mutation-hint" data-testid="handoff-draft-failed">
          交接草稿未生成（{draft.failureReason ?? '未知原因'}
          ）。业务执行结果不受影响；可手工新建草稿。
        </p>
      ) : null}

      {draft?.status === 'published' ? (
        <p className="mutation-hint" data-testid="handoff-draft-published">
          已发布（不可变版本）。修改请新建草稿——会以上一版内容为起点，发布后成为新版本。
        </p>
      ) : null}

      {draft !== null && draft.status !== 'published' && editing === null ? (
        <p className="mutation-hint">正在读取草稿内容…</p>
      ) : null}

      {editing !== null && draft?.status === 'ready' ? (
        <div className="handoff-editor" data-testid="handoff-editor">
          {SECTIONS.map((section) => (
            <div key={section.key} className="handoff-section">
              <h3>{section.label}</h3>
              <ul className="handoff-list">
                {(editing[section.key] as HandoffItem[]).map((item, index) =>
                  renderItemEditor(section.key, index, item),
                )}
              </ul>
              <button
                type="button"
                className="button button-quiet"
                disabled={pending}
                onClick={() => {
                  setEdit({
                    ...editing,
                    [section.key]: [...(editing[section.key] as HandoffItem[]), emptyItem()],
                  })
                  setDirty(true)
                }}
              >
                添加一条
              </button>
            </div>
          ))}
          <div className="handoff-section">
            <h3>提交引用</h3>
            <label className="handoff-field">
              <span>commit（每行一个 sha）</span>
              <textarea
                className="input"
                rows={2}
                aria-label="提交引用 commit"
                value={editing.commits.join('\n')}
                onChange={(event) => {
                  setEdit({
                    ...editing,
                    commits: event.target.value
                      .split('\n')
                      .map((s) => s.trim())
                      .filter((s) => s !== ''),
                  })
                  setDirty(true)
                }}
              />
            </label>
            <label className="handoff-field">
              <span>PR / 链接（每行一个 URL）</span>
              <textarea
                className="input"
                rows={2}
                aria-label="提交引用 PR"
                value={editing.prs.join('\n')}
                onChange={(event) => {
                  setEdit({
                    ...editing,
                    prs: event.target.value
                      .split('\n')
                      .map((s) => s.trim())
                      .filter((s) => s !== ''),
                  })
                  setDirty(true)
                }}
              />
            </label>
          </div>
          <div className="agreement-actions">
            <button
              type="button"
              className="button"
              disabled={pending}
              onClick={() =>
                saveMutation.mutate({
                  narrative: editing,
                  expectedDraftVersion: draft.draftVersion,
                })
              }
            >
              保存草稿
            </button>
            <button
              type="button"
              className="button button-primary"
              disabled={pending || dirty}
              onClick={() => publishMutation.mutate()}
              title={
                dirty
                  ? '有未保存的修改——先「保存草稿」再发布'
                  : '发布后不可修改；材料引用必须已发布、验证证据必须附引用'
              }
            >
              发布交接包
            </button>
            {dirty ? (
              <span className="mutation-hint" data-testid="handoff-dirty">
                有未保存的修改：发布的是上一次保存的内容，请先保存。
              </span>
            ) : null}
            <button
              type="button"
              className="button"
              disabled={pending}
              onClick={() => {
                setEdit(null)
                setRefTexts({})
              }}
            >
              放弃编辑（保留已保存内容）
            </button>
            {pending ? <span className="mutation-hint">正在提交…</span> : null}
          </div>
        </div>
      ) : null}

      {/* 手工新建的入口覆盖「没有草稿」（自动生成未发生/未落库）与 failed/published 三类；
          只有 ready 不出现（那正该编辑）。少了 draft===null 这一支，没草稿时用户只剩解释文字。 */}
      {draft === null || draft.status !== 'ready' ? (
        <div className="agreement-actions">
          <button
            type="button"
            className="button"
            disabled={pending || !task.agreementEnabled}
            onClick={() => createMutation.mutate()}
            title={
              task.agreementEnabled
                ? '手工新建草稿（已发布时以上一版为起点）'
                : '任务未启用约定流程，交接包无法发布'
            }
          >
            {draft?.status === 'published' ? '基于此版本新建草稿' : '手工新建草稿'}
          </button>
        </div>
      ) : null}
    </section>
  )
}
