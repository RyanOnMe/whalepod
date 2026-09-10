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
import { RelativeTime } from '../../shared/RelativeTime.js'
import { formatBytes, shortId } from '../../shared/format.js'
import type { Session } from '../../shared/api/types.js'
import type { TaskRoomArtifact } from '../../shared/api/types.js'

export interface ArtifactListProps {
  artifacts: TaskRoomArtifact[]
  /** 当前会话；candidate 行的发布按钮只对 artifact owner 显示。 */
  session: Session | null
  taskId: string
}

/** 下载文件名：标题里的路径分隔与控制字符折叠成「-」，回退用 artifact 短 id。 */
function safeFileName(artifact: TaskRoomArtifact): string {
  const base = artifact.title
    .replace(/[^\w.\-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60)
  return base === '' ? `artifact-${shortId(artifact.id)}` : base
}

export function ArtifactList({ artifacts, session, taskId }: ArtifactListProps): ReactNode {
  const published = artifacts.filter((a) => a.status === 'published')
  // 候选行的可见性以会话为准（Hub 只给 owner 下发 candidate；此处仍按 owner 过滤，
  // 防御未来服务端形状变化时把他人候选渲染出来）。
  const candidates = artifacts.filter(
    (a) => a.status === 'candidate' && session !== null && a.ownerUserId === session.userId,
  )
  return (
    <div>
      <ArtifactRows artifacts={published} session={session} taskId={taskId} />
      <CandidateRows artifacts={candidates} taskId={taskId} />
      {published.length === 0 && candidates.length === 0 ? (
        <p className="empty-state">
          还没有已发布的 Artifact。Run 产出经发布后，交付物会出现在这里。
        </p>
      ) : null}
      {published.length > 0 ? (
        <p className="artifact-reviewer-note">
          以上已发布交付物将作为 Reviewer Run 的只读输入（按内容摘要 sha256 固定）。
        </p>
      ) : null}
    </div>
  )
}

function ArtifactRows({
  artifacts,
}: {
  artifacts: TaskRoomArtifact[]
  session: Session | null
  taskId: string
}): ReactNode {
  const [busyId, setBusyId] = useState<string | undefined>(undefined)
  const [error, setError] = useState<string | undefined>(undefined)

  async function download(artifact: TaskRoomArtifact): Promise<void> {
    setBusyId(artifact.id)
    setError(undefined)
    try {
      const response = await fetch(`/api/v1/artifacts/${artifact.id}/content`, {
        credentials: 'include',
      })
      if (!response.ok) {
        setError('下载失败，请稍后重试。')
        return
      }
      const blob = await response.blob()
      const url = URL.createObjectURL(blob)
      const anchor = document.createElement('a')
      anchor.href = url
      anchor.download = safeFileName(artifact)
      anchor.click()
      URL.revokeObjectURL(url)
    } finally {
      setBusyId(undefined)
    }
  }

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
            <div>
              <dt>来自 Run</dt>
              <dd>{shortId(artifact.runId)}</dd>
            </div>
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
            <button
              type="button"
              className="button"
              data-testid="artifact-download-button"
              disabled={busyId === artifact.id}
              onClick={() => void download(artifact)}
            >
              下载
            </button>
          </div>
        </li>
      ))}
      {error !== undefined ? (
        <p className="mutation-hint" role="alert">
          {error}
        </p>
      ) : null}
    </ul>
  )
}

function CandidateRows({
  artifacts,
  taskId,
}: {
  artifacts: TaskRoomArtifact[]
  taskId: string
}): ReactNode {
  const queryClient = useQueryClient()
  const [busyId, setBusyId] = useState<string | undefined>(undefined)
  const [error, setError] = useState<string | undefined>(undefined)

  async function publish(artifact: TaskRoomArtifact): Promise<void> {
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
            <div>
              <dt>来自 Run</dt>
              <dd>{shortId(artifact.runId)}</dd>
            </div>
            <div>
              <dt>内容摘要</dt>
              <dd>{artifact.sha256.slice(0, 12)}</dd>
            </div>
          </dl>
          <div className="artifact-actions">
            <button
              type="button"
              className="button"
              data-testid="artifact-publish-button"
              disabled={busyId === artifact.id}
              onClick={() => void publish(artifact)}
            >
              发布
            </button>
          </div>
        </li>
      ))}
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
    <section className="card snapshot-slot" aria-label="复核">
      <h3>复核</h3>
      <p className="empty-state">
        为 Task 启动 Reviewer Agent 的 Run 时，以上已发布交付物会作为只读输入清单 送达该
        Run（受控副本，不继承 Builder 的 Workspace）。
      </p>
    </section>
  )
}
