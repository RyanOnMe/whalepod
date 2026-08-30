/**
 * Hub Artifact 上传客户端（P1-15；03 §4 `POST /node/runs/:runId/artifacts`）。
 *
 * 窄 fetch 封装（与 run/pack-descriptor-client.ts 同型）：fetch 注入（测试用
 * 内存服务）+ Idempotency-Key（同一候选重试用同一 key → Hub 回执幂等）+
 * query 元数据（协议 ArtifactUploadMetadataSchema 的权威形状）+ octet-stream
 * body。瞬时失败（网络/5xx）有界重试；4xx 原样折算错误码不重试。
 */
import { ArtifactUploadMetadataSchema, ErrorCodeSchema } from '@project311/protocol'
import type { ArtifactUploadMetadata } from '@project311/protocol'

export const DEFAULT_UPLOAD_TIMEOUT_MS = 30_000
export const UPLOAD_ATTEMPTS = 3
const RETRY_DELAY_MS = 500

export class ArtifactUploadError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message)
    this.name = 'ArtifactUploadError'
  }
}

export interface UploadCandidateInput {
  readonly title: string
  readonly mediaType: string
  readonly sha256: string
  readonly byteSize: number
  readonly sourceRelativePath: string
}

export interface UploadCandidateOptions {
  readonly fetchImpl?: typeof fetch
  readonly timeoutMs?: number
  /** 上传幂等键（同一次 collect 调用内重试共用）。 */
  readonly idempotencyKey: string
  readonly log?: (
    level: 'info' | 'warn' | 'error',
    msg: string,
    context?: Record<string, unknown>,
  ) => void
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

export async function uploadArtifactCandidate(
  hubUrl: string,
  deviceToken: string,
  runId: string,
  candidate: UploadCandidateInput,
  body: Buffer,
  options: UploadCandidateOptions,
): Promise<{ artifactId: string }> {
  // 协议形状权威：元素与 wire schema 不符是编程错误，fail loud。
  const metadata: ArtifactUploadMetadata = ArtifactUploadMetadataSchema.parse(candidate)
  const query = new URLSearchParams({
    title: metadata.title,
    mediaType: metadata.mediaType,
    byteSize: String(metadata.byteSize),
    sha256: metadata.sha256,
    sourceRelativePath: metadata.sourceRelativePath,
  })
  const url = `${hubUrl.replace(/\/$/, '')}/api/v1/node/runs/${runId}/artifacts?${query.toString()}`
  const fetchFn = options.fetchImpl ?? fetch
  let lastError: ArtifactUploadError | undefined
  for (let attempt = 1; attempt <= UPLOAD_ATTEMPTS; attempt += 1) {
    try {
      const response = await fetchFn(url, {
        method: 'POST',
        headers: {
          authorization: `Device ${deviceToken}`,
          'content-type': 'application/octet-stream',
          'idempotency-key': options.idempotencyKey,
        },
        body: new Uint8Array(body),
        signal: AbortSignal.timeout(options.timeoutMs ?? DEFAULT_UPLOAD_TIMEOUT_MS),
      })
      if (response.ok) {
        const parsed = (await response.json()) as { ok?: unknown; data?: { id?: unknown } }
        if (parsed.ok === true && typeof parsed.data?.id === 'string') {
          return { artifactId: parsed.data.id }
        }
        throw new ArtifactUploadError('VALIDATION_FAILED', 'artifact upload response malformed')
      }
      const errorCode = await errorCodeOf(response)
      // 4xx（除 408/429）是永久拒绝：不重试。
      if (response.status < 500 && response.status !== 408 && response.status !== 429) {
        throw new ArtifactUploadError(
          errorCode,
          `artifact upload rejected with http ${response.status}`,
        )
      }
      lastError = new ArtifactUploadError(
        errorCode,
        `artifact upload failed with http ${response.status}`,
      )
    } catch (error) {
      if (error instanceof ArtifactUploadError && error.code !== 'NETWORK') throw error
      const reason = error instanceof Error ? error.name : 'network error'
      lastError = new ArtifactUploadError('NETWORK', `artifact upload transport failure: ${reason}`)
    }
    if (attempt < UPLOAD_ATTEMPTS) {
      options.log?.('warn', 'artifact upload retry scheduled', {
        component: 'node.artifact',
        runId,
        attempt,
      })
      await sleep(RETRY_DELAY_MS)
    }
  }
  throw lastError ?? new ArtifactUploadError('NETWORK', 'artifact upload failed')
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
