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
