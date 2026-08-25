/**
 * 领域层稳定错误码。Hub 与 protocol 共用同一 union；
 * 非法状态迁移一律抛 DomainError，调用方按 code 判定，不解析 message。
 *
 * 与 03-领域模型与运行协议.md §10 ErrorCode 的关系：DomainErrorCode 是 wire
 * ErrorCode（packages/protocol ErrorCodeSchema）的子集，wire 侧为 SSoT；
 * 本包按边界规则不能 import protocol，故以运行时可枚举的 DOMAIN_ERROR_CODES
 * 持有本包用到的码，由 apps/hub/tests/error-code-alignment.spec.ts 对齐门
 * 断言子集关系（Issue #30）。
 */
export const DOMAIN_ERROR_CODES = [
  'INVALID_TASK_TRANSITION',
  'INVALID_ASSIGNMENT_TRANSITION',
  'INVALID_RUN_TRANSITION',
  'INVALID_ARTIFACT_TRANSITION',
  'APPROVAL_EXPIRED',
  'APPROVAL_ALREADY_DECIDED',
  'ASSIGNMENT_NOT_ACCEPTED',
  'TASK_TERMINAL',
] as const

export type DomainErrorCode = (typeof DOMAIN_ERROR_CODES)[number]

export class DomainError extends Error {
  readonly code: DomainErrorCode

  constructor(code: DomainErrorCode, message?: string) {
    super(message ?? code)
    this.name = 'DomainError'
    this.code = code
  }
}
