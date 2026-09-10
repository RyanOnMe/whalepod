import type { ErrorCode } from '@whalepod/protocol'

/** Hub 业务错误：statusCode + wire ErrorCode，由 app.ts 错误处理器统一上 envelope。 */
export class ApiError extends Error {
  constructor(
    readonly statusCode: number,
    readonly code: ErrorCode,
    message?: string,
    /**
     * 可选 details（#141）：需要让客户端**区分同一状态码下的子情形**时用，
     * 例如邀请失效要分成「已过期 / 已用过」两种文案（否则 UI 只能显示裸错误码）。
     * 不传则该字段不出现在失败 envelope 里，既有失败响应形状零变化。
     */
    readonly details?: unknown,
  ) {
    super(message ?? code)
    this.name = 'ApiError'
  }
}
