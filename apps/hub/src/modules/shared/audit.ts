import type { FastifyRequest } from 'fastify'

export type AuditAction =
  | 'setup'
  | 'auth.login'
  | 'auth.logout'
  | 'invite.create'
  | 'invite.accept'
  // #141：匿名预检（GET /invites/:token）——目前只在限流拒绝时记账
  // （rate_limited），成功路径不记：这是读路径，逐次入审计会淹没真正的事件。
  | 'invite.preflight'
  | 'member.disable'
  | 'project.create'
  | 'task.create'
  | 'task.update'
  | 'task.accept'
  | 'task.reject'
  | 'task.reassign'
  | 'task.submit_review'
  | 'task.complete'
  | 'task.cancel'
  // #378：任务约定（确认/丢弃入审计；草稿保存不入——高频编辑，归属已在行上）。
  | 'agreement.confirm'
  | 'agreement.discard'
  | 'comment.create'
  | 'instruction.send'
  | 'instruction.grant'
  | 'instruction.revoke'
  | 'agent.create'
  | 'agent.revision'
  | 'device.pair'
  | 'device.claim'
  | 'device.revoke'
  | 'plugin.install'
  | 'plugin.pack'
  | 'artifact.publish'
  // #429：交付物审阅（批注/邀请/提交意见）——只记动作与结果，不记意见正文。
  | 'artifact.comment.create'
  | 'artifact.review.invite'
  | 'artifact.review.submit'
  | 'artifact.review.round_create'
  | 'artifact.review.round_start'
  | 'artifact.review.candidate_link'
  | 'artifact.review.comment_resolve'
  // ADR-0024：来源绑定生命周期（只记动作，不记资源身份与正文）。
  | 'source.bind'
  | 'source.pause'
  | 'source.resume'
  | 'source.revoke'

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
