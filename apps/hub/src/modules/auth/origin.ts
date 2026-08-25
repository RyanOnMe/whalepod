import type { FastifyRequest } from 'fastify'
import { ApiError } from '../shared/http-error.js'

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS'])

/**
 * Origin gate（02 Global Constraints、03 §4、Task 5 Step 5）：
 * 所有非安全 HTTP 方法要求 Origin 与 public origin 做 exact scheme/host/port 比较；
 * 缺失、`Origin: null` 与多值 Origin（Node 会拼成逗号串，必然不等于期望值）一律 403。
 */
export function assertSameOrigin(request: FastifyRequest, expectedOrigin: string): void {
  if (SAFE_METHODS.has(request.method)) return
  const origin: string | string[] | undefined = request.headers.origin
  if (typeof origin !== 'string' || origin !== expectedOrigin) {
    throw new ApiError(403, 'ORIGIN_REJECTED', 'origin does not match the public origin')
  }
}
