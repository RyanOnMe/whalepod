import { DomainError } from './errors.js'

// 任务约定版本（#378；ADR-0017 §1）的状态语义：
// 草稿（draft）可编辑、不构成要求；确认（confirm）冻结为不可变版本，revision_number
// 每 Task 单调递增；confirmed 是终态（发布后不原地覆盖——修改产生新草稿、新版本）。
// 与 Run/Artifact 同哲学：这里只固化纯状态边，编号分配与责任人校验由 Hub 命令层做。
export type TaskSpecRevisionStatus = 'draft' | 'confirmed'

export type TaskSpecRevisionEvent = { type: 'confirm' }

const SPEC_NEXT: Readonly<
  Record<
    TaskSpecRevisionStatus,
    Partial<Record<TaskSpecRevisionEvent['type'], TaskSpecRevisionStatus>>
  >
> = {
  draft: { confirm: 'confirmed' },
  confirmed: {},
}

export function transitionTaskSpecRevision(
  revision: { status: TaskSpecRevisionStatus },
  event: TaskSpecRevisionEvent,
): { status: TaskSpecRevisionStatus } {
  const status = SPEC_NEXT[revision.status][event.type]
  if (status === undefined) {
    throw new DomainError(
      'INVALID_SPEC_REVISION_TRANSITION',
      `cannot apply ${event.type} to a spec revision in ${revision.status}`,
    )
  }
  return { ...revision, status }
}

/**
 * 草稿编辑的并发令牌推进（#378）：每次落盘 +1。
 * 调用方已核对 `expectedDraftVersion`（不匹配即拒），这里只做纯推进。
 */
export function nextDraftVersion(current: number): number {
  return current + 1
}
