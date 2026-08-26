/**
 * 同源 API 客户端（02 Task 7 Interfaces：`api.request<T>(route, options)`）。
 *
 * - Cookie 认证：`credentials: 'include'`，浏览器自动携带 HttpOnly 会话 Cookie。
 * - Origin：同源部署时浏览器对 POST/PATCH/DELETE 自动附带 Origin 头，Hub 会做
 *   精确比对（03 §4）；客户端不手工伪造 Origin。
 * - 幂等：所有非 GET 请求默认生成随机 Idempotency-Key（crypto.randomUUID），
 *   语义见 02 Task 7 Step 6——Hub 对重复 key 返回 IDEMPOTENCY_CONFLICT。
 * - 失败：解析失败 envelope（protocol 的 ApiFailureSchema 是 wire SSoT），
 *   抛类型化 ApiError（code/message/requestId/details），UI 原样展示。
 */
import { ApiFailureSchema } from '@project311/protocol'
import { ApiError } from './errors.js'

/** 所有 HTTP 接口的前缀（03 §4）。同源部署时留空。 */
const API_PREFIX = '/api/v1'

export interface RequestOptions {
  method?: 'GET' | 'POST' | 'PATCH' | 'DELETE'
  body?: unknown
  idempotencyKey?: string
}

function newIdempotencyKey(): string {
  return crypto.randomUUID()
}

function isSuccessEnvelope(value: unknown): value is { ok: true; data: unknown } {
  return typeof value === 'object' && value !== null && (value as { ok?: unknown }).ok === true
}

export async function apiRequest<T>(route: string, options: RequestOptions = {}): Promise<T> {
  const method = options.method ?? 'GET'
  const headers: Record<string, string> = {}
  if (options.body !== undefined) headers['content-type'] = 'application/json'
  // Hub 对所有非安全方法强制 Idempotency-Key（03 §4）：缺省自动生成，
  // 调用方持有同义键（重试同一次提交）时可显式传入。
  if (method !== 'GET') headers['idempotency-key'] = options.idempotencyKey ?? newIdempotencyKey()

  let response: Response
  try {
    response = await fetch(`${API_PREFIX}${route}`, {
      method,
      headers,
      credentials: 'include',
      ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
    })
  } catch {
    // 网络层失败没有 Hub 的 requestId；UI 用空串占位并展示通用提示。
    throw new ApiError('INTERNAL_ERROR', '无法连接服务器，请检查网络后重试', '', 0)
  }

  const text = await response.text()
  let parsed: unknown = null
  if (text !== '') {
    try {
      parsed = JSON.parse(text) as unknown
    } catch {
      throw new ApiError(
        'INTERNAL_ERROR',
        '服务器返回了无法解析的响应',
        `http:${response.status}`,
        response.status,
      )
    }
  }

  if (isSuccessEnvelope(parsed)) return parsed.data as T

  const failure = ApiFailureSchema.safeParse(parsed)
  if (failure.success) {
    throw new ApiError(
      failure.data.error.code,
      failure.data.error.message,
      failure.data.error.requestId,
      response.status,
      failure.data.error.details,
    )
  }
  throw new ApiError(
    'INTERNAL_ERROR',
    '服务器返回了无法识别的响应',
    `http:${response.status}`,
    response.status,
  )
}

/** 便捷封装：GET 查询与 POST 变更（非 GET 的幂等键由 apiRequest 统一生成）。 */
export const api = {
  get<T>(route: string): Promise<T> {
    return apiRequest<T>(route)
  },
  mutate<T>(route: string, options: { body?: unknown; idempotencyKey?: string } = {}): Promise<T> {
    return apiRequest<T>(route, {
      method: 'POST',
      ...(options.body !== undefined ? { body: options.body } : {}),
      ...(options.idempotencyKey !== undefined ? { idempotencyKey: options.idempotencyKey } : {}),
    })
  },
}
