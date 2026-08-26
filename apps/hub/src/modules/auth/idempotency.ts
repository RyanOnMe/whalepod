import type { FastifyRequest } from 'fastify'
import { ApiError } from '../shared/http-error.js'

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS'])

/** 03 §4：所有 Browser 写命令必须携带 16–128 字符的 Idempotency-Key。 */
export function assertIdempotencyKey(request: FastifyRequest): void {
  if (SAFE_METHODS.has(request.method)) return
  const key: string | string[] | undefined = request.headers['idempotency-key']
  // 与 Origin 门同形：重复头经 HTTP 解析器逗号拼接（真实 HTTP 中恒为字符串；数组仅作
  // 防御）。拼接形态必然含逗号、不是单一 key——含逗号一律 400，不静默取第一段。
  if (typeof key !== 'string' || key.includes(',') || key.length < 16 || key.length > 128) {
    throw new ApiError(400, 'VALIDATION_FAILED', 'idempotency-key must be 16-128 characters')
  }
}

/** 取已校验的 Idempotency-Key（onRequest hook 已过 assertIdempotencyKey）。 */
export function readIdempotencyKey(request: FastifyRequest): string {
  const key: string | string[] | undefined = request.headers['idempotency-key']
  return typeof key === 'string' ? key : ''
}
