/**
 * 同源 API 客户端（02 Task 7 Interfaces：`api.request<T>(route, options)`）。
 *
 * - Cookie 认证：`credentials: 'include'`，浏览器自动携带 HttpOnly 会话 Cookie。
 * - Origin：同源部署时浏览器对 POST/PATCH/DELETE 自动附带 Origin 头，Hub 会做
 *   精确比对（03 §4）；客户端不手工伪造 Origin。
 * - 幂等：所有非 GET 请求默认生成随机 Idempotency-Key（crypto.randomUUID）。
 *   Hub 对重复 key **重放首次结果**（03 §幂等；`IDEMPOTENCY_CONFLICT` 今天不可达）——
 *   所以「同一意图的重试」必须显式复用同一把键（见 `mutateWithSiblings` 的调用点与 ADR-0013）。
 * - 失败：解析失败 envelope（protocol 的 ApiFailureSchema 是 wire SSoT），
 *   抛类型化 ApiError（code/message/requestId/details），UI 原样展示。
 */
import { ApiFailureSchema } from '@whalepod/protocol'
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

/**
 * 成功信封里 `data` 之外的顶层兄弟字段。
 *
 * 真实 wire 不保证只有 `ok`/`data` 两个键：创建任务指派 Agent 时 Hub 返回
 * `{ ok, data, drive }`——`drive`（自动驱动结果）与 `data` **平级**，不是 `data.drive`
 * （`apps/hub/src/modules/task/routes.ts` 的 `...(drive !== undefined ? { drive } : {})`，
 * Hub 集成用例也按 `json.drive` 读）。只取 `data` 的调用方会把这类结果悄悄丢掉——
 * #312 的 toast 从不出现就是这么漏的。需要兄弟字段的调用方走 `apiRequestEnvelope`。
 */
export type EnvelopeSiblings = Record<string, unknown>

export interface ApiEnvelope<T> {
  data: T
  /** `data` 之外的顶层字段（不含 `ok`）；没有兄弟字段时是空对象，不塞 undefined 占位。 */
  siblings: EnvelopeSiblings
}

function siblingsOf(envelope: Record<string, unknown>): EnvelopeSiblings {
  return Object.fromEntries(
    Object.entries(envelope).filter(([key]) => key !== 'ok' && key !== 'data'),
  )
}

export async function apiRequestEnvelope<T>(
  route: string,
  options: RequestOptions = {},
): Promise<ApiEnvelope<T>> {
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

  if (isSuccessEnvelope(parsed)) {
    return { data: parsed.data as T, siblings: siblingsOf(parsed as Record<string, unknown>) }
  }

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

/** 只要 `data` 的调用方（绝大多数）；兄弟字段走 `apiRequestEnvelope` 单独取。 */
export async function apiRequest<T>(route: string, options: RequestOptions = {}): Promise<T> {
  const envelope = await apiRequestEnvelope<T>(route, options)
  return envelope.data
}

/** 便捷封装：GET 查询、POST 变更、DELETE 撤销（非 GET 的幂等键由 apiRequest 统一生成）。 */
export const api = {
  get<T>(route: string): Promise<T> {
    return apiRequest<T>(route)
  },
  /**
   * DELETE（切片⑥e 起需要：撤销指令权是 `DELETE /tasks/:id/instruction-grants/:userId`）。
   * 底层 `apiRequest` 本来就接 `'DELETE'`，只是此前没有调用方，所以没暴露。
   */
  remove<T>(route: string, options: { idempotencyKey?: string } = {}): Promise<T> {
    return apiRequest<T>(route, {
      method: 'DELETE',
      ...(options.idempotencyKey !== undefined ? { idempotencyKey: options.idempotencyKey } : {}),
    })
  },
  mutate<T>(route: string, options: { body?: unknown; idempotencyKey?: string } = {}): Promise<T> {
    return apiRequest<T>(route, {
      method: 'POST',
      ...(options.body !== undefined ? { body: options.body } : {}),
      ...(options.idempotencyKey !== undefined ? { idempotencyKey: options.idempotencyKey } : {}),
    })
  },
  /**
   * 与 `mutate` 同一条请求，但把 `data` 的**兄弟字段**一并交给调用方（见 `EnvelopeSiblings`）。
   * 指派 Agent 建任务必须用这个：`drive` 只在兄弟位，只取 `data` 会把驱动结果丢掉（#312）。
   */
  mutateWithSiblings<T>(
    route: string,
    options: { body?: unknown; idempotencyKey?: string } = {},
  ): Promise<ApiEnvelope<T>> {
    return apiRequestEnvelope<T>(route, {
      method: 'POST',
      ...(options.body !== undefined ? { body: options.body } : {}),
      ...(options.idempotencyKey !== undefined ? { idempotencyKey: options.idempotencyKey } : {}),
    })
  },
}
