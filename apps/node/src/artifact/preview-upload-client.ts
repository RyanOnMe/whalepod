/**
 * 派生预览上传客户端（#431；03 §4 `PUT /node/artifacts/:artifactId/preview`）。
 *
 * 与原件上传同型：窄 fetch 封装 + 有界重试；4xx（除 408/429）是永久拒绝，不重试。
 * 不携带 Idempotency-Key：预览是 upsert 派生件，同内容重试天然幂等。
 */
import {
  ArtifactPreviewFailureRequestSchema,
  ArtifactPreviewUploadMetadataSchema,
  ErrorCodeSchema,
} from '@whalepod/protocol'
import type {
  ArtifactPreviewFailureRequest,
  ArtifactPreviewUploadMetadata,
} from '@whalepod/protocol'
import { randomUUID } from 'node:crypto'

export const DEFAULT_PREVIEW_UPLOAD_TIMEOUT_MS = 30_000
export const PREVIEW_UPLOAD_ATTEMPTS = 3
const RETRY_DELAY_MS = 500

export class ArtifactPreviewUploadError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message)
    this.name = 'ArtifactPreviewUploadError'
  }
}

export interface PreviewUploadOptions {
  readonly fetchImpl?: typeof fetch
  readonly timeoutMs?: number
  readonly log?: (
    level: 'info' | 'warn' | 'error',
    msg: string,
    context?: Record<string, unknown>,
  ) => void
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** 5xx/408/429：有界重试；4xx 是永久拒绝。 */
class RetryablePreviewError extends Error {
  constructor(readonly code: string) {
    super(code)
    this.name = 'RetryablePreviewError'
  }
}

async function errorCodeOf(response: Response): Promise<string> {
  try {
    const body = (await response.json()) as { error?: { code?: unknown } }
    const code = body.error?.code
    if (typeof code === 'string' && ErrorCodeSchema.safeParse(code).success) return code
  } catch {
    // body 非 JSON：用通用码。
  }
  return 'INTERNAL_ERROR'
}

async function withRetries(
  artifactId: string,
  what: 'preview' | 'preview-failure',
  options: PreviewUploadOptions,
  attemptOnce: () => Promise<void>,
): Promise<void> {
  let lastError: ArtifactPreviewUploadError | undefined
  for (let attempt = 1; attempt <= PREVIEW_UPLOAD_ATTEMPTS; attempt += 1) {
    try {
      await attemptOnce()
      return
    } catch (error) {
      if (error instanceof RetryablePreviewError) {
        lastError = new ArtifactPreviewUploadError(error.code, `${what} retryable failure`)
      } else if (error instanceof ArtifactPreviewUploadError && error.code !== 'NETWORK') {
        throw error
      } else {
        lastError =
          error instanceof ArtifactPreviewUploadError
            ? error
            : new ArtifactPreviewUploadError(
                'NETWORK',
                `${what} transport failure: ${error instanceof Error ? error.name : 'unknown'}`,
              )
      }
    }
    if (attempt < PREVIEW_UPLOAD_ATTEMPTS) {
      options.log?.('warn', `artifact ${what} upload retry scheduled`, {
        component: 'node.artifact',
        artifactId,
        attempt,
      })
      await sleep(RETRY_DELAY_MS)
    }
  }
  throw lastError ?? new ArtifactPreviewUploadError('NETWORK', `${what} upload failed`)
}

export async function uploadArtifactPreview(
  hubUrl: string,
  deviceToken: string,
  artifactId: string,
  metadata: ArtifactPreviewUploadMetadata,
  body: Buffer,
  options: PreviewUploadOptions = {},
): Promise<void> {
  const parsed = ArtifactPreviewUploadMetadataSchema.parse(metadata)
  const query = new URLSearchParams({
    sourceSha256: parsed.sourceSha256,
    sha256: parsed.sha256,
    byteSize: String(parsed.byteSize),
    converter: parsed.converter,
  })
  const url = `${hubUrl.replace(/\/$/, '')}/api/v1/node/artifacts/${artifactId}/preview?${query.toString()}`
  const fetchFn = options.fetchImpl ?? fetch
  // Hub 对所有写请求要求 Idempotency-Key；重试共用同一个键。派生件 upsert 天然幂等，
  // 不进入 command_receipt 台账。
  const idempotencyKey = randomUUID()
  await withRetries(artifactId, 'preview', options, async () => {
    const response = await fetchFn(url, {
      method: 'PUT',
      headers: {
        authorization: `Device ${deviceToken}`,
        'content-type': 'application/octet-stream',
        'idempotency-key': idempotencyKey,
      },
      body: new Uint8Array(body),
      signal: AbortSignal.timeout(options.timeoutMs ?? DEFAULT_PREVIEW_UPLOAD_TIMEOUT_MS),
    })
    if (response.ok) return
    const code = await errorCodeOf(response)
    if (response.status < 500 && response.status !== 408 && response.status !== 429) {
      throw new ArtifactPreviewUploadError(code, `preview rejected with http ${response.status}`)
    }
    throw new RetryablePreviewError(code)
  })
}

export async function reportArtifactPreviewFailure(
  hubUrl: string,
  deviceToken: string,
  artifactId: string,
  report: ArtifactPreviewFailureRequest,
  options: PreviewUploadOptions = {},
): Promise<void> {
  const parsed = ArtifactPreviewFailureRequestSchema.parse(report)
  const url = `${hubUrl.replace(/\/$/, '')}/api/v1/node/artifacts/${artifactId}/preview-failure`
  const fetchFn = options.fetchImpl ?? fetch
  const idempotencyKey = randomUUID()
  await withRetries(artifactId, 'preview-failure', options, async () => {
    const response = await fetchFn(url, {
      method: 'POST',
      headers: {
        authorization: `Device ${deviceToken}`,
        'content-type': 'application/json',
        'idempotency-key': idempotencyKey,
      },
      body: JSON.stringify(parsed),
      signal: AbortSignal.timeout(options.timeoutMs ?? DEFAULT_PREVIEW_UPLOAD_TIMEOUT_MS),
    })
    if (response.ok) return
    const code = await errorCodeOf(response)
    if (response.status < 500 && response.status !== 408 && response.status !== 429) {
      throw new ArtifactPreviewUploadError(
        code,
        `preview failure report rejected with http ${response.status}`,
      )
    }
    throw new RetryablePreviewError(code)
  })
}
