import type { ErrorCode } from '@project311/protocol'

/** Hub 业务错误：statusCode + wire ErrorCode，由 app.ts 错误处理器统一上 envelope。 */
export class ApiError extends Error {
  constructor(
    readonly statusCode: number,
    readonly code: ErrorCode,
    message?: string,
  ) {
    super(message ?? code)
    this.name = 'ApiError'
  }
}
