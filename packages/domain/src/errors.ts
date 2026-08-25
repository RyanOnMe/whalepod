/**
 * 领域层稳定错误码。Hub 与 protocol 共用同一 union；
 * 非法状态迁移一律抛 DomainError，调用方按 code 判定，不解析 message。
 *
 * 与 03-领域模型与运行协议.md §10 ErrorCode 的关系：wire 上的 ErrorCode 以 03 为准；
 * 这里额外包含 03 未列出的 INVALID_TASK_TRANSITION / INVALID_ASSIGNMENT_TRANSITION /
 * INVALID_ARTIFACT_TRANSITION，供领域内部表达对应状态机的非法边。
 */
export type DomainErrorCode =
  | 'INVALID_TASK_TRANSITION'
  | 'INVALID_ASSIGNMENT_TRANSITION'
  | 'INVALID_RUN_TRANSITION'
  | 'INVALID_ARTIFACT_TRANSITION'
  | 'APPROVAL_EXPIRED'
  | 'APPROVAL_ALREADY_DECIDED'
  | 'ASSIGNMENT_NOT_ACCEPTED'
  | 'TASK_TERMINAL'

export class DomainError extends Error {
  readonly code: DomainErrorCode

  constructor(code: DomainErrorCode, message?: string) {
    super(message ?? code)
    this.name = 'DomainError'
    this.code = code
  }
}
