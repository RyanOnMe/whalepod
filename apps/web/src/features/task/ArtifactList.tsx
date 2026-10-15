/**
 * 右侧区域：交付物列表 + 复核插槽（02 Task 7 Step 4；P1-15 接线）。
 *
 * 可见性与动作（03 §2.6/§4，Hub 已按受众裁剪）：
 * - published：全员可见，带「下载」（GET /artifacts/:id/content，Session Cookie
 *   受控接口；文件名只取标题的安全子集，不暴露任何本地路径）。
 * - candidate：Hub 仅向 owner 下发（G6-01），owner 见「发布」按钮
 *   （POST /artifacts/:id/publish，成功后刷新 Task Room）。
 * - 内容摘要 sha256 随行展示：Reviewer 输入按它固定内容（G6-07/G6-08）。
 * 区段标题用中文「交付物 / 复核」（#152）；Builder/Reviewer 是 Agent 的名字
 * （01 §42），作为专名保留英文。
 */
import { useQueryClient } from '@tanstack/react-query'
import { useState, type ReactNode } from 'react'
import { api } from '../../shared/api/client.js'
import { queryKeys } from '../../app/query-client.js'
import { pushToast } from '../../app/toast.js'
import { ConfirmDialog } from '../../shared/ConfirmDialog.js'
import { RelativeTime } from '../../shared/RelativeTime.js'
import { formatBytes, shortId } from '../../shared/format.js'
import { RUN_NOT_IN_TIMELINE_LABEL, runOrdinalLabels } from './runLabels.js'
import { isTextPreviewable, truncatePreview } from './artifactPreview.js'
import type { Session } from '../../shared/api/types.js'
import type { TaskRoomArtifact, TaskRoomRun } from '../../shared/api/types.js'

export interface ArtifactListProps {
  artifacts: TaskRoomArtifact[]
  /** 当前会话；candidate 行的发布按钮只对 artifact owner 显示。 */
  session: Session | null
  taskId: string
  /**
   * 本任务的运行记录（#162）：只用来把 `artifact.runId` 翻译成人话
   * （「第 N 次运行」，与时间线行同款，可对照）。id 本身仍留在 `title` 上。
   */
  runs: TaskRoomRun[]
  /**
   * #250「对这个工件继续说」：把来源运行的引用 token 注入讨论输入框（#216 同一套
   * 窄解析语法，渲染端零改动）。由页面注入——组件不管输入框在哪。
   */
  onReferenceRun?: (runId: string) => void
  onRequestReview?: (artifactId: string) => void
}

/** 下载文件名：标题里的路径分隔与控制字符折叠成「-」，回退用 artifact 短 id。 */
function safeFileName(artifact: TaskRoomArtifact): string {
  const base = artifact.title
    .replace(/[^\w.\-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60)
  return base === '' ? `artifact-${shortId(artifact.id)}` : base
}

export function ArtifactList({
  artifacts,
  session,
  taskId,
  runs,
  onReferenceRun,
  onRequestReview,
}: ArtifactListProps): ReactNode {
  const published = artifacts.filter((a) => a.status === 'published')
  // 候选行的可见性以会话为准（Hub 只给 owner 下发 candidate；此处仍按 owner 过滤，
  // 防御未来服务端形状变化时把他人候选渲染出来）。
  const candidates = artifacts.filter(
    (a) => a.status === 'candidate' && session !== null && a.ownerUserId === session.userId,
  )
  const runLabels = runOrdinalLabels(runs)
  return (
    <div>
      <ArtifactRows
        artifacts={published}
        session={session}
        taskId={taskId}
        runLabels={runLabels}
        onReferenceRun={onReferenceRun}
        onRequestReview={onRequestReview}
      />
      <CandidateRows artifacts={candidates} taskId={taskId} runLabels={runLabels} />
      {published.length === 0 && candidates.length === 0 ? (
        <p className="empty-state">
          还没有已发布的 Artifact。Run 产出经发布后，交付物会出现在这里。
        </p>
      ) : null}
      {published.length > 0 ? (
        <p className="artifact-reviewer-note">
          已发布交付物可选为 Reviewer Run
          的只读输入；本次身份与内容摘要在启动时固定，后续发布不改变旧输入。
        </p>
      ) : null}
    </div>
  )
}

/**
 * 「来源运行」格（#162）：此前这一格直接印 `shortId(artifact.runId)`。现在写
 * 「第 N 次运行」——与中间 Run 时间线的行标签同款，人可以对照着找回去；那个 Run
 * 不在本任务运行记录里（理论不该发生）时说人话，不回落到 id。
 */
function SourceRunCell({
  artifact,
  runLabels,
}: {
  artifact: TaskRoomArtifact
  runLabels: ReadonlyMap<string, string>
}): ReactNode {
  return (
    <div>
      <dt>来源运行</dt>
      <dd title={artifact.runId}>{runLabels.get(artifact.runId) ?? RUN_NOT_IN_TIMELINE_LABEL}</dd>
    </div>
  )
}

function ArtifactRows({
  artifacts,
  runLabels,
  onReferenceRun,
  onRequestReview,
}: {
  artifacts: TaskRoomArtifact[]
  session: Session | null
  taskId: string
  runLabels: ReadonlyMap<string, string>
  onReferenceRun?: ((runId: string) => void) | undefined
  onRequestReview?: ((artifactId: string) => void) | undefined
}): ReactNode {
  if (artifacts.length === 0) return null
  return (
    <ul className="artifact-list" role="list">
      {artifacts.map((artifact) => (
        <li key={artifact.id} className="artifact-item">
          <div className="artifact-title">{artifact.title}</div>
          <dl className="artifact-meta">
            <div>
              <dt>类型</dt>
              <dd>{artifact.mediaType}</dd>
            </div>
            <div>
              <dt>大小</dt>
              <dd>{formatBytes(artifact.byteSize)}</dd>
            </div>
            <SourceRunCell artifact={artifact} runLabels={runLabels} />
            <div>
              <dt>发布时间</dt>
              <dd>
                <RelativeTime iso={artifact.publishedAt} />
              </dd>
            </div>
            <div>
              <dt>内容摘要</dt>
              <dd>{artifact.sha256.slice(0, 12)}</dd>
            </div>
          </dl>
          <div className="artifact-actions">
            {onRequestReview === undefined ? null : (
              <button type="button" className="button" onClick={() => onRequestReview(artifact.id)}>
                发起复核
              </button>
            )}
            <ArtifactPreview artifact={artifact} />
            <ArtifactDownload artifact={artifact} />
            {/* #250：指着这个工件说话——注入来源运行的引用 token（#216 窄解析），
                落点是讨论输入框（人对人）；驱动 Agent 仍由用户自己去执行栏说。 */}
            {onReferenceRun === undefined ? null : (
              <button
                type="button"
                className="button button-quiet"
                data-testid="artifact-reference-button"
                onClick={() => onReferenceRun(artifact.runId)}
              >
                对这个工件继续说
              </button>
            )}
          </div>
        </li>
      ))}
    </ul>
  )
}

/** 同一受控内容接口：发布前的拥有者与发布后的团队共用下载路径。 */
function ArtifactDownload({ artifact }: { artifact: TaskRoomArtifact }): ReactNode {
  const [busy, setBusy] = useState(false)
  async function download(): Promise<void> {
    if (busy) return
    setBusy(true)
    try {
      const response = await fetch(`/api/v1/artifacts/${artifact.id}/content`, {
        credentials: 'include',
      })
      if (!response.ok) throw new Error('content unavailable')
      const url = URL.createObjectURL(await response.blob())
      try {
        const anchor = document.createElement('a')
        anchor.href = url
        anchor.download = safeFileName(artifact)
        anchor.click()
      } finally {
        URL.revokeObjectURL(url)
      }
    } catch {
      pushToast(`下载失败（${artifact.title}），请稍后重试。`)
    } finally {
      setBusy(false)
    }
  }
  return (
    <button
      type="button"
      className="button"
      data-testid="artifact-download-button"
      disabled={busy}
      onClick={() => void download()}
    >
      {busy ? '下载中…' : '下载'}
    </button>
  )
}

/**
 * #250 文本预览：能预览的（`isTextPreviewable`）才画按钮；点击走同一个受控下载接口
 * 取文本，页内 `<pre>` 展示（64KiB 截断）。加载/失败/截断三态诚实呈现，失败不吞下载。
 */
function ArtifactPreview({ artifact }: { artifact: TaskRoomArtifact }): ReactNode {
  const [state, setState] = useState<
    | { kind: 'idle' }
    | { kind: 'loading' }
    | { kind: 'error' }
    | { kind: 'shown'; text: string; truncated: boolean }
  >({ kind: 'idle' })

  if (!isTextPreviewable(artifact.mediaType, artifact.byteSize)) return null

  async function load(): Promise<void> {
    setState({ kind: 'loading' })
    try {
      const response = await fetch(`/api/v1/artifacts/${artifact.id}/content`, {
        credentials: 'include',
      })
      if (!response.ok) {
        setState({ kind: 'error' })
        return
      }
      setState({ kind: 'shown', ...truncatePreview(await response.text()) })
    } catch {
      setState({ kind: 'error' })
    }
  }

  return (
    <>
      <button
        type="button"
        className="button"
        data-testid="artifact-preview-button"
        disabled={state.kind === 'loading'}
        onClick={() => void load()}
      >
        {state.kind === 'loading' ? '加载中…' : '预览'}
      </button>
      {state.kind === 'error' ? (
        <p className="mutation-hint" data-testid="artifact-preview-error" role="alert">
          预览加载失败，可下载后查看。
        </p>
      ) : null}
      {state.kind === 'shown' ? (
        <div className="artifact-preview">
          <pre data-testid="artifact-preview">{state.text}</pre>
          {state.truncated ? <p className="mutation-hint">内容已截断，完整内容请下载。</p> : null}
        </div>
      ) : null}
    </>
  )
}

function CandidateRows({
  artifacts,
  taskId,
  runLabels,
}: {
  artifacts: TaskRoomArtifact[]
  taskId: string
  runLabels: ReadonlyMap<string, string>
}): ReactNode {
  const queryClient = useQueryClient()
  const [busyId, setBusyId] = useState<string | undefined>(undefined)
  const [confirming, setConfirming] = useState<TaskRoomArtifact | null>(null)
  const [error, setError] = useState<string | undefined>(undefined)

  async function publish(artifact: TaskRoomArtifact): Promise<void> {
    if (busyId !== undefined) return
    setConfirming(null)
    setBusyId(artifact.id)
    setError(undefined)
    try {
      await api.mutate(`/artifacts/${artifact.id}/publish`)
      await queryClient.invalidateQueries({ queryKey: queryKeys.taskRoom(taskId) })
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '发布失败，请稍后重试。')
    } finally {
      setBusyId(undefined)
    }
  }

  if (artifacts.length === 0) return null
  return (
    <ul className="artifact-list" role="list" aria-label="候选交付物">
      {artifacts.map((artifact) => (
        <li key={artifact.id} className="artifact-item">
          <div className="artifact-title">{artifact.title}</div>
          <p className="mutation-hint">仅你可见，待发布</p>
          <dl className="artifact-meta">
            <div>
              <dt>类型</dt>
              <dd>{artifact.mediaType}</dd>
            </div>
            <div>
              <dt>大小</dt>
              <dd>{formatBytes(artifact.byteSize)}</dd>
            </div>
            <SourceRunCell artifact={artifact} runLabels={runLabels} />
            <div>
              <dt>内容摘要</dt>
              <dd>{artifact.sha256.slice(0, 12)}</dd>
            </div>
          </dl>
          {!isTextPreviewable(artifact.mediaType, artifact.byteSize) ? (
            <p className="mutation-hint">暂不支持在线预览，请下载检查。</p>
          ) : null}
          <div className="artifact-actions">
            <ArtifactPreview artifact={artifact} />
            <ArtifactDownload artifact={artifact} />
            <button
              type="button"
              className="button"
              data-testid="artifact-publish-button"
              disabled={busyId !== undefined}
              onClick={() => setConfirming(artifact)}
            >
              发布
            </button>
          </div>
        </li>
      ))}
      {confirming !== null ? (
        <ConfirmDialog
          open
          title="发布给团队？"
          body={`发布「${confirming.title}」（内容摘要 ${confirming.sha256.slice(0, 12)}）后，团队成员可以查看或下载。目前仅你可见。`}
          confirmLabel="确认发布给团队"
          pending={busyId !== undefined}
          onConfirm={() => void publish(confirming)}
          onCancel={() => setConfirming(null)}
        />
      ) : null}
      {error !== undefined ? (
        <p className="mutation-hint" role="alert">
          {error}
        </p>
      ) : null}
    </ul>
  )
}

/** 复核插槽：已发布交付物即 Reviewer Run 的输入面（Reviewer 链由 P1-15 完成）。 */
export function ReviewerSlot(): ReactNode {
  return (
    <section className="snapshot-slot" aria-label="复核">
      <h3>复核</h3>
      <p className="empty-state">
        {
          '从已发布产出选择“发起复核”，在执行区确认材料并选择 Agent，再由你启动。交付物以只读输入清单和受控副本提供；本次执行环境、工具与审批仍按执行设置决定。'
        }
      </p>
    </section>
  )
}
