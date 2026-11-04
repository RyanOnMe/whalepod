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
  // ADR-0025：项目事实账本的人工纠正（不记被纠正正文）。
  | 'context.correct'
  // ADR-0026（PC-04a）：成员显式触发确定性协调评估。
  | 'coordination.evaluate'
  // ADR-0028（RD-01）：持续工作、Mandate 与影子准入（只记动作与结果，不记目标正文）。
  | 'work.create'
  | 'work.retire'
  | 'work.accept'
  | 'work.mandate.create'
  | 'work.mandate.pause'
  | 'work.mandate.resume'
  | 'work.mandate.revoke'
  | 'work.admission.check'
  // ADR-0028（RD-03d2a）：ask 的绑定回答（不记问题/回答正文）。
  | 'work.decision.answer'
  // ADR-0028（RD-03a）：受控派工意图的人工确认/拒绝与端口派发（不记目标正文）。
  | 'work.dispatch.approve'
  | 'work.dispatch.reject'
  | 'work.dispatch.dispatch'
  // ADR-0028（RD-02a-1）：工作收件箱的显式关联与生命周期（不记正文）。
  | 'work.inbox.associate'
  | 'work.inbox.return'
  | 'work.inbox.retract'
  | 'work.inbox.expire'
  // ADR-0028（RD-02b）：显式订阅（不记来源正文）。
  | 'work.subscription.create'
  | 'work.subscription.revoke'

export type AuditOutcome = 'success' | 'denied' | 'rate_limited'

/**
 * 审计动作自身的**不透明标识/计数**（如 workKey/mandateId/version）。
 * 白名单式窄类型：不接受任意键，严禁正文、路径、凭据。
 */
export interface AuditFields {
  readonly workKey?: string
  readonly mandateId?: string
  readonly version?: number
  readonly decisionId?: string
  readonly questionId?: string
  readonly answerType?: string
  readonly binding?: boolean
}

/**
 * 审计事件（02 Task 5 Step 7）：只记 actor、action、outcome、requestId（以及白名单
 * AuditFields），不记密码或 Token。载体是带 component 分层字段的结构化日志（六原语·
 * 观测），由 hub 日志流落盘，不进数据库、不进团队投影。
 *
 * 保留键放在 fields 之后展开，调用方无法覆盖 component/action/actor/outcome/requestId。
 */
export function audit(
  request: FastifyRequest,
  action: AuditAction,
  outcome: AuditOutcome,
  actor: string = 'anonymous',
  fields: AuditFields = {},
): void {
  request.log.info(
    {
      ...fields,
      component: 'hub.audit',
      action,
      actor,
      outcome,
      requestId: String(request.id),
    },
    'audit',
  )
}
