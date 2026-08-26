/**
 * 类型化 API 失败（03-领域模型与运行协议.md §4 envelope 的失败分支）。
 * code/requestId 直接来自 wire：code 用 protocol 的 ErrorCodeSchema 枚举（wire SSoT），
 * requestId 由 Hub 在每次失败响应中给出，UI 原样展示供排查。
 */
import type { ErrorCode } from '@project311/protocol'

export class ApiError extends Error {
  readonly code: ErrorCode
  readonly requestId: string
  readonly status: number
  readonly details: unknown

  constructor(
    code: ErrorCode,
    message: string,
    requestId: string,
    status: number,
    details?: unknown,
  ) {
    super(message)
    this.name = 'ApiError'
    this.code = code
    this.requestId = requestId
    this.status = status
    this.details = details
  }
}

export function isApiError(error: unknown): error is ApiError {
  return error instanceof ApiError
}

/** 会话类失败：登录态失效，UI 应提示重新登录而不是继续重试。 */
const SESSION_ERROR_CODES: ReadonlySet<ErrorCode> = new Set(['AUTH_REQUIRED', 'SESSION_EXPIRED'])

export function isSessionError(error: unknown): boolean {
  return isApiError(error) && SESSION_ERROR_CODES.has(error.code)
}
