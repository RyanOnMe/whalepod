/**
 * 右侧区域：Artifact 列表 + Reviewer 插槽（02 Task 7 Step 4）。
 * 只展示 Hub 已发布的 Artifact metadata（task/view.ts 已剥离 storageKey 等路径）。
 */
import type { ReactNode } from 'react'
import { formatBytes, formatIso, shortId } from '../../shared/format.js'
import type { TaskRoomArtifact } from '../../shared/api/types.js'

export interface ArtifactListProps {
  artifacts: TaskRoomArtifact[]
}

export function ArtifactList({ artifacts }: ArtifactListProps): ReactNode {
  if (artifacts.length === 0) {
    return (
      <p className="empty-state">还没有已发布的 Artifact。Run 产出经发布后，交付物会出现在这里。</p>
    )
  }
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
              <dd>{formatIso(artifact.publishedAt)}</dd>
            </div>
          </dl>
        </li>
      ))}
    </ul>
  )
}

/** Reviewer 插槽：已发布交付物的 Review 入口（Reviewer Agent 链随后续版本接入）。 */
export function ReviewerSlot(): ReactNode {
  return (
    <section className="card snapshot-slot" aria-label="Reviewer">
      <h3>Reviewer</h3>
      <p className="empty-state">
        已发布交付物的 Review 入口将在这里提供（Reviewer Agent 运行链随后续版本接入）。
      </p>
    </section>
  )
}
