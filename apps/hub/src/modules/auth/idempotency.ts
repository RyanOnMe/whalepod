import type { FastifyRequest } from 'fastify'
import { ApiError } from '../shared/http-error.js'

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS'])

/** 03 §4：所有 Browser 写命令必须携带 16–128 字符的 Idempotency-Key。 */
export function assertIdempotencyKey(request: FastifyRequest): void {
  if (SAFE_METHODS.has(request.method)) return
  const key: string | string[] | undefined = request.headers['idempotency-key']
  if (typeof key !== 'string' || key.length < 16 || key.length > 128) {
    throw new ApiError(400, 'VALIDATION_FAILED', 'idempotency-key must be 16-128 characters')
  }
}
