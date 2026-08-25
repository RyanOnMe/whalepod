import { DomainError } from './errors.js'

// 规则以 03-领域模型与运行协议.md §3.3 为准：
// pending -> allowed_once | rejected | expired | cancelled。
// 只有第一条有效决定获胜：重复相同决定返回第一次结果，冲突决定抛 APPROVAL_ALREADY_DECIDED。
export type ApprovalStatus = 'pending' | 'allowed_once' | 'rejected' | 'expired' | 'cancelled'

export interface ApprovalSnapshot {
  readonly status: ApprovalStatus
  /** epoch 毫秒；pending Approval 默认 requested_at + 10 分钟。 */
  readonly expiresAt: number
  /** 终态写入，epoch 毫秒。 */
  readonly decidedAt?: number
}

export type ApprovalDecision =
  | { type: 'allow_once'; at: number }
  | { type: 'reject'; at: number }
  | { type: 'expire'; at: number }
  | { type: 'cancel'; at: number }

const DECISION_OUTCOME: Readonly<Record<ApprovalDecision['type'], ApprovalStatus>> = {
  allow_once: 'allowed_once',
  reject: 'rejected',
  expire: 'expired',
  cancel: 'cancelled',
}

export function decideApproval(
  approval: ApprovalSnapshot,
  decision: ApprovalDecision,
): ApprovalSnapshot {
  const outcome = DECISION_OUTCOME[decision.type]
  if (approval.status !== 'pending') {
    if (approval.status === outcome) return approval
    throw new DomainError(
      'APPROVAL_ALREADY_DECIDED',
      `approval already ${approval.status}; cannot apply ${decision.type}`,
    )
  }
  if (
    (decision.type === 'allow_once' || decision.type === 'reject') &&
    decision.at >= approval.expiresAt
  ) {
    throw new DomainError('APPROVAL_EXPIRED', `approval expired at ${approval.expiresAt}`)
  }
  return { ...approval, status: outcome, decidedAt: decision.at }
}
