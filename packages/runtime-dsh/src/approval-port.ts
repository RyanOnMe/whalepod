/**
 * Approval answerer（03 §7.1/§7.2）：把 DSH 的 `approval/request` 瀑布转成
 * `approval.requested` output 帧，挂起等待 Node 下行的 `approval.decide`，
 * 一次性映射回 DSH outcome。TabTin 红线：只有 `allowed-once` 是授权
 * （07 §2 user-approval 结论），不做任何永久授权。
 *
 * 决定迟到（turn 已被取消/请求已被 signal 撤回）时静默丢弃并记日志——
 * Node 与 Runtime 之间的 decide/取消竞态是常态，不是错误。
 */
import type { Context } from '@deepseek-ai/cordis'
import type { ApprovalOutcome, ApprovalRequest } from '@deepseek-ai/dsh-user-approval'
import type { LogSink } from './log.js'

export interface ApprovalRequestedFact {
  readonly callId: string
  readonly toolName: string
  readonly reason: string
}

type PendingDecision = (outcome: ApprovalOutcome) => void

export class ApprovalPort {
  private readonly pending = new Map<string, PendingDecision>()

  constructor(
    private readonly onRequest: (fact: ApprovalRequestedFact) => void,
    private readonly log: LogSink,
  ) {}

  /** 挂进 Run 的 agent scope（scope-filtered dispatch：只收本 agent 的请求）。 */
  install(agentCtx: Context): void {
    agentCtx.on('approval/request', this.answer)
  }

  private readonly answer = (
    req: ApprovalRequest,
    next: () => Promise<ApprovalOutcome>,
  ): Promise<ApprovalOutcome> => {
    // 只有携带 callId 的工具调用审批由本 answerer 认领；其余请求顺瀑布下行。
    if (req.callId === undefined) return next()
    const callId = String(req.callId)
    this.onRequest({
      callId,
      toolName: req.toolName,
      reason: req.reason ?? `tool "${req.toolName}" requires approval`,
    })
    return new Promise<ApprovalOutcome>((resolve) => {
      this.pending.set(callId, resolve)
      // signal 撤回时主动收口本侧 promise；DSH 侧此时已 settle 'cancelled'，
      // 迟到的 decide 会被丢弃（见 dsh-user-approval 的请求契约）。
      req.signal?.addEventListener('abort', () => this.settle(callId, 'cancelled'), {
        once: true,
      })
    })
  }

  /** `approval.decide` 命令入口：wire 的 allowed_once → DSH 的 allowed-once。 */
  decide(callId: string, decision: 'allowed_once' | 'rejected'): void {
    const outcome: ApprovalOutcome = decision === 'allowed_once' ? 'allowed-once' : 'rejected'
    if (!this.settle(callId, outcome)) {
      this.log({
        level: 'warn',
        component: 'runtime.bridge.approval',
        msg: 'approval decide ignored: unknown or already-settled callId',
        callId,
      })
    }
  }

  /** dispose 时收口全部挂起请求，避免 promise 泄漏过 teardown。 */
  cancelAll(): void {
    for (const callId of [...this.pending.keys()]) this.settle(callId, 'cancelled')
  }

  private settle(callId: string, outcome: ApprovalOutcome): boolean {
    const resolve = this.pending.get(callId)
    if (resolve === undefined) return false
    this.pending.delete(callId)
    resolve(outcome)
    return true
  }
}
