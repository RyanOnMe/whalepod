import type { ArtifactStatus } from './artifact.js'
import type { UserId } from './ids.js'
import type { AssignmentStatus } from './task.js'

// 单一权限决策入口。矩阵语义以 03-领域模型与运行协议.md §4「权限」列为准；
// 动作命名沿用 02-第一阶段实施计划.md Task 2 的 snake_case 风格。
// 停用 Member（disabledAt 有值）拒绝一切动作。

export type Role = 'owner' | 'admin' | 'member'

export interface Actor {
  readonly userId: UserId
  readonly role: Role
  /** epoch 毫秒；有值表示该 Member 已停用。 */
  readonly disabledAt?: number
}

export type Action =
  | 'create_invite'
  | 'manage_agent'
  | 'install_plugin'
  | 'create_plugin_pack'
  | 'create_task'
  | 'update_task'
  | 'comment_task'
  | 'reassign_task'
  | 'disable_member'
  | 'view_run'
  | 'pair_device'
  | 'accept_assignment'
  | 'reject_assignment'
  | 'submit_review'
  | 'complete_task'
  | 'cancel_task'
  | 'cancel_run'
  | 'revoke_device'
  | 'decide_approval'
  | 'publish_artifact'
  | 'read_artifact_content'

export interface Resource {
  /** Run/Device/Artifact 的 owner_user_id。 */
  readonly ownerUserId?: UserId
  /** Task 的 assignee_user_id。 */
  readonly assigneeUserId?: UserId
  /** Task 的 assignment_status。 */
  readonly assignmentStatus?: AssignmentStatus
  /** Artifact 的 status。 */
  readonly artifactStatus?: ArtifactStatus
}

const OWNER_OR_ADMIN: readonly Role[] = ['owner', 'admin']

export function authorize(actor: Actor, action: Action, resource: Resource = {}): boolean {
  if (actor.disabledAt !== undefined) return false
  const isOwnerOrAdmin = OWNER_OR_ADMIN.includes(actor.role)
  const isOwner = resource.ownerUserId !== undefined && actor.userId === resource.ownerUserId
  const isAssignee =
    resource.assigneeUserId !== undefined && actor.userId === resource.assigneeUserId
  switch (action) {
    case 'create_invite':
    case 'manage_agent':
    case 'install_plugin':
    case 'create_plugin_pack':
    case 'reassign_task':
    case 'disable_member':
      return isOwnerOrAdmin
    case 'accept_assignment':
    case 'reject_assignment':
      return isAssignee
    case 'submit_review':
    case 'complete_task':
    case 'cancel_task':
      return isAssignee && resource.assignmentStatus === 'accepted'
    // 注意：本函数**不再**包含 `create_run`。切片④（#198）之后驱动权是**数据库事实**
    // （责任人 ∪ `task_instruction_grant` 里的成员），纯函数拿不到授权名单、无法诚实表达；
    // 真正的判定入口是 `packages/db/src/repositories/instruction-grant.ts` 的
    // `resolveInstructionRight`。刻意不留一份会过期的第二真相，故该动作已从 Action 联合类型移除。
    case 'cancel_run':
    case 'revoke_device':
      return isOwner || isOwnerOrAdmin
    case 'decide_approval':
    case 'publish_artifact':
      return isOwner
    case 'read_artifact_content':
      return isOwner || resource.artifactStatus === 'published'
    case 'create_task':
    case 'update_task':
    case 'comment_task':
    case 'view_run':
    case 'pair_device':
      return true
  }
}

/** `can` 是 `authorize` 的别名（P1-02 Issue 用语）。 */
export const can = authorize
