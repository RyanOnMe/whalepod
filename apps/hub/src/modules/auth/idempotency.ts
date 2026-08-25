import type { FastifyRequest } from 'fastify'
import { ApiError } from '../shared/http-error.js'

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS'])

/** 03 §4：所有 Browser 写命令必须携带 16–128 字符的 Idempotency-Key。 */
export function assertIdempotencyKey(request: FastifyRequest): void {
  if (SAFE_METHODS.has(request.method)) return
  const key = singleIdempotencyKey(request)
  if (key.length < 16 || key.length > 128) {
    throw new ApiError(400, 'VALIDATION_FAILED', 'idempotency-key must be 16-128 characters')
  }
}

/** 取已校验的 Idempotency-Key（onRequest hook 已过 assertIdempotencyKey）。 */
export function readIdempotencyKey(request: FastifyRequest): string {
  return singleIdempotencyKey(request)
}

function singleIdempotencyKey(request: FastifyRequest): string {
  const key: string | string[] | undefined = request.headers['idempotency-key']
  return Array.isArray(key) ? (key[0] ?? '') : (key ?? '')
}
