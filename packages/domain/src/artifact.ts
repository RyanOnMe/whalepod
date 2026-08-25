import { DomainError } from './errors.js'

// 状态迁移表以 03-领域模型与运行协议.md §3.4 为准：
// candidate -> published | rejected；终态不可替换、禁止复活。
// 发布只产生 artifact.published Team Event，不会隐式完成 Task。
export type ArtifactStatus = 'candidate' | 'published' | 'rejected'

export type ArtifactEvent = { type: 'publish' } | { type: 'reject' }

const ARTIFACT_NEXT: Readonly<
  Record<ArtifactStatus, Partial<Record<ArtifactEvent['type'], ArtifactStatus>>>
> = {
  candidate: { publish: 'published', reject: 'rejected' },
  published: {},
  rejected: {},
}

export function transitionArtifact(
  artifact: { status: ArtifactStatus },
  event: ArtifactEvent,
): { status: ArtifactStatus } {
  const status = ARTIFACT_NEXT[artifact.status][event.type]
  if (status === undefined) {
    throw new DomainError(
      'INVALID_ARTIFACT_TRANSITION',
      `cannot apply ${event.type} to an artifact in ${artifact.status}`,
    )
  }
  return { ...artifact, status }
}
