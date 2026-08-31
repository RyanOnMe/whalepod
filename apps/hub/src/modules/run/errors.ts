import { DomainError } from '@project311/domain'
import type { ErrorCode } from '@project311/protocol'

/**
 * Hub 命令层错误：code 即 wire ErrorCode（03-领域模型与运行协议.md §10），
 * HTTP 状态映射在 routes.ts；领域已有的码（ASSIGNMENT_NOT_ACCEPTED 等）仍抛
 * DomainError，本类只承载协议侧独有的码（FORBIDDEN/NOT_FOUND/RUN_ALREADY_ACTIVE…）。
 */
export class RunCommandError extends Error {
  readonly code: ErrorCode

  constructor(code: ErrorCode, message?: string) {
    super(message ?? code)
    this.name = 'RunCommandError'
    this.code = code
  }
}

/**
 * #52/ADR-0007 单一事实源：事件通道上「语义冲突」的判定——帧结构合法、归属
 * 合法、seq 有效，只有该 Run 的账本解释不了它。这类错误降级为 Run 级收敛
 * （orchestrator 事务内捕获），不得冒泡成连接级 4003（node-websocket 兜底）。
 * 通道不可信类（schema 坏、FORBIDDEN 越权）不在其列。两处消费共用本函数：
 * 分类判定各自表达一次，惩罚边界就会在两条路径上悄悄漂移。
 */
export function isRunSemanticConflict(error: unknown): boolean {
  if (error instanceof DomainError) return error.code === 'INVALID_RUN_TRANSITION'
  if (error instanceof RunCommandError) {
    // 近亲：approval.decided 引用缺失行——同样是单 Run 账本冲突（NOT_FOUND 在
    // applyProjectedEvent 内仅此一个来源）。
    return error.code === 'NOT_FOUND'
  }
  return false
}
