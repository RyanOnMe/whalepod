import type { FastifyRequest } from 'fastify'

export type AuditAction =
  | 'setup'
  | 'auth.login'
  | 'auth.logout'
  | 'invite.create'
  | 'invite.accept'
  | 'member.disable'

export type AuditOutcome = 'success' | 'denied' | 'rate_limited'

/**
 * 审计事件（02 Task 5 Step 7）：只记 actor、action、outcome、requestId，
 * 不记密码或 Token。载体是带 component 分层字段的结构化日志（六原语·观测），
 * 由 hub 日志流落盘，不进数据库、不进团队投影。
 */
export function audit(
  request: FastifyRequest,
  action: AuditAction,
  outcome: AuditOutcome,
  actor: string = 'anonymous',
): void {
  request.log.info(
    { component: 'hub.audit', action, actor, outcome, requestId: String(request.id) },
    'audit',
  )
}
