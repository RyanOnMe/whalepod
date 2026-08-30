/**
 * Reviewer Run 输入准备（P1-15；G6-06/07 Node 半场）。
 *
 * run.start 后、Runtime 启动前：
 * 1. `GET /node/runs/:runId/input-manifest`（Device Token）拉取任务已发布
 *    Artifact 清单（协议 ArtifactInputManifestSchema fail-closed 解析；
 *    taskId 与 Run 不一致 → VALIDATION_FAILED；Hub 显式拒绝（如 #64 超上限
 *    ARTIFACT_INPUT_MANIFEST_TOO_LARGE）→ 错误码原样透传为 run.start 拒绝）；
 * 2. 逐条 `GET /node/artifacts/:artifactId/content` 受控下载副本，sha256 与
 *    清单比对（不符 → ARTIFACT_HASH_MISMATCH 且清理目录）；
 * 3. 副本文件名 = artifactId（UUID 白名单，无用户可控文件名，无路径面）；
 *    产出 runtime.initialize 的 `artifactInputs` + `artifactInputsDir`。
 *
 * Builder Run（无已发布 Artifact）= 空 manifest，不下载任何副本。目录按 run
 * 隔离（runtime-inputs/<runId>），终态后由 RunManager 触发 cleanup。
 */
import { createHash } from 'node:crypto'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import {
  ArtifactInputManifestSchema,
  ErrorCodeSchema,
  type RuntimeArtifactInput,
} from '@project311/protocol'

export const DEFAULT_INPUTS_TIMEOUT_MS = 30_000

export class ArtifactInputsError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message)
    this.name = 'ArtifactInputsError'
  }
}

export interface PreparedInputs {
  /** 下载副本目录（本地 wire 绝对路径，红线同 workspacePath）。 */
  readonly dir: string
  /** runtime.initialize 的 artifactInputs（只读清单，无本地路径）。 */
  readonly entries: RuntimeArtifactInput[]
}

export interface ArtifactInputsManagerDeps {
  readonly hubUrl: string
  readonly deviceToken: string
  /** 输入根目录（<stateDir>/runtime-inputs；每 run 一层子目录）。 */
  readonly inputsRoot: string
  readonly fetchImpl?: typeof fetch
  readonly timeoutMs?: number
  readonly log?: (
    level: 'info' | 'warn' | 'error',
    msg: string,
    context?: Record<string, unknown>,
  ) => void
}

export class ArtifactInputsManager {
  private readonly deps: ArtifactInputsManagerDeps

  constructor(deps: ArtifactInputsManagerDeps) {
    this.deps = deps
  }

  /** 拉取清单并下载全部已发布副本；失败不留下半成品目录。 */
  async prepare(runId: string, taskId: string): Promise<PreparedInputs> {
    const dir = join(this.deps.inputsRoot, runId)
    try {
      const manifest = await this.fetchManifest(runId)
      if (manifest.taskId !== taskId) {
        throw new ArtifactInputsError(
          'VALIDATION_FAILED',
          'input manifest task does not match the run task',
        )
      }
      await mkdir(dir, { recursive: true })
      for (const entry of manifest.artifacts) {
        const bytes = await this.fetchContent(runId, entry.artifactId)
        const actual = createHash('sha256').update(bytes).digest('hex')
        if (actual !== entry.sha256) {
          throw new ArtifactInputsError(
            'ARTIFACT_HASH_MISMATCH',
            'artifact input copy failed digest verification',
          )
        }
        if (bytes.byteLength !== entry.byteSize) {
          throw new ArtifactInputsError(
            'ARTIFACT_HASH_MISMATCH',
            'artifact input copy size does not match the manifest',
          )
        }
        // 文件名 = manifest 条目的 artifactId（schema 已限 UUID），无遍历面。
        await writeFile(join(dir, entry.artifactId), bytes)
      }
      this.deps.log?.('info', 'artifact inputs prepared', {
        component: 'node.artifact',
        runId,
        count: manifest.artifacts.length,
      })
      // initialize 清单条目 = manifest 条目的内容寻址子集（无 runId/publishedAt）。
      const entries: RuntimeArtifactInput[] = manifest.artifacts.map(
        ({ artifactId, title, mediaType, byteSize, sha256 }) => ({
          artifactId,
          title,
          mediaType,
          byteSize,
          sha256,
        }),
      )
      return { dir, entries }
    } catch (error) {
      await rm(dir, { recursive: true, force: true }).catch(() => {})
      if (error instanceof ArtifactInputsError) throw error
      const reason = error instanceof Error ? error.name : 'unknown error'
      throw new ArtifactInputsError(
        'RUNTIME_START_FAILED',
        `artifact inputs prepare failed: ${reason}`,
      )
    }
  }

  /** Run 终态后清理输入副本（best-effort）。 */
  async cleanup(runId: string): Promise<void> {
    await rm(join(this.deps.inputsRoot, runId), { recursive: true, force: true }).catch(() => {})
  }

  private async fetchManifest(runId: string) {
    const response = await this.request(
      `${this.deps.hubUrl.replace(/\/$/, '')}/api/v1/node/runs/${runId}/input-manifest`,
    )
    if (!response.ok) {
      // #64：Hub 失败 envelope 里的专用码（如 ARTIFACT_INPUT_MANIFEST_TOO_LARGE）
      // 原样透传为 run.start 拒绝码（语义显式可归因）；body 不可解析或码不在
      // 本侧协议版本内时，退回状态码折算（fail-closed 兜底）。
      const envelopeCode = await wireErrorCodeFrom(response)
      throw new ArtifactInputsError(
        envelopeCode ?? mapStatus(response.status),
        envelopeCode !== undefined
          ? 'input manifest request rejected by hub'
          : `input manifest request failed with http ${response.status}`,
      )
    }
    const envelope = (await response.json()) as { ok?: unknown; data?: unknown }
    if (envelope.ok !== true) {
      throw new ArtifactInputsError('VALIDATION_FAILED', 'input manifest response malformed')
    }
    const parsed = ArtifactInputManifestSchema.safeParse(envelope.data)
    if (!parsed.success) {
      throw new ArtifactInputsError('VALIDATION_FAILED', 'input manifest rejected by schema')
    }
    return parsed.data
  }

  private async fetchContent(runId: string, artifactId: string): Promise<Buffer> {
    const response = await this.request(
      `${this.deps.hubUrl.replace(/\/$/, '')}/api/v1/node/artifacts/${artifactId}/content`,
    )
    if (!response.ok) {
      throw new ArtifactInputsError(
        mapStatus(response.status),
        `artifact input download failed with http ${response.status}`,
      )
    }
    return Buffer.from(await response.arrayBuffer())
  }

  private async request(url: string): Promise<Response> {
    const fetchFn = this.deps.fetchImpl ?? fetch
    try {
      return await fetchFn(url, {
        headers: { authorization: `Device ${this.deps.deviceToken}` },
        signal: AbortSignal.timeout(this.deps.timeoutMs ?? DEFAULT_INPUTS_TIMEOUT_MS),
      })
    } catch (error) {
      const reason = error instanceof Error ? error.name : 'network error'
      throw new ArtifactInputsError('DEVICE_OFFLINE', `hub request failed: ${reason}`)
    }
  }
}

function mapStatus(status: number): string {
  if (status === 404) return 'NOT_FOUND'
  if (status === 401) return 'AUTH_REQUIRED'
  if (status === 403) return 'FORBIDDEN'
  if (status === 409) return 'CONFLICT'
  const fallback = 'INTERNAL_ERROR'
  return ErrorCodeSchema.safeParse(fallback).success ? fallback : 'INTERNAL_ERROR'
}

/**
 * #64：从 Hub 失败 envelope（§4 ApiFailure）提取 wire 错误码——只接受能通过
 * ErrorCodeSchema 解析的码（协议演进安全：本侧不认识的码不透传，走状态码折算）。
 */
async function wireErrorCodeFrom(response: Response): Promise<string | undefined> {
  try {
    const body = (await response.json()) as { ok?: unknown; error?: { code?: unknown } }
    if (body.ok !== false) return undefined
    const code = body.error?.code
    if (typeof code !== 'string') return undefined
    return ErrorCodeSchema.safeParse(code).success ? code : undefined
  } catch {
    return undefined
  }
}
